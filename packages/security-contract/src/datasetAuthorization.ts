import { createHash } from "node:crypto";
import { parseAppBackendCaller, type AppBackendCaller } from "./appBackend";
import {
  parseDatasetAlias,
  parseDatasetRevision,
  parseDatasetBindingReference,
  parseAppDatasetCapability,
  datasetColumnFields,
  type DatasetRevision,
  type AppDatasetBinding,
  type AppDatasetCapability,
  type DatasetOperation,
} from "./dataset";
import { generateDatasetOperations } from "./datasetOperations";

function fail(reason?: string): never {
  throw new Error(reason ? `Invalid dataset metadata: ${reason}` : "Invalid dataset metadata.");
}

/** Only hosts reading artifact-verified catalog revisions may supply this lookup. */
export type GeneratedDatasetVerdictLookup = (approved: DatasetRevision) => boolean;

/** Untrusted revisions are checked directly unless the caller supplies its private lookup. */
export function hasGeneratedDatasetRevision(
  approved: DatasetRevision,
  lookup?: GeneratedDatasetVerdictLookup,
): boolean {
  if (lookup) return lookup(approved);
  return (
    createHash("sha256").update(generateDatasetOperations(approved.definition)).digest("hex") ===
    approved.operationsSha256
  );
}

export function parseDatasetBinding(
  value: unknown,
  approvedRevision: DatasetRevision,
  lookup?: GeneratedDatasetVerdictLookup,
): AppDatasetBinding {
  const approved = parseDatasetRevision(approvedRevision);
  const result = parseDatasetBindingReference(value);
  if (result.datasetId !== approved.datasetId)
    fail("dataset binding datasetId does not match the approved Collection.");
  if (result.revision !== approved.revision || result.revisionSha256 !== approved.revisionSha256)
    fail(
      `dataset binding revision (${result.revision}) or revisionSha256 does not match the approved revision (${approved.revision}). Run describe to read the current revision and revisionSha256, update app.publish.json, and prepare again.`,
    );
  const operations = new Set(
    approved.definition.operations.map((operation) => operation.operationId),
  );
  if (result.operationIds.some((id) => !operations.has(id)))
    fail(
      "dataset binding operationIds contains an operationId that is not in the approved revision. Run describe to list valid operationIds.",
    );
  if (result.linkReads?.length && !hasGeneratedDatasetRevision(approved, lookup))
    fail("dataset binding linkReads is only allowed for generated Collection revisions.");
  for (const read of result.linkReads ?? []) {
    const operation = approved.definition.operations.find(
      (operation) => operation.operationId === read.operationId,
    );
    const table = approved.definition.tables.find((table) => table.tableId === operation?.tableId);
    const primary =
      table && datasetColumnFields(table).find((field) => field.sqlColumn === table.primaryKey);
    if (!primary || !read.fieldIds.includes(primary.fieldId))
      fail("dataset binding linkReads must include the table's primary key fieldId.");
    if (
      !operation ||
      operation.kind !== "read" ||
      !operation.readOnly ||
      operation.access === "owner" ||
      read.fieldIds.length !== operation.fieldIds.length ||
      read.fieldIds.some((id) => !operation.fieldIds.includes(id))
    )
      fail(
        'dataset binding linkReads must reference a non-owner read-only "read" operation and list its exact fieldIds.',
      );
  }
  for (const restriction of result.createFields ?? []) {
    const operation = approved.definition.operations.find(
      (operation) => operation.operationId === restriction.operationId,
    );
    if (
      !operation ||
      operation.kind !== "create" ||
      restriction.fieldIds.some((id) => !operation.fieldIds.includes(id))
    )
      fail(
        'dataset binding createFields must reference a "create" operation and only list fieldIds declared by that operation.',
      );
  }
  return result;
}

/** The caller supplies a revision obtained from the owner's approved host catalog. */
export function resolveAppDatasetCapability(
  value: unknown,
  approvedRevision: DatasetRevision,
  lookup?: GeneratedDatasetVerdictLookup,
): AppDatasetCapability {
  const approved = parseDatasetRevision(approvedRevision);
  let alias: string | undefined;
  let rawBinding = value;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "alias")
  ) {
    const { alias: rawAlias, ...rest } = value as Record<string, unknown>;
    alias = parseDatasetAlias(rawAlias);
    rawBinding = rest;
  }
  const binding = parseDatasetBinding(rawBinding, approved, lookup);
  const selected = new Set(binding.operationIds);
  return parseAppDatasetCapability({
    ...binding,
    ...(alias === undefined ? {} : { alias }),
    name: approved.definition.name,
    operations: approved.definition.operations
      .filter((operation) => selected.has(operation.operationId))
      .map(({ operationId, name, access, readOnly, kind, fieldIds, tableId }) => ({
        operationId,
        name,
        access,
        readOnly,
        ...(kind === "read" && binding.linkReads?.some((read) => read.operationId === operationId)
          ? {
              fields: approved.definition.tables
                .find((table) => table.tableId === tableId)!
                .fields.filter((field) => fieldIds.includes(field.fieldId))
                .map(({ fieldId, name }) => ({ fieldId, name })),
            }
          : {}),
      })),
  });
}

/**
 * Adds what each operation does, from the revision the capability names, for Review app to show.
 * `generated` is the host's check of the revision's saved sources: dohc generated both its schema and its operation code.
 * Only then does each operation do what its kind and fields declare. Custom code shows as an action, by its label.
 * Keep the result out of candidates and digests. verifyAppDatasetCapability refuses it.
 */
export function displayAppDatasetCapability(
  capability: AppDatasetCapability,
  approved: DatasetRevision,
  generated: boolean,
): AppDatasetCapability {
  if (
    capability.datasetId !== approved.datasetId ||
    capability.revision !== approved.revision ||
    capability.revisionSha256 !== approved.revisionSha256
  )
    fail("capability revision does not match the approved revision.");
  const shown = {
    ...capability,
    operations: capability.operations.map((operation) => {
      const declared = approved.definition.operations.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      const table = approved.definition.tables.find(
        (candidate) => candidate.tableId === declared?.tableId,
      );
      if (!declared || !table) fail("capability operation is not in the approved revision.");
      if (!generated)
        return {
          ...operation,
          display: { kind: "action" as const, label: declared.label, fields: [] },
        };
      // A generated form may write fewer of a create's fields.
      const fieldIds =
        capability.createFields?.find((entry) => entry.operationId === operation.operationId)
          ?.fieldIds ?? declared.fieldIds;
      return {
        ...operation,
        display: {
          kind: declared.kind,
          label: declared.label,
          fields: table.fields
            .filter((field) => fieldIds.includes(field.fieldId))
            .map((field) => field.name),
        },
      };
    }),
  };
  // The words count toward the capability's size bounds. Past them, each operation keeps its kind and label without field names.
  // Past that too, Review app shows "Records" instead of failing to list or prepare.
  try {
    return parseAppDatasetCapability(shown);
  } catch {}
  const short = {
    ...shown,
    operations: shown.operations.map((operation) => ({
      ...operation,
      display: { ...operation.display, fields: [] },
    })),
  };
  try {
    return parseAppDatasetCapability(short);
  } catch {
    return capability;
  }
}

export function verifyAppDatasetCapability(
  value: unknown,
  approvedRevision: DatasetRevision,
  lookup?: GeneratedDatasetVerdictLookup,
): AppDatasetCapability {
  const parsed = parseAppDatasetCapability(value);
  const { operations: _, name: _name, ...binding } = parsed;
  const expected = resolveAppDatasetCapability(binding, approvedRevision, lookup);
  if (JSON.stringify(parsed) !== JSON.stringify(expected))
    fail("capability metadata does not match the approved revision.");
  return expected;
}

/** Caller must be derived from current host credentials, never request JSON. */
export function effectiveDatasetOperations(
  binding: unknown,
  approvedRevision: DatasetRevision,
  caller: AppBackendCaller,
  lookup?: GeneratedDatasetVerdictLookup,
): DatasetOperation[] {
  const approved = parseDatasetRevision(approvedRevision);
  const parsed = parseDatasetBinding(binding, approved, lookup);
  const principal = parseAppBackendCaller(caller);
  const allowed = new Set(parsed.operationIds);
  const reads = new Set(
    principal.kind === "link" || principal.kind === "named"
      ? parsed.linkReads?.map((read) => read.operationId)
      : [],
  );
  return approved.definition.operations
    .filter(
      (operation) =>
        allowed.has(operation.operationId) &&
        (principal.kind === "owner" ||
          operation.access === "link" ||
          reads.has(operation.operationId) ||
          (operation.access === "helper" && principal.kind === "named" && principal.helper)),
    )
    .map((operation) =>
      principal.kind !== "owner" && reads.has(operation.operationId)
        ? { ...operation, access: "link" }
        : operation,
    );
}
