import { createHash, randomBytes } from "node:crypto";
import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { readBoundedJson } from "@dohc/service-http";
import type { AccountSession, AccountSessions } from "@dohc/workspace-auth/session";
import { hiddenFile } from "./accountFeed";
import type { PhoneAppLaunchGuard } from "./appBackendAuthority";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
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

/**
 * The owner's published apps for the phone: the catalog, each version's
 * review and declared source, the phone's approval, and launch grants that
 * share-web redeems for an app session. Only a publication row is ever
 * listed or launched, so an app approved to run only on a computer is absent.
 * So far the phone opens only an app over one transactional Collection; any
 * other app is absent too.
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
   * Whether the app backend would serve this publication to its owner: its Collection is installed here at a
   * compatible revision. It starts no worker and runs no app code. Throws when it would refuse.
   */
  servable(userId: string, workspaceId: string, publicationId: string): void;
}) {
  const { storage } = options;
  function servable(userId: string, workspaceId: string, id: string): boolean {
    try {
      options.servable(userId, workspaceId, id);
      return true;
    } catch (error) {
      if (storage.unavailable.aborted) throw error;
      return false;
    }
  }

  // Active, not taken down, its share still current, not under a hidden path, and over one transactional Collection.
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
      row.candidate.capabilities.length !== 1 ||
      row.candidate.capabilities[0]!.kind !== "dataset" ||
      !publicationLinkIsCurrent(storage as StorageContext, row.owner) ||
      !servable(userId, workspaceId, id)
    )
      throw notFound();
    return row;
  }

  function ended(launchHashes: readonly string[]): void {
    if (launchHashes.length) options.endShareWebLaunches?.(launchHashes);
  }
  function end(scope: PhoneAppLaunchScope): void {
    ended(endPhoneAppLaunches(storage, scope));
  }

  // Everything a launch is bound to except its sign-in: the launch, its expiry, its approval, the publication
  // at the launch's revision, the fence, ownership and Show on phone. Plain reads with no transaction of their
  // own, so the dataset host runs this inside each commit.
  function holds(binding: PhoneAppBinding, launchHash: string): void {
    const { userId, workspaceId } = binding;
    if (
      phoneAppLaunch(storage, launchHash, options.nowMs())?.approvalId !== binding.approvalId ||
      accountIsFenced(storage, userId) ||
      !storage.workspaceIsOwnedBy(workspaceId, userId) ||
      !storage.showsOnPhone(userId, workspaceId)
    )
      throw notFound();
  }
  // The sign-in, read from the session table, then the rest after that wait, and the publication in full.
  async function recheck(binding: PhoneAppBinding, launchHash: string): Promise<void> {
    const { userId, sessionId, workspaceId } = binding;
    if (!(await options.sessions?.phoneSessionIsCurrent({ userId, sessionId }))) {
      end({ userId, sessionId });
      throw notFound();
    }
    holds(binding, launchHash);
    if (
      publication(userId, workspaceId, binding.publicationId).authorityRevision !==
      binding.authorityRevision
    )
      throw notFound();
  }

  return {
    end,

    /**
     * One app operation for `caller` in a workspace it owns while it shows on
     * the phone. The route has checked both. Approving and launching take a
     * phone sign-in.
     */
    run(caller: AccountSession, workspaceId: string, operation: string, input: unknown): unknown {
      const userId = caller.userId;
      if (operation === "apps") {
        const { cursor } = args(input, [], ["cursor"]);
        if (cursor !== undefined && (typeof cursor !== "string" || !PUBLICATION.test(cursor)))
          throw badRequest("Invalid app cursor.");
        if (!options.limits) return { apps: [], nextCursor: null };
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
            row.datasetCapability === null ||
            row.datasetCapability === "unavailable" ||
            row.collectionCapability !== null ||
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
      );
      const id = publicationId(body.publicationId);
      if (operation === "appRevoke") {
        const { revoked, launchHashes } = revokePhoneApp(storage, {
          userId,
          workspaceId,
          publicationId: id,
        });
        ended(launchHashes);
        return { revoked };
      }
      const row = publication(userId, workspaceId, id);
      if (operation === "appReview") {
        const approval = phoneAppApproval(storage, { userId, workspaceId, publicationId: id });
        return {
          publicationId: id,
          authorityRevision: row.authorityRevision,
          createdAtMs: row.createdAtMs,
          appRoot: row.candidate.appRoot,
          entryPath: row.candidate.entryPath,
          sourceRevision: row.candidate.sourceRevision,
          // Shown to the owner; approval binds the publication and revision, not these.
          candidateDigest: row.approvalProvenance?.committedCandidateDigest ?? null,
          publishedByAgent: row.approvalProvenance?.agent ?? null,
          capabilities: row.candidate.capabilities,
          sources: row.candidate.inputs
            .filter((file) => !hiddenFile(file.path))
            .map(({ path, byteLength }) => ({ path, byteLength })),
          approval:
            approval?.authorityRevision === row.authorityRevision
              ? { approvalId: approval.approvalId, approvedAtMs: approval.approvedAtMs }
              : null,
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
      if (operation === "appApprove")
        return approvePhoneApp(storage, {
          userId,
          workspaceId,
          publicationId: id,
          authorityRevision,
          newApprovalId: randomBytes(16).toString("hex"),
          nowMs: options.nowMs(),
        });
      if (!options.launchable || !options.sessions) throw notFound();
      const approval = phoneAppApproval(storage, { userId, workspaceId, publicationId: id });
      if (approval?.authorityRevision !== authorityRevision)
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
