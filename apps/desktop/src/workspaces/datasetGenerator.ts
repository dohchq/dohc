import { posix } from "node:path";
import { datasetColumnFields, parseDatasetDefinition, type DatasetColumnField, type DatasetDefinition } from "@dohc/security-contract/dataset";

import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
export { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";

const quote = (name: string) => `"${name}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const versionColumn = "_record_version";

function sqlDefault(field: DatasetColumnField): string {
  if (field.default === null) return "NULL";
  if (typeof field.default === "boolean") return field.default ? "1" : "0";
  if (typeof field.default === "number") return String(field.default);
  return literal(typeof field.default === "string" ? field.default : JSON.stringify(field.default));
}

export function generateDatasetSchema(definition: DatasetDefinition): string {
  const statements: string[] = [];
  for (const table of definition.tables) {
    const columns = datasetColumnFields(table).map(field => {
      const column = quote(field.sqlColumn);
      const target = field.relation && definition.tables.find(candidate => candidate.tableId === field.relation!.tableId)!;
      const targetField = target && datasetColumnFields(target).find(candidate => candidate.fieldId === field.relation!.fieldId)!;
      const numeric = field.type === "number" || targetField && !field.relation!.many && targetField.type === "number";
      const type = field.type === "checkbox" ? "INTEGER" : numeric ? "REAL" : "TEXT";
      let sql = `${column} ${type}${field.required ? " NOT NULL" : ""}${field.sqlColumn === table.primaryKey ? " PRIMARY KEY" : field.unique ? " UNIQUE" : ""}`;
      if (Object.hasOwn(field, "default")) sql += ` DEFAULT ${sqlDefault(field)}`;
      if (field.sqlColumn === table.primaryKey && numeric) sql += ` CHECK (${column} BETWEEN -9007199254740991 AND 9007199254740991 AND ${column}=CAST(${column} AS INTEGER))`;
      if (field.type === "checkbox") sql += ` CHECK (${column} IN (0,1))`;
      if (field.type === "select") sql += ` CHECK (${column} IN (${field.options!.map(literal).join(",")}))`;
      if (field.type === "multi-select" || field.relation?.many) sql += ` CHECK (${column} IS NULL OR (json_valid(${column}) AND json_type(${column})='array'))`;
      if (target && !field.relation!.many) sql += ` REFERENCES ${quote(target.sqlName)}(${quote(targetField!.sqlColumn)}) ON UPDATE RESTRICT ON DELETE RESTRICT`;
      return sql;
    });
    columns.push(`${quote(versionColumn)} INTEGER NOT NULL DEFAULT 1 CHECK (${quote(versionColumn)} > 0)`);
    statements.push(`CREATE TABLE ${quote(table.sqlName)} (\n  ${columns.join(",\n  ")}\n) STRICT;`);
    for (const field of datasetColumnFields(table).filter(field => field.sqlColumn !== table.primaryKey && !field.unique && !field.relation?.many && !["attachment", "multi-select"].includes(field.type))) {
      statements.push(`CREATE INDEX ${quote(`idx_${field.fieldId.replaceAll("-", "")}`)} ON ${quote(table.sqlName)} (${quote(field.sqlColumn)},${quote(table.primaryKey)});`);
    }
  }
  // JSON relations retain the declared tables while SQL triggers protect authored operations too.
  for (const table of definition.tables) for (const field of datasetColumnFields(table).filter(field => field.relation?.many)) {
    const target = definition.tables.find(candidate => candidate.tableId === field.relation!.tableId)!;
    const targetField = datasetColumnFields(target).find(candidate => candidate.fieldId === field.relation!.fieldId)!;
    const suffix = field.fieldId.replaceAll("-", "");
    // json_each is a virtual table outside the approved table capability. Use scalar JSON functions instead.
    const indices = (column: string) => `WITH RECURSIVE positions(n) AS (SELECT 0 WHERE json_array_length(${column}) > 0 UNION ALL SELECT n+1 FROM positions WHERE n+1 < json_array_length(${column}))`;
    const column = `NEW.${quote(field.sqlColumn)}`;
    const extracted = `json_extract(${column},'$[' || n || ']')`;
    const types = targetField.type === "number" ? "'integer','real'" : "'text'";
    const missing = `EXISTS (${indices(column)} SELECT 1 FROM positions WHERE json_type(${column},'$[' || n || ']') NOT IN (${types}) OR NOT EXISTS (SELECT 1 FROM ${quote(target.sqlName)} AS target WHERE target.${quote(targetField.sqlColumn)}=${extracted}))`;
    for (const event of ["INSERT", "UPDATE"]) statements.push(`CREATE TRIGGER ${quote(`rel_${suffix}_${event.toLowerCase()}`)} BEFORE ${event} ON ${quote(table.sqlName)} WHEN ${missing} BEGIN SELECT RAISE(ABORT,'Unknown related record'); END;`);
    const source = `source.${quote(field.sqlColumn)}`;
    const linked = `EXISTS (SELECT 1 FROM ${quote(table.sqlName)} AS source WHERE EXISTS (${indices(source)} SELECT 1 FROM positions WHERE json_extract(${source},'$[' || n || ']')=OLD.${quote(targetField.sqlColumn)}))`;
    statements.push(`CREATE TRIGGER ${quote(`rel_${suffix}_delete`)} BEFORE DELETE ON ${quote(target.sqlName)} WHEN ${linked} BEGIN SELECT RAISE(ABORT,'Record is still linked'); END;`);
    statements.push(`CREATE TRIGGER ${quote(`rel_${suffix}_target`)} BEFORE UPDATE OF ${quote(targetField.sqlColumn)} ON ${quote(target.sqlName)} WHEN NEW.${quote(targetField.sqlColumn)} IS NOT OLD.${quote(targetField.sqlColumn)} AND ${linked} BEGIN SELECT RAISE(ABORT,'Record is still linked'); END;`);
  }
  return statements.join("\n\n") + "\n";
}

/** Generates initial, editable sources. Callers must never replace existing sources with this output. */
export function generateDatasetSources(value: DatasetDefinition): { definition: DatasetDefinition; files: Record<string, string> } {
  const definition = parseDatasetDefinition(value);
  for (const operation of definition.operations) if (operation.kind === "edit") operation.reversible = true;
  if (definition.operations.some(operation => operation.kind === "action")) throw new Error("Custom actions need authored operation source. Create that source before approving this Collection.");
  if (definition.tables.some(table => datasetColumnFields(table).some(field => field.sqlColumn.toLowerCase() === versionColumn))) throw new Error("The field column _record_version is reserved. Choose another column name.");
  for (const operation of definition.operations.filter(operation => operation.kind === "create")) {
    const table = definition.tables.find(table => table.tableId === operation.tableId)!;
    for (const field of datasetColumnFields(table)) {
      if (field.required && !Object.hasOwn(field, "default") && !operation.fieldIds.includes(field.fieldId) && !(field.sqlColumn === table.primaryKey && field.type === "text")) {
        throw new Error("A create operation cannot fill a required field. Expose the field or define a default.");
      }
    }
  }
  const descriptor = posix.join(posix.dirname(definition.schemaPath), "dataset.json");
  return { definition, files: {
    [descriptor]: JSON.stringify(definition, null, 2) + "\n",
    [definition.schemaPath]: generateDatasetSchema(definition),
    [definition.operationsPath]: generateDatasetOperations(definition),
  } };
}
