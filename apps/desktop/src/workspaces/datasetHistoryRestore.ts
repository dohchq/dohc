import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parseDatasetDefinition, type DatasetField } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetHistoryRevision } from "@dohc/cli/dataset";

const fieldShape = ({ name: _name, ...field }: DatasetField) => JSON.stringify(field);

/** A compensating change starts from today's schema. It never copies yesterday's records or permissions. */
export function generateDatasetHistoryRestore(current: DatasetHistoryRevision, saved: DatasetHistoryRevision, changed: DatasetHistoryRevision) {
  verifyDatasetArtifacts(current); verifyDatasetArtifacts(saved); verifyDatasetArtifacts(changed);
  if (saved.revision.datasetId !== current.revision.datasetId || changed.revision.datasetId !== current.revision.datasetId ||
    changed.revision.revision !== saved.revision.revision + 1 || changed.revision.revision > current.revision.revision) {
    throw new Error("Choose a saved change from this Collection's History.");
  }
  const definition = structuredClone(current.revision.definition), old = saved.revision.definition, after = changed.revision.definition;
  const restoreLabel = (before: string, selected: string, now: string, name: string) => {
    if (before === selected) return now;
    if (now !== selected && now !== before) throw new Error(`${name} changed again. Review its current name in Fields and names.`);
    return before;
  };
  // Arbitrary SQL has no reliable automatic inverse. Preserve later fields; stop rather than discard their values.
  if (saved.revision.schemaSha256 !== changed.revision.schemaSha256 || JSON.stringify(old.tables.map(table => ({ ...table, name: "", fields: table.fields.map(field => ({ ...field, name: "" })) }))) !==
      JSON.stringify(after.tables.map(table => ({ ...table, name: "", fields: table.fields.map(field => ({ ...field, name: "" })) })))) {
    throw new Error("This change altered fields or constraints. Use Fields and names to review a conversion, or review a source migration that preserves current records.");
  }
  for (const table of old.tables) {
    const selected = after.tables.find(item => item.tableId === table.tableId)!;
    const now = definition.tables.find(item => item.tableId === table.tableId);
    if (!now || now.sqlName !== table.sqlName || now.primaryKey !== table.primaryKey) throw new Error(`The table ${table.name} changed. Review a source migration that preserves its current records.`);
    for (const field of table.fields) {
      const then = selected.fields.find(item => item.fieldId === field.fieldId)!;
      if (field.name === then.name) continue;
      const present = now.fields.find(item => item.fieldId === field.fieldId);
      if (!present || fieldShape(present) !== fieldShape(then)) throw new Error(`The field ${field.name} changed type or constraints. Use Fields and names to review its conversion.`);
      present.name = restoreLabel(field.name, then.name, present.name, field.name);
    }
    now.name = restoreLabel(table.name, selected.name, now.name, table.name);
  }
  const operationShape = (operation: typeof old.operations[number]) => { const { label: _label, access: _access, ...rest } = operation; return JSON.stringify(rest); };
  if (old.operations.length !== after.operations.length || old.operations.some(operation => {
    const selected = after.operations.find(item => item.operationId === operation.operationId);
    return !selected || operationShape(operation) !== operationShape(selected);
  })) throw new Error("This change altered Collection actions. Review a source migration that preserves current access.");
  for (const previous of old.operations) {
    const selected = after.operations.find(item => item.operationId === previous.operationId)!;
    if (previous.label === selected.label) continue;
    const operation = definition.operations.find(item => item.operationId === previous.operationId);
    if (!operation) throw new Error(`The action ${previous.label} was removed. Review a source migration.`);
    operation.label = restoreLabel(previous.label, selected.label, operation.label, previous.label);
  }
  const restoresSource = saved.revision.operationsSha256 !== changed.revision.operationsSha256;
  if (restoresSource && (current.revision.operationsSha256 !== changed.revision.operationsSha256 ||
      saved.revision.schemaSha256 !== changed.revision.schemaSha256 || current.revision.schemaSha256 !== changed.revision.schemaSha256 ||
      current.revision.definition.operations.some(operation => {
        const selected = after.operations.find(item => item.operationId === operation.operationId);
        return !selected || operationShape(operation) !== operationShape(selected);
      }) || current.revision.definition.operations.length !== after.operations.length)) {
    throw new Error("The schema or rules changed again. Review a source migration against the current records before reversing this change.");
  }
  definition.name = restoreLabel(old.name, after.name, definition.name, "Collection name");
  const base = posix.dirname(definition.schemaPath).split("/revisions/")[0]!;
  const directory = posix.join(base, "revisions", `${current.revision.revision + 1}-${randomUUID()}`);
  definition.schemaPath = posix.join(directory, "schema.sql"); definition.operationsPath = posix.join(directory, `operations${posix.extname(restoresSource ? old.operationsPath : definition.operationsPath)}`);
  const parsed = parseDatasetDefinition(definition), descriptorPath = posix.join(directory, "dataset.json"), migrationPath = posix.join(directory, "migration.sql");
  const schemaSql = current.schemaSql, operationSource = restoresSource ? saved.operationSource : current.operationSource, migrationSql = "SELECT 1;";
  return { definition: parsed, descriptorPath, migrationPath, schemaSql, operationSource, migrationSql,
    files: { [descriptorPath]: JSON.stringify(parsed, null, 2) + "\n", [definition.schemaPath]: schemaSql,
      [definition.operationsPath]: operationSource, [migrationPath]: migrationSql } };
}
