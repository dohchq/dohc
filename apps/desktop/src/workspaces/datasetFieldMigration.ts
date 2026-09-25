import { randomUUID } from "node:crypto";
import { constants, DatabaseSync } from "node:sqlite";
import { datasetColumnFields, type DatasetColumnField, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { generateDatasetSchema } from "./datasetGenerator";

const quote = (name: string) => `"${name}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const temporary = () => `migration_${randomUUID().replaceAll("-", "")}`;

function tableConstraints(sql: string): string[] {
  const start = sql.indexOf("("), clauses: string[] = [];
  let part = "", depth = 0, quoted = "";
  for (let index = start + 1; index < sql.length; index++) {
    const char = sql[index]!;
    if (quoted) { part += char; if (char === quoted) { if (sql[index + 1] === quoted) part += sql[++index]; else quoted = ""; } }
    else if (char === "'" || char === '"') { quoted = char; part += char; }
    else if (char === "(") { depth++; part += char; }
    else if (char === ")" && depth > 0) { depth--; part += char; }
    else if ((char === "," || char === ")") && depth === 0) {
      clauses.push(part.trim()); part = "";
      if (char === ")") { clauses.push(sql.slice(index + 1).trim()); break; }
    } else part += char;
  }
  return clauses.sort();
}

/** Compare physical constraints, including earlier ALTER ADD output, before replacing a generated schema. */
function generatedSchema(actual: string, definition: DatasetDefinition): boolean {
  const inspect = (sql: string) => {
    const db = new DatabaseSync(":memory:", {allowExtension:false});
    try {
      // Inspection cannot run authored statements or access another database.
      db.setAuthorizer((action,first,second,database) => {
        if (database !== null && database !== "main") return constants.SQLITE_DENY;
        if ([constants.SQLITE_CREATE_TABLE,constants.SQLITE_CREATE_INDEX,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_REINDEX].includes(action)) return constants.SQLITE_OK;
        if ([constants.SQLITE_READ,constants.SQLITE_INSERT,constants.SQLITE_UPDATE].includes(action) && ["sqlite_master","sqlite_schema"].includes(first ?? "")) return constants.SQLITE_OK;
        if (action === constants.SQLITE_READ && definition.tables.some(table=>table.sqlName === first)) return constants.SQLITE_OK;
        if (action === constants.SQLITE_FUNCTION && ["json_valid","json_type","json_array_length","json_extract"].includes(second ?? "")) return constants.SQLITE_OK;
        return constants.SQLITE_DENY;
      });
      db.exec(sql);
      db.setAuthorizer(null);
      const tables = definition.tables.map(table => ({ name: table.sqlName,
        constraints: tableConstraints(String(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table.sqlName)!.sql)) }));
      const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','view','index') AND sql IS NOT NULL ORDER BY type,name").all();
      const tableNames = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
      return JSON.stringify({tables,objects,tableNames});
    } finally { db.close(); }
  };
  // Exact source proves predicates, while structural inspection accepts only dohc's known ALTER ADD layout.
  if (actual === generateDatasetSchema(definition)) return true;
  try { return inspect(actual) === inspect(generateDatasetSchema(definition)); } catch { return false; }
}

export function generateFieldMigration(input: { previous: DatasetDefinition; next: DatasetDefinition; schemaSql: string; tableId: string; field: DatasetColumnField }) {
  if (!generatedSchema(input.schemaSql, input.previous)) throw new Error("This field uses custom SQL constraints. Edit the schema source, then choose Review source change.");
  const table = input.next.tables.find(table => table.tableId === input.tableId)!;
  const next = datasetColumnFields(table).find(field => field.fieldId === input.field.fieldId)!;
  const field = input.field, sql: string[] = [], name = quote(field.sqlColumn), tableName = quote(table.sqlName);
  const invalid: string[] = [];
  if (next.required) invalid.push(`${name} IS NULL`);
  if (field.type === "text" && next.type === "number") invalid.push(`(${name} IS NOT NULL AND dohc_migration_number(${name}) IS NULL)`);
  if (invalid.length) {
    const guard = temporary();
    sql.push(`CREATE TABLE ${quote(guard)} (id TEXT);`,
      `CREATE TRIGGER ${quote(`${guard}_check`)} BEFORE INSERT ON ${quote(guard)} BEGIN SELECT RAISE(ABORT,${literal(`Cannot change ${field.name}. Fix record `)} || NEW.id || ${literal(": its value is missing or cannot convert without losing information. Then review again.")}); END;`,
      `INSERT INTO ${quote(guard)} SELECT CAST(${quote(table.primaryKey)} AS TEXT) FROM ${tableName} WHERE ${invalid.join(" OR ")} LIMIT 1;`,
      `DROP TABLE ${quote(guard)};`);
  }
  const copies = input.previous.tables.map(table => ({table, copy: temporary()}));
  for (const {table,copy} of copies) sql.push(`CREATE TABLE ${quote(copy)} AS SELECT * FROM ${quote(table.sqlName)};`);
  for (const {table} of copies) sql.push(`DROP TABLE ${quote(table.sqlName)};`);
  const schemaSql = generateDatasetSchema(input.next);
  const triggerStart = schemaSql.indexOf("CREATE TRIGGER ");
  sql.push(triggerStart < 0 ? schemaSql : schemaSql.slice(0, triggerStart));
  for (const {table: old,copy} of copies) {
    const columns = [...datasetColumnFields(old).map(field => field.sqlColumn), "_record_version"];
    const expressions = columns.map(column => old.tableId === table.tableId && column === field.sqlColumn && field.type !== next.type
      ? `${next.type === "number" ? "dohc_migration_number" : "dohc_migration_number_text"}(${quote(column)})` : quote(column));
    sql.push(`INSERT INTO ${quote(old.sqlName)} (${columns.map(quote).join(",")}) SELECT ${expressions.join(",")} FROM ${quote(copy)};`, `DROP TABLE ${quote(copy)};`);
  }
  if (triggerStart >= 0) sql.push(schemaSql.slice(triggerStart));
  return {schemaSql,migrationSql:sql.join("\n")};
}
