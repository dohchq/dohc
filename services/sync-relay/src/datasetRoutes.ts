import { readBoundedJson } from "@dohc/service-http";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import { isDatasetReopenWaitError, isDatasetWorkerFailure } from "@dohc/app-backend-runtime/supervisor";
import { parseDatasetRevision } from "@dohc/security-contract/dataset";
import { parseDatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import { APP_BACKEND_UPLOAD_REQUEST_BYTES, parseAppBackendJson, parseAppBackendInvokeRequest, parseAppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { RelayDatasetHost } from "./datasetHost";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { AppBackendRoute } from "./appBackendRoutes";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";

export interface DatasetRoute {
  route: "dataset";
  workspaceId: string;
  datasetId?: string;
  transferId?: string;
  named?: boolean;
  action: "list" | "activate" | "describe" | "artifacts" | "invoke" | "prepare-migration" | "approve-migration" | "discard-migration" | "migration-preview-page" | "permissions" | "grant" | "binding" | "upload" | "file" | "history" | "history-revision" | "import" | "export" | "lifecycle" | "archive" | "restore" | "pending-attempts" | "reconcile-attempt" | "cancel-attempt" | "delete-preview" | "delete" | "deletion-status";
}
const headers = {"cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff"};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function datasetId(value: string | undefined): string { if (!value || !uuid.test(value)) throw notFound(); return value; }
function record(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || required.some(key => !Object.hasOwn(raw, key)) ||
      Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key))) throw badRequest("Invalid dataset request.");
  return raw as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.includes("\0") || Buffer.byteLength(value) > max) throw badRequest("Invalid dataset value.");
  return value;
}
function positive(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw badRequest("Invalid dataset revision."); return Number(value); }
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw badRequest("Invalid dataset digest."); return value; }
function input(value: unknown) { try { return parseAppBackendJson(value, 64 * 1024); } catch { throw badRequest("Invalid operation input."); } }
async function json(request: Request, signal: AbortSignal, maximum: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("Dataset requests require JSON.");
  try { return await readBoundedJson(request, maximum, signal); }
  catch (error) { signal.throwIfAborted(); if (error instanceof RangeError) throw relayError("payload_too_large"); throw badRequest("Invalid dataset JSON."); }
}
async function response(run: () => unknown): Promise<Response> {
  try { return Response.json(await run(), {headers}); }
  catch (error) {
    if (isAppBackendRuntimeError(error)) return Response.json({code: error.refusal.code, message: error.refusal.message}, {status: 409, headers});
    if (isDatasetReopenWaitError(error) || isDatasetWorkerFailure(error)) return Response.json({code: error.code, message: error.message},
      {status: 503, headers: {...headers, ...(error.retryAfterMs ? {"retry-after": String(Math.ceil(error.retryAfterMs / 1000))} : {})}});
    if (error instanceof JournalError) throw relayError(error.code === "invalid" ? "bad_request" : "conflict");
    if (error instanceof DatasetHostError) throw relayError(error.code === "not_authorized" ? "not_found" : error.code === "invalid" ? "bad_request" : "conflict");
    throw error;
  }
}

export function createDatasetRoutes(host: RelayDatasetHost, storage: SyncRelayStorage,
  options: {limits?: Partial<AppBackendAdmissionLimits>; nowMs: () => number}) {
  const admit = createAppBackendAdmission(options.limits);
  return async (request: Request, route: DatasetRoute, auth: Extract<AppBackendAuth, {kind: "named"}>): Promise<Response> => {
    if (route.action === "import") {
      if (!route.transferId || !["GET", "POST"].includes(request.method)) throw relayError("method_not_allowed");
      if (!storage.workspaceIsOwnedBy(route.workspaceId, auth.userId)) throw notFound();
      if (new URL(request.url).search) throw badRequest("Dataset imports do not accept a query.");
      const scope = {workspaceId: route.workspaceId, datasetId: route.datasetId!, transferId: route.transferId};
      if (request.method === "GET") return response(() => host.recoveryImportStatus(auth, scope));
      if (request.headers.get("content-type") !== "application/octet-stream" || !request.body) throw badRequest("Dataset import requires a recovery stream.");
      const rawCursor = request.headers.get("x-dohc-dataset-source-cursor");
      if (!rawCursor || Buffer.byteLength(rawCursor) > 1024) throw badRequest("Invalid recovery source cursor.");
      let value; try {value = JSON.parse(rawCursor);} catch {throw badRequest("Invalid recovery source cursor.");}
      const cursor = record(value, ["workspaceId", "datasetId", "hostEpoch", "approvedRevisionHash", "revision", "digest"]);
      if (cursor.workspaceId !== scope.workspaceId || cursor.datasetId !== scope.datasetId || !Number.isSafeInteger(cursor.revision) || Number(cursor.revision) < 0) throw badRequest("Invalid recovery source cursor.");
      const sourceCursor = {workspaceId: scope.workspaceId, datasetId: scope.datasetId, hostEpoch: text(cursor.hostEpoch), approvedRevisionHash: digest(cursor.approvedRevisionHash), revision: Number(cursor.revision), digest: digest(cursor.digest)};
      const manifestSha256 = digest(request.headers.get("x-dohc-dataset-manifest-sha256"));
      const signal = AbortSignal.any([request.signal, storage.unavailable, AbortSignal.timeout(120_000)]);
      const release = admit({dataset: JSON.stringify([scope.workspaceId, scope.datasetId]), participant: auth.userId, organizer: true}, "restore", options.nowMs());
      try {
        const body = request.body;
        async function* stream() {
          const reader = body.getReader();
          const aborted = () => {void reader.cancel().catch(() => {});};
          signal.addEventListener("abort", aborted, {once: true});
          try {
            for (;;) {
              signal.throwIfAborted();
              if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
              const item = await reader.read(); if (item.done) break;
              for (let offset = 0; offset < item.value.byteLength; offset += 1024 * 1024) yield item.value.subarray(offset, offset + 1024 * 1024);
            }
          } finally {signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => {}); reader.releaseLock();}
        }
        return await response(() => host.importRecovery(auth, {...scope, manifestSha256, sourceCursor, stream: stream(), activate: true, signal}));
      } finally {release();}
    }
    const read = ["list", "describe", "artifacts", "permissions", "history", "history-revision", "lifecycle", "pending-attempts", "delete-preview", "deletion-status"].includes(route.action);
    if (request.method !== (read ? "GET" : "POST")) throw relayError("method_not_allowed");
    const query = new URL(request.url).searchParams;
    const allowedQuery = route.action === "history" ? ["beforeRevision", "limit"]
      : route.action === "history-revision" ? ["revisionSha256"]
      : route.action === "list" ? ["after", "limit", "includeArchived"]
      : route.action === "describe" ? ["includeArchived"]
      : route.action === "permissions" || route.action === "lifecycle" || route.action === "pending-attempts" || route.action === "delete-preview" ? ["after", "limit"] : [];
    if ([...query.keys()].some(key => !allowedQuery.includes(key)) || allowedQuery.some(key => query.getAll(key).length > 1) ||
      (query.has("includeArchived") && !["true", "false"].includes(query.get("includeArchived")!))) throw badRequest("Invalid dataset query.");
    const signal = AbortSignal.any([request.signal, storage.unavailable, AbortSignal.timeout(30_000)]);
    const scope = {workspaceId: route.workspaceId, datasetId: route.datasetId!};
    const release = admit({dataset: JSON.stringify([route.workspaceId, route.datasetId ?? "catalog"]), participant: auth.userId,
      organizer: storage.workspaceIsOwnedBy(route.workspaceId, auth.userId)}, route.action, options.nowMs());
    try {
      return await response(async () => {
        signal.throwIfAborted();
        const page = {after: query.has("after") ? text(query.get("after")) : undefined, limit: query.has("limit") ? positive(Number(query.get("limit"))) : undefined};
        if (route.action === "pending-attempts") {
          if (page.after !== undefined && (!/^(0|[1-9][0-9]*)$/.test(page.after) || !Number.isSafeInteger(Number(page.after)))) throw badRequest("Invalid pending attempt cursor.");
          if (page.limit !== undefined && page.limit > 100) throw badRequest("Invalid pending attempt page size.");
          return host.pendingAttempts(auth, {...scope, after: page.after === undefined ? undefined : Number(page.after), limit: page.limit});
        }
        const includeArchived = query.get("includeArchived") === "true";
        if (route.action === "list") return host.list(auth, {workspaceId: route.workspaceId, ...page, includeArchived});
        if (route.action === "describe") return host.describe(auth, {...scope, includeArchived});
        if (route.action === "deletion-status") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          return host.deletionStatus(auth, scope);
        }
        if (route.action === "delete-preview") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          if (page.limit !== undefined && page.limit > 100) throw badRequest("Invalid deletion preview page size.");
          return host.deletePreview(auth, {...scope, ...page});
        }
        if (route.action === "lifecycle") return host.lifecycle(auth, {...scope, ...page});
        if (route.action === "artifacts") return host.approvedArtifacts(auth, scope);
        if (route.action === "permissions") return host.permissions(auth, {...scope, ...page});
        if (route.action === "history-revision") return host.historyRevision(auth, { ...scope, revisionSha256: digest(query.get("revisionSha256")) });
        if (route.action === "history") return host.history(auth, { ...scope, limit: page.limit, beforeRevision: query.has("beforeRevision") ? positive(Number(query.get("beforeRevision"))) : undefined });
        const raw = await json(request, signal, route.action === "upload" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : route.action === "activate" || route.action === "prepare-migration" ? 1024 * 1024 : 128 * 1024);
        if (route.action === "approve-migration" || route.action === "discard-migration" || route.action === "migration-preview-page") {
          const body = record(raw, ["candidateId", ...(route.action === "approve-migration" ? ["checkpointSha256"] : [])], route.action === "migration-preview-page" ? ["after", "limit"] : []);
          const candidate = { ...scope, candidateId: datasetId(text(body.candidateId)), signal };
          if (route.action === "approve-migration") return host.approveMigration(auth, { ...candidate, checkpointSha256: digest(body.checkpointSha256) });
          if (route.action === "discard-migration") { await host.discardMigration(auth, candidate); return { discarded: true }; }
          return host.migrationPreviewPage(auth, { ...candidate, after: body.after === undefined ? undefined : text(body.after, 1024), limit: body.limit === undefined ? undefined : positive(body.limit) });
        }
        if (route.action === "reconcile-attempt" || route.action === "cancel-attempt") {
          const body = record(raw, ["reference", "acknowledge"]);
          if (body.acknowledge !== true) throw badRequest("Attempt reconciliation requires acknowledgment.");
          const input = {...scope, reference: digest(body.reference), acknowledge: true as const};
          return route.action === "cancel-attempt" ? host.cancelAttempt(auth, input) : host.reconcileAttempt(auth, input);
        }
        if (route.action === "delete") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          const body = record(raw, ["expected", "reviewToken", "acknowledge"]);
          if (body.acknowledge !== true) throw badRequest("Permanent deletion requires acknowledgment.");
          const expected = record(body.expected, ["workspaceId", "datasetId", "hostEpoch", "approvedRevisionHash", "revision", "digest"]);
          if (expected.workspaceId !== scope.workspaceId || expected.datasetId !== scope.datasetId || !Number.isSafeInteger(expected.revision) || Number(expected.revision) < 0) throw badRequest("Invalid dataset cursor.");
          return host.deleteDataset(auth, {...scope, acknowledge: true, reviewToken: digest(body.reviewToken), expected: {...scope, hostEpoch: text(expected.hostEpoch),
            approvedRevisionHash: digest(expected.approvedRevisionHash), revision: Number(expected.revision), digest: digest(expected.digest)}});
        }
        if (route.action === "archive" || route.action === "restore") {
          record(raw, []);
          return route.action === "archive" ? host.archiveDataset(auth, scope) : host.restoreDataset(auth, scope);
        }
        if (route.action === "upload") {
          const body = record(raw, ["revision", "revisionSha256", "idempotencyKey", "name", "contentType", "bytesBase64", ...(route.named ? ["fieldId"] : [])]);
          let parsed; try {parsed = parseAppBackendUploadRequest({authorityRevision: positive(body.revision), idempotencyKey: body.idempotencyKey, name: body.name, contentType: body.contentType, bytesBase64: body.bytesBase64});} catch {throw badRequest("Invalid dataset upload.");}
          const {authorityRevision: revision, ...file} = parsed;
          return route.named ? host.dataUpload(auth, {...scope, ...file, revision, revisionSha256: digest(body.revisionSha256), fieldId: datasetId(text(body.fieldId))}, signal)
            : host.ownerUpload(auth, {...scope, ...file, revision, revisionSha256: digest(body.revisionSha256)}, signal);
        }
        if (route.action === "file") {
          const body = record(raw, ["revision", "revisionSha256", "fileId", ...(route.named ? ["read"] : [])]);
          if (route.named) {
            const read = record(body.read, ["operationId", "fieldId", "input"]);
            return host.dataReadFile(auth, {...scope, revision: positive(body.revision), revisionSha256: digest(body.revisionSha256), fileId: text(body.fileId, 128),
              operationId: datasetId(text(read.operationId)), fieldId: datasetId(text(read.fieldId)), input: input(read.input)}, signal);
          }
          return host.ownerReadFile(auth, {...scope, revision: positive(body.revision), revisionSha256: digest(body.revisionSha256), fileId: text(body.fileId, 128)}, signal);
        }
        if (route.action === "activate" || route.action === "prepare-migration") {
          const body = record(raw, ["revision", "schemaSql", "operationSource", ...(route.action === "prepare-migration" ? ["expected", "migrationSql"] : [])], ["capacityBytes"]);
          let revision; try {revision = parseDatasetRevision(body.revision);} catch {throw badRequest("Invalid dataset revision.");}
          if (revision.datasetId !== scope.datasetId) throw badRequest("Dataset identity does not match this route.");
          const input = {...scope, revision, schemaSql: text(body.schemaSql, 256 * 1024), operationSource: text(body.operationSource, 256 * 1024), signal};
          if (route.action === "activate") return host.activate(auth, {...input, ...(body.capacityBytes === undefined ? {} : {capacityBytes: positive(body.capacityBytes)})});
          if (body.capacityBytes !== undefined) throw badRequest("Dataset migrations cannot change capacity through this route.");
          const expected = record(body.expected, ["workspaceId", "datasetId", "hostEpoch", "approvedRevisionHash", "revision", "digest"]);
          if (expected.workspaceId !== scope.workspaceId || expected.datasetId !== scope.datasetId || !Number.isSafeInteger(expected.revision) || Number(expected.revision) < 0) throw badRequest("Invalid dataset cursor.");
          return host.prepareMigration(auth, {...input, migrationSql: text(body.migrationSql, 256 * 1024), expected: {...scope,
            hostEpoch: text(expected.hostEpoch), approvedRevisionHash: digest(expected.approvedRevisionHash), revision: Number(expected.revision), digest: digest(expected.digest)}});
        }
        if (route.action === "invoke") {
          const body = record(raw, ["revision", "revisionSha256", "operationId", "input", "idempotencyKey"]);
          return host.invoke(auth, {...scope, revision: positive(body.revision), revisionSha256: digest(body.revisionSha256), operationId: datasetId(text(body.operationId)),
            input: input(body.input), idempotencyKey: text(body.idempotencyKey, 128), signal});
        }
        if (route.action === "binding") {
          const body = record(raw, ["publicationId", "enabled"]);
          if (typeof body.enabled !== "boolean") throw badRequest("Invalid app binding.");
          const input = {...scope, publicationId: digest(body.publicationId)};
          if (body.enabled) host.bindPublication(auth, input); else host.unbindPublication(auth, input);
          return {ok: true};
        }
        const body = record(raw, ["grant"], ["grantId", "principalKey"]);
        if (Object.hasOwn(body, "principalKey")) {
          if (body.grant !== null || Object.hasOwn(body, "grantId")) throw badRequest("Invalid dataset grant removal.");
          host.removeDataGrant(auth, {...scope, principalKey: text(body.principalKey)});
          return {ok: true};
        }
        let grant = null;
        if (body.grant !== null) {
          const value = record(body.grant, ["operationIds", "discover", "revision", "revisionSha256"]);
          if (!Array.isArray(value.operationIds) || value.operationIds.length > 128 || typeof value.discover !== "boolean") throw badRequest("Invalid dataset grant.");
          grant = {operationIds: value.operationIds.map(value => datasetId(text(value))), discover: value.discover,
            revision: positive(value.revision), revisionSha256: digest(value.revisionSha256)};
        }
        host.setDataGrant(auth, {...scope, grantId: text(body.grantId), grant});
        return {ok: true};
      });
    } finally {release();}
  };
}

export function createDatasetAppRoutes(host: RelayDatasetHost, storage: SyncRelayStorage,
  options: {limits?: Partial<AppBackendAdmissionLimits>; nowMs: () => number}) {
  const admit = createAppBackendAdmission(options.limits);
  return async (request: Request, route: AppBackendRoute, auth: AppBackendAuth): Promise<Response> => {
    const published = host.publication(auth, route.publicationId);
    if (!published) throw notFound();
    const {authority, workspaceId, datasetId, authorityRevision, capability} = published;
    const release = admit({dataset: JSON.stringify([workspaceId, datasetId]), participant: authority.principalKey,
      ...(authority.caller.kind === "link" ? {link: JSON.stringify([workspaceId, authority.caller.grantId])} : {}),
      organizer: authority.caller.kind === "owner"}, route.action, options.nowMs());
    const signal = AbortSignal.any([request.signal, storage.unavailable, AbortSignal.timeout(30_000)]);
    try {
      const get = route.action === "descriptor" || route.action === "blob";
      if (request.method !== (get ? "GET" : "POST")) throw relayError("method_not_allowed");
      const query = new URL(request.url).searchParams;
      if (route.action === "blob") {
        if (auth.kind !== "named" || query.size !== 1 || query.get("authorityRevision") !== String(authorityRevision)) throw notFound();
        const file = published.candidate.files.find(file => file.sha256 === route.sha256);
        if (!file) throw notFound();
        const bytes = storage.getBlob(workspaceId, file.sha256);
        if (!bytes || bytes.byteLength !== file.byteLength) throw notFound();
        signal.throwIfAborted();
        return new Response(Uint8Array.from(bytes), {headers: {...headers, "content-type": file.contentType}});
      }
      if (query.size) throw badRequest("App operations do not accept a query.");
      return await response(async () => {
        signal.throwIfAborted();
        if (route.action === "descriptor") {
          if (auth.kind !== "named") throw notFound();
          return {publicationId: route.publicationId, authorityRevision, files: published.candidate.files};
        }
        const raw = await json(request, signal, route.action === "upload" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : 128 * 1024);
        if (route.action === "attempt") {
          const body = record(raw, ["authorityRevision", "operation", "action"], ["idempotencyKey", "input", "token"]);
          const {authorityRevision: expected, operation, ...attempt} = body;
          let parsed; try { parsed = parseDatasetAttemptRequest(attempt); } catch { throw badRequest("Invalid pending submission request."); }
          return host.attempt(auth, route.publicationId, {authorityRevision: positive(expected), operation: text(operation), request: parsed}, signal);
        }
        if (route.action === "upload") {
          let body; try {body = parseAppBackendUploadRequest(raw);} catch {throw badRequest("Invalid app upload.");}
          return host.upload(auth, route.publicationId, body, signal);
        }
        if (route.action === "file") {
          const body = record(raw, ["authorityRevision", "fileId", "operation", "input"]);
          return host.readFile(auth, route.publicationId, {authorityRevision: positive(body.authorityRevision), fileId: text(body.fileId, 128), operation: text(body.operation), input: input(body.input)}, signal);
        }
        if (route.action === "activate") {
          const body = record(raw, ["authorityRevision"]);
          if (body.authorityRevision !== authorityRevision) throw notFound();
          host.bindPublication(auth, {workspaceId, datasetId, publicationId: route.publicationId});
          return {publicationId: route.publicationId, authorityRevision, datasetId};
        }
        if (route.action !== "invoke") throw notFound();
        let body; try {body = parseAppBackendInvokeRequest(raw);} catch {throw badRequest("Invalid app operation.");}
        if (body.authorityRevision !== authorityRevision) throw notFound();
        const operation = capability.operations.find(operation => operation.name === body.operation);
        if (!operation) throw notFound();
        return host.invoke(auth, {workspaceId, datasetId, revision: capability.revision, revisionSha256: capability.revisionSha256,
          operationId: operation.operationId, input: body.input, idempotencyKey: body.idempotencyKey, access: {kind: "app", appId: route.publicationId}, signal});
      });
    } finally {release();}
  };
}
