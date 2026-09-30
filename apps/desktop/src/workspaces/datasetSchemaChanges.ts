import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { datasetColumnFields, parseDatasetDefinition, type DatasetColumnField, type DatasetRevision } from "@dohc/security-contract/dataset";
import { datasetNumberText, losslessDatasetNumber } from "@dohc/security-contract/dataset-conversion";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSources, hasGeneratedDatasetOperations } from "./datasetGenerator";
import { generateFieldMigration } from "./datasetFieldMigration";

export class DatasetSchemaChangeError extends Error {
  constructor(message: string, readonly workspacePaths: readonly string[]) {
    super(message);
    this.name = "DatasetSchemaChangeError";
  }
}

const quote = (value: string) => `"${value}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function column(field: DatasetColumnField): string {
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
  const original = input.revision.definition, generated = hasGeneratedDatasetOperations(input.operationSource, original);
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
    } else if (change.kind === "addButton") {
      // A button stores nothing and no operation lists it, so this revision
      // changes no SQL and no operation.
      table.fields.push({ fieldId: randomUUID(), name: change.name, type: "button" });
      definition = parseDatasetDefinition(definition);
      summary = `Add ${change.name}`;
    } else if (change.kind === "changeField") {
      const field = table.fields.find(candidate => candidate.fieldId === change.fieldId);
      if (!field) throw new Error("This field changed. Refresh the Collection.");
      if (field.type === "button") throw new Error(`${field.name} is a button. It has no type or value to change.`);
      if (!generated) {
        const actions = original.operations.filter(operation => operation.fieldIds.includes(field.fieldId)).map(operation => operation.label).join(", ");
        throw new DatasetSchemaChangeError(`${field.name} uses custom rules${actions ? ` in ${actions}` : ""}. Update ${original.operationsPath}, then choose Review source change.`, [original.operationsPath]);
      }
      if (field.sqlColumn === table.primaryKey) throw new Error("The record ID cannot change type or become optional. Choose another field.");
      const previous = structuredClone(field);
      if (field.type !== change.type && !(["text", "number"].includes(field.type) && ["text", "number"].includes(change.type))) {
        throw new Error("This type change needs a conversion rule. Edit the Collection source, then choose Review source change.");
      }
      if (field.type !== change.type && definition.tables.some(candidate => datasetColumnFields(candidate).some(related => related.relation?.fieldId === field.fieldId))) {
        throw new Error(`${field.name} is used by related records. Review a source change that converts both fields together.`);
      }
      field.type = change.type; field.required = change.required;
      if (field.type !== previous.type && field.default !== undefined && field.default !== null) {
        if (field.type === "text") field.default = datasetNumberText(Number(field.default));
        else {
          const value = losslessDatasetNumber(String(field.default));
          if (value === null) throw new Error(`${field.name} has a default that cannot become a number without losing information. Update its default in the source, then review again.`);
          field.default = value;
        }
      }
      definition = parseDatasetDefinition(definition);
      const migration = generateFieldMigration({ previous: original, next: definition, schemaSql: input.schemaSql, field: previous, tableId: table.tableId });
      schemaSql = migration.schemaSql; migrationSql = migration.migrationSql;
      summary = `Change ${field.name}`;
    } else {
      const fieldId = randomUUID(), field: DatasetColumnField = { ...change.field, fieldId, sqlColumn: `field_${fieldId.replaceAll("-", "")}` };
      if (field.required && (!Object.hasOwn(field, "default") || field.default === null)) throw new Error("A new required field needs a default for existing records.");
      if (field.unique && Object.hasOwn(field, "default") && field.default !== null) throw new Error("A new unique field cannot give every record the same default.");
      table.fields.push(field);
      // New fields do not widen public or collaborator access, or rewrite authored operations.
      if (generated) {
        for (const kind of ["read", "create", "edit"] as const) {
          const owner = definition.operations.filter(operation => operation.access === "owner" && operation.tableId === table.tableId && operation.kind === kind);
          if (!owner.length) {
            const existing = definition.operations.find(operation => operation.tableId === table.tableId && operation.kind === kind);
            if (existing) { const operationId = randomUUID(); definition.operations.unshift({...structuredClone(existing), operationId,
              name:`owner_${operationId.replaceAll("-", "")}`, access:"owner", fieldIds:[...existing.fieldIds,fieldId]}); }
          } else for (const operation of owner) operation.fieldIds.push(fieldId);
        }
      }
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
  const base = posix.dirname(original.schemaPath).split(/(?:^|\/)revisions\//)[0]!;
  const directory = posix.join(base, "revisions", `${input.revision.revision + 1}-${randomUUID()}`);
  definition.schemaPath = posix.join(directory, "schema.sql"); definition.operationsPath = posix.join(directory, `operations${posix.extname(original.operationsPath)}`);
  const descriptorPath = posix.join(directory, "dataset.json"), migrationPath = posix.join(directory, "migration.sql");
  const executableChange = change.kind === "addField" || change.kind === "changeField";
  const next = generated && executableChange ? generateDatasetSources(definition) : { definition: parseDatasetDefinition(definition), files: {} as Record<string, string> };
  const operationSource = generated && executableChange ? next.files[definition.operationsPath]! : input.operationSource;
  return { definition: next.definition, schemaSql, operationSource, migrationSql, descriptorPath, migrationPath, summary,
    files: { [descriptorPath]: JSON.stringify(next.definition, null, 2) + "\n", [definition.schemaPath]: schemaSql,
      [definition.operationsPath]: operationSource, [migrationPath]: migrationSql } };
}
