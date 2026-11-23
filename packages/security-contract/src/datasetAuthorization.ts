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

function isValidLinkRead(
  approved: DatasetRevision,
  read: { operationId: string; fieldIds: readonly string[] },
): "ok" | "primary" | "operation" {
  const operation = approved.definition.operations.find(
    (entry) => entry.operationId === read.operationId,
  );
  const table = approved.definition.tables.find((entry) => entry.tableId === operation?.tableId);
  const primary =
    table && datasetColumnFields(table).find((field) => field.sqlColumn === table.primaryKey);
  if (!primary || !read.fieldIds.includes(primary.fieldId)) return "primary";
  if (
    !operation ||
    operation.kind !== "read" ||
    !operation.readOnly ||
    operation.access === "owner" ||
    read.fieldIds.length !== operation.fieldIds.length ||
    read.fieldIds.some((id) => !operation.fieldIds.includes(id))
  )
    return "operation";
  return "ok";
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
      `dataset binding revision (${result.revision}) or revisionSha256 does not match the approved revision (${approved.revision}). Remove revision and revisionSha256 from app.publish.json (or update them) and prepare again.`,
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
    const check = isValidLinkRead(approved, read);
    if (check === "primary")
      fail("dataset binding linkReads must include the table's primary key fieldId.");
    if (check === "operation")
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

export type AppDatasetDriftStatus = "compatible" | "needs-refresh" | "incompatible";
export interface AppDatasetDrift {
  status: AppDatasetDriftStatus;
  reasons: string[];
}

function fieldNamesLabel(
  tables: readonly DatasetRevision["definition"]["tables"][number][],
  tableId: string | undefined,
  ids: readonly string[],
): string {
  const fields = tableId
    ? tables.filter((t) => t.tableId === tableId).flatMap((t) => t.fields)
    : [];
  const names = ids
    .map((id) => fields.find((f) => f.fieldId === id)?.name)
    .filter((n): n is string => Boolean(n));
  return names.length > 5
    ? `${names.slice(0, 5).join(", ")}, and ${names.length - 5} more`
    : names.join(", ");
}

export function assessAppDatasetDrift(
  capability: AppDatasetCapability,
  targetRevision: DatasetRevision,
  options: {
    scope: "local" | "link";
    bindingCurrent: boolean;
    preservesAccess?: boolean;
    pinnedRevision?: DatasetRevision;
  },
): AppDatasetDrift {
  const parsed = parseAppDatasetCapability(capability);
  const target = parseDatasetRevision(targetRevision);
  if (parsed.datasetId !== target.datasetId)
    fail("capability datasetId does not match the Collection.");
  if (options.bindingCurrent && options.preservesAccess !== false)
    return { status: "compatible", reasons: [] };

  const pinned = options.pinnedRevision ? parseDatasetRevision(options.pinnedRevision) : undefined;
  if (
    pinned &&
    (pinned.datasetId !== parsed.datasetId ||
      pinned.revision !== parsed.revision ||
      pinned.revisionSha256 !== parsed.revisionSha256)
  )
    fail("pinnedRevision does not match the app capability.");

  const reasons: string[] = [];
  const push = (reason: string) => {
    const text = reason.length > 512 ? `${reason.slice(0, 509)}...` : reason;
    if (!reasons.includes(text)) reasons.push(text);
  };
  const targetOps = new Map(target.definition.operations.map((op) => [op.operationId, op]));
  const pinnedOps = new Map(
    (pinned?.definition.operations ?? []).map((op) => [op.operationId, op]),
  );
  const allTables = [...target.definition.tables, ...(pinned?.definition.tables ?? [])];
  const targetGenerated = hasGeneratedDatasetRevision(target);
  const pinnedGenerated = pinned ? hasGeneratedDatasetRevision(pinned) : undefined;
  const rulesChanged =
    !pinned ||
    pinned.operationsSha256 !== target.operationsSha256 ||
    pinned.schemaSha256 !== target.schemaSha256;

  for (const prev of parsed.operations) {
    const next = targetOps.get(prev.operationId);
    const oldOp = pinnedOps.get(prev.operationId);
    const label = next?.label ?? oldOp?.label ?? prev.name;
    if (!next) {
      push(`Action "${label}" was removed.`);
      continue;
    }
    if (next.name !== prev.name) push(`Action "${prev.name}" was renamed to "${next.name}".`);
    if (
      next.readOnly !== prev.readOnly ||
      (oldOp && (next.kind !== oldOp.kind || next.tableId !== oldOp.tableId))
    )
      push(`Action "${label}" changed what it can do.`);
    if (oldOp && next.kind === "read" && targetGenerated) {
      const removed = oldOp.fieldIds.filter((id) => !next.fieldIds.includes(id));
      if (removed.length > 0) {
        const names = fieldNamesLabel(allTables, next.tableId, removed);
        push(`Action "${label}" no longer returns ${names || "some fields"}.`);
      }
    }
    if (options.scope !== "link") continue;
    if (prev.access === "link" && next.access !== "link")
      push(`Action "${label}" is no longer available on share links.`);
    else if (
      (prev.access === "owner" && next.access !== "owner") ||
      (prev.access === "helper" && next.access === "link")
    )
      push(`Action "${label}" changed who can run it.`);
    if (next.access === "link" && next.kind === "read" && oldOp && targetGenerated) {
      const added = next.fieldIds.filter((id) => !oldOp.fieldIds.includes(id));
      if (added.length > 0) {
        const names = fieldNamesLabel(allTables, next.tableId, added);
        push(
          `Action "${label}" would expose new fields${names ? ` (${names})` : ""} on share links.`,
        );
      }
    }
  }
  if (rulesChanged && (!targetGenerated || pinnedGenerated === false)) {
    if (
      options.scope === "link" ||
      (pinnedGenerated !== undefined && targetGenerated !== pinnedGenerated)
    )
      push("Custom action code changed and needs a full app review.");
  } else if (options.scope === "link" && !pinned) {
    push("Previous Collection rules are unavailable to verify share-link access.");
  }

  const createChecks = [
    ...(parsed.createFields ?? []),
    ...parsed.operations
      .filter((op) => !(parsed.createFields ?? []).some((e) => e.operationId === op.operationId))
      .flatMap((op) => {
        const next = targetOps.get(op.operationId);
        const oldOp = pinnedOps.get(op.operationId);
        return next?.kind === "create" && oldOp
          ? [{ operationId: op.operationId, fieldIds: oldOp.fieldIds }]
          : [];
      }),
  ];
  for (const restriction of createChecks) {
    const next = targetOps.get(restriction.operationId);
    if (!next) continue;
    if (next.kind !== "create") {
      push(`Action "${next.label}" can no longer create records.`);
      continue;
    }
    const missing = restriction.fieldIds.filter((id) => !next.fieldIds.includes(id));
    if (missing.length > 0) {
      const names = fieldNamesLabel(allTables, next.tableId, missing);
      push(
        names
          ? `Action "${next.label}" can no longer submit ${names}.`
          : `Some fields submitted by "${next.label}" are no longer available.`,
      );
    }
    const nextTable = target.definition.tables.find((t) => t.tableId === next.tableId);
    const nextColumns = nextTable ? datasetColumnFields(nextTable) : [];
    const oldTable = pinned?.definition.tables.find((t) => t.tableId === next.tableId);
    const oldColumns = oldTable
      ? new Map(datasetColumnFields(oldTable).map((f) => [f.fieldId, f]))
      : null;
    const formatChanged: string[] = [];
    const newlyRequired: string[] = [];
    if (oldColumns) {
      for (const id of restriction.fieldIds) {
        const oldF = oldColumns.get(id);
        const nextF = nextColumns.find((f) => f.fieldId === id);
        if (!oldF || !nextF) continue;
        if (
          oldF.type !== nextF.type ||
          oldF.relation?.many !== nextF.relation?.many ||
          oldF.relation?.tableId !== nextF.relation?.tableId ||
          oldF.relation?.fieldId !== nextF.relation?.fieldId ||
          ((oldF.type === "select" || oldF.type === "multi-select") &&
            nextF.type === oldF.type &&
            (oldF.options ?? []).some((opt) => !(nextF.options ?? []).includes(opt)))
        )
          formatChanged.push(id);
        if (!oldF.required && nextF.required) newlyRequired.push(id);
      }
    }
    if (formatChanged.length > 0) {
      const names = fieldNamesLabel(allTables, next.tableId, formatChanged);
      push(`Action "${next.label}" changed the input format for ${names || "submitted fields"}.`);
    }
    const missingRequired = nextTable
      ? nextColumns
          .filter(
            (f) =>
              f.required &&
              f.default === undefined &&
              f.sqlColumn !== nextTable.primaryKey &&
              (targetGenerated || next.fieldIds.includes(f.fieldId)) &&
              !restriction.fieldIds.includes(f.fieldId),
          )
          .map((f) => f.fieldId)
      : [];
    const allRequired = [...new Set([...newlyRequired, ...missingRequired])];
    if (allRequired.length > 0) {
      const names = fieldNamesLabel(allTables, next.tableId, allRequired);
      push(`Action "${next.label}" now requires ${names || "additional fields"}.`);
    }
  }
  if (parsed.linkReads?.length) {
    if (!targetGenerated) push("Share-link read fields require generated Collection actions.");
    else
      for (const read of parsed.linkReads) {
        const next = targetOps.get(read.operationId);
        if (next && isValidLinkRead(target, read) !== "ok")
          push(`Read fields for "${next.label}" changed.`);
      }
  }

  const bounded =
    reasons.length > 16
      ? [...reasons.slice(0, 15), `And ${reasons.length - 15} more changes.`]
      : reasons;
  return { status: bounded.length === 0 ? "needs-refresh" : "incompatible", reasons: bounded };
}
