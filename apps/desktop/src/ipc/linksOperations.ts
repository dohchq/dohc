import { z } from "zod";
import { DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-declarations";
import { declaredRows, type OperationTable } from "./operationTable";

export const linksOperations = declaredRows(DECLARATION_FAMILIES.links, z.string().min(1).max(256)) satisfies OperationTable;
