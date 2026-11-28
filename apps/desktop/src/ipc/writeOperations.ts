// The window's rows of the declared writes, one table for each family. The
// renderer loads bridgeContract.ts and must not load a declaration, so these
// rows live here.
import { WORKSPACE_ID } from "./bridgeContract";
import { declaredWriteRows, type OperationTable } from "./operationTable";

export const stoppedRunOperations = declaredWriteRows(
  "stoppedRun",
  WORKSPACE_ID,
) satisfies OperationTable;
export const protectedCopyOperations = declaredWriteRows(
  "protectedCopy",
  WORKSPACE_ID,
) satisfies OperationTable;
export const agentRunUndoOperations = declaredWriteRows(
  "agentRunUndo",
  WORKSPACE_ID,
) satisfies OperationTable;
export const noteFormatOperations = declaredWriteRows(
  "noteFormat",
  WORKSPACE_ID,
) satisfies OperationTable;
export const liveNoteOperations = declaredWriteRows(
  "liveNote",
  WORKSPACE_ID,
) satisfies OperationTable;
