import { z } from "zod";
import { createHash } from "node:crypto";
import { DatasetCursor as CursorSchema, DatasetInvocationResult, DatasetResult, DatasetPermissionsPage, DatasetHistoryPage, DatasetHistoryRevision, DatasetLifecyclePage, DatasetLifecycleState, DatasetPendingAttemptsPage, DatasetMigrationCandidate, DatasetMigrationPreviewPage , DatasetDeletePreview, DatasetDeleted } from "@dohc/cli/dataset";
import type { DatasetRequest } from "@dohc/cli/dataset";
import { parseDatasetDescription, parseDatasetRevision, type AppDatasetBinding, type DatasetDescription, type DatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { AppBackendFile } from "@dohc/security-contract/app-backend";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { LocalDatasetInvocation } from "./localDatasetHost";
import type { CloudCredentials } from "./cloudCredentialStore";
import { credentialScopedOperation } from "./credentialScopedOperation";
import { RELAY_FETCH_TIMEOUT_MS } from "./sharedChannels";
import type { DatasetTransferReceipt, DatasetTransferTarget } from "./localDatasetTransfer";
import type { createDatasetHost } from "@dohc/app-backend-runtime/dataset-host";

type RuntimeDatasetHost = ReturnType<typeof createDatasetHost>;

export interface OwnerDatasetData {
  prepareMigrationCandidate?(input: Parameters<RuntimeDatasetHost["prepareMigration"]>[1]): Promise<DatasetMigrationCandidate>;
  approveMigrationCandidate?(input: Parameters<RuntimeDatasetHost["approveMigration"]>[1]): ReturnType<RuntimeDatasetHost["approveMigration"]>;
  migrationPreviewPage?(input: Parameters<RuntimeDatasetHost["migrationPreviewPage"]>[1]): Promise<DatasetMigrationPreviewPage>;
  discardMigrationCandidate?(input: Parameters<RuntimeDatasetHost["discardMigration"]>[1]): Promise<void>;
  inspect?(datasetId: string, options?: { includeArchived?: boolean }): Promise<{ dataset: DatasetDescription; copy?: import("@dohc/cli/dataset").DatasetCopyStatus }>;
  historyRevision?(input: { datasetId: string; revisionSha256: string }): Promise<DatasetHistoryRevision>;
  history(input: { datasetId: string; beforeRevision?: number; limit?: number }): Promise<DatasetHistoryPage>;
  list(input: { after?: string; limit?: number; includeArchived?: boolean }): Promise<{ datasets: DatasetDescription[]; nextCursor: string | null }>;
  describe(datasetId: string, input?: { includeArchived?: boolean }): Promise<DatasetDescription>;
  lifecycle?(input: { datasetId: string; after?: string; limit?: number }): Promise<DatasetLifecyclePage>;
  deletionStatus?(input: { datasetId: string }): Promise<{ deleted: boolean }>;
  deletePreview?(input: { datasetId: string; after?: string; limit?: number }): Promise<DatasetDeletePreview>;
  deleteDataset?(input: { datasetId: string; expected: DatasetCursor; reviewToken: string; acknowledge: true }): Promise<DatasetDeleted>;
  archive?(input: { datasetId: string }): Promise<DatasetLifecycleState>;
  restore?(input: { datasetId: string }): Promise<DatasetLifecycleState>;
  pendingAttempts?(input: { datasetId: string; after?: number; limit?: number }): Promise<DatasetPendingAttemptsPage>;
  reconcileAttempt?(input: { datasetId: string; reference: string; acknowledge: true }): Promise<{ cleared: true }>;
  cancelAttempt?(input: { datasetId: string; reference: string; acknowledge: true }): Promise<{ cancelled: true }>;
  approvedArtifacts(datasetId: string): Promise<{ revision: DatasetRevision; schemaSql: string; operationSource: string; active: boolean; cursor: DatasetCursor }>;
  invoke(input: LocalDatasetInvocation): Promise<DatasetInvocationResult>;
  upload(input: Extract<DatasetRequest, { action: "upload" }> & { signal?: AbortSignal }): Promise<{ file: AppBackendFile; replayed: boolean }>;
  file(input: Extract<DatasetRequest, { action: "file" }> & { signal?: AbortSignal }): Promise<{ file: AppBackendFile; bytesBase64: string }>;
  permissions?(input: Extract<DatasetRequest, { action: "permissions" }>): Promise<DatasetPermissionsPage>;
  setGrant?(input: Extract<DatasetRequest, { action: "setGrant" | "removeGrant" }>): Promise<void>;
}
const identity = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const artifacts = z.object({
  revision: z.unknown().transform(value => parseDatasetRevision(value)),
  schemaSql: z.string().min(1).max(256 * 1024), operationSource: z.string().min(1).max(256 * 1024), active: z.boolean(),
  cursor: z.object({ workspaceId: z.string().min(1), datasetId: identity, hostEpoch: z.string().min(1), approvedRevisionHash: sha256,
    revision: z.number().int().nonnegative(), digest: sha256 }).strict(),
}).strict();

/** A remote authority is never replaced by a local fallback when the server is unavailable. */
export function createRemoteDatasetData(input: {
  workspaceId: string; credentials: CloudCredentials; credentialGeneration: number; signal: AbortSignal;
  /** Main derives this from the pinned share-view marker, never a renderer request. */
  shareId?: string;
  currentCredentialGeneration(): number; assertCurrent(): void;
  relayJson(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
}): OwnerDatasetData {
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration,
    currentGeneration: input.currentCredentialGeneration, assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const base = input.shareId === undefined ? `/sync/${encodeURIComponent(input.workspaceId)}/datasets` : `/sync/shares/${encodeURIComponent(input.shareId)}/datasets`;
  const path = (datasetId: string) => `${base}/${identity.parse(datasetId)}`;
  const confirmationSignal = () => AbortSignal.any([input.signal, AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS)]);
  const request = (url: string, body?: unknown, signal = input.signal) => session.run(async () => {
    signal.throwIfAborted();
    const value = await input.relayJson(input.credentials, url, { signal, method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    signal.throwIfAborted(); return value;
  });
  return {
    async lifecycle(value) {
      const query = new URLSearchParams(); if(value.after)query.set("after",value.after); if(value.limit)query.set("limit",String(value.limit));
      return DatasetLifecyclePage.parse(await request(`${path(value.datasetId)}/lifecycle${query.size ? `?${query}` : ""}`));
    },
    async deletionStatus(value) {
      if (input.shareId !== undefined) throw new Error("Open the original workspace to manage this Collection.");
      return z.object({ deleted: z.boolean() }).strict().parse(await request(`${path(value.datasetId)}/deletion-status`, undefined, confirmationSignal()));
    },
    async deletePreview(value) {
      if (input.shareId !== undefined) throw new Error("Open the original workspace to delete this Collection.");
      const query = new URLSearchParams();
      if (value.after !== undefined) query.set("after", z.string().min(1).max(256).parse(value.after));
      if (value.limit !== undefined) query.set("limit", String(z.number().int().min(1).max(100).parse(value.limit)));
      const result = DatasetDeletePreview.parse(await request(`${path(value.datasetId)}/delete-preview${query.size ? `?${query}` : ""}`));
      if (result.cursor.workspaceId !== input.workspaceId || result.cursor.datasetId !== value.datasetId ||
          result.apps.some((app, index) => app.binding.datasetId !== value.datasetId || app.appId <= (index ? result.apps[index - 1]!.appId : value.after ?? "")) ||
          result.nextCursor !== null && result.nextCursor !== result.apps.at(-1)?.appId) throw new Error("The deletion review changed. Review this Collection again.");
      return result;
    },
    async deleteDataset(value) {
      if (input.shareId !== undefined) throw new Error("Open the original workspace to delete this Collection.");
      const expected = CursorSchema.parse(value.expected);
      if (expected.workspaceId !== input.workspaceId || expected.datasetId !== value.datasetId) throw new Error("This deletion belongs to another Collection.");
      z.literal(true).parse(value.acknowledge);
      const result = DatasetDeleted.parse(await request(`${path(value.datasetId)}/delete`, { expected, reviewToken: sha256.parse(value.reviewToken), acknowledge: true }, confirmationSignal()));
      if (result.datasetId !== value.datasetId) throw new Error("The server did not confirm this Collection deletion. Refresh the Collection.");
      return result;
    },
    async archive(value) { return DatasetLifecycleState.parse(await request(`${path(value.datasetId)}/archive`, {})); },
    async restore(value) { return DatasetLifecycleState.parse(await request(`${path(value.datasetId)}/restore`, {})); },
    async pendingAttempts(value) {
      const query = new URLSearchParams(); if(value.after !== undefined)query.set("after",String(value.after)); if(value.limit)query.set("limit",String(value.limit));
      const result = DatasetPendingAttemptsPage.parse(await request(`${path(value.datasetId)}/pending-attempts${query.size ? `?${query}` : ""}`));
      if (result.datasetId !== value.datasetId || result.nextAfter !== null && result.nextAfter <= (value.after ?? 0)) throw new Error("The server returned a different pending submission page.");
      return result;
    },
    async reconcileAttempt(value) { return z.object({ cleared: z.literal(true) }).strict().parse(await request(`${path(value.datasetId)}/reconcile-attempt`, { reference: value.reference, acknowledge: value.acknowledge })); },
    async cancelAttempt(value) { return z.object({ cancelled: z.literal(true) }).strict().parse(await request(`${path(value.datasetId)}/cancel-attempt`, { reference: value.reference, acknowledge: value.acknowledge })); },
    async permissions(value) {
      const query = new URLSearchParams();
      if (value.after) query.set("after", value.after);
      if (value.limit) query.set("limit", String(value.limit));
      return DatasetPermissionsPage.parse(await request(`${path(value.datasetId)}/permissions${query.size ? `?${query}` : ""}`));
    },
    async setGrant(value) {
      const result = await request(`${path(value.datasetId)}/grants`, value.action === "setGrant"
        ? { grantId: value.grantId, grant: value.grant } : { principalKey: value.principalKey, grant: null });
      z.object({ ok: z.literal(true) }).strict().parse(result);
    },
    async historyRevision(value) {
      if (input.shareId !== undefined) throw new Error("Open the original workspace to inspect Collection rules.");
      const result = DatasetHistoryRevision.parse(await request(`${path(value.datasetId)}/history-revision?revisionSha256=${sha256.parse(value.revisionSha256)}`));
      verifyDatasetArtifacts(result);
      if (result.revision.datasetId !== value.datasetId || result.revision.revisionSha256 !== value.revisionSha256) throw new Error("The server returned another Collection revision.");
      return result;
    },
    async history(page) {
      const query = new URLSearchParams();
      if (page.beforeRevision !== undefined) query.set("beforeRevision", String(z.number().int().positive().parse(page.beforeRevision)));
      if (page.limit !== undefined) query.set("limit", String(z.number().int().min(1).max(100).parse(page.limit)));
      const result = DatasetHistoryPage.parse(await request(`${path(page.datasetId)}/history${query.size ? `?${query}` : ""}`));
      if (result.datasetId !== page.datasetId || result.entries.some((row, index) => row.revision >= (index ? result.entries[index - 1]!.revision : page.beforeRevision ?? Number.MAX_SAFE_INTEGER)) ||
        result.nextBeforeRevision !== null && result.nextBeforeRevision !== result.entries.at(-1)?.revision) throw new Error("The server returned an invalid Collection history page.");
      return result;
    },
    async list(page) {
      const query = new URLSearchParams();
      if (page.includeArchived !== undefined) query.set("includeArchived", String(page.includeArchived));
      if (page.after) query.set("after", identity.parse(page.after));
      if (page.limit !== undefined) query.set("limit", String(z.number().int().min(1).max(100).parse(page.limit)));
      const raw = await request(`${base}${query.size ? `?${query}` : ""}`);
      const result = DatasetResult.parse({ ...(raw as object), kind: "list" });
      if (result.kind !== "list" || result.datasets.some((row, index) => row.datasetId <= (index ? result.datasets[index - 1]!.datasetId : page.after ?? "")) ||
        (result.nextCursor !== null && result.nextCursor !== result.datasets.at(-1)?.datasetId)) throw new Error("The Collection list changed. Reload it.");
      return { datasets: result.datasets, nextCursor: result.nextCursor };
    },
    async describe(datasetId, options) {
      const result = parseDatasetDescription(await request(`${path(datasetId)}${options?.includeArchived ? "?includeArchived=true" : ""}`));
      if (result.datasetId !== datasetId) throw new Error("The server returned a different Collection.");
      return result;
    },
    async approvedArtifacts(datasetId) {
      if (input.shareId !== undefined) throw new Error("Only the Collection owner can read its approved source.");
      const result = artifacts.parse(await request(`${path(datasetId)}/artifacts`));
      verifyDatasetArtifacts(result);
      if (result.revision.datasetId !== datasetId || result.cursor.datasetId !== datasetId || result.cursor.workspaceId !== input.workspaceId ||
        result.cursor.approvedRevisionHash !== result.revision.revisionSha256) throw new Error("The server returned different Collection rules.");
      return result;
    },
    async prepareMigrationCandidate(value) {
      if (input.shareId !== undefined) throw new Error("Only the Collection owner can change its rules.");
      if (value.workspaceId !== input.workspaceId || value.expected.workspaceId !== input.workspaceId || value.expected.datasetId !== value.revision.datasetId) throw new Error("This change belongs to another Collection.");
      verifyDatasetArtifacts(value);
      const signal = value.signal ? AbortSignal.any([input.signal, value.signal]) : input.signal;
      const raw = await request(`${path(value.revision.datasetId)}/prepare-migration`, {
        revision: value.revision, schemaSql: value.schemaSql, operationSource: value.operationSource,
        expected: value.expected, migrationSql: value.migrationSql,
      }, signal);
      const result = DatasetMigrationCandidate.parse(raw);
      if (result.approvedRevisionHash !== value.revision.revisionSha256 || Object.keys(value.expected).some(key => result.expected[key as keyof typeof result.expected] !== value.expected[key as keyof typeof value.expected])) {
        throw new Error("The server returned a different Collection review. Prepare the change again.");
      }
      return result;
    },
    async approveMigrationCandidate(value) {
      if (input.shareId !== undefined || value.workspaceId !== input.workspaceId) throw new Error("Only the Collection owner can change its rules.");
      const signal = value.signal ? AbortSignal.any([input.signal, value.signal]) : input.signal;
      const raw = await request(`${path(value.datasetId)}/approve-migration`, { candidateId: value.candidateId, checkpointSha256: value.checkpointSha256 }, signal);
      const result = DatasetResult.parse({ ...(raw as object), kind: "migrated" });
      if (result.kind !== "migrated" || result.revision.datasetId !== value.datasetId || result.cursor.workspaceId !== input.workspaceId || result.cursor.datasetId !== value.datasetId || result.cursor.approvedRevisionHash !== result.revision.revisionSha256) {
        throw new Error("The server did not confirm this Collection change. Refresh the Collection before reviewing it again.");
      }
      return { revision: result.revision, cursor: result.cursor };
    },
    async migrationPreviewPage(value) {
      if (input.shareId !== undefined || value.workspaceId !== input.workspaceId) throw new Error("Only the Collection owner can review its data changes.");
      const signal = value.signal ? AbortSignal.any([input.signal, value.signal]) : input.signal;
      return DatasetMigrationPreviewPage.parse(await request(`${path(value.datasetId)}/migration-preview-page`, { candidateId: value.candidateId, after: value.after, limit: value.limit }, signal));
    },
    async discardMigrationCandidate(value) {
      if (input.shareId !== undefined || value.workspaceId !== input.workspaceId) throw new Error("Only the Collection owner can review its data changes.");
      const signal = value.signal ? AbortSignal.any([input.signal, value.signal]) : input.signal;
      z.object({ discarded: z.literal(true) }).strict().parse(await request(`${path(value.datasetId)}/discard-migration`, { candidateId: value.candidateId }, signal));
    },
    async invoke(invocation) {
      const { datasetId, revision, revisionSha256, operationId, idempotencyKey } = invocation;
      const signal = invocation.signal ? AbortSignal.any([input.signal, invocation.signal]) : input.signal;
      return DatasetInvocationResult.parse(await request(`${path(datasetId)}/invoke`,
        { revision, revisionSha256, operationId, input: invocation.input, idempotencyKey }, signal));
    },
    async upload(upload) {
      const signal = upload.signal ? AbortSignal.any([input.signal, upload.signal]) : input.signal;
      const result = DatasetResult.parse({ ...(await request(`${path(upload.datasetId)}/upload`, {
        revision: upload.revision, revisionSha256: upload.revisionSha256, idempotencyKey: upload.idempotencyKey,
        name: upload.name, contentType: upload.contentType, bytesBase64: upload.bytesBase64,
        ...(input.shareId !== undefined ? { fieldId: upload.fieldId } : {}),
      }, signal) as object), kind: "uploaded" });
      if (result.kind !== "uploaded") throw new Error("Invalid Collection upload result.");
      const bytes = Buffer.from(upload.bytesBase64, "base64");
      if (result.file.name !== upload.name || result.file.contentType !== upload.contentType || result.file.byteLength !== bytes.byteLength ||
        result.file.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The server returned a different Collection file.");
      return { file: result.file, replayed: result.replayed };
    },
    async file(file) {
      if (input.shareId !== undefined && !file.read) throw new Error("Choose an approved Collection read action to open this file.");
      const signal = file.signal ? AbortSignal.any([input.signal, file.signal]) : input.signal;
      const result = DatasetResult.parse({ ...(await request(`${path(file.datasetId)}/file`, {
        revision: file.revision, revisionSha256: file.revisionSha256, fileId: file.fileId,
        ...(input.shareId !== undefined ? { read: file.read } : {}),
      }, signal) as object), kind: "file" });
      if (result.kind !== "file") throw new Error("Invalid Collection file result.");
      const bytes = Buffer.from(result.bytesBase64, "base64");
      if (result.file.fileId !== file.fileId || bytes.toString("base64") !== result.bytesBase64 || result.file.byteLength !== bytes.byteLength ||
        result.file.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The server returned a different Collection file.");
      return { file: result.file, bytesBase64: result.bytesBase64 };
    },
  };
}

/** Owner-authenticated streaming target for the durable local-to-shared transfer coordinator. */
export function createRemoteDatasetTransferTarget(input: {
  workspaceId: string; datasetId: string; origin: string; credentials: CloudCredentials; credentialGeneration: number;
  currentCredentialGeneration(): number; signal: AbortSignal; assertCurrent(): void;
  relayStream(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
}): DatasetTransferTarget & { status(transferId: string): Promise<DatasetTransferReceipt | null> } {
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Choose a configured sharing server.");
  if (!input.credentials.relayUrl || new URL(input.credentials.relayUrl).origin !== origin.origin) throw new Error("Reconnect to this Collection's sharing server before transferring it.");
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration, currentGeneration: input.currentCredentialGeneration,
    assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const path = (transferId: string) => `/sync/${encodeURIComponent(input.workspaceId)}/datasets/${identity.parse(input.datasetId)}/imports/${identity.parse(transferId)}`;
  const receiptSchema = z.object({ transferId: identity, manifestSha256: sha256, sourceCursor: CursorSchema, targetCursor: CursorSchema }).strict();
  const receipt = (value: unknown, transferId: string): DatasetTransferReceipt | null => {
    if (value === null) return null;
    const result = receiptSchema.parse(value);
    if (result.transferId !== transferId || result.sourceCursor.workspaceId !== input.workspaceId || result.targetCursor.workspaceId !== input.workspaceId ||
      result.sourceCursor.datasetId !== input.datasetId || result.targetCursor.datasetId !== input.datasetId) throw new Error("The sharing server returned another transfer receipt.");
    return result;
  };
  const status = async (transferId: string, signal = input.signal) => receipt(await session.run(() => input.relayStream(input.credentials,
    path(transferId), { method: "GET", signal })), transferId);
  return {
    async importRecovery(value) {
      const signal = value.signal ? AbortSignal.any([input.signal, value.signal]) : input.signal;
      signal.throwIfAborted();
      if (value.sourceCursor.workspaceId !== input.workspaceId || value.sourceCursor.datasetId !== input.datasetId) throw new Error("This transfer belongs to another Collection.");
      const confirmed = await status(value.transferId, signal);
      if (confirmed) return confirmed;
      const chunks = value.stream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({ async pull(controller) { try { signal.throwIfAborted(); session.assertCurrent(); const item = await chunks.next(); if (item.done) controller.close(); else controller.enqueue(item.value); } catch (error) { controller.error(error); } }, async cancel() { await chunks.return?.(); } });
      try {
      const request: RequestInit & { duplex: "half" } = { method: "POST", signal, duplex: "half",
        headers: { "content-type": "application/octet-stream", "x-dohc-dataset-manifest-sha256": value.manifestSha256,
          "x-dohc-dataset-source-cursor": JSON.stringify(value.sourceCursor) }, body };
      const result = await session.run(() => input.relayStream(input.credentials, path(value.transferId), request));
      const confirmed = receipt(result, value.transferId);
      if (!confirmed) throw new Error("The sharing server did not confirm this transfer.");
      return confirmed;
      } catch (error) {
        signal.throwIfAborted(); session.assertCurrent();
        const confirmed = await status(value.transferId, signal).catch(() => null);
        if (confirmed) return confirmed;
        throw error;
      } finally { await chunks.return?.(); }
    },
    status,
  };
}

export async function resolveRemoteDatasetRevision(data: Pick<OwnerDatasetData, "approvedArtifacts">, binding: AppDatasetBinding): Promise<DatasetRevision> {
  const approved = await data.approvedArtifacts(binding.datasetId);
  if (!approved.active || approved.revision.revision !== binding.revision || approved.revision.revisionSha256 !== binding.revisionSha256) {
    throw new Error("Collection rules changed. Reload the Collection and prepare the app again.");
  }
  return approved.revision;
}

export interface DatasetAuthorityRoute {
  /** Returns the durable local transfer marker; absent means this dataset is local. */
  status(datasetId: string): Promise<import("./localDatasetTransfer").DatasetTransferStatus | null>;
  remote(origin: string, datasetId: string): Promise<OwnerDatasetData>;
}

/** Routes every operation for a transferred dataset to its target origin. Fenced transfers never fall back locally. */
export function createDatasetAuthorityRouter(local: OwnerDatasetData | Pick<import("./localDatasetHost").LocalDatasetHost, "list" | "describe" | "approvedArtifacts" | "prepareMigrationCandidate" | "approveMigrationCandidate" | "discardMigrationCandidate" | "migrationPreviewPage" | "invoke" | "upload" | "file" | "history" | "historyRevision" | "lifecycle" | "archive" | "restore" | "deletePreview" | "deleteDataset" | "deletionStatus" | "pendingAttempts" | "reconcileAttempt" | "cancelAttempt">, route: DatasetAuthorityRoute): OwnerDatasetData {
  const target = async (datasetId: string) => {
    const marker = await route.status(datasetId);
    if (!marker) return local;
    if (marker.state !== "imported" || !marker.receipt) throw new Error("This Collection is transferring. Wait for its shared authority to confirm, then retry.");
    return route.remote(marker.targetOrigin, datasetId);
  };
  return {
    async list(page) {
      const limit = page.limit ?? 50, datasets: DatasetDescription[] = []; let after = page.after;
      // Local rows index transferred identities, including ones archived before transfer.
      // Fetch authority metadata before deciding whether an identity belongs in this view.
      for (let scannedPages = 0; ; scannedPages++) {
        const localPage = await local.list({ after, limit, includeArchived: true });
        for (let index = 0; index < localPage.datasets.length; index++) {
          const row = localPage.datasets[index]!, authority = await target(row.datasetId);
          after = row.datasetId;
          if (authority !== local && authority.deletionStatus && (await authority.deletionStatus({ datasetId: row.datasetId })).deleted) continue;
          const current = authority === local ? row : await authority.describe(row.datasetId, { includeArchived: true });
          if (!page.includeArchived && current.archived) continue;
          datasets.push(current);
          if (datasets.length === limit) return { datasets, nextCursor: index + 1 < localPage.datasets.length || localPage.nextCursor ? after : null };
        }
        if (!localPage.nextCursor) return { datasets, nextCursor: null };
        if (localPage.nextCursor <= (page.after ?? "") || localPage.nextCursor !== localPage.datasets.at(-1)?.datasetId) throw new Error("The Collection list changed. Reload it.");
        if (scannedPages === 3) return { datasets, nextCursor: localPage.nextCursor };
        after = localPage.nextCursor;
      }
    },
    describe: async (datasetId, options) => (await target(datasetId)).describe(datasetId, options),
    deletionStatus: async value => { const authority = await target(value.datasetId); if (!authority.deletionStatus) throw new Error("Collection deletion status is unavailable. Update dohc and try again."); return authority.deletionStatus(value); },
    deletePreview: async value => { const authority = await target(value.datasetId); if (!authority.deletePreview) throw new Error("Collection deletion is unavailable. Update dohc and try again."); return authority.deletePreview(value); },
    deleteDataset: async value => { const authority = await target(value.datasetId); if (!authority.deleteDataset) throw new Error("Collection deletion is unavailable. Update dohc and try again."); return authority.deleteDataset(value); },
    lifecycle: async value => { const authority = await target(value.datasetId); if (!authority.lifecycle) throw new Error("Collection archive controls are unavailable."); return authority.lifecycle(value); },
    archive: async value => { const authority = await target(value.datasetId); if (!authority.archive) throw new Error("Collection archive controls are unavailable."); return authority.archive(value); },
    restore: async value => { const authority = await target(value.datasetId); if (!authority.restore) throw new Error("Collection restore controls are unavailable."); return authority.restore(value); },
    pendingAttempts: async value => { const authority = await target(value.datasetId); if (!authority.pendingAttempts) throw new Error("Pending submission review is unavailable."); return authority.pendingAttempts(value); },
    reconcileAttempt: async value => { const authority = await target(value.datasetId); if (!authority.reconcileAttempt) throw new Error("Pending submission review is unavailable."); return authority.reconcileAttempt(value); },
    cancelAttempt: async value => { const authority = await target(value.datasetId); if (!authority.cancelAttempt) throw new Error("Pending submission cancellation is unavailable."); return authority.cancelAttempt(value); },
    inspect: async (datasetId, options) => {
      const authority = await target(datasetId);
      return "inspect" in authority && authority.inspect ? authority.inspect(datasetId, options) : { dataset: await authority.describe(datasetId, options) };
    },
    historyRevision: async value => { const authority = await target(value.datasetId); if (!authority.historyRevision) throw new Error("Saved Collection rules are unavailable. Update the host and try again."); return authority.historyRevision(value); },
    history: async value => (await target(value.datasetId)).history(value),
    approvedArtifacts: async datasetId => (await target(datasetId)).approvedArtifacts(datasetId),
    prepareMigrationCandidate: async value => {
      const authority = await target(value.revision.datasetId);
      if (!authority.prepareMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host.");
      return authority.prepareMigrationCandidate(value);
    },
    approveMigrationCandidate: async value => { const authority = await target(value.datasetId); if (!authority.approveMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host."); return authority.approveMigrationCandidate(value); },
    migrationPreviewPage: async value => { const authority = await target(value.datasetId); if (!authority.migrationPreviewPage) throw new Error("Collection rule changes are unavailable on this host."); return authority.migrationPreviewPage(value); },
    discardMigrationCandidate: async value => { const authority = await target(value.datasetId); if (!authority.discardMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host."); return authority.discardMigrationCandidate(value); },
    invoke: async value => (await target(value.datasetId)).invoke(value),
    upload: async value => (await target(value.datasetId)).upload(value),
    file: async value => (await target(value.datasetId)).file(value),
    permissions: async value => {
      const authority = await target(value.datasetId);
      if (!("permissions" in authority) || !authority.permissions) throw new Error("Publish this Collection before managing shared access.");
      return authority.permissions(value);
    },
    setGrant: async value => {
      const authority = await target(value.datasetId);
      if (!("setGrant" in authority) || !authority.setGrant) throw new Error("Publish this Collection before managing shared access.");
      await authority.setGrant(value);
    },
  };
}
