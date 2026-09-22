import { z } from "zod";
import { createHash } from "node:crypto";
import { DatasetInvocationResult, DatasetResult } from "@dohc/cli/dataset";
import type { DatasetRequest } from "@dohc/cli/dataset";
import { parseDatasetDescription, parseDatasetRevision, type AppDatasetBinding, type DatasetDescription, type DatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { AppBackendFile } from "@dohc/security-contract/app-backend";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { LocalDatasetInvocation } from "./localDatasetHost";
import type { CloudCredentials } from "./cloudCredentialStore";
import { credentialScopedOperation } from "./credentialScopedOperation";
import type { DatasetTransferReceipt, DatasetTransferTarget } from "./localDatasetTransfer";

export interface OwnerDatasetData {
  list(input: { after?: string; limit?: number }): Promise<{ datasets: DatasetDescription[]; nextCursor: string | null }>;
  describe(datasetId: string): Promise<DatasetDescription>;
  approvedArtifacts(datasetId: string): Promise<{ revision: DatasetRevision; schemaSql: string; operationSource: string; active: boolean; cursor: DatasetCursor }>;
  invoke(input: LocalDatasetInvocation): Promise<DatasetInvocationResult>;
  upload(input: Extract<DatasetRequest, { action: "upload" }> & { signal?: AbortSignal }): Promise<{ file: AppBackendFile; replayed: boolean }>;
  file(input: Extract<DatasetRequest, { action: "file" }> & { signal?: AbortSignal }): Promise<{ file: AppBackendFile; bytesBase64: string }>;
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
  currentCredentialGeneration(): number; assertCurrent(): void;
  relayJson(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
}): OwnerDatasetData {
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration,
    currentGeneration: input.currentCredentialGeneration, assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const base = `/sync/${encodeURIComponent(input.workspaceId)}/datasets`;
  const path = (datasetId: string) => `${base}/${identity.parse(datasetId)}`;
  const request = (url: string, body?: unknown, signal = input.signal) => session.run(async () => {
    signal.throwIfAborted();
    const value = await input.relayJson(input.credentials, url, { signal, method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    signal.throwIfAborted(); return value;
  });
  return {
    async list(page) {
      const query = new URLSearchParams();
      if (page.after) query.set("after", identity.parse(page.after));
      if (page.limit !== undefined) query.set("limit", String(z.number().int().min(1).max(100).parse(page.limit)));
      const raw = await request(`${base}${query.size ? `?${query}` : ""}`);
      const result = DatasetResult.parse({ ...(raw as object), kind: "list" });
      if (result.kind !== "list" || result.datasets.some((row, index) => row.datasetId <= (index ? result.datasets[index - 1]!.datasetId : page.after ?? "")) ||
        (result.nextCursor !== null && result.nextCursor !== result.datasets.at(-1)?.datasetId)) throw new Error("The Collection list changed. Reload it.");
      return { datasets: result.datasets, nextCursor: result.nextCursor };
    },
    async describe(datasetId) {
      const result = parseDatasetDescription(await request(path(datasetId)));
      if (result.datasetId !== datasetId) throw new Error("The server returned a different Collection.");
      return result;
    },
    async approvedArtifacts(datasetId) {
      const result = artifacts.parse(await request(`${path(datasetId)}/artifacts`));
      verifyDatasetArtifacts(result);
      if (result.revision.datasetId !== datasetId || result.cursor.datasetId !== datasetId || result.cursor.workspaceId !== input.workspaceId ||
        result.cursor.approvedRevisionHash !== result.revision.revisionSha256) throw new Error("The server returned different Collection rules.");
      return result;
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
      }, signal) as object), kind: "uploaded" });
      if (result.kind !== "uploaded") throw new Error("Invalid Collection upload result.");
      const bytes = Buffer.from(upload.bytesBase64, "base64");
      if (result.file.name !== upload.name || result.file.contentType !== upload.contentType || result.file.byteLength !== bytes.byteLength ||
        result.file.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The server returned a different Collection file.");
      return { file: result.file, replayed: result.replayed };
    },
    async file(file) {
      const signal = file.signal ? AbortSignal.any([input.signal, file.signal]) : input.signal;
      const result = DatasetResult.parse({ ...(await request(`${path(file.datasetId)}/file`, {
        revision: file.revision, revisionSha256: file.revisionSha256, fileId: file.fileId,
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
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration, currentGeneration: input.currentCredentialGeneration,
    assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const path = (transferId: string) => `/sync/${encodeURIComponent(input.workspaceId)}/datasets/${encodeURIComponent(identity.parse(input.datasetId))}/imports/${encodeURIComponent(transferId)}`;
  const receipt = (value: unknown): DatasetTransferReceipt | null => {
    if (value === null) return null;
    const result = value as Record<string, unknown>;
    if (!result || typeof result !== "object" || typeof result.transferId !== "string" || typeof result.manifestSha256 !== "string" ||
      !result.sourceCursor || !result.targetCursor) throw new Error("The sharing server returned an invalid transfer receipt.");
    return result as DatasetTransferReceipt;
  };
  return {
    async importRecovery(value) {
      const chunks = value.stream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({ async pull(controller) { try { const item = await chunks.next(); if (item.done) controller.close(); else controller.enqueue(item.value); } catch (error) { controller.error(error); } }, async cancel() { await chunks.return?.(); } });
      const result = await session.run(() => input.relayStream(input.credentials, path(value.transferId), { method: "POST", signal: value.signal ?? input.signal,
        headers: { "content-type": "application/octet-stream", "x-dohc-dataset-manifest-sha256": value.manifestSha256,
          "x-dohc-dataset-source-cursor": JSON.stringify(value.sourceCursor) }, body }));
      return receipt(result)!;
    },
    async status(transferId) {
      const result = await session.run(() => input.relayStream(input.credentials, path(transferId), { method: "GET", signal: input.signal }));
      return receipt(result);
    },
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
  remote(origin: string): Promise<OwnerDatasetData>;
}

/** Routes every operation for a transferred dataset to its target origin. Fenced transfers never fall back locally. */
export function createDatasetAuthorityRouter(local: OwnerDatasetData | Pick<import("./localDatasetHost").LocalDatasetHost, "list" | "describe" | "approvedArtifacts" | "invoke" | "upload" | "file">, route: DatasetAuthorityRoute): OwnerDatasetData {
  const target = async (datasetId: string) => {
    const marker = await route.status(datasetId);
    if (!marker) return local;
    if (marker.state !== "imported" || !marker.receipt) throw new Error("This Collection is transferring. Wait for its shared authority to confirm, then retry.");
    return route.remote(marker.targetOrigin);
  };
  return {
    async list(page) {
      const localPage = await local.list(page), localRows = await Promise.all(localPage.datasets.map(async row => ({ row, authority: await target(row.datasetId) })));
      const remoteRows = await Promise.all(localRows.map(async ({ row, authority }) => authority === local ? row : await authority.describe(row.datasetId)));
      return { datasets: remoteRows, nextCursor: localPage.nextCursor };
    },
    describe: async datasetId => (await target(datasetId)).describe(datasetId),
    approvedArtifacts: async datasetId => (await target(datasetId)).approvedArtifacts(datasetId),
    invoke: async value => (await target(value.datasetId)).invoke(value),
    upload: async value => (await target(value.datasetId)).upload(value),
    file: async value => (await target(value.datasetId)).file(value),
  };
}
