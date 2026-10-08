import { prepareCollectionRecord } from "@dohc/automation-executor/collection-record-edits";
import { parseCollectionRecordIdentity, parseCollectionSchema } from "@dohc/workspace-contracts";
import { ShareUnavailableError, SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { CreateCollectionRecordPayload } from "../ipc/bridgeContract";
import type { ShareViewFiles, ShareViewFilesTarget, ResolvedShareViewFilesTarget } from "./shareViewFiles";
import { recordedShareSelector } from "./shareViewRecords";
import type { ShareViewSelector } from "./shareViewInfo";
import type { WorkspaceOperationLease } from "./workspaceAssets";
import type { CreationPartial } from "@dohc/cli/creation";

export interface ReceivedRecordDraft {
  path: string;
  recordId: string;
  delivery: "pending" | "accepted" | "refused";
  reason?: string;
}

/** A record is journaled before any delivery. Retries reuse its file and journal position. */
export async function createReceivedShareRecord(input: CreateCollectionRecordPayload, host: {
  target: ShareViewFilesTarget;
  resolved: ResolvedShareViewFilesTarget;
  collectionPath: string;
  files: Pick<ShareViewFiles, "read" | "change">;
  checkAuthority(): Promise<ShareViewSelector | null>;
  recordStatus(path: string): Promise<{ state: "pending" | "accepted" | "refused"; originalRecordId?: string; reason?: string } | null>;
  assertCurrent(): void;
  withLease<T>(work: (lease: WorkspaceOperationLease) => Promise<T>): Promise<T>;
  shareViewEdited(): void;
}): Promise<ReceivedRecordDraft | CreationPartial> {
  const { resolved } = host;
  const covers = (grant: ShareViewSelector | null) => grant?.access === "edit" && grant.versionId === null
    && grant.paths.some(root => host.collectionPath === root || host.collectionPath.startsWith(`${root}/`));
  if (resolved.kind !== "standalone") throw new Error("Open this share as a workspace to create a record.");
  if (resolved.ended || !resolved.shareId) throw new ShareUnavailableError();
  if (!covers(recordedShareSelector(resolved.grantedSelector))) {
    throw new SharedFileReadOnlyError("This Collection does not have Edit access.");
  }
  let prepared = prepareCollectionRecord({ ...input, collectionPath: host.collectionPath });
  // A missing connection permits a local draft. A server refusal never does.
  const live = await host.checkAuthority();
  host.assertCurrent();
  if (live !== null && !covers(live)) throw new SharedFileReadOnlyError("This Collection does not have Edit access.");
  const schema = await host.files.read(host.target, { kind: "text", path: `${host.collectionPath}/collection.yaml` });
  if (schema.kind !== "text" || schema.truncated || parseCollectionSchema(schema.text).status !== "valid") {
    throw new Error("This Collection does not have a current document schema.");
  }
  let existing: string | null = null;
  for (let suffix = 1; ; suffix++) {
    try {
      const read = await host.files.read(host.target, { kind: "text", path: prepared.path });
      existing = read.kind === "text" && !read.truncated ? parseCollectionRecordIdentity(read.text) ?? "" : "";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      existing = null;
    }
    host.assertCurrent();
    if (existing === null || input.recordId !== undefined) break;
    prepared = prepareCollectionRecord({ ...input, collectionPath: host.collectionPath,
      recordId: prepared.recordId, name: `${input.name ?? "Untitled"} ${suffix + 1}` });
  }
  const visiblePath = prepared.path;
  const status = existing !== null && input.recordId !== undefined ? await host.recordStatus(prepared.path) : null;
  const repaired = existing !== null && existing !== "" && input.recordId !== undefined && existing !== input.recordId
    && status?.state === "accepted" && status.originalRecordId === input.recordId;
  if (existing !== null && (input.recordId === undefined || existing !== input.recordId) && !repaired) {
    throw new Error(`${prepared.path} already exists. Choose another record name.`);
  }
  if (existing === null) {
    const outcome = await host.withLease(async lease => {
      host.assertCurrent();
      const outcome = await host.files.change(lease, host.target, { kind: "create", path: prepared.path, initialText: prepared.text });
      return outcome;
    });
    if (outcome.status !== "committed") {
      host.shareViewEdited();
      return { kind: "partial", created: outcome.status === "partial"
        && outcome.effects.some(effect => effect.path === prepared.path && effect.before === "absent" && effect.after === "present") ? [visiblePath] : [],
        failedStage: "write", reason: outcome.message,
        retry: { mode: "resume", recordId: prepared.recordId,
          instruction: "Try again with the same record ID to check this draft without creating another record." } };
    }
  }
  host.assertCurrent();
  host.shareViewEdited();
  return { path: visiblePath, recordId: repaired ? existing! : prepared.recordId, delivery: status?.state ?? "pending",
    ...(status?.reason ? { reason: status.reason } : {}) };
}
