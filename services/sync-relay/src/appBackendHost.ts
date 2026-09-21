import { createHash, randomBytes, randomUUID } from "node:crypto";
import { evaluateAppOperation, initializeAppDatabase, validateAppDatabase } from "@dohc/app-backend-runtime";
import { APP_BACKEND_RESULT_BYTES, canInvokeAppBackendOperation, parseAppBackendInvokeRequest, parseAppBackendJson, parseAppBackendUploadRequest,
  type AppBackendInvokeRequest, type AppBackendJson, type AppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { badRequest, notFound, relayError } from "./errors";
import { backendArtifact, requireBackendAuthority, requireBackendOwner, type AppBackendAuth, type BackendAuthority } from "./appBackendAuthority";
import type { StorageContext } from "./storage/context";
import { activateAppBackend, commitAppBackendOperation, exportAppBackend, findAppBackendReceipt, listAppBackendCallerFiles,
  readAppBackendFileInTransaction, readAppBackendSnapshot, restoreAppBackend, setAppBackendHelper, stageAppBackendFile,
  type AppBackendRecoveryBundle, type AppBackendSnapshot } from "./storage/appBackendData";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";
import { targetVersionId, visibleSharePath } from "./shareFilter";

export type { AppBackendAuth } from "./appBackendAuthority";
export interface AppBackendHostOptions {
  storage: StorageContext;
  limits: AppPublicationLimits;
  nowMs: () => number;
  runtime?: { initializeAppDatabase: typeof initializeAppDatabase; evaluateAppOperation: typeof evaluateAppOperation; validateAppDatabase?: typeof validateAppDatabase };
}
export interface AppBackendInvokeResponse { result: AppBackendJson; revision: number; replayed: boolean }
export interface AppBackendReadFileRequest {
  authorityRevision: number;
  fileId: string;
  operation?: string;
  input?: AppBackendJson;
}
export interface AppBackendHelperRequest { authorityRevision: number; grantId: string; enabled: boolean }
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const scope = (authority: BackendAuthority) => ({workspaceId: authority.workspaceId, dataPath: authority.capability.dataPath});
function checkSignal(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function request<T>(parse: (value: unknown) => T, value: unknown): T {
  try { return parse(value); } catch { throw badRequest("Invalid app backend request."); }
}
function sameAuthority(before: BackendAuthority, after: BackendAuthority): void {
  if (JSON.stringify(before.caller) !== JSON.stringify(after.caller) || before.workspaceId !== after.workspaceId ||
      before.candidate.appRoot !== after.candidate.appRoot || JSON.stringify(before.capability) !== JSON.stringify(after.capability)) throw notFound();
}
function activeSnapshot(storage: StorageContext, authority: BackendAuthority): AppBackendSnapshot {
  const snapshot = readAppBackendSnapshot(storage, scope(authority));
  if (!snapshot) throw relayError("conflict", "The owner must activate this app backend first.");
  if (snapshot.publicationId !== authority.publicationId || snapshot.publicationRevision !== authority.authorityRevision ||
      snapshot.appRoot !== authority.candidate.appRoot || snapshot.schemaSha256 !== authority.capability.schemaSha256 ||
      snapshot.schemaVersion !== authority.capability.schemaVersion || snapshot.sourceSha256 !== authority.capability.backendSha256 ||
      snapshot.capabilityJson !== JSON.stringify(authority.capability) || sha(snapshot.source) !== snapshot.sourceSha256) throw notFound();
  return snapshot;
}

export function createAppBackendHost(options: AppBackendHostOptions) {
  const {storage, limits, nowMs} = options;
  const runtime = options.runtime ?? {initializeAppDatabase, evaluateAppOperation};
  const authority = (auth: AppBackendAuth, publicationId: string, revision: number | undefined, enroll = false) =>
    requireBackendAuthority(storage, limits, auth, publicationId, revision, nowMs(), enroll);
  const current = (auth: AppBackendAuth, captured: BackendAuthority, signal?: AbortSignal) => {
    checkSignal(signal);
    const next = authority(auth, captured.publicationId, captured.authorityRevision);
    sameAuthority(captured, next);
    return activeSnapshot(storage, next);
  };

  async function activate(auth: AppBackendAuth, publicationId: string, expectedAuthorityRevision: number, signal?: AbortSignal) {
    signal = signal ? AbortSignal.any([signal, storage.unavailable]) : storage.unavailable;
    checkSignal(signal);
    if (!Number.isSafeInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 1) throw badRequest("Invalid app authority revision.");
    const captured = storage.readTx(() => {
      const value = authority(auth, publicationId, expectedAuthorityRevision);
      requireBackendOwner(value);
      return {authority: value, previous: readAppBackendSnapshot(storage, scope(value)),
        source: backendArtifact(storage, value, value.capability.backendPath, value.capability.backendSha256),
        schemaSql: backendArtifact(storage, value, value.capability.schemaPath, value.capability.schemaSha256)};
    });
    const value = captured.authority;
    if (captured.previous?.publicationId === publicationId && captured.previous.publicationRevision === value.authorityRevision) {
      return {publicationId, authorityRevision: value.authorityRevision, revision: captured.previous.revision};
    }
    if (captured.previous && (captured.previous.appRoot !== value.candidate.appRoot ||
        captured.previous.schemaSha256 !== value.capability.schemaSha256 || captured.previous.schemaVersion !== value.capability.schemaVersion)) {
      throw relayError("conflict", "App schema changes require an explicit migration.");
    }
    const database = captured.previous?.database ?? await runtime.initializeAppDatabase({schemaSql: captured.schemaSql,
      tables: value.capability.tables.map(table => table.name), signal});
    checkSignal(signal);
    const snapshot = activateAppBackend(storage, {...scope(value), appRoot: value.candidate.appRoot,
      publicationId, publicationRevision: value.authorityRevision, schemaSha256: value.capability.schemaSha256,
      schemaVersion: value.capability.schemaVersion, sourceSha256: value.capability.backendSha256, source: captured.source,
      capabilityJson: JSON.stringify(value.capability), database, expectedRevision: captured.previous?.revision ?? null, nowMs: nowMs(),
      authorize() { checkSignal(signal); const next = authority(auth, publicationId, value.authorityRevision); requireBackendOwner(next); sameAuthority(value, next); }});
    return {publicationId, authorityRevision: value.authorityRevision, revision: snapshot.revision};
  }

  async function execute(auth: AppBackendAuth, publicationId: string, input: AppBackendInvokeRequest, signal?: AbortSignal,
    readCommit?: (value: BackendAuthority, result: AppBackendJson) => unknown): Promise<AppBackendInvokeResponse | unknown> {
    signal = signal ? AbortSignal.any([signal, storage.unavailable]) : storage.unavailable;
    checkSignal(signal);
    const parsed = request(parseAppBackendInvokeRequest, input);
    const invocationTime = nowMs(), secret = randomBytes(32).toString("base64url"), requestId = randomUUID();
    // Explicit invocation enrolls an anonymous caller once, before any asynchronous evaluation.
    storage.tx(() => {
      const value = authority(auth, publicationId, parsed.authorityRevision, true);
      activeSnapshot(storage, value);
      const operation = value.capability.operations.find(item => item.name === parsed.operation);
      if (!operation || !canInvokeAppBackendOperation(value.caller, operation) || (readCommit && !operation.readOnly)) throw notFound();
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      checkSignal(signal);
      const captured = storage.readTx(() => {
        const value = authority(auth, publicationId, parsed.authorityRevision);
        const operation = value.capability.operations.find(item => item.name === parsed.operation);
        if (!operation || !canInvokeAppBackendOperation(value.caller, operation) || (readCommit && !operation.readOnly)) throw notFound();
        const snapshot = activeSnapshot(storage, value);
        const receiptScope = {...scope(value), caller: value.receiptCaller, idempotencyKey: parsed.idempotencyKey,
          payloadSha256: sha(JSON.stringify(["dohc-app-operation-v1", publicationId, parsed.operation, parsed.input]))};
        const receipt = operation.readOnly ? null : findAppBackendReceipt(storage, receiptScope);
        const files = operation.readOnly ? [] : listAppBackendCallerFiles(storage, {...scope(value), caller: value.receiptCaller, nowMs: nowMs()});
        return {value, operation, snapshot, receiptScope, receipt, files};
      });
      const {value, snapshot, operation} = captured;
      if (captured.receipt) return {...captured.receipt, result: parseAppBackendJson(captured.receipt.result), replayed: true};
      let evaluated: Awaited<ReturnType<typeof evaluateAppOperation>>;
      try {
        evaluated = await runtime.evaluateAppOperation({source: snapshot.source, database: snapshot.database,
          tables: value.capability.tables.map(table => table.name), operation: parsed.operation, caller: value.caller,
          input: parsed.input, nowMs: invocationTime, requestId, secret, readOnly: operation.readOnly, files: captured.files, signal});
      } catch (error) {
        // An app refusal can contain data read by its code, so it needs the same final authority check as a result.
        const unchanged = storage.readTx(() => current(auth, value, signal).revision === snapshot.revision);
        if (!unchanged) continue;
        throw error;
      }
      const result = parseAppBackendJson(evaluated.result, APP_BACKEND_RESULT_BYTES - 1024);
      checkSignal(signal);
      if (operation.readOnly) {
        if (evaluated.changed || evaluated.attachedFileIds.length) throw badRequest("Read-only app operation changed data.");
        const committed = storage.readTx(() => {
          const next = current(auth, value, signal);
          if (next.revision !== snapshot.revision) return {conflict: true} as const;
          return {conflict: false, result: readCommit ? readCommit(value, result) : {result, revision: snapshot.revision, replayed: false}} as const;
        });
        if (!committed.conflict) return committed.result;
      } else {
        const committed = commitAppBackendOperation(storage, {...captured.receiptScope, expectedRevision: snapshot.revision,
          publicationId, publicationRevision: value.authorityRevision, schemaSha256: value.capability.schemaSha256,
          database: evaluated.database, changeset: evaluated.changeset, result, attachedFileIds: evaluated.attachedFileIds,
          nowMs: nowMs(), authorize() { current(auth, value, signal); }});
        if (committed.kind !== "conflict") return {result: parseAppBackendJson(committed.result), revision: committed.revision, replayed: committed.kind === "replayed"};
      }
    }
    throw relayError("conflict", "App data changed. Retry the operation with the same idempotency key.");
  }

  async function invoke(auth: AppBackendAuth, publicationId: string, input: AppBackendInvokeRequest, signal?: AbortSignal): Promise<AppBackendInvokeResponse> {
    return await execute(auth, publicationId, input, signal) as AppBackendInvokeResponse;
  }
  function upload(auth: AppBackendAuth, publicationId: string, input: AppBackendUploadRequest, signal?: AbortSignal) {
    checkSignal(signal);
    const parsed = request(parseAppBackendUploadRequest, input);
    const content = Buffer.from(parsed.bytesBase64, "base64");
    validateFileSignature(parsed.contentType, content);
    const value = storage.tx(() => {
      const value = authority(auth, publicationId, parsed.authorityRevision, true);
      activeSnapshot(storage, value);
      if (!value.capability.operations.some(operation => !operation.readOnly && canInvokeAppBackendOperation(value.caller, operation))) throw notFound();
      return value;
    });
    const uploadedAt = nowMs();
    return stageAppBackendFile(storage, {...scope(value), caller: value.receiptCaller, idempotencyKey: parsed.idempotencyKey,
        name: parsed.name, contentType: parsed.contentType, content, nowMs: uploadedAt, expiresAtMs: uploadedAt + 86_400_000,
        authorize() { current(auth, value, signal); }});
  }
  async function readFile(auth: AppBackendAuth, publicationId: string, input: AppBackendReadFileRequest, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.fileId)) throw badRequest("Invalid app file.");
    const read = (value: BackendAuthority) => {
      const stored = readAppBackendFileInTransaction(storage, {...scope(value), fileId: input.fileId, authorize() { current(auth, value, signal); }});
      if (!stored) throw notFound();
      const {content, ...file} = stored;
      return {file, bytesBase64: Buffer.from(content).toString("base64")};
    };
    if (!input.operation) return storage.readTx(() => {
      const value = authority(auth, publicationId, input.authorityRevision);
      if (value.caller.kind !== "owner" && !(value.caller.kind === "named" && value.caller.helper && value.caller.access === "edit")) throw notFound();
      return read(value);
    });
    return await execute(auth, publicationId, {authorityRevision: input.authorityRevision, operation: input.operation,
      input: input.input ?? null, idempotencyKey: randomUUID()}, signal, (value, result) => {
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || result.fileId !== input.fileId) throw notFound();
      return read(value);
    }) as ReturnType<typeof read>;
  }
  function describe(auth: AppBackendAuth, publicationId: string, signal?: AbortSignal) {
    checkSignal(signal);
    return storage.readTx(() => {
      const value = authority(auth, publicationId, undefined);
      requireBackendOwner(value);
      const snapshot = readAppBackendSnapshot(storage, scope(value));
      return {publicationId, authorityRevision: value.authorityRevision, capability: value.capability,
        active: snapshot?.publicationId === publicationId && snapshot.publicationRevision === value.authorityRevision,
        revision: snapshot?.revision ?? 0};
    });
  }
  function helper(auth: AppBackendAuth, publicationId: string, input: AppBackendHelperRequest, signal?: AbortSignal) {
    checkSignal(signal);
    if (typeof input.enabled !== "boolean" || typeof input.grantId !== "string") throw badRequest("Invalid app helper.");
    const value = storage.readTx(() => {
      const value = authority(auth, publicationId, input.authorityRevision);
      requireBackendOwner(value);
      activeSnapshot(storage, value);
      return value;
    });
    setAppBackendHelper(storage, {...scope(value), grantId: input.grantId, enabled: input.enabled, nowMs: nowMs(), authorize() {
        current(auth, value, signal);
        if (!input.enabled) return;
        const grant = storage.getShareGrant(input.grantId);
        if (!grant?.principalUserId || grant.principalKind !== "user") throw notFound();
        const allowed = authorizeNamedLiveEditShareGrant({storage, actorUserId: grant.principalUserId, grantId: input.grantId});
        const publicationShare = storage.db.prepare("SELECT share_id FROM sync_relay_app_publications WHERE publication_id=?").get(publicationId);
        if (!allowed.ok || allowed.share.shareId !== publicationShare?.share_id || allowed.share.workspaceId !== value.workspaceId ||
            targetVersionId(allowed.effectiveSelector) !== value.candidate.versionId || visibleSharePath(allowed.effectiveSelector, value.candidate.appRoot) !== value.candidate.appRoot) throw notFound();
      }});
    return {grantId: input.grantId, enabled: input.enabled};
  }
  function exportData(auth: AppBackendAuth, publicationId: string, signal?: AbortSignal) {
    checkSignal(signal);
    const value = storage.readTx(() => {
      const value = authority(auth, publicationId, undefined);
      requireBackendOwner(value);
      return value;
    });
    return exportAppBackend(storage, {...scope(value), authorize() { current(auth, value, signal); }});
  }
  async function restore(auth: AppBackendAuth, publicationId: string, input: {authorityRevision: number; bundle: AppBackendRecoveryBundle}, signal?: AbortSignal) {
    signal = signal ? AbortSignal.any([signal, storage.unavailable]) : storage.unavailable;
    checkSignal(signal);
    if (!Number.isSafeInteger(input.authorityRevision) || input.authorityRevision < 1) throw badRequest("Invalid app authority revision.");
    const captured = storage.readTx(() => {
      const value = authority(auth, publicationId, input.authorityRevision);
      requireBackendOwner(value);
      if (readAppBackendSnapshot(storage, scope(value))) throw relayError("conflict", "Recovery cannot replace existing app data.");
      return {value, source: backendArtifact(storage, value, value.capability.backendPath, value.capability.backendSha256),
        schemaSql: backendArtifact(storage, value, value.capability.schemaPath, value.capability.schemaSha256)};
    });
    const {value} = captured;
    const snapshot = await restoreAppBackend(storage, {...scope(value), appRoot: value.candidate.appRoot, publicationId,
      publicationRevision: value.authorityRevision, schemaSha256: value.capability.schemaSha256, schemaVersion: value.capability.schemaVersion,
      sourceSha256: value.capability.backendSha256, source: captured.source, capabilityJson: JSON.stringify(value.capability),
      expectedRevision: null, nowMs: nowMs(), bundle: input.bundle,
      validateDatabase: database => (options.runtime?.validateAppDatabase ?? validateAppDatabase)({database,
        schemaSql: captured.schemaSql, tables: value.capability.tables.map(table => table.name), signal}),
      authorize() { checkSignal(signal); const next = authority(auth, publicationId, value.authorityRevision); requireBackendOwner(next); sameAuthority(value, next); }});
    return {publicationId, authorityRevision: value.authorityRevision, revision: snapshot.revision};
  }
  function descriptor(auth: AppBackendAuth, publicationId: string, signal?: AbortSignal) {
    checkSignal(signal);
    return storage.readTx(() => {
      const value = authority(auth, publicationId, undefined);
      if (value.caller.kind !== "owner" && !(value.caller.kind === "named" && value.caller.helper && value.caller.access === "edit")) throw notFound();
      activeSnapshot(storage, value);
      return {publicationId, authorityRevision: value.authorityRevision,
        files: value.candidate.files.filter(file => file.path !== value.capability.backendPath && file.path !== value.capability.schemaPath)};
    });
  }
  function blob(auth: AppBackendAuth, publicationId: string, sha256: string, authorityRevision: number, signal?: AbortSignal) {
    checkSignal(signal);
    return storage.readTx(() => {
      const value = authority(auth, publicationId, authorityRevision);
      if (value.caller.kind !== "owner" && !(value.caller.kind === "named" && value.caller.helper && value.caller.access === "edit")) throw notFound();
      activeSnapshot(storage, value);
      const file = value.candidate.files.find(file => file.sha256 === sha256 && file.path !== value.capability.backendPath && file.path !== value.capability.schemaPath);
      if (!file) throw notFound();
      const bytes = storage.getBlob(value.workspaceId, sha256);
      if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== sha256) throw notFound();
      return {file, bytes};
    });
  }
  return {activate, invoke, upload, readFile, describe, helper, export: exportData, restore, descriptor, blob};
}
export type AppBackendHost = ReturnType<typeof createAppBackendHost>;

function validateFileSignature(contentType: string, bytes: Uint8Array): void {
  const starts = (expected: number[]) => expected.every((value, index) => bytes[index] === value);
  if ((contentType === "image/png" && !starts([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (contentType === "image/jpeg" && !starts([255, 216, 255])) ||
      (contentType === "application/pdf" && !starts([37, 80, 68, 70, 45]))) throw badRequest("File content does not match its type.");
}
