import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, type AppDatasetCapability } from "@dohc/security-contract/app-publication";
import { verifyAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { parseAppBackendInvokeRequest, parseAppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { AppDatasetBinding, DatasetRevision } from "@dohc/security-contract/dataset";
import { resolveCompatibleDatasetRevision, type DatasetAccess, type DatasetAuthority, type InvokeDatasetInput } from "@dohc/app-backend-runtime/dataset-host";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { LocalAppStore, LocalAppRow, LocalAppPrepared, LocalAppStorage } from "./localAppStore";
import type { LocalAppAction } from "./localAppLaunch";
import type { LocalDatasetAgent, LocalDatasetUpload } from "./localDatasetHost";
import { parseDatasetAttemptRequest, type DatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";

/** One invocation's app authority, and the agent it writes as, read once when the invocation starts. */
export interface LocalDatasetAppContext { readonly publicationId: string; readonly authorityRevision: number; readonly agent: LocalDatasetAgent | null }

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Uses the dataset authority database. No app gets the owner data API or source artifacts. */
export function createLocalDatasetApps(options: {
  db: JournalDb; store: LocalAppStore; workspaceId: string; ownerId: string;
  assertCurrent(): void;
  /** The agent run active in this workspace attachment now, or null. */
  agentRun(): LocalDatasetAgent | null;
  /** The person on this computer, whom a local app's commits are made for. */
  localPersonId(): string;
  approved(datasetId: string): { revision: DatasetRevision; active: boolean };
  bind(datasetId: string, appId: string, binding: AppDatasetBinding | null, commit: () => void): void;
  invoke(context: LocalDatasetAppContext, input: InvokeDatasetInput): Promise<DatasetInvocationResult>;
  upload(context: LocalDatasetAppContext, input: LocalDatasetUpload): Promise<unknown>;
  readFile(context: LocalDatasetAppContext, input: InvokeDatasetInput, fileId: string): Promise<unknown>;
  attempt(context: LocalDatasetAppContext, input: Pick<InvokeDatasetInput, "workspaceId" | "datasetId" | "revision" | "revisionSha256" | "operationId" | "access">, request: DatasetAttemptRequest): unknown;
}) {
  const { db } = options;
  const contexts = new WeakSet<LocalDatasetAppContext>();
  function capability(value: LocalAppRow): AppDatasetCapability {
    const candidate = value.candidate;
    const current = options.approved(value.resourceId);
    if (!current.active) throw new Error("This Collection is unavailable on this device.");
    const requested = candidate.capabilities[0];
    if (requested?.kind !== "dataset") throw new Error("Invalid app approval.");
    return verifyAppDatasetCapability(requested, resolveCompatibleDatasetRevision(db,{workspaceId:options.workspaceId,datasetId:value.resourceId},requested,current.revision));
  }
  function current(id: string, expected?: number) { const value = options.store.row(id, expected); return { row: value, capability: capability(value) }; }
  function resolveAuthority(context: LocalDatasetAppContext, request: { workspaceId: string; datasetId?: string; access: DatasetAccess }): DatasetAuthority {
    if (!contexts.has(context) || request.workspaceId !== options.workspaceId || request.access.kind !== "app" || request.access.appId !== context.publicationId) throw new Error("App access is not permitted.");
    const checked = current(context.publicationId, context.authorityRevision);
    if (request.datasetId !== checked.row.resourceId) throw new Error("App access is not permitted.");
    return { caller: { kind: "owner", userId: options.ownerId }, principalKey: `${options.ownerId}:app:${context.publicationId}`,
      appId: context.publicationId, authorityToken: String(context.authorityRevision), person: options.localPersonId(),
      ...(context.agent === null ? {} : { agent: { depth: context.agent.depth } }) };
  }
  async function inContext<T>(id: string, expected: number, signal: AbortSignal | undefined, work: (context: LocalDatasetAppContext) => Promise<T>): Promise<T> {
    signal?.throwIfAborted(); current(id, expected);
    // The app cannot tell a person's click from an agent's request, so while
    // an agent run is active every invocation is the run's, which keeps its
    // chain depth. The invocation keeps it after the run ends.
    const run = options.agentRun(), agent = run === null ? null : Object.freeze({ depth: run.depth });
    const context = Object.freeze({ publicationId: id, authorityRevision: expected, agent }); contexts.add(context);
    try { const result = await work(context); signal?.throwIfAborted(); current(id, expected); return result; }
    finally { contexts.delete(context); }
  }
  const api = {
    current,
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) {
      options.assertCurrent(); signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      const declared = candidate.capabilities[0];
      if (declared?.kind !== "dataset") throw new Error("Choose an app connected to a Collection.");
      const approved = options.approved(declared.datasetId);
      if (!approved.active) throw new Error("This Collection is unavailable on this device.");
      const verified = verifyAppDatasetCapability(declared, approved.revision);
      const publicationId = hash(JSON.stringify(["dohc-local-dataset-app-v1", options.workspaceId, candidate]));
      const { operations: _, name: _name, ...binding } = verified;
      return options.store.activate({ kind: "dataset", resourceId: verified.datasetId, publicationId, prepared, agent }, signal,
        (existing, _displaced, commit) => options.bind(verified.datasetId, publicationId, binding, () => {
          if (existing && existing.publicationId !== publicationId) options.bind(existing.resourceId, existing.publicationId, null, () => {});
          commit();
        }));
    },
    /** The store has checked the root's authority. The Dataset itself may no longer be approved. */
    withdrawBinding(value: LocalAppRow, commit: () => void) {
      options.bind(value.resourceId, value.publicationId, null, commit);
    },
    describe(value: LocalAppRow) {
      const declared = value.candidate.capabilities[0];
      if (declared?.kind !== "dataset") throw new Error("Invalid app approval.");
      let active = false; try { current(value.publicationId, value.authorityRevision); active = true; } catch {}
      return { publicationId: value.publicationId, authorityRevision: value.authorityRevision, appRoot: value.appRoot,
        sourceRevision: value.candidate.sourceRevision, datasetCapability: declared, approved: options.store.held(value), active };
    },
    request(publicationId: string, action: LocalAppAction, raw: unknown, signal?: AbortSignal): Promise<unknown> {
      if (action === "list" || action === "create") throw new Error("This app is not approved for document Collection access.");
      if (action === "attempt") {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid pending submission request.");
        const { authorityRevision, operation: operationName, ...request } = raw as Record<string, unknown>;
        const parsed = parseDatasetAttemptRequest(request);
        const identity = parseAppBackendInvokeRequest({ authorityRevision, operation: operationName, input: {}, idempotencyKey: "attempt" });
        return inContext(publicationId, identity.authorityRevision, signal, async context => {
          const { capability: cap } = current(publicationId, identity.authorityRevision);
          const operation = cap.operations.find(operation => operation.name === identity.operation && !operation.readOnly);
          if (!operation) throw new Error("This action is not approved for the app.");
          return options.attempt(context, { workspaceId: options.workspaceId, datasetId: cap.datasetId, revision: cap.revision, revisionSha256: cap.revisionSha256,
            operationId: operation.operationId, access: { kind: "app", appId: publicationId } }, parsed);
        });
      }
      if (action === "upload") {
        const input = parseAppBackendUploadRequest(raw);
        return inContext(publicationId, input.authorityRevision, signal, async context => {
          const { capability: cap } = current(publicationId, input.authorityRevision);
          if (!cap.operations.some(operation => !operation.readOnly)) throw new Error("This app cannot upload files.");
          return options.upload(context, { datasetId: cap.datasetId, revision: cap.revision, revisionSha256: cap.revisionSha256, ...input, signal });
        });
      }
      const input = parseAppBackendInvokeRequest(raw);
      return inContext(publicationId, input.authorityRevision, signal, async context => {
        const { capability: cap } = current(publicationId, input.authorityRevision);
        const operation = cap.operations.find(operation => operation.name === input.operation);
        if (!operation) throw new Error("This action is not approved for the app.");
        return options.invoke(context, { workspaceId: options.workspaceId, datasetId: cap.datasetId, revision: cap.revision, revisionSha256: cap.revisionSha256,
          operationId: operation.operationId, idempotencyKey: input.idempotencyKey, input: input.input, access: { kind: "app", appId: publicationId }, signal });
      });
    },
    readBrowserFile(publicationId: string, raw: { authorityRevision: number; fileId: string; operation: string; input: unknown }, signal?: AbortSignal): Promise<unknown> {
      const input = parseAppBackendInvokeRequest({ authorityRevision: raw.authorityRevision, operation: raw.operation, input: raw.input, idempotencyKey: "file-read" });
      return inContext(publicationId, input.authorityRevision, signal, async context => {
        const { capability: cap } = current(publicationId, input.authorityRevision);
        const operation = cap.operations.find(operation => operation.name === input.operation && operation.readOnly);
        if (!operation || typeof raw.fileId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(raw.fileId)) throw new Error("Choose an approved read action for this file.");
        return options.readFile(context, { workspaceId: options.workspaceId, datasetId: cap.datasetId, revision: cap.revision, revisionSha256: cap.revisionSha256,
          operationId: operation.operationId, idempotencyKey: "file-read", input: input.input, access: { kind: "app", appId: publicationId }, signal }, raw.fileId);
      });
    },
  };
  return { ...api, resolveAuthority };
}

export function localDatasetAppStorage(db: JournalDb): LocalAppStorage {
  return { kind: "dataset", publicationTable: "local_dataset_apps", artifactTable: "local_dataset_app_artifacts", resourceColumn: "dataset_id",
    ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS local_dataset_apps(
    publication_id TEXT PRIMARY KEY, app_root TEXT NOT NULL UNIQUE, dataset_id TEXT NOT NULL,
    authority_revision INTEGER NOT NULL, candidate TEXT NOT NULL, storage_bytes INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_dataset_app_artifacts(
    publication_id TEXT NOT NULL REFERENCES local_dataset_apps(publication_id) ON DELETE CASCADE,
    path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(publication_id,path)) STRICT;`);
    },
  };
}
