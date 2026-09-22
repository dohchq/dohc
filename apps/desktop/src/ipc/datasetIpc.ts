import { DatasetRequest, DatasetInvocationResult, DatasetPreparation, DatasetMigrationPreparation } from "@dohc/cli/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetFormSources } from "../workspaces/datasetFormGenerator";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";

type Workspace = { workspaceId: string; shareView?: unknown };
type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
type Operation<W extends Workspace> = { workspace: W; signal: AbortSignal; assertCurrent(): void };

/** The desktop and owner CLI enter the same workspace authority before using data. */
export function createDatasetHandler<Caller, W extends Workspace, O extends Operation<W>>(dependencies: {
  withWorkspaceOperation<T>(caller: Caller, workspaceId: string, work: (operation: O) => Promise<T>): Promise<T>;
  hostForWorkspace(workspace: W, signal: AbortSignal): Promise<LocalDatasetHost>;
  withAdapter<T>(workspace: W, work: (adapter: SourceAdapter) => Promise<T>): Promise<T>;
  /** Creates absent files through the workspace engine and settles their source capture. */
  createSources(workspace: W, files: Record<string, string>, signal: AbortSignal): Promise<void>;
}) {
  return async (caller: Caller, raw: unknown) => {
    const input = DatasetRequest.parse(raw);
    return dependencies.withWorkspaceOperation(caller, input.workspaceId, async operation => {
      const current = () => { operation.signal.throwIfAborted(); operation.assertCurrent(); };
      current();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Open the original workspace to manage this Collection.");
      const host = await dependencies.hostForWorkspace(operation.workspace, operation.signal);
      current();
      if (input.action === "list") return { kind: "list" as const, ...host.list({ after: input.after, limit: input.limit }) };
      if (input.action === "describe") return { kind: "description" as const, dataset: host.describe(input.datasetId) };
      if (input.action === "createForm") {
        const approved = host.approvedArtifacts(input.datasetId);
        if (!approved.active || approved.revision.revision !== input.revision || approved.revision.revisionSha256 !== input.revisionSha256) {
          throw new Error("Collection rules changed. Reload the Collection before creating a form.");
        }
        const generated = generateDatasetFormSources({ ...input, approvedRevision: approved.revision });
        const files = Object.fromEntries(Object.entries(generated.files).map(([path, source]) => [`${input.appRoot}/${path}`, source]));
        await dependencies.createSources(operation.workspace, files, operation.signal);
        current();
        const latest = host.approvedArtifacts(input.datasetId);
        if (!latest.active || latest.revision.revisionSha256 !== input.revisionSha256) {
          throw new Error("Collection rules changed. The form source was saved. Reload the Collection before approving the form.");
        }
        return { kind: "form-created" as const, appRoot: input.appRoot, paths: Object.keys(files) };
      }
      if (input.action === "discard") { host.discard(input.preparationId); return { kind: "discarded" as const }; }
      if (input.action === "discardMigration") { host.discardMigration(input.preparationId); return { kind: "migration-discarded" as const }; }
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
        const result = await host.invoke({ ...input, signal: operation.signal });
        current();
        return { kind: "invoked" as const, ...DatasetInvocationResult.parse(result) };
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
