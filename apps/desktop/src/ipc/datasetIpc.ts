import { randomUUID } from "node:crypto";
import { datasetBaseFolder, parseDatasetDefinition } from "@dohc/security-contract/dataset";
import type { CreationStage, CreationPartial } from "@dohc/cli/creation";
import { CreatedFileWriteError } from "../workspaces/workspaceFiles";
import { CollectionsRefusalError } from "../workspaces/collectionsHolder";
import {
  SourceCreationConflict,
  type SourceCreationProgress,
} from "../workspaces/datasetSourceCreation";
import {
  DATASET_ADMIN_ACTIONS,
  DatasetRequest,
  DatasetHistoryRevision,
  DatasetInvocationResult,
  DatasetPreparation,
  DatasetMigrationPreparation,
  DatasetMigrationPreviewPage,
  DatasetDeletePreview,
  DatasetDeleted,
  type DatasetListRefusal,
  type DatasetPermissionsPage,
  type DatasetPlace,
} from "@dohc/cli/dataset";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  localDatasetStoreExists,
  type LocalDatasetAgent,
  type LocalDatasetHost,
} from "../workspaces/localDatasetHost";
import {
  discoverDatasetBoundApps,
  type ShareLinkPublication,
} from "../workspaces/datasetBoundApps";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { writeDatasetTypes } from "../workspaces/datasetTypes";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetFormSources } from "../workspaces/datasetFormGenerator";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { datasetOwnerOnlyError } from "./errorWords";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { OwnerDatasetData, RemoteDatasetData } from "../workspaces/remoteDataset";
import type { NamedDatasetData } from "../workspaces/namedDataset";
import {
  approveLocalDatasetMigration,
  createLocalDatasetMigrations,
  type LocalDatasetMigrationPreparation,
} from "../workspaces/localDatasetMigration";
import { generateDatasetHistoryRestore } from "../workspaces/datasetHistoryRestore";
import { hasGeneratedDatasetSources } from "../workspaces/datasetFieldMigration";
import { generateDatasetSchemaChange } from "../workspaces/datasetSchemaChanges";
import { generateDatasetRelationChoices } from "../workspaces/datasetRelationChoices";
import { collectionChangeProposal } from "../workspaces/collectionChange";
import {
  DatasetAddressUnavailableError,
  addressDatasets,
  resolveDatasetAddress,
  invalidateDatasetAddresses,
  type ResolvedDatasetRequest,
} from "../workspaces/datasetAddress";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { LocalAppRow } from "../workspaces/localAppStore";
import { APP_PUBLICATION_LIMITS } from "../workspaces/ownerAppPublication";
import { MAIN_ONLY_SCHEMA_CHANGES } from "../workspaces/localPreviewStore";
import { collectionHistoryAuthors, type CollectionHistoryNames } from "./collectionHistoryAuthors";
import {
  assertSourcePathsNotHeld,
  assertSourcePathsNotDeferred,
  type SourceCaptureStatus,
} from "../workspaces/datasetSourceCapture";

type Workspace = { workspaceId: string; rootPath?: string; shareView?: unknown };
type SourceAdapter = Pick<
  VersionedLiveAdapter,
  | "captureSourceMetadata"
  | "getActiveVersion"
  | "hydrateCapturedSources"
  | "listTextFileMetadata"
  | "resolveFiles"
  | "workspace"
>;
type Operation<W extends Workspace> = {
  workspace: W;
  signal: AbortSignal;
  scope?: string;
  assertCurrent(): void;
};

// Why this computer can't list the Collections, or null for any other error.
function listRefusalOf(error: unknown): DatasetListRefusal | null {
  if (!(error instanceof CollectionsRefusalError)) return null;
  const { refusal, message: words } = error;
  return refusal.kind === "elsewhere"
    ? { kind: "elsewhere", words, computer: refusal.computer.label }
    : { kind: refusal.kind, words };
}

const NAMED_ACTIONS: readonly string[] = [
  "list",
  "describe",
  "types",
  "invoke",
  "upload",
  "file",
  "permissions",
  "setGrant",
  "removeGrant",
  "setDefaults",
  "approval",
];

function inPlace<
  T extends {
    definition: DatasetDefinition;
    schemaSql: string;
    operationSource: string;
    migrationSql: string;
    migrationPath: string;
  },
>(change: T, descriptorPath: string, pinned: DatasetDefinition) {
  const definition = parseDatasetDefinition({
    ...change.definition,
    schemaPath: pinned.schemaPath,
    operationsPath: pinned.operationsPath,
  });
  return {
    ...change,
    definition,
    descriptorPath,
    files: {
      [descriptorPath]: JSON.stringify(definition, null, 2) + "\n",
      [pinned.schemaPath]: change.schemaSql,
      [pinned.operationsPath]: change.operationSource,
      [change.migrationPath]: change.migrationSql,
    },
  };
}

class DatasetScopeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The desktop and owner CLI enter the same workspace authority before using data. */
export function createDatasetHandler<
  Caller,
  W extends Workspace,
  O extends Operation<W>,
>(dependencies: {
  withWorkspaceOperation<T>(
    caller: Caller,
    workspaceId: string,
    work: (operation: O) => Promise<T>,
  ): Promise<T>;
  hostForWorkspace(workspace: W, signal: AbortSignal): Promise<LocalDatasetHost>;
  /** Resolves the dataset's current authority. Remote failures must never fall back to local writes. */
  dataForWorkspace?(workspace: W, signal: AbortSignal): Promise<OwnerDatasetData>;
  currentCredentialGeneration?(): number;
  namedDataForWorkspace?(workspace: W, signal: AbortSignal): Promise<NamedDatasetData>;
  /** Where the Owner approves a Collection's rules on its server, or null where this computer keeps them. */
  governanceForWorkspace?(
    workspace: W,
    datasetId: string,
    signal: AbortSignal,
  ): Promise<Pick<RemoteDatasetData, "approval" | "confirmApproval"> | null>;
  /** Writes a joined workspace's Collection types into the member's Personal app folder. */
  writePersonalTypes?(
    workspace: W,
    description: import("@dohc/security-contract/dataset").DatasetDescription,
  ): Promise<string>;
  chooseRecoveryFile?(workspace: W, signal: AbortSignal): Promise<string | null>;
  exportArchive?(
    workspace: W,
    request: Extract<ResolvedDatasetRequest, { action: "export" }>,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string | null>;
  /** Reconciles disk edits before capturing immutable source for review. */
  flushSourceCapture(workspace: W, signal: AbortSignal): Promise<SourceCaptureStatus>;
  /** Rejects when the workspace engine is unavailable, so work returns a value, never null. */
  withAdapter<T extends {}>(workspace: W, work: (adapter: SourceAdapter) => Promise<T>): Promise<T>;
  withMainVersionLock?<T>(workspace: W, work: () => Promise<T>): Promise<T>;
  /** Creates absent files through the workspace engine and settles their source capture. */
  createSources(
    workspace: W,
    files: Record<string, string>,
    signal: AbortSignal,
    progress?: SourceCreationProgress,
  ): Promise<void>;
  /** Writes an Admin's Collection rule files in a joined copy, and returns once the Owner's workspace has them. */
  writeSharedSources?(
    workspace: W,
    files: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void>;
  /** An automation's name in its Collection's automations.yaml now, or null. */
  automationName?(workspace: W, automationId: string): Promise<string | null>;
  /** Where a Collection is: only on this computer, or on the workspace's server. */
  collectionPlace?(workspace: W, datasetId: string, signal: AbortSignal): Promise<DatasetPlace>;
  readShareLinkPublication?(
    workspace: W,
    publicationId: string,
    signal: AbortSignal,
  ): Promise<ShareLinkPublication | null>;
  collectionRulesChanged?(workspaceId: string, datasetId: string): void;
  /** Names Collection History's people and agents for the desktop. The owner CLI keeps raw actors. */
  historyPeople?(caller: Caller, workspace: W): Omit<CollectionHistoryNames, "app">;
}) {
  const migrations = new Map<
    string,
    {
      caller: Caller;
      workspaceId: string;
      signal: AbortSignal;
      scope?: string;
      credentialGeneration?: number;
      review: LocalDatasetMigrationPreparation;
      clear(): void;
    }
  >();
  const invocations = new Map<
    string,
    { caller: Caller; workspaceId: string; controller: AbortController }
  >();
  let preparingMigrations = 0;
  /**
   * `agent` is set only by the owner CLI, from the actor main derived for the
   * call, never from the request, so the agent's local invocation names it
   * and carries its run's chain on.
   */
  return async (caller: Caller, raw: unknown, agent: LocalDatasetAgent | null = null) => {
    const request = DatasetRequest.parse(raw);
    if (request.action === "cancelInvoke") {
      // A dialog can unmount after its window switches workspaces. Only signal a request this sender registered.
      const running = invocations.get(request.invocationId);
      if (running && running.caller === caller && running.workspaceId === request.workspaceId) {
        running.controller.abort(
          new Error(
            "dohc could not confirm whether this action finished. Try again with the same idempotencyKey.",
          ),
        );
      }
      return { kind: "invoke-cancel-requested" as const, outcome: "unknown" as const };
    }
    const invocationId = request.action === "invoke" ? request.invocationId : undefined;
    const invocation = invocationId
      ? { caller, workspaceId: request.workspaceId, controller: new AbortController() }
      : undefined;
    if (invocationId && invocation) {
      if (invocations.has(invocationId))
        throw new Error("This Collection request is already running.");
      if (invocations.size >= 256)
        throw new Error("Too many Collection requests are running. Wait for one to finish.");
      invocations.set(invocationId, invocation);
    }
    let formFailure: ((error: unknown) => CreationPartial) | undefined;
    let formPartial: CreationPartial | undefined;
    // Preparing a change reads the files as they are now, so it settles disk edits first.
    const capturesFirst = request.action === "prepareMigration" || request.action === "askToApply";
    try {
      return await dependencies.withWorkspaceOperation(
        caller,
        request.workspaceId,
        async (operation) => {
          const current = () => {
            try {
              operation.signal.throwIfAborted();
              operation.assertCurrent();
            } catch (error) {
              throw new DatasetScopeError(error);
            }
          };
          current();
          const invokeSignal = invocation
            ? AbortSignal.any([operation.signal, invocation.controller.signal])
            : operation.signal;
          let sourceCapture: SourceCaptureStatus = { heldFiles: [], deferredWrites: [] };
          const flushSourceCapture = async () => {
            sourceCapture = await dependencies.flushSourceCapture(
              operation.workspace,
              operation.signal,
            );
            current();
          };
          const withSourceAdapter = <T extends {}>(work: (adapter: SourceAdapter) => Promise<T>) =>
            dependencies.withAdapter(operation.workspace, (adapter) =>
              work({
                workspace: adapter.workspace,
                getActiveVersion: adapter.getActiveVersion.bind(adapter),
                listTextFileMetadata: adapter.listTextFileMetadata.bind(adapter),
                resolveFiles: adapter.resolveFiles.bind(adapter),
                hydrateCapturedSources: adapter.hydrateCapturedSources.bind(adapter),
                captureSourceMetadata: (input) => {
                  current();
                  assertSourcePathsNotHeld(sourceCapture.heldFiles, input.paths);
                  assertSourcePathsNotDeferred(sourceCapture.deferredWrites, input.paths);
                  return adapter.captureSourceMetadata(input);
                },
              }),
            );
          const onMain = async (adapter: Pick<SourceAdapter, "getActiveVersion">) => {
            const active = await adapter.getActiveVersion({
              workspaceId: operation.workspace.workspaceId,
            });
            if ((active?.id ?? "main") !== "main") throw new Error(MAIN_ONLY_SCHEMA_CHANGES);
          };
          const requireMain = async () => {
            await dependencies.withAdapter(operation.workspace, async (adapter) => {
              await onMain(adapter);
              return {};
            });
            current();
          };
          const onMainLocked = <T>(work: () => Promise<T>) => {
            const guarded = async () => {
              await requireMain();
              return work();
            };
            return dependencies.withMainVersionLock &&
              !shareViewIsPresent(operation.workspace.shareView)
              ? dependencies.withMainVersionLock(operation.workspace, guarded)
              : guarded();
          };
          let input: ResolvedDatasetRequest;
          if ("datasetPath" in request) {
            if (capturesFirst) {
              await flushSourceCapture();
              current();
              invalidateDatasetAddresses({ workspaceId: request.workspaceId });
            }
            const resolve = () =>
              withSourceAdapter((adapter) =>
                resolveDatasetAddress(
                  adapter,
                  request.workspaceId,
                  request.datasetPath,
                  operation.signal,
                ),
              );
            const datasetId = await resolve()
              .catch(async (error) => {
                current();
                if (
                  !(error instanceof DatasetAddressUnavailableError) ||
                  capturesFirst ||
                  shareViewIsPresent(operation.workspace.shareView)
                )
                  throw error;
                await flushSourceCapture();
                current();
                invalidateDatasetAddresses({ workspaceId: request.workspaceId });
                return resolve();
              })
              .catch((error) => {
                current();
                if (
                  shareViewIsPresent(operation.workspace.shareView) &&
                  error instanceof DatasetAddressUnavailableError
                ) {
                  throw new Error(
                    `Collection source unavailable: ${request.datasetPath}. Ask the owner to include its dataset.json file in this share.`,
                  );
                }
                throw error;
              });
            current();
            if (request.expectedDatasetId && request.expectedDatasetId !== datasetId)
              throw new Error("This Collection moved. Reopen it.");
            const { datasetPath: _, expectedDatasetId: _expected, ...fields } = request;
            input = { ...fields, datasetId };
          } else input = request;
          const addressPage = async <
            T extends import("@dohc/security-contract/dataset").DatasetDescription,
          >(
            page: { datasets: T[]; nextCursor: string | null },
            approvedFolder?: (datasetId: string) => Promise<string>,
          ) => {
            const datasets = await withSourceAdapter((adapter) =>
              addressDatasets(
                adapter,
                request.workspaceId,
                page.datasets,
                operation.signal,
                approvedFolder,
              ),
            );
            current();
            return { ...page, datasets };
          };
          const addressed = <
            T extends { dataset: import("@dohc/security-contract/dataset").DatasetDescription },
          >(
            result: T,
          ) => ({
            ...result,
            dataset: {
              ...result.dataset,
              datasetPath: "datasetPath" in request ? request.datasetPath : null,
            },
          });
          if (input.action === "export") {
            if (shareViewIsPresent(operation.workspace.shareView)) throw datasetOwnerOnlyError();
            if (!dependencies.exportArchive)
              throw new Error(
                "Collection recovery export is unavailable. Restart dohc and try again.",
              );
            const savedPath = await dependencies.exportArchive(
              operation.workspace,
              input,
              operation.signal,
              current,
            );
            current();
            return { kind: "exported" as const, savedPath };
          }
          const governs =
            shareViewIsPresent(operation.workspace.shareView) &&
            DATASET_ADMIN_ACTIONS.has(input.action) &&
            !NAMED_ACTIONS.includes(input.action);
          if (shareViewIsPresent(operation.workspace.shareView) && !governs) {
            if (!dependencies.namedDataForWorkspace || !NAMED_ACTIONS.includes(input.action))
              throw datasetOwnerOnlyError();
            const data = await dependencies.namedDataForWorkspace(
              operation.workspace,
              operation.signal,
            );
            current();
            if (input.action === "permissions") {
              const result = await data.permissions(input);
              current();
              return { kind: "permissions" as const, ...result };
            }
            if (input.action === "approval") {
              const result = await data.approval(input.datasetId);
              current();
              return { kind: "approval" as const, ...result };
            }
            if (input.action === "setDefaults") {
              await data.setDefaults(input);
              current();
              return { kind: "grant-updated" as const };
            }
            if (input.action === "setGrant" || input.action === "removeGrant") {
              await data.setGrant(input);
              current();
              return { kind: "grant-updated" as const };
            }
            if (input.action === "list") {
              if (input.includeArchived)
                throw new Error("Open the original workspace to restore Collections.");
              const page = await data.list({ after: input.after, limit: input.limit });
              current();
              return { kind: "list" as const, ...(await addressPage(page)) };
            }
            if (input.action === "describe") {
              if (input.includeArchived)
                throw new Error("Open the original workspace to restore Collections.");
              const result = data.inspect
                ? await data.inspect(input.datasetId)
                : { dataset: await data.describe(input.datasetId) };
              current();
              return { kind: "description" as const, ...addressed(result) };
            }
            if (input.action === "types") {
              if (!dependencies.writePersonalTypes) throw datasetOwnerOnlyError();
              const description = await data.describe(input.datasetId);
              current();
              const path = await dependencies.writePersonalTypes(operation.workspace, description);
              current();
              return { kind: "types-written" as const, path, revision: description.revision };
            }
            if (input.action === "upload") {
              const result = await data.upload(input);
              current();
              return { kind: "uploaded" as const, ...result };
            }
            if (input.action === "file") {
              const result = await data.file(input);
              current();
              return { kind: "file" as const, ...result };
            }
            if (input.action === "invoke") {
              try {
                invokeSignal.throwIfAborted();
                const result = await data.invoke({ ...input, signal: invokeSignal });
                current();
                return { kind: "invoked" as const, ...DatasetInvocationResult.parse(result) };
              } catch (error) {
                current();
                if (isAppBackendRuntimeError(error))
                  return { kind: "refused" as const, ...error.refusal };
                throw error;
              }
            }
            throw new Error("This Collection action is unavailable.");
          }
          let shared: { workspaceId: string; data: RemoteDatasetData } | null = null;
          if (governs) {
            if (!dependencies.namedDataForWorkspace) throw datasetOwnerOnlyError();
            shared = (
              await dependencies.namedDataForWorkspace(operation.workspace, operation.signal)
            ).governance();
            current();
          }
          const authorityWorkspaceId = shared?.workspaceId ?? input.workspaceId;
          const writeSources = (files: Record<string, string>) => {
            if (!shared)
              return dependencies.createSources(operation.workspace, files, operation.signal);
            if (!dependencies.writeSharedSources) throw datasetOwnerOnlyError();
            return dependencies.writeSharedSources(operation.workspace, files, operation.signal);
          };
          if (
            agent &&
            agent.depth > 0 &&
            ["approve", "approveMigration", "confirmApproval"].includes(input.action)
          )
            throw new Error("Automations cannot approve Collection rules.");
          const approvalAgent = agent
            ? (agent.approvalAgent ?? {
                kind: "agent" as const,
                label: null,
                labelSource: "agent-declared" as const,
              })
            : undefined;
          // The local store opens only for work that uses it. It refuses on a computer that doesn't keep it.
          let opened: Promise<LocalDatasetHost> | undefined;
          const localHost = async () => {
            if (shared) throw datasetOwnerOnlyError();
            const host = await (opened ??= dependencies.hostForWorkspace(
              operation.workspace,
              operation.signal,
            ));
            current();
            return host;
          };
          if (input.action === "prepareRecovery") {
            const host = await localHost();
            const sourcePath =
              input.sourcePath ??
              (await dependencies.chooseRecoveryFile?.(operation.workspace, operation.signal));
            current();
            if (!sourcePath) return { kind: "recovery-prepared" as const, recovery: null };
            const recovery = await host.prepareRecovery({ sourcePath, signal: operation.signal });
            current();
            return { kind: "recovery-prepared" as const, recovery };
          }
          if (input.action === "claimRecovery") {
            const host = await localHost();
            if (input.sourceCursor.workspaceId !== input.workspaceId)
              throw new Error("This recovery belongs to another Collection.");
            const receipt = await host.claimRecovery(input);
            current();
            if (!receipt.targetCursor)
              throw new Error("Recovery has not activated this Collection. Retry recovery.");
            let datasetPath: string | null = null;
            let sourceError: string | undefined;
            try {
              await flushSourceCapture();
              current();
              invalidateDatasetAddresses({ workspaceId: input.workspaceId });
              // oxlint-disable-next-line typescript/await-thenable -- await kept: removing it changes scheduling
              const approved = await host.approvedArtifacts(receipt.targetCursor.datasetId);
              current();
              const description = {
                datasetId: approved.revision.datasetId,
                name: approved.revision.definition.name,
                revision: approved.revision.revision,
                revisionSha256: approved.revision.revisionSha256,
                tables: [],
                operations: [],
              };
              const [address] = await withSourceAdapter((adapter) =>
                addressDatasets(adapter, input.workspaceId, [description], operation.signal),
              );
              current();
              datasetPath = address?.datasetPath ?? null;
              if (!datasetPath) {
                const definition = approved.revision.definition;
                const folder = datasetBaseFolder(definition);
                datasetPath = folder === "." ? "dataset.json" : `${folder}/dataset.json`;
                const files = {
                  [definition.schemaPath]: approved.schemaSql,
                  [definition.operationsPath]: approved.operationSource,
                  [datasetPath]: JSON.stringify(definition, null, 2) + "\n",
                };
                const paths = Object.keys(files);
                const existing = await withSourceAdapter((adapter) =>
                  adapter.resolveFiles({
                    workspaceId: input.workspaceId,
                    versionId: "main",
                    targets: paths.map((path) => ({ path })),
                    signal: operation.signal,
                  }),
                );
                current();
                if (existing.results.some((file) => file.status === "invalid"))
                  throw new Error("Collection recovery has an invalid source path.");
                const present = new Set(
                  paths.filter((_path, index) => existing.results[index]?.status === "found"),
                );
                if (present.has(datasetPath))
                  throw new Error(
                    `Collection restored, but ${datasetPath} conflicts with its source. Move that file, then retry recovery.`,
                  );
                const missing = Object.fromEntries(
                  Object.entries(files).filter(([path]) => !present.has(path)),
                );
                await dependencies.createSources(operation.workspace, missing, operation.signal);
                current();
              }
            } catch (error) {
              current();
              datasetPath = null;
              sourceError =
                error instanceof Error
                  ? error.message.slice(0, 1024)
                  : "Restore its dataset.json source file to open the Collection.";
            }
            return {
              kind: "recovery-claimed" as const,
              ...receipt,
              targetCursor: receipt.targetCursor,
              datasetPath,
              ...(sourceError ? { sourceError } : {}),
            };
          }
          if (input.action === "discardRecovery") {
            await (await localHost()).discardRecovery(input.transferId);
            current();
            return { kind: "recovery-discarded" as const };
          }
          const readsData = [
            "list",
            "describe",
            "types",
            "sql",
            "trace",
            "createForm",
            "invoke",
            "upload",
            "file",
            "history",
            "historyRevision",
            "prepareHistoryRestore",
            "permissions",
            "setGrant",
            "setDefaults",
            "removeGrant",
            "lifecycle",
            "archive",
            "restore",
            "deletePreview",
            "delete",
            "pendingAttempts",
            "reconcileAttempt",
            "cancelAttempt",
            "prepareSchemaChange",
            "prepareRelationChoices",
            "prepareMigration",
            "askToApply",
            "approveMigration",
            "discardMigration",
            "migrationPreviewPage",
            "approval",
          ].includes(input.action);
          const openData = async () =>
            shared
              ? shared.data
              : readsData && dependencies.dataForWorkspace
                ? await dependencies.dataForWorkspace(operation.workspace, operation.signal)
                : await localHost();
          if (input.action === "list") {
            try {
              const data = await openData();
              current();
              const result = await data.list({
                after: input.after,
                limit: input.limit,
                includeArchived: input.includeArchived,
              });
              current();
              const approvedFolder = async (datasetId: string) =>
                datasetBaseFolder((await data.approvedArtifacts(datasetId)).revision.definition);
              return {
                kind: "list" as const,
                ...(await addressPage(result, approvedFolder)),
              };
            } catch (error) {
              current();
              const refusal = listRefusalOf(error);
              if (refusal === null) throw error;
              // The Explorer lists after every change. A refusal thrown here would reach Electron's log each time.
              return { kind: "collections-refused" as const, refusal };
            }
          }
          if (input.action === "approval" || input.action === "confirmApproval") {
            const governing = await dependencies.governanceForWorkspace?.(
              operation.workspace,
              input.datasetId,
              operation.signal,
            );
            current();
            if (!governing) {
              if (input.action === "confirmApproval")
                throw new Error(
                  "This Collection is kept on this computer. Its rules need no confirmation.",
                );
              const { revision } = await (await openData()).approvedArtifacts(input.datasetId);
              current();
              return {
                kind: "approval" as const,
                revisionSha256: revision.revisionSha256,
                approvedBy: null,
                needsOwnerConfirmation: false,
              };
            }
            const result =
              input.action === "approval"
                ? await governing.approval(input.datasetId)
                : await governing.confirmApproval(input.datasetId, input.revisionSha256);
            current();
            return { kind: "approval" as const, ...result };
          }
          const data = await openData();
          current();
          const lookupLocalApps = async (
            ids: readonly string[],
          ): Promise<Map<string, LocalAppRow> | null> => {
            if (shared) return null;
            if (
              operation.workspace.rootPath &&
              !(await localDatasetStoreExists(operation.workspace.rootPath))
            )
              return new Map();
            try {
              const apps = (await localHost()).apps;
              const map = new Map<string, LocalAppRow>();
              for (const id of ids) {
                const row = apps?.heldDatasetApp?.(id);
                if (row) map.set(id, row);
              }
              return map;
            } catch (error) {
              if (operation.signal.aborted) throw error;
              return null;
            }
          };
          const discoverBoundApps = async (
            datasetId: string,
            targetRevision: DatasetRevision | (() => Promise<DatasetRevision>),
            extra: {
              previousRevision?: DatasetRevision;
              initialPermissionsPage?: DatasetPermissionsPage;
            } = {},
          ) => {
            const found = await discoverDatasetBoundApps({
              datasetId,
              targetRevision,
              ...extra,
              permissionsPage:
                "permissions" in data && data.permissions
                  ? async () =>
                      data.permissions!({
                        action: "permissions",
                        workspaceId: input.workspaceId,
                        datasetId,
                        limit: 100,
                      })
                  : undefined,
              historyRevision:
                "historyRevision" in data && data.historyRevision
                  ? async (revisionSha256) => data.historyRevision!({ datasetId, revisionSha256 })
                  : undefined,
              lookupLocalApps,
              readShareLinkPublication: dependencies.readShareLinkPublication
                ? (pubId, sig) =>
                    dependencies.readShareLinkPublication!(operation.workspace, pubId, sig)
                : undefined,
              signal: operation.signal,
            });
            current();
            return {
              ...(found.boundApps.length > 0 ? { boundApps: found.boundApps } : {}),
              ...(found.boundAppsIncomplete ? { boundAppsIncomplete: true as const } : {}),
            };
          };
          const preparedWithBoundApps = async (prepared: LocalDatasetMigrationPreparation) => ({
            kind: "migration-prepared" as const,
            ...DatasetMigrationPreparation.parse({
              ...prepared,
              ...(await discoverBoundApps(prepared.revision.datasetId, prepared.revision, {
                previousRevision: prepared.previousRevision,
              })),
            }),
          });
          const descriptorAt = async (path: string) => {
            const [file] = await withSourceAdapter(async (adapter) =>
              adapter.hydrateCapturedSources(
                await adapter.captureSourceMetadata({
                  workspaceId: input.workspaceId,
                  versionId: "main",
                  paths: [path],
                  bounds: { maxInputFiles: 1, maxInputBytes: 256 * 1024 },
                  signal: operation.signal,
                }),
                operation.signal,
              ),
            );
            current();
            if (!file) throw new Error(`Collection source unavailable: ${path}.`);
            return parseDatasetDefinition(JSON.parse(new TextDecoder().decode(file.bytes)), {
              descriptorPath: path,
            });
          };
          const credentialGeneration = dependencies.currentCredentialGeneration?.();
          const migrationAuthority = {
            workspaceId: authorityWorkspaceId,
            sourceWorkspaceId: input.workspaceId,
            assertCurrent() {
              current();
              if (dependencies.currentCredentialGeneration?.() !== credentialGeneration)
                throw new Error("Your server session changed. Try again.");
            },
            approvedArtifacts: (datasetId: string) => data.approvedArtifacts(datasetId),
            prepareMigrationCandidate: (
              value: Parameters<NonNullable<OwnerDatasetData["prepareMigrationCandidate"]>>[0],
            ) => {
              migrationAuthority.assertCurrent();
              if (!data.prepareMigrationCandidate)
                throw new Error("Collection rule changes are unavailable on this host.");
              return data.prepareMigrationCandidate(value);
            },
            approveMigrationCandidate: (
              value: Parameters<NonNullable<OwnerDatasetData["approveMigrationCandidate"]>>[0],
            ) => {
              migrationAuthority.assertCurrent();
              if (!data.approveMigrationCandidate)
                throw new Error("Collection rule changes are unavailable on this host.");
              return data.approveMigrationCandidate({ ...value, approvalAgent });
            },
            discardMigrationCandidate: (
              value: Parameters<NonNullable<OwnerDatasetData["discardMigrationCandidate"]>>[0],
            ) => {
              migrationAuthority.assertCurrent();
              if (!data.discardMigrationCandidate)
                throw new Error("Collection rule changes are unavailable on this host.");
              return data.discardMigrationCandidate(value);
            },
          };
          if (
            input.action === "approveMigration" ||
            input.action === "discardMigration" ||
            input.action === "migrationPreviewPage"
          ) {
            const pending = migrations.get(input.preparationId);
            if (
              !pending ||
              pending.caller !== caller ||
              pending.workspaceId !== input.workspaceId ||
              pending.signal !== operation.signal ||
              pending.scope !== operation.scope ||
              pending.credentialGeneration !== credentialGeneration
            ) {
              throw new Error("This Collection review expired. Prepare the change again.");
            }
            const candidate = {
              workspaceId: authorityWorkspaceId,
              datasetId: pending.review.revision.datasetId,
              candidateId: pending.review.candidate.candidateId,
              signal: operation.signal,
            };
            if (input.action === "migrationPreviewPage") {
              if (pending.review.expiresAtMs <= Date.now() || !data.migrationPreviewPage)
                throw new Error("This Collection review expired. Prepare the change again.");
              const page = await data.migrationPreviewPage({
                ...candidate,
                after: input.after,
                limit: input.limit,
              });
              migrationAuthority.assertCurrent();
              return {
                kind: "migration-preview-page" as const,
                ...DatasetMigrationPreviewPage.parse(page),
              };
            }
            if (input.action === "discardMigration") {
              // Consume before any authority read or SQL, including an uncertain remote reply.
              pending.clear();
              await migrationAuthority.discardMigrationCandidate(candidate);
              migrationAuthority.assertCurrent();
              return { kind: "migration-discarded" as const };
            }
            const result = await onMainLocked(async () => {
              if (migrations.get(input.preparationId) !== pending)
                throw new Error("This Collection review expired. Prepare the change again.");
              // Consume before any authority read or SQL, including an uncertain remote reply.
              pending.clear();
              return approveLocalDatasetMigration(migrationAuthority, pending.review, {
                ...input,
                signal: operation.signal,
              });
            });
            migrationAuthority.assertCurrent();
            dependencies.collectionRulesChanged?.(input.workspaceId, candidate.datasetId);
            return { kind: "migrated" as const, ...result };
          }
          const prepareMigration = async (selection: {
            datasetId: string;
            descriptorPath: string;
            migrationPath: string | null;
          }) => {
            if (migrations.size + preparingMigrations >= 8)
              throw new Error(
                "Too many Collection changes await approval. Finish or discard a review.",
              );
            preparingMigrations++;
            const review = createLocalDatasetMigrations(migrationAuthority);
            try {
              if (!capturesFirst) {
                await flushSourceCapture();
                current();
              }
              const prepared = await withSourceAdapter(async (adapter) => {
                await onMain(adapter);
                return review.prepareMigration({ ...selection, adapter, signal: operation.signal });
              });
              migrationAuthority.assertCurrent();
              const { signal } = operation;
              const preparationId = prepared.preparationId;
              const clear = () => {
                migrations.delete(preparationId);
                signal.removeEventListener("abort", expire);
                clearTimeout(timer);
              };
              const expire = () => {
                clear();
              };
              const timer = setTimeout(expire, Math.max(0, prepared.expiresAtMs - Date.now()));
              timer.unref();
              migrations.set(prepared.preparationId, {
                caller,
                workspaceId: input.workspaceId,
                signal: operation.signal,
                scope: operation.scope,
                credentialGeneration,
                review: structuredClone(prepared),
                clear,
              });
              operation.signal.addEventListener("abort", expire, { once: true });
              return prepared;
            } finally {
              review.clear();
              preparingMigrations--;
            }
          };
          if (input.action === "deletePreview") {
            if (!data.deletePreview)
              throw new Error("Collection deletion is unavailable. Update dohc and try again.");
            const result = DatasetDeletePreview.parse(await data.deletePreview(input));
            current();
            if (
              result.cursor.workspaceId !== input.workspaceId ||
              result.cursor.datasetId !== input.datasetId
            )
              throw new Error("This deletion review belongs to another Collection.");
            return { kind: "delete-preview" as const, ...result };
          }
          if (input.action === "delete") {
            if (
              input.expected.workspaceId !== input.workspaceId ||
              input.expected.datasetId !== input.datasetId
            )
              throw new Error("This deletion belongs to another Collection.");
            if (!data.deleteDataset)
              throw new Error("Collection deletion is unavailable. Update dohc and try again.");
            const result = DatasetDeleted.parse(await data.deleteDataset(input));
            current();
            if (result.datasetId !== input.datasetId)
              throw new Error(
                "dohc did not confirm this Collection deletion. Refresh the Collection.",
              );
            return { kind: "deleted" as const, ...result };
          }
          if (input.action === "lifecycle") {
            if (!data.lifecycle) throw new Error("Collection archive controls are unavailable.");
            const result = await data.lifecycle(input);
            current();
            return { kind: "lifecycle" as const, ...result };
          }
          if (input.action === "archive" || input.action === "restore") {
            const action = data[input.action];
            if (!action) throw new Error("Collection archive controls are unavailable.");
            const result = await action(input);
            current();
            return { kind: "lifecycle-updated" as const, ...result };
          }
          if (input.action === "pendingAttempts") {
            if (!data.pendingAttempts) throw new Error("Pending submission review is unavailable.");
            const result = await data.pendingAttempts(input);
            current();
            return { kind: "pending-attempts" as const, ...result };
          }
          if (input.action === "reconcileAttempt") {
            if (!data.reconcileAttempt)
              throw new Error("Pending submission review is unavailable.");
            const result = await data.reconcileAttempt(input);
            current();
            return { kind: "attempt-reconciled" as const, ...result };
          }
          if (input.action === "cancelAttempt") {
            if (!data.cancelAttempt)
              throw new Error("Pending submission cancellation is unavailable.");
            const result = await data.cancelAttempt(input);
            current();
            return { kind: "attempt-cancelled" as const, ...result };
          }
          if (input.action === "historyRevision") {
            if (!data.historyRevision)
              throw new Error(
                "Saved Collection rules are unavailable. Update the host and try again.",
              );
            const result = DatasetHistoryRevision.parse(await data.historyRevision(input));
            current();
            if (
              result.revision.datasetId !== input.datasetId ||
              result.revision.revisionSha256 !== input.revisionSha256
            )
              throw new Error("This revision belongs to another Collection change.");
            return {
              kind: "history-revision" as const,
              ...result,
              generatedSources: hasGeneratedDatasetSources(result.revision, result.schemaSql),
            };
          }
          if (input.action === "prepareHistoryRestore") {
            if (!data.historyRevision)
              throw new Error(
                "Saved Collection rules are unavailable. Update the host and try again.",
              );
            await requireMain();
            const approved = await data.approvedArtifacts(input.datasetId);
            current();
            if (
              !approved.active ||
              approved.revision.revision !== input.revision ||
              approved.revision.revisionSha256 !== input.revisionSha256
            )
              throw new Error("The Collection changed. Refresh History before restoring rules.");
            const saved = await data.historyRevision({
              datasetId: input.datasetId,
              revisionSha256: input.targetRevisionSha256,
            });
            current();
            if (saved.revision.revisionSha256 !== input.targetRevisionSha256)
              throw new Error("The saved rules differ from this selection. Refresh History.");
            const changed = await data.historyRevision({
              datasetId: input.datasetId,
              revisionSha256: input.changedRevisionSha256,
            });
            current();
            if (changed.revision.revisionSha256 !== input.changedRevisionSha256)
              throw new Error("The selected change differs from History. Refresh History.");
            const generated = generateDatasetHistoryRestore(approved, saved, changed);
            const expected = describeDatasetRevision({
              definition: generated.definition,
              revision: approved.revision.revision + 1,
              schemaSql: generated.schemaSql,
              operationSource: generated.operationSource,
            });
            await onMainLocked(() =>
              dependencies.createSources(operation.workspace, generated.files, operation.signal),
            );
            current();
            const prepared = await prepareMigration({
              datasetId: input.datasetId,
              descriptorPath: generated.descriptorPath,
              migrationPath: generated.migrationPath,
            });
            current();
            if (
              prepared.previousRevision.revisionSha256 !== approved.revision.revisionSha256 ||
              prepared.revision.revisionSha256 !== expected.revisionSha256 ||
              prepared.migrationSql !== generated.migrationSql
            ) {
              migrations.get(prepared.preparationId)?.clear();
              await migrationAuthority.discardMigrationCandidate({
                workspaceId: authorityWorkspaceId,
                datasetId: input.datasetId,
                candidateId: prepared.candidate.candidateId,
                signal: operation.signal,
              });
              throw new Error(
                "The Collection changed while preparing this restore. Refresh History and review it again.",
              );
            }
            return await preparedWithBoundApps(prepared);
          }
          if (input.action === "history") {
            if (!("history" in data) || !data.history)
              throw new Error("Collection history is unavailable. Restart dohc and try again.");
            const result = await data.history(input);
            current();
            // History names each automation as its Collection names it now.
            const names = new Map<string, string | null>();
            for (const entry of result.entries) {
              const automationId = entry.automation?.automationId;
              if (automationId !== undefined && !names.has(automationId))
                names.set(
                  automationId,
                  (await dependencies.automationName?.(operation.workspace, automationId)) ?? null,
                );
            }
            current();
            const entries = result.entries.map((entry) => {
              const name = entry.automation && names.get(entry.automation.automationId);
              return name && entry.automation
                ? { ...entry, automation: { ...entry.automation, name } }
                : entry;
            });
            const people = dependencies.historyPeople?.(caller, operation.workspace);
            if (!people) return { kind: "history" as const, ...result, entries };
            const appRoot = async (publicationId: string) => {
              const held = (await lookupLocalApps([publicationId]))?.get(publicationId);
              if (held) return held.appRoot;
              const shared = await dependencies.readShareLinkPublication?.(
                operation.workspace,
                publicationId,
                AbortSignal.any([operation.signal, AbortSignal.timeout(5_000)]),
              );
              return shared?.active && !shared.operatorTakedown && shared.linkCurrent !== false
                ? parseAppPublicationCandidate(shared.candidate, APP_PUBLICATION_LIMITS).appRoot
                : null;
            };
            const named = await collectionHistoryAuthors(entries, {
              ...people,
              app: async (publicationId) => {
                const root = await appRoot(publicationId);
                return root === null ? null : root.slice(root.lastIndexOf("/") + 1);
              },
            });
            current();
            return { kind: "history" as const, ...result, entries: named };
          }
          if (input.action === "permissions") {
            if (!("permissions" in data) || !data.permissions)
              throw new Error("Collection access is unavailable on this computer.");
            const result = await data.permissions(input);
            current();
            const place = await dependencies.collectionPlace?.(
              operation.workspace,
              input.datasetId,
              operation.signal,
            );
            current();
            const bound =
              input.after === undefined
                ? await discoverBoundApps(
                    input.datasetId,
                    async () => (await data.approvedArtifacts(input.datasetId)).revision,
                    { initialPermissionsPage: result },
                  )
                : {};
            return {
              kind: "permissions" as const,
              ...result,
              ...(place ? { place } : {}),
              ...bound,
            };
          }
          if (
            input.action === "setGrant" ||
            input.action === "removeGrant" ||
            input.action === "setDefaults"
          ) {
            // A person reaches a Collection through the workspace's server.
            if (input.action !== "removeGrant") {
              const place = await dependencies.collectionPlace?.(
                operation.workspace,
                input.datasetId,
                operation.signal,
              );
              current();
              if (place?.kind === "here")
                throw new Error("Sync this workspace with a server before giving a person access.");
            }
            if (input.action === "setDefaults") {
              if (!("setDefaults" in data) || !data.setDefaults)
                throw new Error("Collection access is unavailable on this computer.");
              await data.setDefaults(input);
            } else {
              if (!("setGrant" in data) || !data.setGrant)
                throw new Error("Collection access is unavailable on this computer.");
              await data.setGrant(input);
            }
            current();
            return { kind: "grant-updated" as const };
          }
          if (input.action === "describe") {
            const result =
              "inspect" in data && data.inspect
                ? await data.inspect(input.datasetId, { includeArchived: input.includeArchived })
                : {
                    dataset: await data.describe(input.datasetId, {
                      includeArchived: input.includeArchived,
                    }),
                  };
            current();
            return { kind: "description" as const, ...addressed(result) };
          }
          if (input.action === "types") {
            const { revision } = await data.approvedArtifacts(input.datasetId);
            current();
            if (!operation.workspace.rootPath)
              throw new Error(
                "Open this workspace's folder on this computer to write Collection types.",
              );
            const path = await writeDatasetTypes(operation.workspace.rootPath, revision);
            current();
            return { kind: "types-written" as const, path, revision: revision.revision };
          }
          if (input.action === "sql") {
            if (!("querySql" in data) || !data.querySql)
              throw new Error(
                "Read-only SQL inspection needs a local Collection or a synced Collection copy on this computer.",
              );
            const result = await data
              .querySql({
                datasetId: input.datasetId,
                sql: input.sql,
                params: input.params,
                explain: input.explain,
                limit: input.limit,
                signal: operation.signal,
              })
              .catch((error: unknown) => {
                const code = (error as { code?: unknown } | undefined)?.code;
                if (
                  error instanceof Error &&
                  error.name === "PersistentRuntimeError" &&
                  (code === "invalid_input" || code === "not_authorized")
                )
                  throw new Error(error.message);
                throw error;
              });
            current();
            return { kind: "sql" as const, ...result };
          }
          if (input.action === "trace") {
            if (!("trace" in data) || !data.trace)
              throw new Error("Operation traces are unavailable for this Collection.");
            const result = await data.trace({
              datasetId: input.datasetId,
              limit: input.limit,
            });
            current();
            return { kind: "trace" as const, ...result };
          }
          if (input.action === "upload") {
            const description = await data.describe(input.datasetId);
            current();
            if (
              !description.tables.some((table) =>
                table.fields.some(
                  (field) => field.fieldId === input.fieldId && field.type === "attachment",
                ),
              ) ||
              !description.operations.some(
                (action) => !action.readOnly && action.fieldIds.includes(input.fieldId),
              )
            )
              throw new Error("Choose an editable Collection file field.");
            const result = await data.upload({ ...input, signal: operation.signal });
            current();
            return { kind: "uploaded" as const, ...result };
          }
          if (input.action === "file") {
            const result = await data.file({ ...input, signal: operation.signal });
            current();
            return { kind: "file" as const, ...result };
          }
          if (input.action === "createForm") {
            const approved = await data.approvedArtifacts(input.datasetId);
            current();
            if (
              !approved.active ||
              approved.revision.revision !== input.revision ||
              approved.revision.revisionSha256 !== input.revisionSha256
            ) {
              throw new Error(
                "Collection rules changed. Reload the Collection before creating a form.",
              );
            }
            const generated = generateDatasetFormSources({
              ...input,
              datasetPath: "datasetPath" in request ? request.datasetPath : "",
              approvedRevision: approved.revision,
            });
            const files = Object.fromEntries(
              Object.entries(generated.files).map(([path, source]) => [
                `${input.appRoot}/${path}`,
                source,
              ]),
            );
            let created: string[] = [];
            let failedStage: CreationStage = "write";
            let rulesChanged = false;
            formFailure = (error) => {
              if (created.length === 0) throw error;
              const remove =
                rulesChanged ||
                error instanceof SourceCreationConflict ||
                error instanceof CreatedFileWriteError;
              return (formPartial = {
                kind: "partial",
                created,
                failedStage: error instanceof DatasetScopeError ? "scope" : failedStage,
                reason: error instanceof Error ? error.message : String(error),
                retry: {
                  mode: remove ? "remove-and-retry" : "resume",
                  instruction: remove
                    ? "Review the listed files in Files, then remove them. Reload the Collection and create the form in an empty folder."
                    : "Try again with the same form settings and folder. dohc keeps matching files and creates only missing files.",
                },
              });
            };
            try {
              await dependencies.createSources(
                operation.workspace,
                files,
                operation.signal,
                (stage, paths) => {
                  failedStage = stage;
                  created = [...paths];
                },
              );
              created = Object.keys(files);
              current();
              failedStage = "revision";
              const latest = await data.approvedArtifacts(input.datasetId);
              current();
              if (!latest.active || latest.revision.revisionSha256 !== input.revisionSha256) {
                rulesChanged = true;
                throw new Error("Collection rules changed.");
              }
              return { kind: "form-created" as const, appRoot: input.appRoot, paths: created };
            } catch (error) {
              return formFailure(error);
            }
          }
          if (input.action === "discard") {
            (await localHost()).discard(input.preparationId);
            return { kind: "discarded" as const };
          }
          if (input.action === "prepareSchemaChange" || input.action === "prepareRelationChoices") {
            await requireMain();
            const approved = await data.approvedArtifacts(input.datasetId);
            current();
            if (!approved.active)
              throw new Error(
                "This Collection is unavailable. Reconnect to its host and try again.",
              );
            if (
              approved.revision.revision !== input.revision ||
              approved.revision.revisionSha256 !== input.revisionSha256
            )
              throw new Error(
                "Collection rules changed. Refresh the Collection before changing fields.",
              );
            const changed =
              input.action === "prepareSchemaChange"
                ? generateDatasetSchemaChange({ ...approved, change: input.change })
                : generateDatasetRelationChoices({
                    ...approved,
                    tableId: input.tableId,
                    fieldId: input.fieldId,
                    labelFieldId: input.labelFieldId,
                  });
            const generated =
              shared && "datasetPath" in request
                ? inPlace(changed, request.datasetPath, await descriptorAt(request.datasetPath))
                : changed;
            const expected = describeDatasetRevision({
              definition: generated.definition,
              revision: input.revision + 1,
              schemaSql: generated.schemaSql,
              operationSource: generated.operationSource,
            });
            await onMainLocked(() => writeSources(generated.files));
            current();
            const prepared = await prepareMigration({
              datasetId: input.datasetId,
              descriptorPath: generated.descriptorPath,
              migrationPath: generated.migrationPath,
            });
            current();
            if (
              prepared.previousRevision.revisionSha256 !== input.revisionSha256 ||
              prepared.revision.revisionSha256 !== expected.revisionSha256 ||
              prepared.migrationSql !== generated.migrationSql
            ) {
              migrations.get(prepared.preparationId)?.clear();
              await migrationAuthority.discardMigrationCandidate({
                workspaceId: authorityWorkspaceId,
                datasetId: input.datasetId,
                candidateId: prepared.candidate.candidateId,
                signal: operation.signal,
              });
              throw new Error(
                "The Collection change differs from this review. Refresh the Collection and prepare it again.",
              );
            }
            return await preparedWithBoundApps(prepared);
          }
          if (input.action === "prepareMigration") {
            if (request.action !== "prepareMigration")
              throw new Error("This Collection review changed. Prepare it again.");
            const prepared = await prepareMigration({
              ...input,
              descriptorPath: request.datasetPath,
              migrationPath: input.migrationPath ?? null,
            });
            current();
            return await preparedWithBoundApps(prepared);
          }
          if (input.action === "askToApply") {
            if (request.action !== "askToApply")
              throw new Error("This Collection request changed. Ask again.");
            const migrationPath = input.migrationPath ?? null;
            const prepared = await prepareMigration({
              datasetId: input.datasetId,
              descriptorPath: request.datasetPath,
              migrationPath,
            });
            let proposal: ReturnType<typeof collectionChangeProposal>;
            // The file records the change; the person who applies it prepares it again.
            try {
              proposal = collectionChangeProposal(prepared, {
                datasetPath: request.datasetPath,
                migrationPath,
                note: input.note ?? null,
              });
            } finally {
              migrations.get(prepared.preparationId)?.clear();
              await migrationAuthority.discardMigrationCandidate({
                workspaceId: authorityWorkspaceId,
                datasetId: input.datasetId,
                candidateId: prepared.candidate.candidateId,
                signal: operation.signal,
              });
            }
            current();
            const folder = request.datasetPath.includes("/")
              ? request.datasetPath.slice(0, request.datasetPath.lastIndexOf("/") + 1)
              : "";
            const path = `${folder}changes/${randomUUID()}.json`;
            await dependencies.createSources(
              operation.workspace,
              {
                [path]: `${JSON.stringify(proposal, null, 2)}
`,
              },
              operation.signal,
            );
            current();
            return { kind: "change-asked" as const, path, changeSha256: proposal.changeSha256 };
          }
          if (input.action === "invoke") {
            try {
              invokeSignal.throwIfAborted();
              const result = await data.invoke({
                ...input,
                signal: invokeSignal,
                ...(agent === null ? {} : { agent }),
              });
              current();
              return { kind: "invoked" as const, ...DatasetInvocationResult.parse(result) };
            } catch (error) {
              current();
              if (isAppBackendRuntimeError(error))
                return { kind: "refused" as const, ...error.refusal };
              throw error;
            }
          }
          if (input.action === "create" && shared) {
            const generated = generateDatasetSources(input.definition);
            const schemaSql = generated.files[generated.definition.schemaPath]!,
              operationSource = generated.files[generated.definition.operationsPath]!;
            const revision = describeDatasetRevision({
              definition: generated.definition,
              revision: 1,
              schemaSql,
              operationSource,
            });
            await onMainLocked(() => writeSources(generated.files));
            current();
            const approved = await shared.data.activate({
              revision,
              schemaSql,
              operationSource,
              approvalAgent,
            });
            current();
            return { kind: "approved" as const, revision: approved };
          }
          const host = await localHost();
          if (input.action === "approve") {
            const revision = await onMainLocked(() =>
              host.approve({
                ...input,
                approvalAgent,
                signal: operation.signal,
              }),
            );
            current();
            return { kind: "approved" as const, revision };
          }
          let descriptorPath: string;
          let expectedRevision: string | undefined;
          if (input.action === "create") {
            const generated = generateDatasetSources(input.definition);
            expectedRevision = describeDatasetRevision({
              definition: generated.definition,
              revision: 1,
              schemaSql: generated.files[generated.definition.schemaPath]!,
              operationSource: generated.files[generated.definition.operationsPath]!,
            }).revisionSha256;
            descriptorPath = Object.keys(generated.files).find(
              (path) => path === "dataset.json" || path.endsWith("/dataset.json"),
            )!;
            await onMainLocked(() =>
              dependencies.createSources(operation.workspace, generated.files, operation.signal),
            );
            current();
          } else {
            descriptorPath = input.descriptorPath;
            await flushSourceCapture();
            current();
          }
          const prepared = await withSourceAdapter(async (adapter) => {
            await onMain(adapter);
            return host.prepare({ descriptorPath, adapter, signal: operation.signal });
          });
          current();
          if (input.action === "prepare")
            return { kind: "prepared" as const, ...DatasetPreparation.parse(prepared) };
          if (prepared.revision.revisionSha256 !== expectedRevision) {
            host.discard(prepared.preparationId);
            throw new Error(
              "Collection source differs from these fields. Choose another folder or review the saved source.",
            );
          }
          // The creation control approves the generated fields and actions it just displayed.
          const revision = await onMainLocked(() =>
            host.approve({
              preparationId: prepared.preparationId,
              revisionSha256: prepared.revision.revisionSha256,
              approvalAgent,
              signal: operation.signal,
            }),
          );
          current();
          return { kind: "approved" as const, revision };
        },
      );
    } catch (error) {
      if (formPartial) return formPartial;
      if (formFailure) return formFailure(new DatasetScopeError(error));
      throw error;
    } finally {
      if (invocationId) invocations.delete(invocationId);
    }
  };
}
