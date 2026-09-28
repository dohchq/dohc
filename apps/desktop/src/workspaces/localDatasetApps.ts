import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, type AppDatasetCapability, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { verifyAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { parseAppBackendInvokeRequest, parseAppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { AppDatasetBinding, DatasetRevision } from "@dohc/security-contract/dataset";
import { resolveCompatibleDatasetRevision, type DatasetAccess, type DatasetAuthority, type InvokeDatasetInput } from "@dohc/app-backend-runtime/dataset-host";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { ClosedAppBuild } from "./closedAppCompiler";
import type { LocalDatasetAgent, LocalDatasetUpload } from "./localDatasetHost";
import { parseDatasetAttemptRequest, type DatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";

/** One invocation's app authority, and the agent it writes as, read once when the invocation starts. */
export interface LocalDatasetAppContext { readonly publicationId: string; readonly authorityRevision: number; readonly agent: LocalDatasetAgent | null }
type Prepared = { candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] };
type Row = { publication_id: string; app_root: string; dataset_id: string; authority_revision: number; candidate: string; storage_bytes: number; active: number };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Uses the dataset authority database. No app gets the owner data API or source artifacts. */
export function createLocalDatasetApps(options: {
  db: JournalDb; workspaceId: string; ownerId: string;
  assertCurrent(): void; charge(datasetId: string, bytes: number): void;
  /** The agent run active in this workspace attachment now, or null. */
  agentRun(): LocalDatasetAgent | null;
  approved(datasetId: string): { revision: DatasetRevision; active: boolean };
  bind(datasetId: string, appId: string, binding: AppDatasetBinding | null, commit: () => void): void;
  invoke(context: LocalDatasetAppContext, input: InvokeDatasetInput): Promise<DatasetInvocationResult>;
  upload(context: LocalDatasetAppContext, input: LocalDatasetUpload): Promise<unknown>;
  readFile(context: LocalDatasetAppContext, input: InvokeDatasetInput, fileId: string): Promise<unknown>;
  attempt(context: LocalDatasetAppContext, input: Pick<InvokeDatasetInput, "workspaceId" | "datasetId" | "revision" | "revisionSha256" | "operationId" | "access">, request: DatasetAttemptRequest): unknown;
}) {
  const { db } = options;
  db.exec(`CREATE TABLE IF NOT EXISTS local_dataset_apps(
    publication_id TEXT PRIMARY KEY, app_root TEXT NOT NULL UNIQUE, dataset_id TEXT NOT NULL,
    authority_revision INTEGER NOT NULL, candidate TEXT NOT NULL, storage_bytes INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_dataset_app_artifacts(
    publication_id TEXT NOT NULL REFERENCES local_dataset_apps(publication_id) ON DELETE CASCADE,
    path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(publication_id,path)) STRICT;`);
  const contexts = new WeakSet<LocalDatasetAppContext>();
  function row(id: string, expected?: number): Row {
    options.assertCurrent();
    const result = db.prepare("SELECT * FROM local_dataset_apps WHERE publication_id=?").get(id) as Row | undefined;
    if (!result || !result.active || (expected !== undefined && expected !== result.authority_revision)) throw new Error("This app approval changed. Prepare the app again.");
    return result;
  }
  function capability(value: Row): AppDatasetCapability {
    const candidate = parseAppPublicationCandidate(JSON.parse(value.candidate), APP_PUBLICATION_LIMITS);
    const current = options.approved(value.dataset_id);
    if (!current.active) throw new Error("This Collection is unavailable on this device.");
    const requested = candidate.capabilities[0];
    if (requested?.kind !== "dataset") throw new Error("Invalid app approval.");
    return verifyAppDatasetCapability(requested, resolveCompatibleDatasetRevision(db,{workspaceId:options.workspaceId,datasetId:value.dataset_id},requested,current.revision));
  }
  function current(id: string, expected?: number) { const value = row(id, expected); return { row: value, capability: capability(value) }; }
  function resolveAuthority(context: LocalDatasetAppContext, request: { workspaceId: string; datasetId?: string; access: DatasetAccess }): DatasetAuthority {
    if (!contexts.has(context) || request.workspaceId !== options.workspaceId || request.access.kind !== "app" || request.access.appId !== context.publicationId) throw new Error("App access is not permitted.");
    const checked = current(context.publicationId, context.authorityRevision);
    if (request.datasetId !== checked.row.dataset_id) throw new Error("App access is not permitted.");
    return { caller: { kind: "owner", userId: options.ownerId }, principalKey: `${options.ownerId}:app:${context.publicationId}`,
      appId: context.publicationId, authorityToken: String(context.authorityRevision), ...(context.agent === null ? {} : { agent: { depth: context.agent.depth } }) };
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
    async activate(prepared: Prepared, signal: AbortSignal) {
      options.assertCurrent(); signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      const declared = candidate.capabilities[0];
      if (declared?.kind !== "dataset") throw new Error("Choose an app connected to a Collection.");
      const approved = options.approved(declared.datasetId);
      if (!approved.active) throw new Error("This Collection is unavailable on this device.");
      const verified = verifyAppDatasetCapability(declared, approved.revision);
      if (prepared.files.length !== candidate.files.length) throw new Error("App bundle files changed. Prepare the app again.");
      const files = candidate.files.map(metadata => {
        const matches = prepared.files.filter(file => file.path === metadata.path);
        const file = matches[0];
        if (matches.length !== 1 || !file || file.bytes.byteLength !== metadata.byteLength || hash(file.bytes) !== metadata.sha256) throw new Error("App bundle files changed. Prepare the app again.");
        return { path: file.path, bytes: Uint8Array.from(file.bytes) };
      });
      const json = JSON.stringify(candidate), publicationId = hash(JSON.stringify(["dohc-local-dataset-app-v1", options.workspaceId, candidate]));
      const existing = db.prepare("SELECT * FROM local_dataset_apps WHERE app_root=?").get(candidate.appRoot) as Row | undefined;
      if (existing?.publication_id === publicationId && existing.active) return { publicationId, authorityRevision: existing.authority_revision };
      if (!existing && Number(db.prepare("SELECT count(*) AS count FROM local_dataset_apps").get()!.count) >= 64) throw new Error("Remove an app before approving another one.");
      const authorityRevision = (existing?.authority_revision ?? 0) + 1;
      const storageBytes = Buffer.byteLength(json) + files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + 512;
      const { operations: _, name: _name, ...binding } = verified;
      options.bind(verified.datasetId, publicationId, binding, () => {
        signal.throwIfAborted(); options.assertCurrent();
        if (existing) {
          // Both binding changes and the replacement share this synchronous authority transaction.
          if (existing.publication_id !== publicationId) options.bind(existing.dataset_id, existing.publication_id, null, () => {});
          db.prepare("DELETE FROM local_dataset_app_artifacts WHERE publication_id=?").run(existing.publication_id);
          db.prepare("DELETE FROM local_dataset_apps WHERE publication_id=?").run(existing.publication_id);
        }
        if (existing) options.charge(existing.dataset_id,-existing.storage_bytes);
        options.charge(verified.datasetId,storageBytes);
        db.prepare("INSERT INTO local_dataset_apps VALUES(?,?,?,?,?,?,1)").run(publicationId, candidate.appRoot, verified.datasetId, authorityRevision, json, storageBytes);
        for (const file of files) db.prepare("INSERT INTO local_dataset_app_artifacts VALUES(?,?,?)").run(publicationId, file.path, file.bytes);
      });
      current(publicationId, authorityRevision);
      return { publicationId, authorityRevision };
    },
    list(appRoot: string) {
      options.assertCurrent();
      return (db.prepare("SELECT * FROM local_dataset_apps WHERE app_root=?").all(appRoot) as Row[]).map(value => {
        const candidate = parseAppPublicationCandidate(JSON.parse(value.candidate), APP_PUBLICATION_LIMITS);
        const declared = candidate.capabilities[0];
        if (declared?.kind !== "dataset") throw new Error("Invalid app approval.");
        let active = false; try { current(value.publication_id, value.authority_revision); active = true; } catch {}
        return { publicationId: value.publication_id, authorityRevision: value.authority_revision, appRoot: value.app_root,
          sourceRevision: candidate.sourceRevision, datasetCapability: declared, active };
      });
    },
    has(publicationId: string) { options.assertCurrent(); return !!db.prepare("SELECT 1 FROM local_dataset_apps WHERE publication_id=?").get(publicationId); },
    withdraw(publicationId: string, authorityRevision: number) {
      const checked = current(publicationId, authorityRevision);
      options.bind(checked.row.dataset_id, publicationId, null, () => {
        row(publicationId, authorityRevision);
        db.prepare("UPDATE local_dataset_apps SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?").run(publicationId);
      });
      return { publicationId, authorityRevision: authorityRevision + 1 };
    },
    browserPublication(publicationId: string) {
      const checked = current(publicationId), candidate = parseAppPublicationCandidate(JSON.parse(checked.row.candidate), APP_PUBLICATION_LIMITS);
      const files = candidate.files.map(metadata => {
        const stored = db.prepare("SELECT content FROM local_dataset_app_artifacts WHERE publication_id=? AND path=?").get(publicationId, metadata.path);
        if (!stored || !(stored.content instanceof Uint8Array) || stored.content.byteLength !== metadata.byteLength || hash(stored.content) !== metadata.sha256) throw new Error("App bundle integrity check failed.");
        return { ...metadata, bytes: Uint8Array.from(stored.content) };
      });
      return { publicationId, authorityRevision: checked.row.authority_revision, appRoot: checked.row.app_root, files };
    },
    assertBrowserPublication(publicationId: string, authorityRevision: number) { current(publicationId, authorityRevision); },
    request(publicationId: string, action: "invoke" | "upload" | "attempt", raw: unknown, signal?: AbortSignal): Promise<unknown> {
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
  return { api, resolveAuthority };
}
