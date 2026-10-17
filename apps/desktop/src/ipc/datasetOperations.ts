import { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { DATASET_CAPABILITIES } from "@dohc/cli/protocol";
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
} as const satisfies OperationTable;
