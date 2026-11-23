import { createHash } from "node:crypto";
import {
  parseAppPublicationCandidate,
  type AppDatasetCapability,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import {
  displayAppDatasetCapability,
  verifyAppDatasetCapability,
} from "@dohc/security-contract/dataset-authorization";
import {
  parseAppBackendInvokeRequest,
  parseAppBackendUploadRequest,
} from "@dohc/security-contract/app-backend";
import type { AppDatasetBinding, DatasetRevision } from "@dohc/security-contract/dataset";
import {
  resolveCompatibleDatasetRevision,
  type DatasetAccess,
  type DatasetAuthority,
  type InvokeDatasetInput,
} from "@dohc/app-backend-runtime/dataset-host";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import { hasGeneratedDatasetSources } from "./datasetFieldMigration";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type {
  LocalAppStore,
  LocalAppRow,
  LocalAppPrepared,
  LocalAppStorage,
} from "./localAppStore";
import type { LocalAppAction } from "./localAppLaunch";
import type { LocalDatasetAgent, LocalDatasetUpload } from "./localDatasetHost";
import {
  parseDatasetAttemptRequest,
  type DatasetAttemptRequest,
} from "@dohc/security-contract/dataset-attempts";

/** One invocation's app authority, and the agent it writes as, read once when the invocation starts. */
export interface LocalDatasetAppContext {
  readonly publicationId: string;
  readonly authorityRevision: number;
  readonly agent: LocalDatasetAgent | null;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function datasetCapabilitiesOf(candidate: AppPublicationCandidate): AppDatasetCapability[] {
  if (
    candidate.capabilities.length === 0 ||
    candidate.capabilities.some((capability) => capability.kind !== "dataset")
  ) {
    throw new Error("Invalid app approval.");
  }
  return candidate.capabilities as AppDatasetCapability[];
}

export function selectDatasetCapability(
  capabilities: readonly AppDatasetCapability[],
  dataset?: string,
): AppDatasetCapability {
  if (capabilities.length === 1) {
    const only = capabilities[0]!;
    if (dataset !== undefined && only.alias !== dataset) {
      throw new Error("This Collection is not approved for the app.");
    }
    return only;
  }
  if (dataset === undefined) {
    throw new Error("Choose which Collection this app action targets.");
  }
  const matched = capabilities.find((capability) => capability.alias === dataset);
  if (!matched) throw new Error("This Collection is not approved for the app.");
  return matched;
}

/** Uses the dataset authority database. No app gets the owner data API or source artifacts. */
export function createLocalDatasetApps(options: {
  db: JournalDb;
  store: LocalAppStore;
  workspaceId: string;
  ownerId: string;
  assertCurrent(): void;
  /** The agent run active in this workspace attachment now, or null. */
  agentRun(): LocalDatasetAgent | null;
  /** The person on this computer, whom a local app's commits are made for. */
  localPersonId(): string;
  approved(datasetId: string): { revision: DatasetRevision; schemaSql: string; active: boolean };
  bind(
    operations: ReadonlyArray<{
      datasetId: string;
      appId: string;
      binding: AppDatasetBinding | null;
    }>,
    commit: () => void,
  ): void;
  invoke(
    context: LocalDatasetAppContext,
    input: InvokeDatasetInput,
  ): Promise<DatasetInvocationResult>;
  upload(context: LocalDatasetAppContext, input: LocalDatasetUpload): Promise<unknown>;
  readFile(
    context: LocalDatasetAppContext,
    input: InvokeDatasetInput,
    fileId: string,
  ): Promise<unknown>;
  attempt(
    context: LocalDatasetAppContext,
    input: Pick<
      InvokeDatasetInput,
      "workspaceId" | "datasetId" | "revision" | "revisionSha256" | "operationId" | "access"
    >,
    request: DatasetAttemptRequest,
  ): unknown;
}) {
  const { db } = options;
  const contexts = new WeakSet<LocalDatasetAppContext>();
  function verifyCapabilities(value: LocalAppRow): AppDatasetCapability[] {
    const declared = datasetCapabilitiesOf(value.candidate);
    return declared.map((requested) => {
      const approved = options.approved(requested.datasetId);
      if (!approved.active) throw new Error("This Collection is unavailable on this device.");
      return verifyAppDatasetCapability(
        requested,
        resolveCompatibleDatasetRevision(
          db,
          { workspaceId: options.workspaceId, datasetId: requested.datasetId },
          requested,
          approved.revision,
        ),
      );
    });
  }
  function current(id: string, expected?: number) {
    const value = options.store.row(id, expected);
    return { row: value, capabilities: verifyCapabilities(value) };
  }
  /** The approval as Review app shows it: what each operation does in the revision it names, when this device still has that revision. */
  function shown(declared: AppDatasetCapability): AppDatasetCapability {
    try {
      const key = { workspaceId: options.workspaceId, datasetId: declared.datasetId },
        approved = options.approved(declared.datasetId);
      // A compatible earlier revision names the same schema and operation code as the approved one.
      const revision = resolveCompatibleDatasetRevision(db, key, declared, approved.revision);
      return displayAppDatasetCapability(
        declared,
        revision,
        hasGeneratedDatasetSources(revision, approved.schemaSql),
      );
    } catch {
      return declared;
    }
  }
  function resolveAuthority(
    context: LocalDatasetAppContext,
    request: { workspaceId: string; datasetId?: string; access: DatasetAccess },
  ): DatasetAuthority {
    if (
      !contexts.has(context) ||
      request.workspaceId !== options.workspaceId ||
      request.access.kind !== "app" ||
      request.access.appId !== context.publicationId
    )
      throw new Error("App access is not permitted.");
    const checked = current(context.publicationId, context.authorityRevision);
    if (
      !request.datasetId ||
      !checked.capabilities.some((capability) => capability.datasetId === request.datasetId)
    )
      throw new Error("App access is not permitted.");
    return {
      caller: { kind: "owner", userId: options.ownerId },
      principalKey: `${options.ownerId}:app:${context.publicationId}`,
      appId: context.publicationId,
      authorityToken: String(context.authorityRevision),
      person: options.localPersonId(),
      ...(context.agent === null ? {} : { agent: { depth: context.agent.depth } }),
    };
  }
  async function inContext<T>(
    id: string,
    expected: number,
    signal: AbortSignal | undefined,
    activated: boolean,
    work: (context: LocalDatasetAppContext) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    current(id, expected);
    // While an agent run is active, an invocation is the run's and keeps its chain
    // depth, unless a person's click or key press in the app started it, as dohc's
    // bootstrap reports. The invocation keeps its attribution after the run ends.
    const run = options.agentRun(),
      agent = run === null || activated ? null : Object.freeze({ depth: run.depth });
    const context = Object.freeze({ publicationId: id, authorityRevision: expected, agent });
    contexts.add(context);
    try {
      const result = await work(context);
      signal?.throwIfAborted();
      current(id, expected);
      return result;
    } finally {
      contexts.delete(context);
    }
  }
  const api = {
    current,
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) {
      options.assertCurrent();
      signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      if (
        candidate.capabilities.length === 0 ||
        candidate.capabilities.some((capability) => capability.kind !== "dataset")
      )
        throw new Error("Choose an app connected to a Collection.");
      const declaredList = candidate.capabilities as AppDatasetCapability[];
      const verified = declaredList.map((declared) => {
        let approved;
        try {
          approved = options.approved(declared.datasetId);
        } catch (error) {
          if (declaredList.length > 1) {
            throw new Error("All Collections used by this app must be active on the same host.");
          }
          throw error;
        }
        if (!approved.active) {
          throw new Error(
            declaredList.length > 1
              ? "All Collections used by this app must be active on the same host."
              : "This Collection is unavailable on this device.",
          );
        }
        return verifyAppDatasetCapability(declared, approved.revision);
      });
      const publicationId = hash(
        JSON.stringify(["dohc-local-dataset-app-v1", options.workspaceId, candidate]),
      );
      const resourceId = verified.length === 1 ? verified[0]!.datasetId : "";
      const newBindings = verified.map((cap) => {
        const { operations: _, name: _name, alias: _alias, ...binding } = cap;
        return { datasetId: cap.datasetId, appId: publicationId, binding };
      });
      return options.store.activate(
        { kind: "dataset", resourceId, publicationId, prepared, agent },
        signal,
        (existing, _displaced, commit) => {
          const retireBindings =
            existing && existing.publicationId !== publicationId
              ? datasetCapabilitiesOf(existing.candidate).map((cap) => ({
                  datasetId: cap.datasetId,
                  appId: existing.publicationId,
                  binding: null,
                }))
              : [];
          options.bind([...newBindings, ...retireBindings], commit);
        },
      );
    },
    /** The store has checked the root's authority. The Dataset itself may no longer be approved. */
    withdrawBinding(value: LocalAppRow, commit: () => void) {
      options.bind(
        datasetCapabilitiesOf(value.candidate).map((cap) => ({
          datasetId: cap.datasetId,
          appId: value.publicationId,
          binding: null,
        })),
        commit,
      );
    },
    describe(value: LocalAppRow) {
      const declared = datasetCapabilitiesOf(value.candidate);
      let active = false;
      try {
        current(value.publicationId, value.authorityRevision);
        active = true;
      } catch {}
      const formatted = declared.map((capability) => shown(capability));
      return {
        publicationId: value.publicationId,
        authorityRevision: value.authorityRevision,
        appRoot: value.appRoot,
        sourceRevision: value.candidate.sourceRevision,
        ...(formatted.length === 1
          ? { datasetCapability: formatted[0]! }
          : { datasetCapabilities: formatted }),
        approved: options.store.held(value),
        active,
      };
    },
    request(
      publicationId: string,
      action: LocalAppAction,
      raw: unknown,
      signal?: AbortSignal,
      activated = false,
    ): Promise<unknown> {
      if (action === "list" || action === "create")
        throw new Error("This app is not approved for document Collection access.");
      if (action === "attempt") {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Invalid pending submission request.");
        const {
          authorityRevision,
          operation: operationName,
          dataset,
          ...request
        } = raw as Record<string, unknown>;
        const parsed = parseDatasetAttemptRequest(request);
        const identity = parseAppBackendInvokeRequest({
          authorityRevision,
          operation: operationName,
          input: {},
          idempotencyKey: "attempt",
          ...(Object.hasOwn(raw, "dataset") ? { dataset } : {}),
        });
        return inContext(
          publicationId,
          identity.authorityRevision,
          signal,
          activated,
          async (context) => {
            const { capabilities } = current(publicationId, identity.authorityRevision);
            const cap = selectDatasetCapability(capabilities, identity.dataset);
            const operation = cap.operations.find(
              (operation) => operation.name === identity.operation && !operation.readOnly,
            );
            if (!operation) throw new Error("This action is not approved for the app.");
            return options.attempt(
              context,
              {
                workspaceId: options.workspaceId,
                datasetId: cap.datasetId,
                revision: cap.revision,
                revisionSha256: cap.revisionSha256,
                operationId: operation.operationId,
                access: { kind: "app", appId: publicationId },
              },
              parsed,
            );
          },
        );
      }
      if (action === "upload") {
        const input = parseAppBackendUploadRequest(raw);
        return inContext(
          publicationId,
          input.authorityRevision,
          signal,
          activated,
          async (context) => {
            const { capabilities } = current(publicationId, input.authorityRevision);
            const cap = selectDatasetCapability(capabilities, input.dataset);
            if (!cap.operations.some((operation) => !operation.readOnly))
              throw new Error("This app cannot upload files.");
            return options.upload(context, {
              datasetId: cap.datasetId,
              revision: cap.revision,
              revisionSha256: cap.revisionSha256,
              idempotencyKey: input.idempotencyKey,
              name: input.name,
              contentType: input.contentType,
              bytesBase64: input.bytesBase64,
              signal,
            });
          },
        );
      }
      const input = parseAppBackendInvokeRequest(raw);
      return inContext(
        publicationId,
        input.authorityRevision,
        signal,
        activated,
        async (context) => {
          const { capabilities } = current(publicationId, input.authorityRevision);
          const cap = selectDatasetCapability(capabilities, input.dataset);
          const operation = cap.operations.find((operation) => operation.name === input.operation);
          if (!operation) throw new Error("This action is not approved for the app.");
          return options.invoke(context, {
            workspaceId: options.workspaceId,
            datasetId: cap.datasetId,
            revision: cap.revision,
            revisionSha256: cap.revisionSha256,
            operationId: operation.operationId,
            idempotencyKey: input.idempotencyKey,
            input: input.input,
            access: { kind: "app", appId: publicationId },
            signal,
          });
        },
      );
    },
    readBrowserFile(
      publicationId: string,
      raw: {
        authorityRevision: number;
        fileId: string;
        operation: string;
        input: unknown;
        dataset?: string;
      },
      signal?: AbortSignal,
    ): Promise<unknown> {
      const input = parseAppBackendInvokeRequest({
        authorityRevision: raw.authorityRevision,
        operation: raw.operation,
        input: raw.input,
        idempotencyKey: "file-read",
        ...(raw.dataset === undefined ? {} : { dataset: raw.dataset }),
      });
      return inContext(publicationId, input.authorityRevision, signal, false, async (context) => {
        const { capabilities } = current(publicationId, input.authorityRevision);
        const cap = selectDatasetCapability(capabilities, input.dataset);
        const operation = cap.operations.find(
          (operation) => operation.name === input.operation && operation.readOnly,
        );
        if (
          !operation ||
          typeof raw.fileId !== "string" ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(raw.fileId)
        )
          throw new Error("Choose an approved read action for this file.");
        return options.readFile(
          context,
          {
            workspaceId: options.workspaceId,
            datasetId: cap.datasetId,
            revision: cap.revision,
            revisionSha256: cap.revisionSha256,
            operationId: operation.operationId,
            idempotencyKey: "file-read",
            input: input.input,
            access: { kind: "app", appId: publicationId },
            signal,
          },
          raw.fileId,
        );
      });
    },
  };
  return { ...api, resolveAuthority };
}

export function localDatasetAppStorage(db: JournalDb): LocalAppStorage {
  return {
    kind: "dataset",
    publicationTable: "local_dataset_apps",
    artifactTable: "local_dataset_app_artifacts",
    resourceColumn: "dataset_id",
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
