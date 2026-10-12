import { createHash } from "node:crypto";
import { z } from "zod";
import { AccessAnswer, AccessCollectionRow, AccessObjectRef, type SharingAccessInput } from "@dohc/workspace-contracts/access";
import { DatasetPermissionsPage } from "@dohc/cli/dataset";
import { createAccessQuery, decodeAccessCursor, encodeAccessCursor, unknownAccess } from "./accessQuery";
import type { RosterObservation } from "../automations/shareRoster";
import type { ReceivedObservation } from "../workspaces/receivedShareStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";

export function ownerAccessRoster(
  workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "shareView">,
  credentials: CloudCredentials | null,
  observation: (workspaceId: string) => RosterObservation,
): RosterObservation {
  // The server/account matcher ignores relayUrl; a missing relay must stay unknown, matching account().
  if (workspace.shareView || !workspace.remote || !credentials?.relayUrl ||
      !workspaceRemoteMatchesCredentials(workspace.remote, credentials)) return { listing: null, checkedAtMs: null, freshness: "unknown" };
  return observation(workspace.workspaceId);
}

export type ResolvedAccessObject = { ref: AccessObjectRef; visibility: "visible" | "hidden" | "missing" | "unknown";
  shareId?: string; shareRoot?: boolean; ended?: boolean; relayUrl?: string; recipientUserId?: string; recipientEmail?: string | null };

/** Main supplies physical resolution and authority routing. These observations never admit a write. */
export function createAccessOwner<Workspace>(dependencies: {
  resolve(workspace: Workspace, ref: AccessObjectRef): Promise<ResolvedAccessObject>;
  roster(workspace: Workspace): RosterObservation;
  received(): ReceivedObservation;
  account(): { userId: string; email: string; relayUrl: string; generation: number } | null;
  scope(workspace: Workspace): string;
  assertCurrent(workspace: Workspace): void;
  permissions(workspace: Workspace, datasetId: string, after?: string): Promise<unknown>;
  refresh(workspace: Workspace): Promise<void>;
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
      catch { dependencies.assertCurrent(workspace); return unknownAccess(ref); }
      dependencies.assertCurrent(workspace);
      if (!accountIsCurrent()) return unknownAccess(resolved.ref);
      if (resolved.visibility !== "visible") return unknownAccess(resolved.ref, resolved.visibility);
      if (resolved.ref.kind === "collection") {
        const checkedAtMs = nowMs();
        const datasetId = resolved.ref.datasetId;
        const scope = createHash("sha256").update(JSON.stringify([capturedScope, resolved.ref])).digest("hex");
        let after: string | undefined;
        if (input.cursor) {
          const decoded = decodeAccessCursor(input.cursor, scope);
          if (decoded === null) return unknownAccess(resolved.ref);
          after = decoded;
        }
        try {
          const page = DatasetPermissionsPage.parse(await dependencies.permissions(workspace, datasetId, after));
          dependencies.assertCurrent(workspace);
          if (!accountIsCurrent()) return unknownAccess(resolved.ref);
          const rows = page.permissions.map(row => AccessCollectionRow.parse({ kind: "collection", datasetId,
            principal: row.principal, appId: row.kind === "app" ? row.principal : null,
            operationIds: row.metadata.operationIds, revision: row.metadata.revision, revisionSha256: row.metadata.revisionSha256, compatible: row.current }));
          return { ref: resolved.ref, rows, visibility: "visible", checkedAtMs, freshness: "fresh",
            coverage: { kind: "collection", complete: true, observation: "interval" },
            nextCursor: page.nextCursor ? encodeAccessCursor(scope, page.nextCursor) : null };
        } catch {
          dependencies.assertCurrent(workspace);
          return unknownAccess(resolved.ref, "visible");
        }
      }
      if (resolved.shareId && (!account || resolved.relayUrl !== account.relayUrl ||
          (resolved.recipientEmail !== undefined
            ? typeof resolved.recipientEmail !== "string" || !resolved.recipientEmail || resolved.recipientEmail.toLowerCase() !== account.email.toLowerCase()
            : typeof resolved.recipientUserId !== "string" || !resolved.recipientUserId || resolved.recipientUserId !== account.userId))) return unknownAccess(resolved.ref);
      const answer = query.answer({ ref: resolved.ref, shareRoot: resolved.shareRoot, observation: resolved.shareId ? dependencies.received() : dependencies.roster(workspace),
        recipientUserId: account?.userId ?? "", cursorScope: capturedScope,
        coverage: resolved.shareId ? "received-own-grant" : "granted", shareId: resolved.shareId, cursor: input.cursor });
      if (resolved.ended && answer.freshness === "fresh") answer.freshness = "stale";
      return AccessAnswer.parse(answer);
    },
    sharing(workspace: Workspace, input: z.infer<typeof SharingAccessInput>): AccessAnswer {
      dependencies.assertCurrent(workspace);
      const account = dependencies.account();
      if (input.lane === "received" && !account) return unknownAccess(null);
      return AccessAnswer.parse(query.answer({ ref: null, observation: input.lane === "received" ? dependencies.received() : dependencies.roster(workspace),
        recipientUserId: account?.userId ?? "", cursorScope: dependencies.scope(workspace),
        coverage: input.lane === "received" ? "received-account" : "granted", cursor: input.cursor }));
    },
    async refresh(workspace: Workspace): Promise<void> { await dependencies.refresh(workspace); dependencies.assertCurrent(workspace); },
  };
}

export function accessCliQueries<Workspace>(owner: Pick<ReturnType<typeof createAccessOwner<Workspace>>, "object" | "sharing">,
  run: <Result>(work: (workspace: Workspace) => Result | Promise<Result>) => Promise<Result>) {
  return { object: (input: { ref: AccessObjectRef; cursor?: string }) => run(workspace => owner.object(workspace, input)),
    sharing: (input: z.infer<typeof SharingAccessInput>) => run(workspace => owner.sharing(workspace, input)) };
}

/** The two acquisition owners supply their own pacing and coalescing. */
export function createAccessAcquisition(dependencies: {
  roster(workspaceId: string): Promise<void>; received(): Promise<void>;
}) {
  return {
    request(workspaceId: string): Promise<void> {
      return Promise.all([dependencies.roster(workspaceId), dependencies.received()]).then(() => undefined);
    },
  };
}
