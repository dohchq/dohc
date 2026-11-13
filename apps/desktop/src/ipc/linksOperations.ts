import { z } from "zod";
import { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";
import { declaredRows, type OperationTable } from "./operationTable";

export const linksOperations = declaredRows(LINKS_DECLARATIONS, z.string().min(1).max(256)) satisfies OperationTable;
