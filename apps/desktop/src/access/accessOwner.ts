import { createHash } from "node:crypto";
import { z } from "zod";
import { AccessAnswer, AccessCollectionRow, AccessObjectRef, type SharingAccessInput } from "@dohc/workspace-contracts/access";
import { DatasetPermissionsPage } from "@dohc/cli/dataset";
import { createAccessQuery, unknownAccess } from "./accessQuery";
import type { RosterObservation } from "../automations/shareRoster";
import type { ReceivedObservation } from "../workspaces/receivedShareStore";

export type ResolvedAccessObject = { ref: AccessObjectRef; visibility: "visible" | "hidden" | "missing" | "unknown";
  shareId?: string; shareRoot?: boolean; ended?: boolean; relayUrl?: string; recipientUserId?: string };
const PermissionCursor = z.object({ version: z.literal(1), scope: z.string(), after: z.string().max(1024) }).strict();

/** Main supplies physical resolution and authority routing. These observations never admit a write. */
export function createAccessOwner<Workspace>(dependencies: {
  resolve(workspace: Workspace, ref: AccessObjectRef): Promise<ResolvedAccessObject>;
  roster(workspace: Workspace): RosterObservation;
  received(): ReceivedObservation;
  account(): { userId: string; relayUrl: string } | null;
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
      const ref = AccessObjectRef.parse(input.ref);
      let resolved: ResolvedAccessObject;
      try { resolved = await dependencies.resolve(workspace, ref); }
      catch { dependencies.assertCurrent(workspace); return unknownAccess(ref); }
      dependencies.assertCurrent(workspace);
      if (capturedScope !== dependencies.scope(workspace)) return unknownAccess(resolved.ref);
      if (resolved.visibility !== "visible") return unknownAccess(resolved.ref, resolved.visibility);
      if (resolved.ref.kind === "collection") {
        const checkedAtMs = nowMs();
        const scope = createHash("sha256").update(JSON.stringify([dependencies.scope(workspace), resolved.ref])).digest("hex");
        let after: string | undefined;
        if (input.cursor) {
          try {
            const cursor = PermissionCursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
            if (cursor.scope !== scope) return unknownAccess(resolved.ref);
            after = cursor.after;
          } catch { return unknownAccess(resolved.ref); }
        }
        try {
          const page = DatasetPermissionsPage.parse(await dependencies.permissions(workspace, resolved.ref.datasetId, after));
          dependencies.assertCurrent(workspace);
          if (capturedScope !== dependencies.scope(workspace)) return unknownAccess(resolved.ref);
          const rows = page.permissions.map(row => AccessCollectionRow.parse({ kind: "collection", datasetId: resolved.ref.kind === "collection" ? resolved.ref.datasetId : "",
            principal: row.principal, appId: row.kind === "app" ? row.principal : null,
            operationIds: row.metadata.operationIds, revision: row.metadata.revision, revisionSha256: row.metadata.revisionSha256, compatible: row.current }));
          return { ref: resolved.ref, rows, visibility: "visible", checkedAtMs, freshness: "fresh",
            coverage: { kind: "collection", complete: true, observation: "interval" },
            nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({ version: 1, scope, after: page.nextCursor })).toString("base64url") : null };
        } catch {
          dependencies.assertCurrent(workspace);
          return unknownAccess(resolved.ref, "visible");
        }
      }
      const account = dependencies.account();
      if (resolved.shareId && (!account || resolved.relayUrl !== account.relayUrl ||
          resolved.recipientUserId !== undefined && resolved.recipientUserId !== account.userId)) return unknownAccess(resolved.ref);
      const answer = query.answer({ ref: resolved.ref, shareRoot: resolved.shareRoot, observation: resolved.shareId ? dependencies.received() : dependencies.roster(workspace),
        recipientUserId: account?.userId ?? "", cursorScope: dependencies.scope(workspace),
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

/** One surface request feeds the two existing paced acquisition owners and coalesces concurrent callers. */
export function createAccessAcquisition(dependencies: {
  roster(workspaceId: string): Promise<void>; received(): Promise<void>; context(workspaceId: string): unknown;
}) {
  const pending = new Map<string, { context: unknown; promise: Promise<void> }>();
  return {
    request(workspaceId: string): Promise<void> {
      const context = dependencies.context(workspaceId), existing = pending.get(workspaceId);
      if (existing && existing.context === context) return existing.promise;
      const promise = Promise.all([dependencies.roster(workspaceId), dependencies.received()]).then(() => undefined).finally(() => {
        if (pending.get(workspaceId)?.promise === promise) pending.delete(workspaceId);
      });
      pending.set(workspaceId, { context, promise });
      return promise;
    },
  };
}
