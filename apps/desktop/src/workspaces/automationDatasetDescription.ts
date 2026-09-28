import { shareViewIsPresent } from "./shareViewMarker";
import type { OwnerDatasetData } from "./remoteDataset";

type Workspace = { workspaceId: string; shareView?: unknown };
type Operation<W> = { workspace: W; signal: AbortSignal; assertCurrent(): void };

/** Internal automation ids resolve through the current workspace's data authority. */
export async function describeAutomationDataset<W extends Workspace>(
  operation: Operation<W>,
  datasetId: string,
  dependencies: {
    dataForWorkspace(workspace: W, signal: AbortSignal): Promise<Pick<OwnerDatasetData, "describe">>;
    namedDataForWorkspace(workspace: W, signal: AbortSignal): Promise<Pick<OwnerDatasetData, "describe">>;
  },
) {
  const current = () => { operation.assertCurrent(); operation.signal.throwIfAborted(); };
  current();
  const data = shareViewIsPresent(operation.workspace.shareView)
    ? await dependencies.namedDataForWorkspace(operation.workspace, operation.signal)
    : await dependencies.dataForWorkspace(operation.workspace, operation.signal);
  current();
  const described = await data.describe(datasetId);
  current();
  return described;
}
