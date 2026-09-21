import type { CollectionSchema } from "@dohc/workspace-contracts/collection";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { generateAppFormFrontend } from "./appFormFrontend";

type Field = { name: string; type: "text" | "number" | "checkbox" | "date" | "select" | "url"; options?: string[]; column: string };
const types = new Set(["text", "number", "checkbox", "date", "select", "url"]);
const reserved = new Set(["id", "version", "createdAt", "__proto__", "constructor", "prototype"]);
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

/** Reuses field definitions once. It does not copy records or maintain a link to the Collection. */
export function generateAppForm(input: {
  schema: CollectionSchema; schemaSource: string; appRoot: string; publicFields: string[];
}): { files: Record<string, string> } {
  const { schema, appRoot, schemaSource } = input;
  if (!isShareablePath(appRoot) || !/^[A-Za-z0-9_@./-]+$/.test(appRoot) || appRoot.length > 900 || !isShareablePath(schemaSource)) {
    throw new Error("Choose workspace paths for the Collection and new app.");
  }
  if (!schema.fields.length || schema.fields.length > 24 || schema.fields.reduce((sum, field) => sum + field.name.length, 0) > 512) {
    throw new Error("Use 1 to 24 fields with at most 512 characters across their names.");
  }
  const names = new Set<string>();
  const fields: Field[] = schema.fields.map((field, index) => {
    if (!field.name.trim() || field.name.length > 64 || /[\u0000-\u001f\u007f]/u.test(field.name) || reserved.has(field.name) || names.has(field.name)) {
      throw new Error(`Rename the unsupported or repeated field: ${field.name}.`);
    }
    names.add(field.name);
    if (!types.has(field.type)) throw new Error(`The form generator does not support ${field.type} fields. Remove or change ${field.name}.`);
    if (field.type === "select" && (!field.options.length || field.options.length > 100 ||
        new Set(field.options).size !== field.options.length || field.options.some(option => !option || option.length > 200 || /[\u0000-\u001f\u007f]/u.test(option)))) {
      throw new Error(`Use 1 to 100 distinct, short options for ${field.name}.`);
    }
    return { name: field.name, type: field.type as Field["type"], column: `field_${index + 1}`,
      ...(field.type === "select" ? { options: [...field.options] } : {}) };
  });
  if (!input.publicFields.length || new Set(input.publicFields).size !== input.publicFields.length || input.publicFields.some(name => !names.has(name))) {
    throw new Error("Choose at least 1 public field. Use each existing field name once.");
  }
  const publicFields = fields.filter(field => input.publicFields.includes(field.name));
  if (new TextEncoder().encode(json(fields)).byteLength > 32 * 1024) {
    throw new Error("The field definitions are too large. Shorten the names or select options.");
  }
  const title = (schema.name || "New form").slice(0, 200);
  const columns = fields.map(field => `  ${field.column} ${field.type === "number" ? "REAL" : field.type === "checkbox" ? "INTEGER" : "TEXT"}`);
  // JSON keeps the source path on one SQL comment line, even for hostile labels.
  const schemaSql = `-- Field definitions from ${json(schemaSource)}. Existing records are not copied.\n` +
    "-- This database is the sole response store. Later Collection edits do not update this schema.\n" +
    "CREATE TABLE responses (\n  id TEXT PRIMARY KEY NOT NULL,\n  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),\n  created_at INTEGER NOT NULL,\n" +
    columns.join(",\n") + "\n);\n";
  const backend = `// Edit this source to add app-specific rules. All writes run in a host transaction.\n` +
    `const fields = ${json(fields)};\nconst publicNames = ${json(publicFields.map(field => field.name))};\n` + backendOperations;
  const inputs = ["frontend.js", "frontend.css", "backend.js", "schema.sql"].map(path => `${appRoot}/${path}`);
  const manifest = {
    entryPath: `${appRoot}/frontend.js`, inputs, packageMap: {},
    backend: { entryPath: `${appRoot}/backend.js`, schemaPath: `${appRoot}/schema.sql`, dataPath: `${appRoot}/responses.sqlite`, schemaVersion: 1,
      operations: [
        { name: "submit", access: "link", readOnly: false },
        { name: "listResponses", access: "helper", readOnly: true },
        { name: "editResponse", access: "helper", readOnly: false },
      ],
      tables: [{ name: "responses", primaryKey: "id", readOperation: "listResponses", writeOperation: "editResponse" }],
    },
  };
  return { files: {
    ...generateAppFormFrontend({ title, fields: publicFields.map(({ column: _column, ...field }) => field) }),
    "dohc.json": JSON.stringify({ type: "site", title }, null, 2) + "\n",
    "backend.js": backend, "schema.sql": schemaSql, "app.publish.json": JSON.stringify(manifest, null, 2) + "\n",
  } };
}

const backendOperations = String.raw`
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = ctx => ctx.refuse("invalid_input", "Check the field values and try again.");
function organizer(ctx) {
  const caller = ctx.caller;
  if (caller.kind !== "owner" && !(caller.kind === "named" && caller.access === "edit" && caller.helper === true)) {
    ctx.refuse("forbidden", "Organizer access is required.");
  }
}
function only(ctx, input, allowed) {
  if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) invalid(ctx);
}
function value(ctx, field, raw, editing = false) {
  if (raw === null || raw === undefined) return null;
  if (editing && raw === "") return null;
  if (editing && typeof raw === "string" && field.type !== "text" && field.type !== "select") {
    if (!raw.trim()) return null;
    if (field.type === "number" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) raw = Number(raw);
    if (field.type === "checkbox" && ["true", "false"].includes(raw)) raw = raw === "true";
  }
  if (field.type === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER) invalid(ctx);
    return raw;
  }
  if (field.type === "checkbox") {
    if (typeof raw !== "boolean") invalid(ctx);
    return raw ? 1 : 0;
  }
  if (typeof raw !== "string" || raw.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) invalid(ctx);
  if (field.type === "select" && !field.options.includes(raw)) invalid(ctx);
  if (field.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) invalid(ctx);
    const date = new Date(raw + "T00:00:00.000Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) invalid(ctx);
  }
  if (field.type === "url" && !/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(raw)) invalid(ctx);
  return raw;
}
function display(row) {
  return Object.fromEntries([["id", row.id], ["version", row.version], ["createdAt", row.created_at],
    ...fields.map(field => [field.name, field.type === "checkbox" && row[field.column] !== null ? row[field.column] === 1 : row[field.column]])]);
}
function bound(ctx, row) {
  // At most 50 rows fit within the host's response bound, including JSON escaping.
  const text = JSON.stringify(display(row));
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  if (bytes > 3500) ctx.refuse("response_too_large", "This response is too long. Shorten the field values.");
}
globalThis.operations = {
  submit(ctx, input) {
    only(ctx, input, publicNames);
    const values = fields.map(field => publicNames.includes(field.name)
      ? value(ctx, field, Object.prototype.hasOwnProperty.call(input, field.name) ? input[field.name] : null)
      : null);
    const row = Object.fromEntries([["id", ctx.requestId], ["version", 1], ["created_at", ctx.nowMs],
      ...fields.map((field, index) => [field.column, values[index]])]);
    bound(ctx, row);
    ctx.db.execute("INSERT INTO responses (id, version, created_at, " + fields.map(field => field.column).join(", ") +
      ") VALUES (?, 1, ?, " + fields.map(() => "?").join(", ") + ")", [ctx.requestId, ctx.nowMs, ...values]);
    return { id: ctx.requestId };
  },
  listResponses(ctx, input) {
    organizer(ctx);
    only(ctx, input, ["offset", "limit", "search"]);
    const { offset = 0, limit = 50, search = "" } = input;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        typeof search !== "string" || search.length > 200) invalid(ctx);
    const where = search ? " WHERE " + fields.map(field => "instr(lower(coalesce(CAST(" + field.column + " AS TEXT), '')), lower(?)) > 0").join(" OR ") : "";
    const args = search ? fields.map(() => search) : [];
    return { rows: ctx.db.query("SELECT * FROM responses" + where + " ORDER BY created_at, id LIMIT ? OFFSET ?", [...args, limit, offset]).map(display),
      total: ctx.db.query("SELECT count(*) AS total FROM responses" + where, args)[0].total };
  },
  editResponse(ctx, input) {
    organizer(ctx);
    only(ctx, input, ["rowId", "field", "value", "expectedVersion"]);
    if (typeof input.rowId !== "string" || input.rowId.length > 128 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        !Object.prototype.hasOwnProperty.call(input, "value")) invalid(ctx);
    const field = fields.find(field => field.name === input.field);
    if (!field) invalid(ctx);
    const row = ctx.db.query("SELECT * FROM responses WHERE id = ?", [input.rowId])[0];
    if (!row || row.version !== input.expectedVersion) ctx.refuse("conflict", "This response changed. Reload it before editing.");
    row[field.column] = value(ctx, field, input.value, true);
    row.version++;
    bound(ctx, row);
    ctx.db.execute("UPDATE responses SET " + field.column + " = ?, version = version + 1 WHERE id = ? AND version = ?",
      [row[field.column], input.rowId, input.expectedVersion]);
    return display(row);
  },
};
`;
