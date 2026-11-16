import { isDeepStrictEqual } from "node:util";
import type { AccountSession, AccountSessions } from "@dohc/workspace-auth/session";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { validateUserWritePath } from "@dohc/workspace-core";
import { hiddenFile } from "./accountFeed";
import { badRequest, notFound, RelayError } from "./errors";
import type { createLiveTickets } from "./liveTickets";
import { serviceHostReadiness, type ServiceHostReadinessHost } from "./serviceHostEnrollmentRoutes";
import { MAX_SHARE_PATH_CHARS } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import { LiveHostingRefusal, type ServiceHostEnrollment } from "./storage/serviceHostEnrollment";

// The phone opens one of its account's pages to edit it live. The account
// route has already checked the phone's sign-in, its fence, the workspace's
// owner and Show on phone. This enrolls a page that already has live history
// as the owner's open, and once the live host is ready, mints the one-use
// ticket the phone's owner connection presents. A page no computer has opened
// live is refused, as it is for agents: its owner opens it on a desktop first.

/** The account's documents the live host keeps for its owner's opens. Past it, a phone enrolls no new one. */
export const PHONE_OWNER_DOCUMENTS_PER_ACCOUNT = 16;
/** How long the open waits for the session table, and for the ticket's mint. */
export const PHONE_PAGE_WAIT_MS = 10_000;

export type PhonePageAnswer =
  | {
      status: "ready";
      objectId: string;
      lineageClaimId: string;
      /** The one-use ticket, which only the response body carries. */
      ticket: string;
      expiresAtMs: number;
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
  /** Read uncached for the mint. */
  sessions: Pick<AccountSessions, "read">;
  nowMs(): number;
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
  function pageAt(workspaceId: string, path: string): string | undefined {
    if (hiddenFile(path)) return undefined;
    const checked = validateUserWritePath(path);
    if (!checked.ok || checked.normalized !== path || liveDocumentKindForPath(path) !== "richdoc")
      return undefined;
    return storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path });
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
    async open({ caller, workspaceId, args, authorize, signal }) {
      // A desktop or browser edits as the owner without a ticket, so only a phone opens a page here.
      if (caller.clientKind !== "phone") throw notFound();
      const path = parsePath(args);
      const objectId = pageAt(workspaceId, path);
      if (objectId === undefined) return refused("missing");
      if (!options.supported()) return refused("live_hosting_unsupported");
      // Only a page some computer opened live has a lineage to host. The server makes none, so it enrolls nothing here.
      if (!storage.mainLiveLineageExists({ workspaceId, objectId }))
        return refused("live-document-without-lineage");
      if (pastAccountBound(caller.userId, workspaceId, objectId)) return refused("live_host_full");
      let row: ServiceHostEnrollment;
      try {
        // The owner's open, never their Resume: a Pause or Stop stays in force.
        row = storage.ensureOwnedLiveDocument({
          intent: "owner-open",
          workspaceId,
          path,
          ownerUserId: caller.userId,
          nowMs: options.nowMs(),
          guard: () => signal.throwIfAborted(),
        });
      } catch (error) {
        if (error instanceof LiveHostingRefusal) return refused(error.reason);
        throw error;
      }
      host.reconcile();
      if (row.objectId !== objectId) return refused("document-unavailable");
      const now = state(row);
      if (now.status === "ready")
        return await mint(caller, row, now.document.binding, authorize, signal);
      if (now.status === "paused") return refused("paused");
      // Preparing, or unavailable without a reason: the host is still activating the page, or not running yet.
      if (now.status === "preparing" || now.reason === undefined) return preparing;
      return refused(now.reason);
    },
  };

  // Only after the page is ready and the phone's access is checked one last time.
  async function mint(
    caller: AccountSession,
    row: ServiceHostEnrollment,
    binding: { objectId: string; lineageClaimId: string; currentPath: string },
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<PhonePageAnswer> {
    await authorize();
    if (hiddenFile(binding.currentPath)) return refused("missing");
    if (binding.objectId !== row.objectId || binding.currentPath !== row.path)
      return refused("document-unavailable");
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
    // The sign-in as its table holds it now, which also gives the ticket its end.
    const stored = (await within(options.sessions.read([caller.sessionId]), bounded)).get(
      caller.sessionId,
    );
    if (
      stored?.userId !== caller.userId ||
      stored.clientKind !== "phone" ||
      stored.expiresAtMs <= options.nowMs()
    )
      throw notFound();
    let minted: Awaited<ReturnType<typeof options.tickets.mint>> = null;
    try {
      minted = await options.tickets.mint(
        { objectId: row.objectId },
        {
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
    // Unless readiness still names the binding checked above, the ticket may be for another lineage, so the phone
    // opens again rather than connecting with this one.
    if (
      minted === null ||
      after.status !== "ready" ||
      !isDeepStrictEqual(after.document.binding, binding)
    )
      return preparing;
    return {
      status: "ready",
      objectId: binding.objectId,
      lineageClaimId: binding.lineageClaimId,
      ticket: minted.token,
      expiresAtMs: minted.expiresAtMs,
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
