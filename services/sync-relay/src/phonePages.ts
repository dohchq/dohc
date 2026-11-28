import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AccountSession, AccountSessions } from "@dohc/workspace-auth/session";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import { validateUserWritePath } from "@dohc/workspace-core";
import { hiddenFile } from "./accountFeed";
import { badRequest, notFound, RelayError } from "./errors";
import type { createLiveTickets } from "./liveTickets";
import { pathShown, phoneMember, type PhoneMember } from "./phoneMember";
import { serviceHostReadiness, type ServiceHostReadinessHost } from "./serviceHostEnrollmentRoutes";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";
import { fileSideOf, MAX_SHARE_PATH_CHARS, pathLevel } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import { liveRoomPaused } from "./storage/liveRoomPauses";
import { LiveHostingRefusal, type ServiceHostEnrollment } from "./storage/serviceHostEnrollment";

// The phone, or the owner's browser through share-web, opens one of its account's pages to edit it live. The account
// route has already checked the sign-in, its fence, the workspace's
// owner or joined member and, for a phone, Show on phone. This enrolls a page that already has live history
// as the owner's or member's open, and once the live host is ready, mints the one-use
// ticket the phone connection presents. A page no computer has opened
// live is refused, as it is for agents: its owner opens it on a desktop first.

/** The account's documents the live host keeps for its owner's opens. Past it, a phone enrolls no new one. */
export const PHONE_OWNER_DOCUMENTS_PER_ACCOUNT = 16;
/** How long the open waits for the session table, and for the ticket's mint. */
export const PHONE_PAGE_WAIT_MS = 10_000;
const PHONE_MEMBER_SESSIONS_PER_ACCOUNT = 16;

export interface PhoneMemberLiveSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly grantId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly path: string;
}

export type PhoneMemberLiveSessions = ReturnType<typeof createPhoneMemberLiveSessions>;

export function memberEditGrant(
  storage: SyncRelayStorage,
  input: Pick<PhoneMemberLiveSession, "userId" | "workspaceId" | "shareId" | "grantId" | "path">,
): { readonly generation: number; readonly access: string } | null {
  if (hiddenFile(input.path)) return null;
  const current = authorizeNamedLiveEditShareGrant({
    storage,
    actorUserId: input.userId,
    grantId: input.grantId,
  });
  const files = current.ok ? fileSideOf(current.effectiveSelector) : null;
  return current.ok &&
    current.grant.grantId === input.grantId &&
    current.share.shareId === input.shareId &&
    current.share.workspaceId === input.workspaceId &&
    files !== null &&
    pathLevel(files, input.path) === "edit"
    ? { generation: current.grant.generation, access: current.grant.access }
    : null;
}

const hashPhoneTicket = (token: string) => createHash("sha256").update(token).digest();

export function createPhoneMemberLiveSessions(options: {
  storage: SyncRelayStorage;
  maxSessions: number;
  now?: () => number;
}) {
  const { storage, maxSessions, now = Date.now } = options;
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0)
    throw new TypeError("Invalid phone member session limits.");
  const entries = new Map<
    string,
    {
      session: PhoneMemberLiveSession;
      expiresAtMs: number;
      tokenHash: Buffer;
      generation: number;
      access: string;
    }
  >();
  const liveEntry = (discriminator: string) => {
    const entry = entries.get(discriminator);
    if (!entry || entry.expiresAtMs <= now()) {
      if (entry) entries.delete(discriminator);
      return null;
    }
    return entry;
  };
  const drop = (match: (session: PhoneMemberLiveSession) => boolean) => {
    for (const [key, entry] of entries) if (match(entry.session)) entries.delete(key);
  };

  return {
    create(
      input: PhoneMemberLiveSession & { readonly token: string; readonly expiresAtMs: number },
    ) {
      const grant = memberEditGrant(storage, input);
      const nowMs = now();
      if (!grant || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= nowMs)
        return null;
      let held = 0,
        oldest: string | undefined;
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs <= nowMs) entries.delete(key);
        else if (entry.session.userId === input.userId) {
          held += 1;
          oldest ??= key;
        }
      }
      const discriminator = randomBytes(9).toString("base64url");
      if (entries.has(discriminator)) throw new Error("Phone session discriminator collision.");
      if (held >= PHONE_MEMBER_SESSIONS_PER_ACCOUNT && oldest !== undefined) entries.delete(oldest);
      if (entries.size >= maxSessions) return null;
      const { token, expiresAtMs, ...session } = input;
      entries.set(discriminator, {
        session: Object.freeze(session),
        expiresAtMs,
        tokenHash: hashPhoneTicket(token),
        ...grant,
      });
      return { discriminator, expiresAtMs };
    },
    has: (discriminator: string) => liveEntry(discriminator) !== null,
    take(input: { discriminator: string; userId: string; sessionId: string; token: string }) {
      const entry = liveEntry(input.discriminator);
      if (
        !entry ||
        entry.session.userId !== input.userId ||
        entry.session.sessionId !== input.sessionId ||
        !timingSafeEqual(hashPhoneTicket(input.token), entry.tokenHash)
      )
        return null;
      entries.delete(input.discriminator);
      const grant =
        !accountIsFenced(storage, input.userId) &&
        storage.showsOnPhone(input.userId, entry.session.workspaceId)
          ? memberEditGrant(storage, entry.session)
          : null;
      return grant && grant.generation === entry.generation && grant.access === entry.access
        ? entry.session
        : null;
    },
    stopSession: (userId: string, sessionId: string) =>
      drop((s) => s.userId === userId && s.sessionId === sessionId),
    stopPhoneWorkspace: (userId: string, workspaceId: string) =>
      drop((s) => s.userId === userId && s.workspaceId === workspaceId),
    deleteAccount: (userId: string, workspaceIds: readonly string[]) =>
      drop((s) => s.userId === userId || workspaceIds.includes(s.workspaceId)),
  };
}

export type PhonePageAnswer =
  | {
      status: "ready";
      mode?: "named";
      session?: string;
      liveWorkspaceId?: string;
      objectId: string;
      lineageClaimId: string;
      /** The one-use ticket, which only the response body carries. */
      ticket: string;
      expiresAtMs: number;
      /** The bounds the owner connection holds the phone's editor to, as the desktop's admission sends them. */
      editorLimits: NamedLiveBrowserLimits;
    }
  | { status: "preparing" }
  /** A hidden page and a missing one both answer `missing`. */
  | { status: "refused"; reason: string };

const preparing = { status: "preparing" } as const;
const refused = (reason: string) => ({ status: "refused", reason }) as const;

/** What the account route needs to open a page for the phone. */
export interface PhonePages {
  open(input: {
    caller: AccountSession;
    member?: PhoneMember | null;
    workspaceId: string;
    args: unknown;
    /** The route's checks of the sign-in, owner and Show on phone. Throws notFound() for any loss. */
    authorize(): Promise<void>;
    signal: AbortSignal;
  }): Promise<PhonePageAnswer>;
}

export function createPhonePages(options: {
  storage: SyncRelayStorage;
  history: LiveJournalHistoryAuthority;
  host: ServiceHostReadinessHost & { reconcile(): void };
  /** Whether the self-hosted live host is the configured host now. */
  supported(): boolean;
  tickets: Pick<ReturnType<typeof createLiveTickets>, "mint">;
  phoneNamedTickets?: Pick<ReturnType<typeof createLiveTickets>, "mint">;
  phoneMemberSessions?: Pick<PhoneMemberLiveSessions, "create">;
  /** Read uncached for the mint. */
  sessions: Pick<AccountSessions, "read">;
  nowMs(): number;
  editorLimits: NamedLiveBrowserLimits;
  waitMs?: number;
}): PhonePages {
  const { storage, host } = options;
  const waitMs = options.waitMs ?? PHONE_PAGE_WAIT_MS;
  const { state } = serviceHostReadiness({
    storage,
    history: options.history,
    host,
    activation: storage.createServiceActivationStore(options.history),
  });

  function parsePath(args: unknown): string {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).length !== 1 ||
      typeof (args as { path?: unknown }).path !== "string" ||
      (args as { path: string }).path.length > MAX_SHARE_PATH_CHARS
    )
      throw badRequest("the arguments do not fit openPage");
    return (args as { path: string }).path;
  }

  // The rich document at the path on main, or undefined for a path the phone can't reach.
  // A hidden path is classified first, so it answers exactly as a missing one, before anything else is read.
  function pageAt(
    workspaceId: string,
    path: string,
    member: PhoneMember | null,
  ): string | undefined {
    if (hiddenFile(path)) return undefined;
    const checked = validateUserWritePath(path);
    if (!checked.ok || checked.normalized !== path || liveDocumentKindForPath(path) !== "richdoc")
      return undefined;
    if (member !== null && !pathShown(member, path)) return undefined;
    return storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path });
  }

  function memberRefusal(
    userId: string,
    workspaceId: string,
    member: PhoneMember,
    path: string,
    objectId: string,
  ): string | null {
    const live = phoneMember(storage, workspaceId, userId);
    if (
      !live ||
      live.grantId !== member.grantId ||
      live.shareId !== member.shareId ||
      !pathShown(live, path)
    )
      return "missing";
    if (
      !memberEditGrant(storage, {
        userId,
        workspaceId,
        shareId: live.shareId,
        grantId: live.grantId,
        path,
      })
    )
      return "read-only";
    return liveRoomPaused(storage as StorageContext, { workspaceId, objectId })
      ? "live_paused_by_owner"
      : null;
  }

  // Whether enrolling the page would add one more document the live host keeps for the account's opens, past its bound.
  function pastAccountBound(userId: string, workspaceId: string, objectId: string): boolean {
    const hosted = storage.listServiceHostEnrollments();
    if (hosted.some((row) => row.workspaceId === workspaceId && row.objectId === objectId))
      return false;
    return (
      hosted.filter((row) => row.ownerUserId === userId && row.ownerDemand).length >=
      PHONE_OWNER_DOCUMENTS_PER_ACCOUNT
    );
  }

  return {
    async open({ caller, member = null, workspaceId, args, authorize, signal }) {
      if (
        member
          ? caller.clientKind !== "phone"
          : caller.clientKind === "desktop" ||
            !storage.workspaceIsOwnedBy(workspaceId, caller.userId)
      )
        throw notFound();
      const path = parsePath(args);
      const objectId = pageAt(workspaceId, path, member);
      if (objectId === undefined) return refused("missing");
      const deny = member
        ? memberRefusal(caller.userId, workspaceId, member, path, objectId)
        : null;
      if (deny === "missing" || deny === "read-only") return refused(deny);
      if (
        !options.supported() ||
        (member && (!options.phoneNamedTickets || !options.phoneMemberSessions))
      )
        return refused("live_hosting_unsupported");
      if (deny !== null) return refused(deny);
      // Only a page some computer opened live has a lineage to host. The server makes none, so it enrolls nothing here.
      if (!storage.mainLiveLineageExists({ workspaceId, objectId }))
        return refused("live-document-without-lineage");
      if (!member && pastAccountBound(caller.userId, workspaceId, objectId))
        return refused("live_host_full");
      let row: ServiceHostEnrollment;
      try {
        const base = {
          workspaceId,
          path,
          nowMs: options.nowMs(),
          guard: () => signal.throwIfAborted(),
        };
        // The owner's or member's open, never their Resume: a Pause or Stop stays in force.
        row = storage.ensureOwnedLiveDocument(
          member
            ? { ...base, intent: "member-open", userId: caller.userId }
            : { ...base, intent: "owner-open", ownerUserId: caller.userId },
        );
      } catch (error) {
        if (error instanceof LiveHostingRefusal) return refused(error.reason);
        if (member && error instanceof RelayError && error.code === "conflict")
          return refused("document-unavailable");
        throw error;
      }
      host.reconcile();
      if (row.objectId !== objectId) return refused("document-unavailable");
      const now = state(row);
      if (now.status === "ready")
        return await mint(caller, member, row, now.document.binding, authorize, signal);
      if (now.status === "paused") return refused(member ? "live_paused_by_owner" : "paused");
      // Preparing, or unavailable without a reason: the host is still activating the page, or not running yet.
      if (now.status === "preparing" || now.reason === undefined) return preparing;
      return refused(now.reason);
    },
  };

  // Only after the page is ready and the phone's access is checked one last time.
  async function mint(
    caller: AccountSession,
    member: PhoneMember | null,
    row: ServiceHostEnrollment,
    binding: { objectId: string; lineageClaimId: string; currentPath: string },
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<PhonePageAnswer> {
    await authorize();
    if (hiddenFile(binding.currentPath)) return refused("missing");
    if (binding.objectId !== row.objectId || binding.currentPath !== row.path)
      return refused("document-unavailable");
    const memberScope = member
      ? {
          userId: caller.userId,
          workspaceId: row.workspaceId,
          shareId: member.shareId,
          grantId: member.grantId,
        }
      : null;
    const checkMember = () =>
      member
        ? memberRefusal(caller.userId, row.workspaceId, member, binding.currentPath, row.objectId)
        : null;
    const preDeny = checkMember();
    if (preDeny !== null) return refused(preDeny);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
    // The sign-in as its table holds it now, which also gives the ticket its end.
    const stored = (await within(options.sessions.read([caller.sessionId]), bounded)).get(
      caller.sessionId,
    );
    if (
      stored?.userId !== caller.userId ||
      stored.clientKind !== caller.clientKind ||
      stored.expiresAtMs <= options.nowMs()
    )
      throw notFound();
    let minted: Awaited<ReturnType<typeof options.tickets.mint>> = null;
    try {
      minted = await (member ? options.phoneNamedTickets! : options.tickets).mint(
        { objectId: row.objectId },
        memberScope
          ? { kind: "named", ...memberScope }
          : {
              kind: "owner",
              workspaceId: row.workspaceId,
              userId: caller.userId,
              sessionId: caller.sessionId,
              sessionExpiresAtMs: stored.expiresAtMs,
            },
        bounded,
      );
    } catch {
      // The live host changed while the ticket was minted, or the mint ran past its wait. The next open asks again.
      signal.throwIfAborted();
    }
    await authorize();
    // The mint reads the page's current binding itself, so the page is read again after it: a page moved to a
    // secret path meanwhile answers exactly as a missing one, whether or not its ticket was minted.
    const after = state(row);
    if (
      hiddenFile(storage.objectLastKnownPath(row.workspaceId, row.objectId)) ||
      (after.status === "ready" && hiddenFile(after.document.binding.currentPath))
    )
      return refused("missing");
    const postDeny = checkMember();
    if (postDeny !== null) return refused(postDeny);
    // Unless readiness still names the binding checked above, the ticket may be for another lineage, so the phone
    // opens again rather than connecting with this one.
    if (
      minted === null ||
      after.status !== "ready" ||
      !isDeepStrictEqual(after.document.binding, binding)
    )
      return preparing;
    const ready = {
      status: "ready" as const,
      objectId: binding.objectId,
      lineageClaimId: binding.lineageClaimId,
      ticket: minted.token,
      expiresAtMs: minted.expiresAtMs,
      editorLimits: options.editorLimits,
    };
    if (!memberScope) return ready;
    const expiresAtMs = Math.min(minted.expiresAtMs, stored.expiresAtMs);
    if (expiresAtMs <= options.nowMs()) throw notFound();
    const created = options.phoneMemberSessions!.create({
      ...memberScope,
      sessionId: caller.sessionId,
      objectId: binding.objectId,
      lineageClaimId: binding.lineageClaimId,
      path: binding.currentPath,
      token: minted.token,
      expiresAtMs,
    });
    return created === null
      ? preparing
      : {
          ...ready,
          mode: "named",
          session: created.discriminator,
          liveWorkspaceId: `named:${memberScope.grantId}`,
          expiresAtMs: created.expiresAtMs,
        };
  }
}

/** The work's answer, or a busy refusal once `signal` ends first. The work itself is left to finish on its own. */
async function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const ended = new Promise<never>((_, reject) => {
    stop = () =>
      reject(new RelayError("server_busy", "Your server is slow to answer. Try again shortly."));
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work, ended]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
