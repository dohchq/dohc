import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parseDatasetDefinition, type DatasetRevision, type DatasetField } from "@dohc/security-contract/dataset";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSources } from "./datasetGenerator";

const quote = (value: string) => `"${value}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function column(field: DatasetField): string {
  const name = quote(field.sqlColumn), type = field.type === "number" ? "REAL" : field.type === "checkbox" ? "INTEGER" : "TEXT";
  let output = `${name} ${type}${field.required ? " NOT NULL" : ""}`;
  if (Object.hasOwn(field, "default")) {
    const value = field.default;
    output += ` DEFAULT ${value === null ? "NULL" : typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : literal(typeof value === "string" ? value : JSON.stringify(value))}`;
  }
  if (field.type === "checkbox") output += ` CHECK (${name} IN (0,1))`;
  if (field.type === "select") output += ` CHECK (${name} IN (${field.options!.map(literal).join(",")}))`;
  if (field.type === "multi-select") output += ` CHECK (${name} IS NULL OR (json_valid(${name}) AND json_type(${name})='array'))`;
  return output;
}

/** Match SQLite ALTER ADD's schema text while preserving all existing constraints and physical column order. */
function appendColumn(schema: string, table: string, sql: string): string {
  const prefix = `CREATE TABLE ${quote(table)} (`;
  const start = schema.indexOf(prefix);
  if (start < 0 || schema.indexOf(prefix, start + prefix.length) >= 0) throw new Error("This Collection uses a custom schema. Edit its source and review the change.");
  let depth = 1, position = start + prefix.length;
  while (position < schema.length) {
    const character = schema[position]!;
    if (schema.startsWith("--", position)) { const end = schema.indexOf("\n", position + 2); if (end < 0) break; position = end + 1; continue; }
    if (schema.startsWith("/*", position)) { const end = schema.indexOf("*/", position + 2); if (end < 0) break; position = end + 2; continue; }
    if (["'", '"', "`", "["].includes(character)) {
      const closing = character === "[" ? "]" : character; position++;
      while (position < schema.length) {
        if (schema[position] === closing) { if (schema[position + 1] === closing && closing !== "]") { position += 2; continue; } position++; break; }
        position++;
      }
      continue;
    }
    if (character === "(") depth++;
    if (character === ")" && --depth === 0) return `${schema.slice(0, position)}, ${sql}${schema.slice(position)}`;
    position++;
  }
  throw new Error("This Collection schema could not be read. Edit its source and review the change.");
}

/** Build new source files; existing authored files are never overwritten. */
export function generateDatasetSchemaChange(input: { revision: DatasetRevision; schemaSql: string; operationSource: string; change: DatasetSchemaChange }) {
  const original = input.revision.definition, generated = generateDatasetSources(original);
  if (input.operationSource !== generated.files[original.operationsPath]) throw new Error("This Collection has custom actions. Edit its source and use Review source change.");
  let definition = structuredClone(original), schemaSql = input.schemaSql, migrationSql = "SELECT 1;", summary: string;
  const change = input.change;
  if (change.kind === "renameCollection") { definition.name = change.name; summary = `Rename ${original.name} to ${change.name}`; }
  else {
    const table = definition.tables.find(candidate => candidate.tableId === change.tableId);
    if (!table) throw new Error("This Collection table changed. Refresh the Collection.");
    if (change.kind === "renameTable") { summary = `Rename ${table.name} to ${change.name}`; table.name = change.name; }
    else if (change.kind === "renameField") {
      const field = table.fields.find(candidate => candidate.fieldId === change.fieldId);
      if (!field) throw new Error("This field changed. Refresh the Collection.");
      summary = `Rename ${field.name} to ${change.name}`; field.name = change.name;
    } else {
      const fieldId = randomUUID(), field: DatasetField = { ...change.field, fieldId, sqlColumn: `field_${fieldId.replaceAll("-", "")}` };
      if (field.required && (!Object.hasOwn(field, "default") || field.default === null)) throw new Error("A new required field needs a default for existing records.");
      if (field.unique && Object.hasOwn(field, "default") && field.default !== null) throw new Error("A new unique field cannot give every record the same default.");
      table.fields.push(field);
      // Existing app bindings and helper grants stay pinned to the old revision until separately approved.
      for (const operation of definition.operations) if (operation.tableId === table.tableId && ["read", "create", "edit"].includes(operation.kind)) operation.fieldIds.push(fieldId);
      definition = parseDatasetDefinition(definition);
      const sql = column(field), tableSql = quote(table.sqlName);
      schemaSql = appendColumn(schemaSql, table.sqlName, sql);
      migrationSql = `ALTER TABLE ${tableSql} ADD COLUMN ${sql};`;
      if (field.unique || !["attachment", "multi-select"].includes(field.type)) {
        const index = `CREATE ${field.unique ? "UNIQUE " : ""}INDEX ${quote(`idx_${fieldId.replaceAll("-", "")}`)} ON ${tableSql} (${quote(field.sqlColumn)}${field.unique ? "" : `,${quote(table.primaryKey)}`});`;
        migrationSql += `\n${index}`; schemaSql += `\n${index}\n`;
      }
      summary = `Add ${field.name}`;
    }
  }
  const base = posix.dirname(original.schemaPath).split("/revisions/")[0]!;
  const directory = posix.join(base, "revisions", `${input.revision.revision + 1}-${randomUUID()}`);
  definition.schemaPath = posix.join(directory, "schema.sql"); definition.operationsPath = posix.join(directory, "operations.js");
  const next = generateDatasetSources(definition), descriptorPath = posix.join(directory, "dataset.json"), migrationPath = posix.join(directory, "migration.sql");
  const operationSource = next.files[definition.operationsPath]!;
  return { definition: next.definition, schemaSql, operationSource, migrationSql, descriptorPath, migrationPath, summary,
    files: { [descriptorPath]: JSON.stringify(next.definition, null, 2) + "\n", [definition.schemaPath]: schemaSql,
      [definition.operationsPath]: operationSource, [migrationPath]: migrationSql } };
}
