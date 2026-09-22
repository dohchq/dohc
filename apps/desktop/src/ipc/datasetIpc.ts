import { DatasetRequest, DatasetInvocationResult, DatasetPreparation, DatasetMigrationPreparation } from "@dohc/cli/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetFormSources } from "../workspaces/datasetFormGenerator";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { OwnerDatasetData } from "../workspaces/remoteDataset";
import { generateDatasetSchemaChange } from "../workspaces/datasetSchemaChanges";

type Workspace = { workspaceId: string; shareView?: unknown };
type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
type Operation<W extends Workspace> = { workspace: W; signal: AbortSignal; assertCurrent(): void };

/** The desktop and owner CLI enter the same workspace authority before using data. */
export function createDatasetHandler<Caller, W extends Workspace, O extends Operation<W>>(dependencies: {
  withWorkspaceOperation<T>(caller: Caller, workspaceId: string, work: (operation: O) => Promise<T>): Promise<T>;
  hostForWorkspace(workspace: W, signal: AbortSignal): Promise<LocalDatasetHost>;
  /** Resolves the dataset's current authority. Remote failures must never fall back to local writes. */
  dataForWorkspace?(workspace: W, signal: AbortSignal): Promise<OwnerDatasetData>;
  namedDataForWorkspace?(workspace: W, signal: AbortSignal): Promise<Pick<OwnerDatasetData, "list" | "describe" | "invoke" | "upload" | "file">>;
  exportArchive?(workspace: W, request: Extract<import("@dohc/cli/dataset").DatasetRequest, { action: "export" }>, signal: AbortSignal, authorize: () => void): Promise<string | null>;
  withAdapter<T>(workspace: W, work: (adapter: SourceAdapter) => Promise<T>): Promise<T>;
  /** Creates absent files through the workspace engine and settles their source capture. */
  createSources(workspace: W, files: Record<string, string>, signal: AbortSignal): Promise<void>;
}) {
  return async (caller: Caller, raw: unknown) => {
    const input = DatasetRequest.parse(raw);
    return dependencies.withWorkspaceOperation(caller, input.workspaceId, async operation => {
      const current = () => { operation.signal.throwIfAborted(); operation.assertCurrent(); };
      current();
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
        if (input.action === "list") { if(input.includeArchived)throw new Error("Open the original workspace to restore Collections."); const page = await data.list({ after: input.after, limit: input.limit }); current(); return { kind: "list" as const, ...page }; }
        if (input.action === "describe") { if(input.includeArchived)throw new Error("Open the original workspace to restore Collections."); const dataset = await data.describe(input.datasetId); current(); return { kind: "description" as const, dataset }; }
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
      const readsData = ["list", "describe", "createForm", "invoke", "upload", "file", "history", "permissions", "setGrant", "removeGrant", "lifecycle", "archive", "restore", "pendingAttempts", "reconcileAttempt"].includes(input.action);
      const data = readsData && dependencies.dataForWorkspace ? await dependencies.dataForWorkspace(operation.workspace, operation.signal) : host;
      current();
      if(input.action === "lifecycle") { if(!data.lifecycle)throw new Error("Collection archive controls are unavailable."); const result=await data.lifecycle(input);current();return {kind:"lifecycle" as const,...result}; }
      if(input.action === "archive" || input.action === "restore") { const action=data[input.action];if(!action)throw new Error("Collection archive controls are unavailable.");const result=await action(input);current();return {kind:"lifecycle-updated" as const,...result}; }
      if(input.action === "pendingAttempts") { if(!data.pendingAttempts)throw new Error("Pending submission review is unavailable."); const result=await data.pendingAttempts(input);current();return {kind:"pending-attempts" as const,...result}; }
      if(input.action === "reconcileAttempt") { if(!data.reconcileAttempt)throw new Error("Pending submission review is unavailable."); const result=await data.reconcileAttempt(input);current();return {kind:"attempt-reconciled" as const,...result}; }
      if (input.action === "history") {
        if (!("history" in data) || !data.history) throw new Error("Collection history is unavailable. Restart dohc and try again.");
        const result = await data.history(input); current(); return { kind: "history" as const, ...result };
      }
      if (input.action === "permissions") {
        if (!("permissions" in data) || !data.permissions) throw new Error("Publish this Collection before managing shared access.");
        const result = await data.permissions(input); current(); return { kind: "permissions" as const, ...result };
      }
      if (input.action === "setGrant" || input.action === "removeGrant") {
        if (!("setGrant" in data) || !data.setGrant) throw new Error("Publish this Collection before managing shared access.");
        await data.setGrant(input); current(); return { kind: "grant-updated" as const };
      }
      if (input.action === "list") { const result = await data.list({ after: input.after, limit: input.limit, includeArchived: input.includeArchived }); current(); return { kind: "list" as const, ...result }; }
      if (input.action === "describe") {
        const result = "inspect" in data && data.inspect ? await data.inspect(input.datasetId, { includeArchived: input.includeArchived }) : { dataset: await data.describe(input.datasetId, { includeArchived: input.includeArchived }) };
        current(); return { kind: "description" as const, ...result };
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
        const generated = generateDatasetFormSources({ ...input, approvedRevision: approved.revision });
        const files = Object.fromEntries(Object.entries(generated.files).map(([path, source]) => [`${input.appRoot}/${path}`, source]));
        await dependencies.createSources(operation.workspace, files, operation.signal);
        current();
        const latest = await data.approvedArtifacts(input.datasetId);
        current();
        if (!latest.active || latest.revision.revisionSha256 !== input.revisionSha256) {
          throw new Error("Collection rules changed. The form source was saved. Reload the Collection before approving the form.");
        }
        return { kind: "form-created" as const, appRoot: input.appRoot, paths: Object.keys(files) };
      }
      if (input.action === "discard") { host.discard(input.preparationId); return { kind: "discarded" as const }; }
      if (input.action === "discardMigration") { host.discardMigration(input.preparationId); return { kind: "migration-discarded" as const }; }
      if (input.action === "prepareSchemaChange") {
        const approved = host.approvedArtifacts(input.datasetId);
        if (!approved.active) throw new Error("This Collection is hosted elsewhere. Review schema changes on its active host.");
        if (approved.revision.revision !== input.revision || approved.revision.revisionSha256 !== input.revisionSha256) throw new Error("Collection rules changed. Refresh the Collection before changing fields.");
        const generated = generateDatasetSchemaChange({ ...approved, change: input.change });
        const expected = describeDatasetRevision({ definition: generated.definition, revision: input.revision + 1,
          schemaSql: generated.schemaSql, operationSource: generated.operationSource });
        await dependencies.createSources(operation.workspace, generated.files, operation.signal);
        current();
        const prepared = await dependencies.withAdapter(operation.workspace, adapter => host.prepareMigration({ datasetId: input.datasetId,
          descriptorPath: generated.descriptorPath, migrationPath: generated.migrationPath, adapter, signal: operation.signal }));
        current();
        if (prepared.previousRevision.revisionSha256 !== input.revisionSha256 || prepared.revision.revisionSha256 !== expected.revisionSha256 || prepared.migrationSql !== generated.migrationSql) {
          host.discardMigration(prepared.preparationId);
          throw new Error("The Collection change differs from this review. Refresh the Collection and prepare it again.");
        }
        return { kind: "migration-prepared" as const, ...DatasetMigrationPreparation.parse(prepared) };
      }
      if (input.action === "prepareMigration") {
        const prepared = await dependencies.withAdapter(operation.workspace, adapter => host.prepareMigration({ ...input, adapter, signal: operation.signal }));
        current();
        return { kind: "migration-prepared" as const, ...DatasetMigrationPreparation.parse(prepared) };
      }
      if (input.action === "approveMigration") {
        const result = await host.approveMigration({ ...input, signal: operation.signal });
        current();
        return { kind: "migrated" as const, ...result };
      }
      if (input.action === "invoke") {
        try {
          const result = await data.invoke({ ...input, signal: operation.signal });
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
      } else descriptorPath = input.descriptorPath;
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
  };
}
