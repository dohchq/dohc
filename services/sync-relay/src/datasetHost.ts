import { createHash, randomUUID } from "node:crypto";
import { createDatasetHost, DatasetHostError, type DatasetAuthority, type DatasetAccess, type DatasetHostOptions, type DatasetDataGrant } from "@dohc/app-backend-runtime/dataset-host";
import type { AppBackendJson, AppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { createDatasetSupervisor, type DatasetSupervisorOptions } from "@dohc/app-backend-runtime/supervisor";
import { parseDatasetRevision, verifyAppDatasetCapability, type AppDatasetCapability } from "@dohc/security-contract/dataset";
import { parseAppPublicationCandidate, type AppPublicationCandidate, type AppPublicationLimits } from "@dohc/security-contract/app-publication";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { StorageContext } from "./storage/context";
import { assertWorkspaceQuota } from "./storage/workspaces";
import { requireLinkAppPublication } from "./storage/publications";
import { readLinkEnrollment, linkWriteRefusal } from "./storage/linkEnrollment";
import { authorizeShareGrantAction, authorizeShareAction } from "./shareAuthorization";
import { effectiveShareSelector, parseStoredAnyShareSelectorJson, targetVersionId, visibleSharePath } from "./shareFilter";
import { notFound } from "./errors";
import { createDatasetFiles } from "./storage/datasetFiles";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const principalKey = (workspaceId: string, grantId: string, userId: string) => hash(JSON.stringify(["dohc-dataset-principal-v1", workspaceId, grantId, userId]));
export interface RelayDatasetHostOptions {
  storage: StorageContext;
  directory: string;
  limits: AppPublicationLimits;
  nowMs?: () => number;
  runtime?: DatasetSupervisorOptions["runtime"];
  maxWorkers?: number;
  compileOperations?: DatasetHostOptions<AppBackendAuth>["compileOperations"];
  onShutdownError(error: unknown): void;
}

/** The existing relay connection owns every authoritative dataset transaction. */
export async function createRelayDatasetHost(options: RelayDatasetHostOptions) {
  const {storage, limits} = options, nowMs = options.nowMs ?? Date.now;
  const standing = storage.captureStanding();
  const transaction = <T>(run: () => T): T => storage.tx(run);
  const journal = createDatasetJournal({db: storage.db, transaction, nowMs});
  storage.tx(() => storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_dataset_usage (
    workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, storage_bytes INTEGER NOT NULL CHECK(storage_bytes>=0),
    PRIMARY KEY(workspace_id,dataset_id),
    FOREIGN KEY(workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
  ) STRICT;`));
  const supervisor = await createDatasetSupervisor({journal, directory: options.directory, runtime: options.runtime,
    maxWorkers: options.maxWorkers, nowMs});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      storage.unavailable.removeEventListener("abort", unavailable);
      closing = supervisor.close();
    }
    return closing;
  };
  const unavailable = () => { void close().catch(error => options.onShutdownError(error)); };
  storage.unavailable.addEventListener("abort", unavailable, {once: true});
  if (storage.unavailable.aborted) { await close(); standing(); }

  function current(): void { standing(); if (closing) throw new Error("Dataset host is closed."); }
  function account(workspaceId: string, datasetId: string, bytes: number, create = false): void {
    current();
    if (!Number.isSafeInteger(bytes)) throw new Error("Invalid dataset allocation.");
    assertWorkspaceQuota(storage, workspaceId, bytes);
    if (create) storage.db.prepare("INSERT INTO sync_relay_dataset_usage VALUES(?,?,?)").run(workspaceId, datasetId, bytes);
    else {
      const changed = storage.db.prepare("UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes+? WHERE workspace_id=? AND dataset_id=?")
        .run(bytes, workspaceId, datasetId);
      if (Number(changed.changes) !== 1) throw new Error("Dataset usage counter is missing.");
    }
    const changed = storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(bytes, workspaceId);
    if (Number(changed.changes) !== 1) throw new Error("Workspace usage counter is missing.");
  }
  function owner(auth: AppBackendAuth, workspaceId: string): DatasetAuthority {
    current();
    if (auth.kind !== "named" || auth.workspaceId !== workspaceId || !storage.workspaceIsOwnedBy(workspaceId, auth.userId)) throw notFound();
    return {caller: {kind: "owner", userId: auth.userId}, principalKey: principalKey(workspaceId, "owner", auth.userId)};
  }
  function named(workspaceId: string, grantId: string, userId: string): DatasetAuthority {
    const result = authorizeShareGrantAction({storage, grantId, principalKind: "user", principalUserId: userId, action: "read"});
    if (!result.ok || result.share.workspaceId !== workspaceId || !["view", "comment", "edit"].includes(result.grant.access)) throw notFound();
    return {caller: {kind: "named", userId, grantId, access: result.grant.access as "view" | "comment" | "edit", helper: false},
      principalKey: principalKey(workspaceId, grantId, userId),
      authorityToken: hash(JSON.stringify([result.grant.generation, result.share.selectorJson]))};
  }
  function namedPublication(auth: Extract<AppBackendAuth, {kind: "named"}>, publicationId: string) {
    const row = storage.db.prepare("SELECT * FROM sync_relay_app_publications WHERE workspace_id=? AND publication_id=?").get(auth.workspaceId, publicationId);
    if (!row || row.active !== 1 || !storage.workspaceIsOwnedBy(auth.workspaceId, String(row.owner_user_id))) throw notFound();
    const bytes = storage.getBlob(auth.workspaceId, String(row.manifest_sha256));
    if (!bytes || bytes.byteLength > limits.maxMetadataBytes || hash(bytes) !== row.manifest_sha256) throw notFound();
    const candidate = parseAppPublicationCandidate(JSON.parse(Buffer.from(bytes).toString("utf8")), limits);
    const share = storage.getShare(String(row.share_id)), grant = storage.getShareGrant(String(row.grant_id));
    const parsed = share && parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector = parsed && grant && effectiveShareSelector(parsed, grant.access);
    if (!share || !grant || share.workspaceId !== auth.workspaceId || share.granterUserId !== row.owner_user_id ||
        grant.shareId !== share.shareId || grant.status !== "active" || grant.revokedAtMs !== null || grant.generation !== row.grant_generation ||
        !selector || "kind" in selector || targetVersionId(selector) !== candidate.versionId || visibleSharePath(selector, candidate.appRoot) !== candidate.appRoot ||
        candidate.inputs.some(file => visibleSharePath(selector, file.path) !== file.path)) throw notFound();
    const publicationOwner = {workspaceId: auth.workspaceId, shareId: share.shareId, grantId: grant.grantId, generation: grant.generation, ownerUserId: String(row.owner_user_id)};
    if (hash(JSON.stringify(["dohc-app-publication-v1", publicationOwner, hash(JSON.stringify(candidate))])) !== publicationId) throw notFound();
    if (auth.userId === row.owner_user_id) return {candidate, authorityRevision: Number(row.authority_revision), authority: {...owner(auth, auth.workspaceId), authorityToken: String(row.authority_revision)}};
    const authorized = authorizeShareAction({storage, actorUserId: auth.userId, shareId: share.shareId, action: "read"});
    const grantId = auth.grantId ?? (authorized.ok ? authorized.grant.grantId : undefined);
    if (!grantId) throw notFound();
    const authority = named(auth.workspaceId, grantId, auth.userId);
    const namedGrant = storage.getShareGrant(grantId);
    const namedSelector = parsed && namedGrant && effectiveShareSelector(parsed, namedGrant.access);
    if (!namedGrant || namedGrant.shareId !== share.shareId || !namedSelector || "kind" in namedSelector ||
        targetVersionId(namedSelector) !== candidate.versionId || visibleSharePath(namedSelector, candidate.appRoot) !== candidate.appRoot) throw notFound();
    return {candidate, authorityRevision: Number(row.authority_revision), authority: {...authority, authorityToken: hash(JSON.stringify([authority.authorityToken, row.authority_revision]))}};
  }
  function capability(candidate: AppPublicationCandidate, workspaceId: string, datasetId: string): AppDatasetCapability {
    const row = storage.db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(workspaceId, datasetId);
    if (!row) throw notFound();
    const requested = candidate.capabilities.find(value => value.kind === "dataset" && value.datasetId === datasetId);
    if (!requested) throw notFound();
    return verifyAppDatasetCapability(requested, parseDatasetRevision(JSON.parse(String(row.revision_json))));
  }
  function app(auth: AppBackendAuth, workspaceId: string, datasetId: string, appId: string) {
    current();
    let candidate: AppPublicationCandidate, authority: DatasetAuthority;
    if (auth.kind === "link") {
      const published = requireLinkAppPublication(storage, {...auth, publicationId: appId, limits, nowMs: nowMs()});
      if (published.workspaceId !== workspaceId) throw notFound();
      const enrollment = readLinkEnrollment(storage, auth, nowMs());
      if (!enrollment || linkWriteRefusal(enrollment)) throw notFound();
      candidate = published.candidate;
      authority = {caller: {kind: "link", grantId: published.result.grantId,
        principalId: `dataset_${hash(JSON.stringify([workspaceId, datasetId, published.result.grantId, auth.profileTokenHash]))}`},
        principalKey: principalKey(workspaceId, published.result.grantId, auth.profileTokenHash),
        authorityToken: hash(JSON.stringify([published.result.generation, published.result.descriptor.authorityRevision]))};
    } else {
      if (auth.workspaceId !== workspaceId) throw notFound();
      ({candidate, authority} = namedPublication(auth, appId));
    }
    return {capability: capability(candidate, workspaceId, datasetId), authority: {...authority, appId}};
  }
  function resolveAuthority(auth: AppBackendAuth, request: {workspaceId: string; datasetId?: string; access: DatasetAccess}): DatasetAuthority {
    current();
    if (request.access.kind === "app") {
      if (!request.datasetId) throw notFound();
      return app(auth, request.workspaceId, request.datasetId, request.access.appId).authority;
    }
    if (auth.kind !== "named" || auth.workspaceId !== request.workspaceId) throw notFound();
    if (storage.workspaceIsOwnedBy(auth.workspaceId, auth.userId)) return owner(auth, auth.workspaceId);
    if (!auth.grantId) throw notFound();
    return named(auth.workspaceId, auth.grantId, auth.userId);
  }
  function publication(auth: AppBackendAuth, publicationId: string) {
    current();
    let candidate: AppPublicationCandidate, workspaceId: string, authorityRevision: number;
    if (auth.kind === "link") {
      const published = requireLinkAppPublication(storage, {...auth, publicationId, limits, nowMs: nowMs()});
      candidate = published.candidate; workspaceId = published.workspaceId; authorityRevision = published.result.descriptor.authorityRevision;
    } else {
      const published = namedPublication(auth, publicationId);
      candidate = published.candidate; workspaceId = auth.workspaceId; authorityRevision = published.authorityRevision;
    }
    const requested = candidate.capabilities.find(value => value.kind === "dataset");
    if (!requested) return null;
    const verified = app(auth, workspaceId, requested.datasetId, publicationId);
    return {workspaceId, datasetId: requested.datasetId, authorityRevision, capability: verified.capability, authority: verified.authority, candidate};
  }
  try {
    const files = createDatasetFiles(storage, account, nowMs);
    const host = createDatasetHost<AppBackendAuth>({db: storage.db, transaction, journal, supervisor, resolveAuthority, compileOperations: options.compileOperations,
      accountCreation(_auth, allocation) { account(allocation.workspaceId, allocation.datasetId, allocation.bytes, true); },
      accountMigration(_auth, allocation) { account(allocation.workspaceId, allocation.datasetId, allocation.bytes); },
      accountCheckpointStage(_auth, allocation) { account(allocation.scope.workspaceId, allocation.scope.datasetId, allocation.bytes); },
      accountMetadata(_auth, allocation) { account(allocation.workspaceId, allocation.datasetId, allocation.bytes); },
      operationResources(_auth, request) { return files.resources(request, request.authority, request.input); },
    });
    storage.tx(() => storage.db.exec(`DROP TRIGGER IF EXISTS sync_relay_dataset_delete;
      CREATE TRIGGER sync_relay_dataset_delete
      AFTER DELETE ON sync_relay_dataset_usage BEGIN
        DELETE FROM dohc_dataset_bindings WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_data_grants WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_catalog WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_catalog_history WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_receipts WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_events WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_checkpoint_history WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_journals WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_checkpoint_chunks WHERE stage_id IN (
          SELECT stage_id FROM dohc_dataset_checkpoints WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_checkpoints WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id;
      END;`));
    return {
      activate(auth: AppBackendAuth, input: Parameters<typeof host.activate>[1]) {
        return host.activate(auth, {...input, signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])])});
      },
      migrate(auth: AppBackendAuth, input: Parameters<typeof host.migrate>[1]) {
        return host.migrate(auth, {...input, signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])])});
      },
      describe: host.describe, list: host.list, approvedArtifacts: host.approvedArtifacts, permissions: host.permissions, publication,
      invoke(auth: AppBackendAuth, input: Parameters<typeof host.invoke>[1]) {
        return host.invoke(auth, {...input, signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])])});
      },
      upload(auth: AppBackendAuth, publicationId: string, input: AppBackendUploadRequest, signal?: AbortSignal) {
        const published = publication(auth, publicationId);
        if (!published || published.authorityRevision !== input.authorityRevision) throw notFound();
        const {workspaceId, datasetId, capability} = published;
        const scope = {workspaceId, datasetId, revision: capability.revision, revisionSha256: capability.revisionSha256, access: {kind: "app" as const, appId: publicationId}};
        let permitted: ReturnType<typeof host.authorize> | undefined;
        for (const operation of capability.operations.filter(operation => !operation.readOnly)) {
          try { permitted = host.authorize(auth, {...scope, operationId: operation.operationId}); break; }
          catch (error) { if (!(error instanceof DatasetHostError) || error.code !== "not_authorized") throw error; }
        }
        if (!permitted) throw notFound();
        const captured = permitted;
        return files.upload(scope, captured.authority, input, () => {
          signal?.throwIfAborted(); current();
          const checked = host.authorize(auth, {...scope, operationId: captured.operation.operationId});
          if (JSON.stringify(checked.authority) !== JSON.stringify(captured.authority)) throw notFound();
          const head = storage.db.prepare("SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(workspaceId, datasetId);
          if (!head || head.active !== 1 || head.approved_revision_hash !== scope.revisionSha256) throw notFound();
        });
      },
      ownerUpload(auth: AppBackendAuth, input: Omit<AppBackendUploadRequest, "authorityRevision"> & {workspaceId: string; datasetId: string; revision: number; revisionSha256: string}, signal?: AbortSignal) {
        const scope = {workspaceId: input.workspaceId, datasetId: input.datasetId};
        const authorize = () => {
          signal?.throwIfAborted(); const authority = owner(auth, input.workspaceId);
          const description = host.describe(auth, scope);
          const head = storage.db.prepare("SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(scope.workspaceId, scope.datasetId);
          if (!head || head.active !== 1 || head.approved_revision_hash !== input.revisionSha256 || description.revision !== input.revision || description.revisionSha256 !== input.revisionSha256) throw new DatasetHostError("conflict", "Dataset revision is stale. Reload it before uploading.");
          return authority;
        };
        return files.upload(scope, authorize(), {authorityRevision: input.revision, idempotencyKey: input.idempotencyKey, name: input.name, contentType: input.contentType, bytesBase64: input.bytesBase64}, authorize);
      },
      ownerReadFile(auth: AppBackendAuth, input: {workspaceId: string; datasetId: string; revision: number; revisionSha256: string; fileId: string}, signal?: AbortSignal) {
        return storage.tx(() => {
          owner(auth, input.workspaceId); signal?.throwIfAborted();
          const description = host.describe(auth, input);
          if (description.revision !== input.revision || description.revisionSha256 !== input.revisionSha256) throw new DatasetHostError("conflict", "Dataset revision is stale. Reload it before reading.");
          return files.readOwner(input, input.fileId);
        });
      },
      readFile(auth: AppBackendAuth, publicationId: string, input: {authorityRevision: number; fileId: string; operation: string; input: AppBackendJson}, signal?: AbortSignal) {
        const published = publication(auth, publicationId);
        if (!published || published.authorityRevision !== input.authorityRevision) throw notFound();
        const {workspaceId, datasetId, capability} = published, operation = capability.operations.find(operation => operation.name === input.operation);
        if (!operation?.readOnly) throw notFound();
        host.authorize(auth, {workspaceId, datasetId, revision: capability.revision, revisionSha256: capability.revisionSha256, operationId: operation.operationId, access: {kind: "app", appId: publicationId}});
        return host.readOperation(auth, {workspaceId, datasetId, revision: capability.revision, revisionSha256: capability.revisionSha256,
          operationId: operation.operationId, input: input.input, idempotencyKey: randomUUID(), access: {kind: "app", appId: publicationId},
          signal: AbortSignal.any([storage.unavailable, ...(signal ? [signal] : [])])}, result => files.readAttached({workspaceId, datasetId}, input.fileId, result));
      },
      bindPublication(auth: AppBackendAuth, input: {workspaceId: string; datasetId: string; publicationId: string}): void {
        owner(auth, input.workspaceId);
        const approved = app(auth, input.workspaceId, input.datasetId, input.publicationId).capability;
        const {operations: _operations, ...binding} = approved;
        host.setBinding(auth, {...input, appId: input.publicationId, binding});
      },
      unbindPublication(auth: AppBackendAuth, input: {workspaceId: string; datasetId: string; publicationId: string}): void {
        host.setBinding(auth, {...input, appId: input.publicationId, binding: null});
      },
      setDataGrant(auth: AppBackendAuth, input: {workspaceId: string; datasetId: string; grantId: string; grant: DatasetDataGrant | null}): void {
        owner(auth, input.workspaceId);
        const target = storage.getShareGrant(input.grantId);
        if (!target || target.principalKind !== "user" || !target.principalUserId) throw notFound();
        const key = input.grant === null ? principalKey(input.workspaceId, input.grantId, target.principalUserId)
          : named(input.workspaceId, input.grantId, target.principalUserId).principalKey;
        host.setDataGrant(auth, {...input, principalKey: key});
      },
      removeDataGrant(auth: AppBackendAuth, input: {workspaceId: string; datasetId: string; principalKey: string}): void {
        host.setDataGrant(auth, {...input, grant: null});
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
export type RelayDatasetHost = Awaited<ReturnType<typeof createRelayDatasetHost>>;
