import { z } from "zod";
import { declaredRows, type OperationTable } from "./operationTable";

export const captureOperations = declaredRows(
  "capture",
  z.string().min(1).max(256),
) satisfies OperationTable;
