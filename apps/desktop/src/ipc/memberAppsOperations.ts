import { WORKSPACE_ID } from "./bridgeContract";
import { declaredRows, declaredWriteRows, type OperationTable } from "./operationTable";

export const memberAppsReadOperations = declaredRows(
  "memberApps",
  WORKSPACE_ID,
) satisfies OperationTable;
export const memberAppsWriteOperations = declaredWriteRows(
  "memberApps",
  WORKSPACE_ID,
) satisfies OperationTable;
