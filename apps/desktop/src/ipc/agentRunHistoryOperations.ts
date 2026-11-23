import { z } from "zod";
import { declaredRows, type OperationTable } from "./operationTable";

export const agentRunHistoryOperations = declaredRows(
  "agentRunHistory",
  z.string().min(1).max(256),
) satisfies OperationTable;
