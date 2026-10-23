import { createHash } from "node:crypto";
import { z } from "zod";
import { AccessAnswer, AccessCollectionRow, AccessObjectRef, type AccessRefreshResult, type SharingAccessInput } from "@dohc/workspace-contracts/access";
import { DatasetPermissionsPage } from "@dohc/cli/dataset";
import { createAccessQuery, decodeAccessCursor, encodeAccessCursor, unknownAccess, type AccessRosterObservation } from "./accessQuery";
import type { RosterObservation } from "../automations/shareRoster";
import { relayUrlsMatch } from "../workspaces/syncCode";
import type { ReceivedObservation } from "../workspaces/receivedShareStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { serverUrlsMatch } from "../workspaces/chatRelayIdentity";

export function ownerAccessRoster(
  workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "pausedRemote" | "shareView">,
  credentials: CloudCredentials | null,
  observation: (workspaceId: string) => RosterObservation,
): AccessRosterObservation {
  const unavailable = (unknownReason: NonNullable<AccessAnswer["unknownReason"]>): AccessRosterObservation =>
    ({ listing: null, checkedAtMs: null, freshness: "unknown", unknownReason });
  if (workspace.shareView) return { listing: null, checkedAtMs: null, freshness: "unknown", visibility: "hidden" };
  const remote = workspace.remote ?? workspace.pausedRemote;
  if (!remote) return unavailable("not-synced");
  if (!credentials) return unavailable("signed-out");
  if (!serverUrlsMatch(remote.serverUrl, credentials.serverUrl)) return unavailable("other-server");
  if (remote.ownerUserId !== credentials.userId) return unavailable("other-account");
  if (!credentials.relayUrl) return unavailable("unreadable");
  return observation(workspace.workspaceId);
}

export type ResolvedAccessObject = { ref: AccessObjectRef; visibility: "visible" | "hidden" | "missing" | "unknown";
  shareId?: string; shareRoot?: boolean; ended?: boolean; relayUrl?: string; recipientUserId?: string; recipientEmail?: string | null };

/** Main supplies physical resolution and authority routing. These observations never admit a write. */
export function createAccessOwner<Workspace>(dependencies: {
  resolve(workspace: Workspace, ref: AccessObjectRef): Promise<ResolvedAccessObject>;
  roster(workspace: Workspace): AccessRosterObservation;
  received(): ReceivedObservation;
  account(): { userId: string; email: string; relayUrl?: string; generation: number } | null;
  scope(workspace: Workspace): string;
  assertCurrent(workspace: Workspace): void;
  permissions(workspace: Workspace, datasetId: string, after?: string): Promise<unknown>;
  refresh(workspace: Workspace): Promise<AccessRefreshResult>;
  nowMs?: () => number;
}) {
  const query = createAccessQuery(), nowMs = dependencies.nowMs ?? Date.now;
  return {
    async object(workspace: Workspace, input: { ref: AccessObjectRef; cursor?: string }): Promise<AccessAnswer> {
      const capturedScope = dependencies.scope(workspace);
      const account = dependencies.account(), accountKey = JSON.stringify(account);
      const accountIsCurrent = () => JSON.stringify(dependencies.account()) === accountKey;
      const ref = AccessObjectRef.parse(input.ref);
      let resolved: ResolvedAccessObject;
      try { resolved = await dependencies.resolve(workspace, ref); }
      catch { dependencies.assertCurrent(workspace); return unknownAccess(ref, "unreadable"); }
      dependencies.assertCurrent(workspace);
      if (!accountIsCurrent()) return unknownAccess(resolved.ref, "changed");
      if (resolved.visibility === "hidden" || resolved.visibility === "missing") return unknownAccess(resolved.ref, null, resolved.visibility);
      if (resolved.visibility === "unknown") return unknownAccess(resolved.ref, "unreadable");
      if (resolved.ref.kind === "collection") {
        const checkedAtMs = nowMs();
        const datasetId = resolved.ref.datasetId;
        const scope = createHash("sha256").update(JSON.stringify([capturedScope, resolved.ref])).digest("hex");
        let after: string | undefined;
        if (input.cursor) {
          const decoded = decodeAccessCursor(input.cursor, scope);
          if (decoded === null) return unknownAccess(resolved.ref, "changed");
          after = decoded;
        }
        try {
          const page = DatasetPermissionsPage.parse(await dependencies.permissions(workspace, datasetId, after));
          dependencies.assertCurrent(workspace);
          if (!accountIsCurrent()) return unknownAccess(resolved.ref, "changed");
          const rows = page.permissions.map(row => AccessCollectionRow.parse({ kind: "collection", datasetId,
            principal: row.principal, appId: row.kind === "app" ? row.principal : null,
            operationIds: row.metadata.operationIds, revision: row.metadata.revision, revisionSha256: row.metadata.revisionSha256, compatible: row.current }));
          return { ref: resolved.ref, rows, visibility: "visible", unknownReason: null, checkedAtMs, freshness: "fresh",
            coverage: { kind: "collection", complete: true, observation: "interval" },
            nextCursor: page.nextCursor ? encodeAccessCursor(scope, page.nextCursor) : null };
        } catch {
          dependencies.assertCurrent(workspace);
          return unknownAccess(resolved.ref, "unreadable", "visible");
        }
      }
      if (resolved.shareId) {
        if (!account) return unknownAccess(resolved.ref, "signed-out");
        if (resolved.relayUrl && account.relayUrl && !relayUrlsMatch(resolved.relayUrl, account.relayUrl))
          return unknownAccess(resolved.ref, "other-server");
        const recipient = resolved.recipientEmail !== undefined ? resolved.recipientEmail : resolved.recipientUserId;
        if (typeof recipient !== "string" || !recipient) return unknownAccess(resolved.ref, "unreadable");
        if (resolved.recipientEmail !== undefined
          ? recipient.toLowerCase() !== account.email.toLowerCase()
          : recipient !== account.userId) return unknownAccess(resolved.ref, "other-account");
        if (!resolved.relayUrl || !account.relayUrl) return unknownAccess(resolved.ref, "unreadable");
      }
      const answer = query.answer({ ref: resolved.ref, shareRoot: resolved.shareRoot, observation: resolved.shareId ? dependencies.received() : dependencies.roster(workspace),
        recipientUserId: account?.userId ?? "", cursorScope: capturedScope,
        coverage: resolved.shareId ? "received-own-grant" : "granted", shareId: resolved.shareId, cursor: input.cursor });
      if (resolved.ended && answer.freshness === "fresh") answer.freshness = "stale";
      return AccessAnswer.parse(answer);
    },
    sharing(workspace: Workspace, input: z.infer<typeof SharingAccessInput>): AccessAnswer {
      dependencies.assertCurrent(workspace);
      const account = dependencies.account();
      if (input.lane === "received") {
        if (!account) return unknownAccess(null, "signed-out");
        if (!account.relayUrl) return unknownAccess(null, "unreadable");
      }
      return AccessAnswer.parse(query.answer({ ref: null, observation: input.lane === "received" ? dependencies.received() : dependencies.roster(workspace),
        recipientUserId: account?.userId ?? "", cursorScope: dependencies.scope(workspace),
        coverage: input.lane === "received" ? "received-account" : "granted", cursor: input.cursor }));
    },
    async refresh(workspace: Workspace): Promise<AccessRefreshResult> {
      dependencies.assertCurrent(workspace);
      const result = await dependencies.refresh(workspace);
      dependencies.assertCurrent(workspace);
      return result.status === "unavailable" && !dependencies.account()
        ? { status: "unavailable", reason: "signed-out" } : result;
    },
  };
}

export function accessCliQueries<Workspace>(owner: Pick<ReturnType<typeof createAccessOwner<Workspace>>, "object" | "sharing" | "refresh">,
  run: <Result>(work: (workspace: Workspace) => Result | Promise<Result>) => Promise<Result>) {
  return { object: (input: { ref: AccessObjectRef; cursor?: string }) => run(workspace => owner.object(workspace, input)),
    sharing: (input: z.infer<typeof SharingAccessInput>) => run(workspace => owner.sharing(workspace, input)),
    refresh: () => run(workspace => owner.refresh(workspace)) };
}

/** The two acquisition owners supply their own pacing and coalescing. */
export function createAccessAcquisition(dependencies: {
  roster(workspaceId: string): Promise<AccessRefreshResult["status"]>;
  received(): Promise<AccessRefreshResult["status"]>;
}) {
  return {
    async request(workspaceId: string): Promise<AccessRefreshResult> {
      const statuses = await Promise.all([dependencies.roster(workspaceId), dependencies.received()]);
      for (const status of ["requested", "joined", "paced"] as const) if (statuses.includes(status)) return { status };
      return { status: "unavailable", reason: "unreadable" };
    },
  };
}

export async function refreshAccessObservations(
  operation: { workspace: { workspaceId: string }; assertCurrent(): void },
  warmCredentials: () => Promise<unknown>,
  acquisition: ReturnType<typeof createAccessAcquisition>,
): Promise<AccessRefreshResult> {
  await warmCredentials().catch(() => undefined);
  operation.assertCurrent();
  return acquisition.request(operation.workspace.workspaceId);
}
