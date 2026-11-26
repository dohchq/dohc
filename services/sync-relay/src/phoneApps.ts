import { createHash, randomBytes } from "node:crypto";
import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { readBoundedJson } from "@dohc/service-http";
import type { AccountSession, AccountSessions } from "@dohc/workspace-auth/session";
import { hiddenFile } from "./accountFeed";
import type { AppBackendAuth, PhoneAppLaunchGuard } from "./appBackendAuthority";
import type { RelayDatasetHost } from "./datasetHost";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { PhoneMember } from "./phoneMember";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import {
  memberAppPage,
  memberAppRow,
  MemberAppRefusal,
  recordMemberAppConsent,
  workspaceAppPage,
} from "./storage/memberApps";
import {
  approvePhoneApp,
  endPhoneAppLaunches,
  issuePhoneAppGrant,
  phoneAppApproval,
  phoneAppLaunch,
  redeemPhoneAppGrant,
  revokePhoneApp,
  type PhoneAppBinding,
  type PhoneAppLaunchScope,
} from "./storage/phoneApps";
import { publicationLinkIsCurrent } from "./storage/publications";

/** How long the phone has to hand a grant to share-web. */
export const PHONE_APP_GRANT_MS = 30_000;
/** Share-web's handoff and app session together, counted from redemption. A launch is never renewed. */
export const PHONE_APP_LAUNCH_MS = 30_000 + 10 * 60_000;
const SOURCE_MAX_BYTES = 1024 * 1024;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PUBLICATION = /^[0-9a-f]{64}$/;
const LAUNCH_HOST = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,8}$/;

const OPERATIONS = new Set([
  "apps",
  "memberApps",
  "appReview",
  "appSource",
  "appApprove",
  "appRevoke",
  "appLaunch",
]);

/** The phone's app operations. They read the relay's own tables, so they need no server copy. */
export function isPhoneAppOperation(name: string): boolean {
  return OPERATIONS.has(name);
}

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

function args(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("Invalid app arguments.");
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw badRequest("Invalid app arguments.");
  return value as Record<string, unknown>;
}
function publicationId(value: unknown): string {
  if (typeof value !== "string" || !PUBLICATION.test(value)) throw notFound();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw badRequest("Invalid app revision.");
  return Number(value);
}

type Served = ReturnType<RelayDatasetHost["servedPublication"]>;

/**
 * The owner's published apps and the workspace's Member apps for the phone:
 * the catalogs, each version's review and declared source, the phone's
 * approval, and launch grants that share-web redeems for an app session. Only
 * a publication row is ever listed or launched, so an app approved to run only
 * on a computer is absent. The phone opens only apps over transactional
 * Collections or that request nothing in the workspace. A Member app runs for
 * the owner as for any viewer: within both its author's and the owner's reach,
 * and only once the owner allowed what it can do. A Member or an Admin sees
 * the workspace's official apps instead of the owner's published ones, and the
 * Member apps both reaches allow, and each runs within their own reach.
 */
export function createPhoneApps(options: {
  storage: SyncRelayStorage;
  limits: AppPublicationLimits | undefined;
  sessions: AccountSessions | undefined;
  /** Share-web and the app backend are configured, so a grant can become an app session. */
  launchable: boolean;
  nowMs(): number;
  /** Ends share-web's app sessions for these launch IDs' hashes, which the relay has already deleted. */
  endShareWebLaunches?(launchHashes: readonly string[]): void;
  /**
   * The app backend's own lookup, as it runs on every launch call: its Collections are installed here at compatible
   * revisions and, for a Member app, both reaches hold. It starts no worker and runs no app code. Throws when it
   * would refuse; while `reviewing`, a Member app the person hasn't allowed is still answered.
   */
  served(auth: AppBackendAuth, publicationId: string, reviewing: boolean): Served;
  authorName?(userId: string): Promise<string | null>;
}) {
  const { storage } = options;
  const context = storage as StorageContext;
  function served(userId: string, workspaceId: string, id: string, reviewing: boolean): Served {
    try {
      return options.served({ kind: "named", workspaceId, userId }, id, reviewing);
    } catch (error) {
      if (error instanceof MemberAppRefusal) throw relayError("conflict", error.message);
      if (storage.unavailable.aborted) throw error;
      throw notFound();
    }
  }
  function servable(userId: string, workspaceId: string, id: string): boolean {
    try {
      const published = served(userId, workspaceId, id, false);
      return !!published && !published.local;
    } catch (error) {
      if (storage.unavailable.aborted) throw error;
      return false;
    }
  }

  // Active, not taken down, its share still current, not under a hidden path, and over one transactional
  // Collection or nothing in the workspace.
  function publication(userId: string, workspaceId: string, id: string) {
    if (!options.limits) throw notFound();
    let row;
    try {
      row = storage.readAppPublication({
        workspaceId,
        publicationId: id,
        ownerUserId: userId,
        limits: options.limits,
      });
    } catch (error) {
      if (error instanceof RelayError) throw notFound();
      throw error;
    }
    if (
      !row.active ||
      row.operatorTakedown ||
      hiddenFile(row.candidate.appRoot) ||
      row.candidate.capabilities.some((capability) => capability.kind !== "dataset") ||
      !publicationLinkIsCurrent(storage as StorageContext, row.owner) ||
      !servable(userId, workspaceId, id)
    )
      throw notFound();
    return row;
  }

  function workspaceApp(userId: string, workspaceId: string, id: string) {
    const row = context.db
      .prepare(
        `SELECT p.created_at_ms FROM sync_relay_app_publications p WHERE p.workspace_id=? AND p.publication_id=?
         AND p.active=1 AND p.audience='workspace'
         AND NOT EXISTS (SELECT 1 FROM sync_relay_member_apps m WHERE m.publication_id=p.publication_id)
         AND NOT EXISTS (SELECT 1 FROM sync_relay_app_publication_takedowns t WHERE t.publication_id=p.publication_id)`,
      )
      .get(workspaceId, id);
    if (!row || !options.limits) throw notFound();
    const published = served(userId, workspaceId, id, false);
    if (
      !published ||
      published.local ||
      published.member ||
      hiddenFile(published.candidate.appRoot) ||
      published.candidate.capabilities.some((capability) => capability.kind !== "dataset")
    )
      throw notFound();
    return {
      candidate: published.candidate,
      authorityRevision: published.authorityRevision,
      createdAtMs: Number(row.created_at_ms),
      approvalProvenance: undefined,
    };
  }

  function memberApp(userId: string, workspaceId: string, id: string, reviewing: boolean) {
    const row = memberAppRow(context, id);
    if (!row || row.workspaceId !== workspaceId || !options.limits) throw notFound();
    const published = served(userId, workspaceId, id, reviewing);
    if (!published?.member || published.local || hiddenFile(published.candidate.appRoot))
      throw notFound();
    return { ...published, member: published.member, createdAtMs: row.createdAtMs };
  }
  const allowed = (
    approval: ReturnType<typeof phoneAppApproval>,
    app: ReturnType<typeof memberApp>,
  ) => approval?.authorityRevision === app.authorityRevision && app.member.consent === "current";
  const isMemberApp = (workspaceId: string, id: string) =>
    memberAppRow(context, id)?.workspaceId === workspaceId;

  function ended(launchHashes: readonly string[]): void {
    if (launchHashes.length) options.endShareWebLaunches?.(launchHashes);
  }
  function end(scope: PhoneAppLaunchScope): void {
    ended(endPhoneAppLaunches(storage, scope));
  }

  // Everything a launch is bound to except its sign-in: the launch, its expiry, its approval, the publication
  // at the launch's revision, the fence, the person's place in the workspace and their Show on phone. Plain reads
  // with no transaction of their own, so the dataset host runs this inside each commit.
  function holds(binding: PhoneAppBinding, launchHash: string): void {
    const { userId, workspaceId } = binding;
    if (
      phoneAppLaunch(storage, launchHash, options.nowMs())?.approvalId !== binding.approvalId ||
      accountIsFenced(storage, userId) ||
      storage.phoneRole(userId, workspaceId) === null
    )
      throw notFound();
  }
  const app = (userId: string, workspaceId: string, id: string, reviewing: boolean) =>
    isMemberApp(workspaceId, id)
      ? memberApp(userId, workspaceId, id, reviewing)
      : storage.workspaceIsOwnedBy(workspaceId, userId)
        ? publication(userId, workspaceId, id)
        : workspaceApp(userId, workspaceId, id);
  // The sign-in, read from the session table, then the rest after that wait, and the publication in full.
  async function recheck(binding: PhoneAppBinding, launchHash: string): Promise<void> {
    const { userId, sessionId, workspaceId } = binding;
    if (!(await options.sessions?.phoneSessionIsCurrent({ userId, sessionId }))) {
      end({ userId, sessionId });
      throw notFound();
    }
    holds(binding, launchHash);
    const current = app(userId, workspaceId, binding.publicationId, false);
    if (current.authorityRevision !== binding.authorityRevision) throw notFound();
  }

  function authors(workspaceId: string, operation: string, input: unknown): string[] {
    if (operation === "memberApps") {
      const cursor = (input as { cursor?: unknown } | null)?.cursor;
      return [
        ...new Set(
          memberAppPage(context, workspaceId, typeof cursor === "string" ? cursor : "").rows.map(
            (row) => row.publisherUserId,
          ),
        ),
      ];
    }
    const id = (input as { publicationId?: unknown } | null)?.publicationId;
    if (operation !== "appReview" || typeof id !== "string") return [];
    const row = memberAppRow(context, id);
    return row?.workspaceId === workspaceId ? [row.publisherUserId] : [];
  }

  return {
    end,

    /**
     * The names of the authors a read shows. Null when it shows none, so the route answers with no wait; otherwise
     * the route checks the sign-in again after this wait and before `run`.
     */
    async names(
      workspaceId: string,
      operation: string,
      input: unknown,
    ): Promise<Map<string, string | null> | null> {
      const ids = authors(workspaceId, operation, input);
      if (!ids.length) return null;
      return new Map(
        await Promise.all(
          ids.map(
            async (id) => [id, (await options.authorName?.(id).catch(() => null)) ?? null] as const,
          ),
        ),
      );
    },

    /**
     * One app operation for `caller` in a workspace it owns or joined while it
     * shows on their phone. The route has checked both, and passes a Member's
     * or an Admin's reach. Approving and launching take a phone sign-in.
     */
    run(
      caller: AccountSession,
      workspaceId: string,
      operation: string,
      input: unknown,
      names: ReadonlyMap<string, string | null> = new Map(),
      member: PhoneMember | null = null,
    ): unknown {
      const userId = caller.userId;
      if (operation === "memberApps") {
        const { cursor } = args(input, [], ["cursor"]);
        if (cursor !== undefined && (typeof cursor !== "string" || !PUBLICATION.test(cursor)))
          throw badRequest("Invalid app cursor.");
        if (!options.limits) return { memberApps: [], nextCursor: null };
        const page = memberAppPage(context, workspaceId, cursor ?? "");
        return {
          memberApps: page.rows.flatMap((row) => {
            let app;
            try {
              app = memberApp(userId, workspaceId, row.publicationId, true);
            } catch (error) {
              if (error instanceof RelayError) return [];
              throw error;
            }
            return [
              {
                publicationId: row.publicationId,
                authorityRevision: app.authorityRevision,
                appRoot: app.candidate.appRoot,
                sourceRevision: app.candidate.sourceRevision,
                approved: allowed(
                  phoneAppApproval(storage, {
                    userId,
                    workspaceId,
                    publicationId: row.publicationId,
                  }),
                  app,
                ),
                name: row.slug,
                author: { name: names.get(row.publisherUserId) ?? null },
                consent: app.member.consent,
              },
            ];
          }),
          nextCursor: page.nextCursor,
        };
      }
      if (operation === "apps") {
        const { cursor } = args(input, [], ["cursor"]);
        if (cursor !== undefined && (typeof cursor !== "string" || !PUBLICATION.test(cursor)))
          throw badRequest("Invalid app cursor.");
        if (!options.limits) return { apps: [], nextCursor: null };
        if (member !== null) {
          const page = workspaceAppPage(context, workspaceId, `w${cursor ?? ""}`);
          return {
            apps: page.rows.flatMap((row) => {
              if (row.kind !== "workspace") return [];
              let found;
              try {
                found = workspaceApp(userId, workspaceId, row.publicationId);
              } catch (error) {
                if (error instanceof RelayError) return [];
                throw error;
              }
              return [
                {
                  publicationId: row.publicationId,
                  authorityRevision: found.authorityRevision,
                  appRoot: found.candidate.appRoot,
                  sourceRevision: found.candidate.sourceRevision,
                  approved:
                    phoneAppApproval(storage, {
                      userId,
                      workspaceId,
                      publicationId: row.publicationId,
                    })?.authorityRevision === found.authorityRevision,
                },
              ];
            }),
            nextCursor: page.nextCursor?.startsWith("w") ? page.nextCursor.slice(1) : null,
          };
        }
        const page = storage.listAppPublications({
          workspaceId,
          ownerUserId: userId,
          limits: options.limits,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          apps: page.publications.flatMap((row) =>
            row.manifestUnavailable ||
            !row.active ||
            row.operatorTakedown ||
            !row.linkCurrent ||
            hiddenFile(row.appRoot) ||
            row.datasetCapabilities === "unavailable" ||
            row.collectionCapability !== null ||
            // Serves only a dataset app or one that requests nothing; a Collection awaiting approval is neither.
            !servable(userId, workspaceId, row.publicationId)
              ? []
              : [
                  {
                    publicationId: row.publicationId,
                    authorityRevision: row.authorityRevision,
                    appRoot: row.appRoot,
                    sourceRevision: row.sourceRevision,
                    approved:
                      phoneAppApproval(storage, {
                        userId,
                        workspaceId,
                        publicationId: row.publicationId,
                      })?.authorityRevision === row.authorityRevision,
                  },
                ],
          ),
          nextCursor: page.nextCursor,
        };
      }
      const body = args(
        input,
        operation === "appSource"
          ? ["publicationId", "path"]
          : operation === "appApprove" || operation === "appLaunch"
            ? ["publicationId", "authorityRevision"]
            : ["publicationId"],
        operation === "appApprove" ? ["scopeDigest"] : [],
      );
      const id = publicationId(body.publicationId);
      if (!isMemberApp(workspaceId, id) && body.scopeDigest !== undefined)
        throw badRequest("Invalid app arguments.");
      if (operation === "appRevoke") {
        const { revoked, launchHashes } = revokePhoneApp(storage, {
          userId,
          workspaceId,
          publicationId: id,
        });
        ended(launchHashes);
        return { revoked };
      }
      const row = app(userId, workspaceId, id, operation !== "appLaunch");
      const approval = phoneAppApproval(storage, { userId, workspaceId, publicationId: id });
      const approved =
        "member" in row
          ? allowed(approval, row)
          : approval?.authorityRevision === row.authorityRevision;
      if (operation === "appReview") {
        const { candidate } = row;
        const provenance = "member" in row ? undefined : row.approvalProvenance;
        return {
          publicationId: id,
          authorityRevision: row.authorityRevision,
          createdAtMs: row.createdAtMs,
          appRoot: candidate.appRoot,
          entryPath: candidate.entryPath,
          sourceRevision: candidate.sourceRevision,
          // Shown to the owner; approval binds the publication and revision, not these.
          candidateDigest: provenance?.committedCandidateDigest ?? null,
          publishedByAgent: provenance?.agent ?? null,
          sources: candidate.inputs
            .filter((file) => !hiddenFile(file.path))
            .map(({ path, byteLength }) => ({ path, byteLength })),
          revocable: "member" in row ? approved || row.member.consent !== "none" : approved,
          approval:
            approval && approved
              ? { approvalId: approval.approvalId, approvedAtMs: approval.approvedAtMs }
              : null,
          ...("member" in row
            ? {
                name: row.member.slug,
                author: { name: names.get(row.member.publisherUserId) ?? null },
                consent: row.member.consent,
                scopeDigest: row.member.digest,
                capabilities: row.capabilities.map((capability) => {
                  const { operationIds, access } = row.member.scope.find(
                    (value) => value.datasetId === capability.datasetId,
                  )!;
                  return {
                    ...capability,
                    access,
                    operationIds,
                    operations: capability.operations.filter((value) =>
                      operationIds.includes(value.operationId),
                    ),
                  };
                }),
              }
            : {
                author: null,
                consent: null,
                scopeDigest: null,
                capabilities: candidate.capabilities,
              }),
        };
      }
      if (operation === "appSource") {
        // The source the publisher built from, not proof of what runs. Hidden reads as absent.
        const file = row.candidate.inputs.find((input) => input.path === body.path);
        if (!file || hiddenFile(file.path)) throw notFound();
        const bytes =
          file.byteLength <= SOURCE_MAX_BYTES ? storage.getBlob(workspaceId, file.sha256) : null;
        if (bytes && bytes.byteLength === file.byteLength && sha(bytes) === file.sha256) {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return { path: file.path, available: true, text };
          } catch {}
        }
        return { path: file.path, available: false };
      }
      if (caller.clientKind !== "phone") throw notFound();
      const authorityRevision = revision(body.authorityRevision);
      if (row.authorityRevision !== authorityRevision)
        throw relayError("conflict", "This app changed. Review it again.");
      if (operation === "appApprove") {
        if ("member" in row && body.scopeDigest !== row.member.digest)
          throw "scopeDigest" in body
            ? relayError("conflict", "This app changed. Review it again.")
            : badRequest("Invalid app arguments.");
        if ("member" in row && row.member.consent !== "current")
          end({ userId, workspaceId, publicationId: id });
        return context.tx(() => {
          if ("member" in row)
            recordMemberAppConsent(context, {
              workspaceId,
              viewerUserId: userId,
              publicationId: id,
              scopeDigest: row.member.digest,
              scope: row.member.scope.map(({ datasetId, operationIds }) => ({
                datasetId,
                operationIds,
              })),
              nowMs: options.nowMs(),
            });
          return approvePhoneApp(storage, {
            userId,
            workspaceId,
            publicationId: id,
            authorityRevision,
            newApprovalId: randomBytes(16).toString("hex"),
            nowMs: options.nowMs(),
          });
        });
      }
      if (!options.launchable || !options.sessions) throw notFound();
      if (!approval || !approved)
        throw relayError("conflict", "Approve this version of the app first.");
      const grant = secret(),
        now = options.nowMs();
      issuePhoneAppGrant(storage, {
        userId,
        sessionId: caller.sessionId,
        workspaceId,
        publicationId: id,
        authorityRevision,
        approvalId: approval.approvalId,
        grantHash: sha(grant),
        expiresAtMs: now + PHONE_APP_GRANT_MS,
        nowMs: now,
      });
      return { grant, expiresAtMs: now + PHONE_APP_GRANT_MS };
    },

    /**
     * Share-web's one redemption of a grant for `launchHost`. The caller has
     * checked the exchange key. Answers the launch ID and what it is bound to.
     */
    async redeem(
      request: Request,
      route: { workspaceId: string; publicationId: string },
    ): Promise<Response> {
      let raw: unknown;
      try {
        raw = await readBoundedJson(request, 1024, request.signal);
      } catch {
        throw badRequest("Invalid launch grant.");
      }
      const { grant, launchHost } = args(raw, ["grant", "launchHost"]);
      if (
        typeof grant !== "string" ||
        !SECRET.test(grant) ||
        typeof launchHost !== "string" ||
        !LAUNCH_HOST.test(launchHost)
      )
        throw notFound();
      const launchId = secret(),
        launchHash = sha(launchId),
        now = options.nowMs();
      const binding = redeemPhoneAppGrant(storage, {
        grantHash: sha(grant),
        launchHash,
        launchHost,
        workspaceId: route.workspaceId,
        publicationId: route.publicationId,
        nowMs: now,
        expiresAtMs: now + PHONE_APP_LAUNCH_MS,
      });
      if (!binding) throw notFound();
      await recheck(binding, launchHash);
      return Response.json({
        launchId,
        userId: binding.userId,
        authorityRevision: binding.authorityRevision,
      });
    },

    /**
     * The account a launch ID acts for, on its own publication's app paths
     * only, and the guard its request carries while it works.
     */
    async authorizeLaunch(
      launchId: string,
      route: { workspaceId: string; publicationId: string },
    ): Promise<{ userId: string; guard: PhoneAppLaunchGuard }> {
      if (!SECRET.test(launchId)) throw notFound();
      const launchHash = sha(launchId);
      const binding = phoneAppLaunch(storage, launchHash, options.nowMs());
      if (
        !binding ||
        binding.workspaceId !== route.workspaceId ||
        binding.publicationId !== route.publicationId
      )
        throw notFound();
      const guard: PhoneAppLaunchGuard = {
        authorizeOperation: () => holds(binding, launchHash),
        recheck: () => recheck(binding, launchHash),
      };
      await guard.recheck();
      return { userId: binding.userId, guard };
    },
  };
}

export type PhoneApps = ReturnType<typeof createPhoneApps>;
