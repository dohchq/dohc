import { createHash } from "node:crypto";
import { parseAppBackendCaller, type AppBackendCaller } from "./appBackend";
import { parseDatasetRevision, parseDatasetBindingReference, parseAppDatasetCapability, datasetColumnFields, type DatasetRevision, type AppDatasetBinding, type AppDatasetCapability, type DatasetOperation } from "./dataset";
import { generateDatasetOperations } from "./datasetOperations";

function fail(): never { throw new Error("Invalid dataset metadata."); }

/** Only hosts reading artifact-verified catalog revisions may supply this lookup. */
export type GeneratedDatasetVerdictLookup = (approved: DatasetRevision) => boolean;

/** Untrusted revisions are checked directly unless the caller supplies its private lookup. */
export function hasGeneratedDatasetRevision(approved: DatasetRevision, lookup?: GeneratedDatasetVerdictLookup): boolean {
  if (lookup) return lookup(approved);
  return createHash("sha256").update(generateDatasetOperations(approved.definition)).digest("hex") === approved.operationsSha256;
}

export function parseDatasetBinding(value: unknown, approvedRevision: DatasetRevision, lookup?: GeneratedDatasetVerdictLookup): AppDatasetBinding {
  const approved = parseDatasetRevision(approvedRevision);
  const result = parseDatasetBindingReference(value);
  if (result.datasetId !== approved.datasetId || result.revision !== approved.revision || result.revisionSha256 !== approved.revisionSha256) fail();
  const operations = new Set(approved.definition.operations.map(operation => operation.operationId));
  if (result.operationIds.some(id => !operations.has(id))) fail();
  if (result.linkReads?.length && !hasGeneratedDatasetRevision(approved, lookup)) fail();
  for (const read of result.linkReads ?? []) {
    const operation = approved.definition.operations.find(operation => operation.operationId === read.operationId);
    const table = approved.definition.tables.find(table => table.tableId === operation?.tableId);
    const primary = table && datasetColumnFields(table).find(field => field.sqlColumn === table.primaryKey);
    if (!primary || !read.fieldIds.includes(primary.fieldId)) fail();
    if (!operation || operation.kind !== "read" || !operation.readOnly || operation.access === "owner" ||
        read.fieldIds.length !== operation.fieldIds.length || read.fieldIds.some(id => !operation.fieldIds.includes(id))) fail();
  }
  for (const restriction of result.createFields ?? []) {
    const operation = approved.definition.operations.find(operation => operation.operationId === restriction.operationId);
    if (!operation || operation.kind !== "create" || restriction.fieldIds.some(id => !operation.fieldIds.includes(id))) fail();
  }
  return result;
}

/** The caller supplies a revision obtained from the owner's approved host catalog. */
export function resolveAppDatasetCapability(value: unknown, approvedRevision: DatasetRevision, lookup?: GeneratedDatasetVerdictLookup): AppDatasetCapability {
  const approved = parseDatasetRevision(approvedRevision);
  const binding = parseDatasetBinding(value, approved, lookup);
  const selected = new Set(binding.operationIds);
  return parseAppDatasetCapability({ ...binding, operations: approved.definition.operations.filter(operation => selected.has(operation.operationId))
    .map(({ operationId, name, access, readOnly, kind, fieldIds, tableId }) => ({ operationId, name, access, readOnly,
      ...(kind === "read" && binding.linkReads?.some(read => read.operationId === operationId) ? { fields: approved.definition.tables.find(table => table.tableId === tableId)!.fields
        .filter(field => fieldIds.includes(field.fieldId)).map(({ fieldId, name }) => ({ fieldId, name })) } : {}) })) });
}

export function verifyAppDatasetCapability(value: unknown, approvedRevision: DatasetRevision, lookup?: GeneratedDatasetVerdictLookup): AppDatasetCapability {
  const parsed = parseAppDatasetCapability(value);
  const { operations: _, ...binding } = parsed;
  const expected = resolveAppDatasetCapability(binding, approvedRevision, lookup);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) fail();
  return expected;
}

/** Caller must be derived from current host credentials, never request JSON. */
export function effectiveDatasetOperations(binding: unknown, approvedRevision: DatasetRevision, caller: AppBackendCaller, lookup?: GeneratedDatasetVerdictLookup): DatasetOperation[] {
  const approved = parseDatasetRevision(approvedRevision);
  const parsed = parseDatasetBinding(binding, approved, lookup);
  const principal = parseAppBackendCaller(caller);
  const allowed = new Set(parsed.operationIds);
  const reads = new Set(parsed.linkReads?.map(read => read.operationId));
  return approved.definition.operations.filter(operation => allowed.has(operation.operationId) && (
    principal.kind === "owner" || operation.access === "link" || reads.has(operation.operationId) ||
    (operation.access === "helper" && principal.kind === "named" && principal.helper)
  )).map(operation => principal.kind !== "owner" && reads.has(operation.operationId) ? { ...operation, access: "link" } : operation);
}
