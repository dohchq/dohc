import { DATASET_CAPABILITIES, DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { WorkspaceIdPayload } from "./bridgeContract";
import type { OperationTable } from "./operationTable";

export const datasetOperations = {
  dataset: {
    capabilityIdsByAction: DATASET_CAPABILITIES,
    channel: "desktop:dataset", payload: DatasetRequest, result: DatasetResult,
    guard: "trusted-sender", scope: "workspace",
    handlerCheck: {
      check: "datasetHandler.withRendererWorkspaceOperation",
      reason: "The handler binds the sender's workspace and retains its per-action authority and lifetime checks.",
    },
  },
  // A person chose to keep Collections that no computer keeps yet on this one.
  keepCollectionsHere: {
    capabilityId: "dataset.holder.keep",
    channel: "desktop:keep-collections-here", payload: WorkspaceIdPayload,
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: "Open this workspace to keep its Collections on this computer.",
  },
} as const satisfies OperationTable;
