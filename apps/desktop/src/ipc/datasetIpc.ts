import type { CreationStage, CreationPartial } from "@dohc/cli/creation";
import { CreatedFileWriteError } from "../workspaces/workspaceFiles";
import { SourceCreationConflict, type SourceCreationProgress } from "../workspaces/datasetSourceCreation";
import { DatasetRequest, DatasetHistoryRevision, DatasetInvocationResult, DatasetPreparation, DatasetMigrationPreparation, DatasetMigrationPreviewPage , DatasetDeletePreview, DatasetDeleted } from "@dohc/cli/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { LocalDatasetAgent, LocalDatasetHost } from "../workspaces/localDatasetHost";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetFormSources } from "../workspaces/datasetFormGenerator";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { OwnerDatasetData } from "../workspaces/remoteDataset";
import { approveLocalDatasetMigration, createLocalDatasetMigrations, type LocalDatasetMigrationPreparation } from "../workspaces/localDatasetMigration";
import { generateDatasetHistoryRestore } from "../workspaces/datasetHistoryRestore";
import { generateDatasetSchemaChange } from "../workspaces/datasetSchemaChanges";
import { generateDatasetRelationChoices } from "../workspaces/datasetRelationChoices";
import { DatasetAddressUnavailableError, addressDatasets, resolveDatasetAddress, invalidateDatasetAddresses, type ResolvedDatasetRequest } from "../workspaces/datasetAddress";


type Workspace = { workspaceId: string; shareView?: unknown };
type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata" | "workspace">;
type Operation<W extends Workspace> = { workspace: W; signal: AbortSignal; scope?: string; assertCurrent(): void };

class DatasetScopeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The desktop and owner CLI enter the same workspace authority before using data. */
export function createDatasetHandler<Caller, W extends Workspace, O extends Operation<W>>(dependencies: {
  withWorkspaceOperation<T>(caller: Caller, workspaceId: string, work: (operation: O) => Promise<T>): Promise<T>;
  hostForWorkspace(workspace: W, signal: AbortSignal): Promise<LocalDatasetHost>;
  /** Resolves the dataset's current authority. Remote failures must never fall back to local writes. */
  dataForWorkspace?(workspace: W, signal: AbortSignal): Promise<OwnerDatasetData>;
  currentCredentialGeneration?(): number;
  namedDataForWorkspace?(workspace: W, signal: AbortSignal): Promise<Pick<OwnerDatasetData, "list" | "describe" | "inspect" | "invoke" | "upload" | "file">>;
  chooseRecoveryFile?(workspace: W, signal: AbortSignal): Promise<string | null>;
  exportArchive?(workspace: W, request: Extract<ResolvedDatasetRequest, { action: "export" }>, signal: AbortSignal, authorize: () => void): Promise<string | null>;
  /** Reconciles disk edits before capturing immutable source for review. */
  flushSourceCapture(workspace: W, signal: AbortSignal): Promise<void>;
  withAdapter<T>(workspace: W, work: (adapter: SourceAdapter) => Promise<T>): Promise<T>;
  /** Creates absent files through the workspace engine and settles their source capture. */
  createSources(workspace: W, files: Record<string, string>, signal: AbortSignal, progress?: SourceCreationProgress): Promise<void>;
  /** An automation's name in its Collection's automations.yaml now, or null. */
  automationName?(workspace: W, automationId: string): Promise<string | null>;
}) {
  const migrations = new Map<string, { caller: Caller; workspaceId: string; signal: AbortSignal; scope?: string; credentialGeneration?: number; review: LocalDatasetMigrationPreparation; clear(): void }>();
  let preparingMigrations = 0;
  /**
   * `agent` is set only by the owner CLI, from the actor main derived for the
   * call, never from the request, so the agent's local invocation names it
   * and carries its run's chain on.
   */
  return async (caller: Caller, raw: unknown, agent: LocalDatasetAgent | null = null) => {
    const request = DatasetRequest.parse(raw);
    let formFailure: ((error: unknown) => CreationPartial) | undefined;
    let formPartial: CreationPartial | undefined;
    try {
      return await dependencies.withWorkspaceOperation(caller, request.workspaceId, async operation => {
      const current = () => {
        try { operation.signal.throwIfAborted(); operation.assertCurrent(); }
        catch (error) { throw new DatasetScopeError(error); }
      };
      current();
      let input: ResolvedDatasetRequest;
      if ("datasetPath" in request) {
        if (request.action === "prepareMigration") {
          await dependencies.flushSourceCapture(operation.workspace, operation.signal);
          current();
          invalidateDatasetAddresses({ workspaceId: request.workspaceId });
        }
        const resolve = () => dependencies.withAdapter(operation.workspace, adapter => resolveDatasetAddress(adapter, request.workspaceId, request.datasetPath, operation.signal));
        const datasetId = await resolve().catch(async error => {
          current();
          if (!(error instanceof DatasetAddressUnavailableError) || request.action === "prepareMigration" || shareViewIsPresent(operation.workspace.shareView)) throw error;
          await dependencies.flushSourceCapture(operation.workspace, operation.signal);
          current();
          invalidateDatasetAddresses({ workspaceId: request.workspaceId });
          return resolve();
        }).catch(error => {
          current();
          if (shareViewIsPresent(operation.workspace.shareView) && error instanceof DatasetAddressUnavailableError) {
            throw new Error(`Collection source unavailable: ${request.datasetPath}. Ask the owner to include its dataset.json file in this share.`);
          }
          throw error;
        });
        current();
        if (request.expectedDatasetId && request.expectedDatasetId !== datasetId) throw new Error("This Collection moved. Reopen it.");
        const { datasetPath: _, expectedDatasetId: _expected, ...fields } = request;
        input = { ...fields, datasetId };
      } else input = request;
      const addressPage = async (page: { datasets: import("@dohc/security-contract/dataset").DatasetDescription[]; nextCursor: string | null }) => {
        const datasets = await dependencies.withAdapter(operation.workspace, adapter => addressDatasets(adapter, request.workspaceId, page.datasets, operation.signal));
        current();
        return { ...page, datasets };
      };
      const addressed = <T extends { dataset: import("@dohc/security-contract/dataset").DatasetDescription }>(result: T) => ({ ...result, dataset: { ...result.dataset, datasetPath: "datasetPath" in request ? request.datasetPath : null } });
      if (input.action === "export") {
        if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Open the original workspace to manage this Collection.");
        if (!dependencies.exportArchive) throw new Error("Collection recovery export is unavailable. Restart dohc and try again.");
        const savedPath = await dependencies.exportArchive(operation.workspace, input, operation.signal, current);
        current();
        return { kind: "exported" as const, savedPath };
      }
      if (shareViewIsPresent(operation.workspace.shareView)) {
        if (!dependencies.namedDataForWorkspace || !["list", "describe", "invoke", "upload", "file"].includes(input.action)) throw new Error("Open the original workspace to manage this Collection.");
        const data = await dependencies.namedDataForWorkspace(operation.workspace, operation.signal);
        current();
        if (input.action === "list") { if(input.includeArchived)throw new Error("Open the original workspace to restore Collections."); const page = await data.list({ after: input.after, limit: input.limit }); current(); return { kind: "list" as const, ...await addressPage(page) }; }
        if (input.action === "describe") { if(input.includeArchived)throw new Error("Open the original workspace to restore Collections."); const result = data.inspect ? await data.inspect(input.datasetId) : { dataset: await data.describe(input.datasetId) }; current(); return { kind: "description" as const, ...addressed(result) }; }
        if (input.action === "upload") { const result = await data.upload(input); current(); return { kind: "uploaded" as const, ...result }; }
        if (input.action === "file") { const result = await data.file(input); current(); return { kind: "file" as const, ...result }; }
        if (input.action === "invoke") {
          try { const result = await data.invoke({ ...input, signal: operation.signal }); current(); return { kind: "invoked" as const, ...DatasetInvocationResult.parse(result) }; }
          catch (error) { current(); if (isAppBackendRuntimeError(error)) return { kind: "refused" as const, ...error.refusal }; throw error; }
        }
        throw new Error("This Collection action is unavailable.");
      }
      const host = await dependencies.hostForWorkspace(operation.workspace, operation.signal);
      current();
      if (input.action === "prepareRecovery") {
        const sourcePath = input.sourcePath ?? await dependencies.chooseRecoveryFile?.(operation.workspace,operation.signal);
        current();
        if (!sourcePath) return { kind: "recovery-prepared" as const, recovery:null };
        const recovery = await host.prepareRecovery({sourcePath,signal:operation.signal}); current();
        return { kind: "recovery-prepared" as const, recovery };
      }
      if (input.action === "claimRecovery") {
        if(input.sourceCursor.workspaceId!==input.workspaceId) throw new Error("This recovery belongs to another Collection.");
        const receipt = await host.claimRecovery(input); current();
        if (!receipt.targetCursor) throw new Error("Recovery has not activated this Collection. Retry recovery.");
        let datasetPath: string | null = null;
        let sourceError: string | undefined;
        try {
          await dependencies.flushSourceCapture(operation.workspace, operation.signal); current();
          invalidateDatasetAddresses({ workspaceId: input.workspaceId });
          const approved = await host.approvedArtifacts(receipt.targetCursor.datasetId); current();
          const description = { datasetId: approved.revision.datasetId, name: approved.revision.definition.name,
            revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256, tables: [], operations: [] };
          datasetPath = await dependencies.withAdapter(operation.workspace, async adapter => {
            const [address] = await addressDatasets(adapter, input.workspaceId, [description], operation.signal);
            current();
            return address?.datasetPath ?? null;
          });
          current();
          if (!datasetPath) {
            const definition = approved.revision.definition;
            datasetPath = definition.schemaPath.slice(0, definition.schemaPath.lastIndexOf("/") + 1) + "dataset.json";
            const files = { [definition.schemaPath]: approved.schemaSql, [definition.operationsPath]: approved.operationSource,
              [datasetPath]: JSON.stringify(definition, null, 2) + "\n" };
            const existing = await dependencies.withAdapter(operation.workspace, adapter => adapter.listTextFileMetadata({ workspaceId: input.workspaceId, versionId: "main" }));
            current();
            if (existing.some(file => file.path === datasetPath)) throw new Error(`Collection restored, but ${datasetPath} conflicts with its source. Move that file, then retry recovery.`);
            const missing = Object.fromEntries(Object.entries(files).filter(([path]) => !existing.some(file => file.path === path)));
            await dependencies.createSources(operation.workspace, missing, operation.signal); current();
          }
        } catch (error) {
          current();
          datasetPath = null;
          sourceError = error instanceof Error ? error.message.slice(0, 1024) : "Restore its dataset.json source file to open the Collection.";
        }
        return {kind:"recovery-claimed" as const,...receipt,targetCursor:receipt.targetCursor,datasetPath,...(sourceError ? { sourceError } : {})};
      }
      if (input.action === "discardRecovery") { await host.discardRecovery(input.transferId); current(); return {kind:"recovery-discarded" as const}; }
      const readsData = ["list", "describe", "createForm", "invoke", "upload", "file", "history", "historyRevision", "prepareHistoryRestore", "permissions", "setGrant", "removeGrant", "lifecycle", "archive", "restore", "deletePreview", "delete", "pendingAttempts", "reconcileAttempt", "cancelAttempt", "prepareSchemaChange", "prepareRelationChoices", "prepareMigration", "approveMigration", "discardMigration", "migrationPreviewPage"].includes(input.action);
      const data = readsData && dependencies.dataForWorkspace ? await dependencies.dataForWorkspace(operation.workspace, operation.signal) : host;
      current();
      const credentialGeneration = dependencies.currentCredentialGeneration?.();
      const migrationAuthority = {
        workspaceId: input.workspaceId,
        assertCurrent() {
          current();
          if (dependencies.currentCredentialGeneration?.() !== credentialGeneration) throw new Error("Your server session changed. Try again.");
        },
        approvedArtifacts: (datasetId: string) => data.approvedArtifacts(datasetId),
        prepareMigrationCandidate: (value: Parameters<NonNullable<OwnerDatasetData["prepareMigrationCandidate"]>>[0]) => {
          migrationAuthority.assertCurrent();
          if (!data.prepareMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host.");
          return data.prepareMigrationCandidate(value);
        },
        approveMigrationCandidate: (value: Parameters<NonNullable<OwnerDatasetData["approveMigrationCandidate"]>>[0]) => {
          migrationAuthority.assertCurrent();
          if (!data.approveMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host.");
          return data.approveMigrationCandidate(value);
        },
        discardMigrationCandidate: (value: Parameters<NonNullable<OwnerDatasetData["discardMigrationCandidate"]>>[0]) => {
          migrationAuthority.assertCurrent();
          if (!data.discardMigrationCandidate) throw new Error("Collection rule changes are unavailable on this host.");
          return data.discardMigrationCandidate(value);
        },
      };
      if (input.action === "approveMigration" || input.action === "discardMigration" || input.action === "migrationPreviewPage") {
        const pending = migrations.get(input.preparationId);
        if (!pending || pending.caller !== caller || pending.workspaceId !== input.workspaceId || pending.signal !== operation.signal || pending.scope !== operation.scope || pending.credentialGeneration !== credentialGeneration) {
          throw new Error("This Collection review expired. Prepare the change again.");
        }
        const candidate = { workspaceId: input.workspaceId, datasetId: pending.review.revision.datasetId, candidateId: pending.review.candidate.candidateId, signal: operation.signal };
        if (input.action === "migrationPreviewPage") {
          if (pending.review.expiresAtMs <= Date.now() || !data.migrationPreviewPage) throw new Error("This Collection review expired. Prepare the change again.");
          const page = await data.migrationPreviewPage({ ...candidate, after: input.after, limit: input.limit });
          migrationAuthority.assertCurrent();
          return { kind: "migration-preview-page" as const, ...DatasetMigrationPreviewPage.parse(page) };
        }
        // Consume before any authority read or SQL, including an uncertain remote reply.
        pending.clear();
        if (input.action === "discardMigration") { await migrationAuthority.discardMigrationCandidate(candidate); migrationAuthority.assertCurrent(); return { kind: "migration-discarded" as const }; }
        const result = await approveLocalDatasetMigration(migrationAuthority, pending.review, { ...input, signal: operation.signal }); migrationAuthority.assertCurrent();
        return { kind: "migrated" as const, ...result };
      }
      const prepareMigration = async (selection: { datasetId: string; descriptorPath: string; migrationPath: string }) => {
        if (migrations.size + preparingMigrations >= 8) throw new Error("Too many Collection changes await approval. Finish or discard a review.");
        preparingMigrations++;
        const review = createLocalDatasetMigrations(migrationAuthority);
        try {
          if (request.action !== "prepareMigration") { await dependencies.flushSourceCapture(operation.workspace, operation.signal); current(); }
          const prepared = await dependencies.withAdapter(operation.workspace, adapter => review.prepareMigration({ ...selection, adapter, signal: operation.signal }));
          migrationAuthority.assertCurrent();
          const { signal } = operation;
          const preparationId = prepared.preparationId;
          const clear = () => { migrations.delete(preparationId); signal.removeEventListener("abort", expire); clearTimeout(timer); };
          const expire = () => { clear(); };
          const timer = setTimeout(expire, Math.max(0, prepared.expiresAtMs - Date.now())); timer.unref();
          migrations.set(prepared.preparationId, { caller, workspaceId: input.workspaceId, signal: operation.signal, scope: operation.scope, credentialGeneration, review: structuredClone(prepared), clear });
          operation.signal.addEventListener("abort", expire, { once: true });
          return prepared;
        } finally { review.clear(); preparingMigrations--; }
      };
      if (input.action === "deletePreview") {
        if (!data.deletePreview) throw new Error("Collection deletion is unavailable. Update dohc and try again.");
        const result = DatasetDeletePreview.parse(await data.deletePreview(input)); current();
        if (result.cursor.workspaceId !== input.workspaceId || result.cursor.datasetId !== input.datasetId) throw new Error("This deletion review belongs to another Collection.");
        return { kind: "delete-preview" as const, ...result };
      }
      if (input.action === "delete") {
        if (input.expected.workspaceId !== input.workspaceId || input.expected.datasetId !== input.datasetId) throw new Error("This deletion belongs to another Collection.");
        if (!data.deleteDataset) throw new Error("Collection deletion is unavailable. Update dohc and try again.");
        const result = DatasetDeleted.parse(await data.deleteDataset(input)); current();
        if (result.datasetId !== input.datasetId) throw new Error("dohc did not confirm this Collection deletion. Refresh the Collection.");
        return { kind: "deleted" as const, ...result };
      }
      if(input.action === "lifecycle") { if(!data.lifecycle)throw new Error("Collection archive controls are unavailable."); const result=await data.lifecycle(input);current();return {kind:"lifecycle" as const,...result}; }
      if(input.action === "archive" || input.action === "restore") { const action=data[input.action];if(!action)throw new Error("Collection archive controls are unavailable.");const result=await action(input);current();return {kind:"lifecycle-updated" as const,...result}; }
      if(input.action === "pendingAttempts") { if(!data.pendingAttempts)throw new Error("Pending submission review is unavailable."); const result=await data.pendingAttempts(input);current();return {kind:"pending-attempts" as const,...result}; }
      if(input.action === "reconcileAttempt") { if(!data.reconcileAttempt)throw new Error("Pending submission review is unavailable."); const result=await data.reconcileAttempt(input);current();return {kind:"attempt-reconciled" as const,...result}; }
      if(input.action === "cancelAttempt") { if(!data.cancelAttempt)throw new Error("Pending submission cancellation is unavailable."); const result=await data.cancelAttempt(input);current();return {kind:"attempt-cancelled" as const,...result}; }
      if (input.action === "historyRevision") {
        if (!data.historyRevision) throw new Error("Saved Collection rules are unavailable. Update the host and try again.");
        const result = DatasetHistoryRevision.parse(await data.historyRevision(input)); current();
        if (result.revision.datasetId !== input.datasetId || result.revision.revisionSha256 !== input.revisionSha256) throw new Error("This revision belongs to another Collection change.");
        return { kind: "history-revision" as const, ...result };
      }
      if (input.action === "prepareHistoryRestore") {
        if (!data.historyRevision) throw new Error("Saved Collection rules are unavailable. Update the host and try again.");
        const approved = await data.approvedArtifacts(input.datasetId); current();
        if (!approved.active || approved.revision.revision !== input.revision || approved.revision.revisionSha256 !== input.revisionSha256) throw new Error("The Collection changed. Refresh History before restoring rules.");
        const saved = await data.historyRevision({ datasetId: input.datasetId, revisionSha256: input.targetRevisionSha256 }); current();
        if (saved.revision.revisionSha256 !== input.targetRevisionSha256) throw new Error("The saved rules differ from this selection. Refresh History.");
        const changed = await data.historyRevision({ datasetId: input.datasetId, revisionSha256: input.changedRevisionSha256 }); current();
        if (changed.revision.revisionSha256 !== input.changedRevisionSha256) throw new Error("The selected change differs from History. Refresh History.");
        const generated = generateDatasetHistoryRestore(approved, saved, changed);
        const expected = describeDatasetRevision({ definition: generated.definition, revision: approved.revision.revision + 1, schemaSql: generated.schemaSql, operationSource: generated.operationSource });
        await dependencies.createSources(operation.workspace, generated.files, operation.signal); current();
        const prepared = await prepareMigration({ datasetId: input.datasetId, descriptorPath: generated.descriptorPath, migrationPath: generated.migrationPath }); current();
        if (prepared.previousRevision.revisionSha256 !== approved.revision.revisionSha256 || prepared.revision.revisionSha256 !== expected.revisionSha256 || prepared.migrationSql !== generated.migrationSql) {
          migrations.get(prepared.preparationId)?.clear();
          await migrationAuthority.discardMigrationCandidate({ workspaceId: input.workspaceId, datasetId: input.datasetId, candidateId: prepared.candidate.candidateId, signal: operation.signal });
          throw new Error("The Collection changed while preparing this restore. Refresh History and review it again.");
        }
        return { kind: "migration-prepared" as const, ...DatasetMigrationPreparation.parse(prepared) };
      }
      if (input.action === "history") {
        if (!("history" in data) || !data.history) throw new Error("Collection history is unavailable. Restart dohc and try again.");
        const result = await data.history(input); current();
        // History names each automation as its Collection names it now.
        const names = new Map<string, string | null>();
        for (const entry of result.entries) {
          const automationId = entry.automation?.automationId;
          if (automationId !== undefined && !names.has(automationId)) names.set(automationId, await dependencies.automationName?.(operation.workspace, automationId) ?? null);
        }
        current();
        return { kind: "history" as const, ...result, entries: result.entries.map((entry) => {
          const name = entry.automation && names.get(entry.automation.automationId);
          return name && entry.automation ? { ...entry, automation: { ...entry.automation, name } } : entry;
        }) };
      }
      if (input.action === "permissions") {
        if (!("permissions" in data) || !data.permissions) throw new Error("Publish this Collection before managing shared access.");
        const result = await data.permissions(input); current(); return { kind: "permissions" as const, ...result };
      }
      if (input.action === "setGrant" || input.action === "removeGrant") {
        if (!("setGrant" in data) || !data.setGrant) throw new Error("Publish this Collection before managing shared access.");
        await data.setGrant(input); current(); return { kind: "grant-updated" as const };
      }
      if (input.action === "list") { const result = await data.list({ after: input.after, limit: input.limit, includeArchived: input.includeArchived }); current(); return { kind: "list" as const, ...await addressPage(result) }; }
      if (input.action === "describe") {
        const result = "inspect" in data && data.inspect ? await data.inspect(input.datasetId, { includeArchived: input.includeArchived }) : { dataset: await data.describe(input.datasetId, { includeArchived: input.includeArchived }) };
        current(); return { kind: "description" as const, ...addressed(result) };
      }
      if (input.action === "upload") {
        const description = await data.describe(input.datasetId);
        current();
        if (!description.tables.some(table => table.fields.some(field => field.fieldId === input.fieldId && field.type === "attachment")) ||
            !description.operations.some(action => !action.readOnly && action.fieldIds.includes(input.fieldId))) throw new Error("Choose an editable Collection file field.");
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
        if (!approved.active || approved.revision.revision !== input.revision || approved.revision.revisionSha256 !== input.revisionSha256) {
          throw new Error("Collection rules changed. Reload the Collection before creating a form.");
        }
        const generated = generateDatasetFormSources({ ...input, datasetPath: "datasetPath" in request ? request.datasetPath : "", approvedRevision: approved.revision });
        const files = Object.fromEntries(Object.entries(generated.files).map(([path, source]) => [`${input.appRoot}/${path}`, source]));
        let created: string[] = [];
        let failedStage: CreationStage = "write";
        let rulesChanged = false;
        formFailure = (error) => {
          if (created.length === 0) throw error;
          const remove = rulesChanged || error instanceof SourceCreationConflict || error instanceof CreatedFileWriteError;
          return formPartial = {
            kind: "partial", created, failedStage: error instanceof DatasetScopeError ? "scope" : failedStage,
            reason: error instanceof Error ? error.message : String(error),
            retry: {
              mode: remove ? "remove-and-retry" : "resume",
              instruction: remove
                ? "Review the listed files in Files, then remove them. Reload the Collection and create the form in an empty folder."
                : "Try again with the same form settings and folder. dohc keeps matching files and creates only missing files.",
            },
          };
        };
        try {
          await dependencies.createSources(operation.workspace, files, operation.signal, (stage, paths) => {
            failedStage = stage;
            created = [...paths];
          });
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
      if (input.action === "discard") { host.discard(input.preparationId); return { kind: "discarded" as const }; }
      if (input.action === "prepareSchemaChange" || input.action === "prepareRelationChoices") {
        const approved = await data.approvedArtifacts(input.datasetId);
        current();
        if (!approved.active) throw new Error("This Collection is unavailable. Reconnect to its host and try again.");
        if (approved.revision.revision !== input.revision || approved.revision.revisionSha256 !== input.revisionSha256) throw new Error("Collection rules changed. Refresh the Collection before changing fields.");
        const generated = input.action === "prepareSchemaChange"
          ? generateDatasetSchemaChange({ ...approved, change: input.change })
          : generateDatasetRelationChoices({ ...approved, tableId: input.tableId, fieldId: input.fieldId, labelFieldId: input.labelFieldId });
        const expected = describeDatasetRevision({ definition: generated.definition, revision: input.revision + 1,
          schemaSql: generated.schemaSql, operationSource: generated.operationSource });
        await dependencies.createSources(operation.workspace, generated.files, operation.signal);
        current();
        const prepared = await prepareMigration({ datasetId: input.datasetId, descriptorPath: generated.descriptorPath, migrationPath: generated.migrationPath });
        current();
        if (prepared.previousRevision.revisionSha256 !== input.revisionSha256 || prepared.revision.revisionSha256 !== expected.revisionSha256 || prepared.migrationSql !== generated.migrationSql) {
          migrations.get(prepared.preparationId)?.clear();
          await migrationAuthority.discardMigrationCandidate({ workspaceId: input.workspaceId, datasetId: input.datasetId, candidateId: prepared.candidate.candidateId, signal: operation.signal });
          throw new Error("The Collection change differs from this review. Refresh the Collection and prepare it again.");
        }
        return { kind: "migration-prepared" as const, ...DatasetMigrationPreparation.parse(prepared) };
      }
      if (input.action === "prepareMigration") {
        if (request.action !== "prepareMigration") throw new Error("This Collection review changed. Prepare it again.");
        const prepared = await prepareMigration({ ...input, descriptorPath: request.datasetPath });
        current();
        return { kind: "migration-prepared" as const, ...DatasetMigrationPreparation.parse(prepared) };
      }
      if (input.action === "invoke") {
        try {
          const result = await data.invoke({ ...input, signal: operation.signal, ...(agent === null ? {} : { agent }) });
          current();
          return { kind: "invoked" as const, ...DatasetInvocationResult.parse(result) };
        } catch (error) {
          current();
          if (isAppBackendRuntimeError(error)) return { kind: "refused" as const, ...error.refusal };
          throw error;
        }
      }
      if (input.action === "approve") {
        const revision = await host.approve({ ...input, signal: operation.signal });
        current();
        return { kind: "approved" as const, revision };
      }
      let descriptorPath: string;
      let expectedRevision: string | undefined;
      if (input.action === "create") {
        const generated = generateDatasetSources(input.definition);
        expectedRevision = describeDatasetRevision({ definition: generated.definition, revision: 1,
          schemaSql: generated.files[generated.definition.schemaPath]!, operationSource: generated.files[generated.definition.operationsPath]!,
        }).revisionSha256;
        descriptorPath = Object.keys(generated.files).find(path => path === "dataset.json" || path.endsWith("/dataset.json"))!;
        await dependencies.createSources(operation.workspace, generated.files, operation.signal);
        current();
      } else {
        descriptorPath = input.descriptorPath;
        await dependencies.flushSourceCapture(operation.workspace, operation.signal); current();
      }
      const prepared = await dependencies.withAdapter(operation.workspace, adapter => host.prepare({ descriptorPath, adapter, signal: operation.signal }));
      current();
      if (input.action === "prepare") return { kind: "prepared" as const, ...DatasetPreparation.parse(prepared) };
      if (prepared.revision.revisionSha256 !== expectedRevision) {
        host.discard(prepared.preparationId);
        throw new Error("Collection source differs from these fields. Choose another folder or review the saved source.");
      }
      // The creation control approves the generated fields and actions it just displayed.
      const revision = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256, signal: operation.signal });
      current();
      return { kind: "approved" as const, revision };
      });
    } catch (error) {
      if (formPartial) return formPartial;
      if (formFailure) return formFailure(new DatasetScopeError(error));
      throw error;
    }
  };
}
