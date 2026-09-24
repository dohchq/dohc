import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parseDatasetDefinition, parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";

/** Prepare a separate source revision. Only owner approval can activate the public read action. */
export function generateDatasetRelationChoices(input: { revision: DatasetRevision; schemaSql: string; operationSource: string; tableId: string; fieldId: string; labelFieldId: string }) {
  const revision = parseDatasetRevision(input.revision), definition = structuredClone(revision.definition);
  const field = definition.tables.find(table => table.tableId === input.tableId)?.fields.find(field => field.fieldId === input.fieldId);
  if (!field?.relation) throw Error("Choose a related-record field in this Collection.");
  const relation = field.relation;
  const target = definition.tables.find(table => table.tableId === relation.tableId)!;
  const key = target.fields.find(field => field.fieldId === relation.fieldId)!;
  const label = target.fields.find(field => field.fieldId === input.labelFieldId);
  if (!label || !["text", "number", "select"].includes(label.type)) throw Error("Choose a text, number, or select field as the public label.");
  const operationId = randomUUID(), name = `choices_${operationId.replaceAll("-", "")}`;
  definition.operations.push({ operationId, name, label: `Read ${field.name} choices`, tableId: target.tableId, kind: "read", access: "link", readOnly: true,
    fieldIds: [...new Set([key.fieldId, label.fieldId])] });
  const base = posix.dirname(definition.schemaPath).split(/(?:^|\/)revisions\//)[0]!;
  const directory = posix.join(base, "revisions", `${revision.revision + 1}-${randomUUID()}`);
  definition.schemaPath = posix.join(directory, "schema.sql"); definition.operationsPath = posix.join(directory, `operations${posix.extname(revision.definition.operationsPath)}`);
  const parsed = parseDatasetDefinition(definition);
  const quote = (value: string) => `"${value}"`;
  const operationSource = input.operationSource + `\n;(() => {\nconst settings = ${JSON.stringify({ name, table: quote(target.sqlName), key: quote(key.sqlColumn), label: quote(label.sqlColumn), keyFieldId: key.fieldId, labelFieldId: label.fieldId, numeric: key.type === "number" })};\n${READ_SOURCE}\n})();\n`;
  const descriptorPath = posix.join(directory, "dataset.json"), migrationPath = posix.join(directory, "migration.sql"), migrationSql = "SELECT 1;";
  return { definition: parsed, schemaSql: input.schemaSql, operationSource, descriptorPath, migrationPath, migrationSql,
    summary: `Allow apps to request ${key.name} and ${label.name} from ${target.name}`,
    files: { [descriptorPath]: JSON.stringify(parsed, null, 2) + "\n", [parsed.schemaPath]: input.schemaSql, [parsed.operationsPath]: operationSource, [migrationPath]: migrationSql } };
}

const READ_SOURCE = String.raw`
if (globalThis.operations === null || typeof globalThis.operations !== 'object' || !Object.isExtensible(globalThis.operations)) {
  throw new Error('This Collection locks its action source. Edit the source to add public choices, then review the change.');
}
globalThis.operations[settings.name] = (ctx, input) => {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const invalid = () => ctx.refuse('invalid_input', 'Check the choice search and try again.');
  const scalar = value => settings.numeric ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'string' && value.length > 0;
  if (!object(input) || Object.keys(input).some(key => !['limit','after','search'].includes(key))) invalid();
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const terms = [], params = [];
  if (input.after !== undefined && input.after !== null) {
    const after = input.after;
    if (!object(after) || Object.keys(after).some(key => !['id','value'].includes(key)) || !scalar(after.id) || after.value !== after.id) invalid();
    terms.push(settings.key + '> ?'); params.push(after.id);
  }
  if (input.search !== undefined) {
    if (typeof input.search !== 'string' || input.search.length > 200) invalid();
    terms.push('instr(lower(CAST(' + settings.label + ' AS TEXT)),lower(?)) > 0'); params.push(input.search);
  }
  params.push(limit + 1);
  const rows = ctx.db.query('SELECT ' + settings.key + ' AS choice_key,' + settings.label + ' AS choice_label FROM ' + settings.table +
    (terms.length ? ' WHERE ' + terms.join(' AND ') : '') + ' ORDER BY ' + settings.key + ' LIMIT ?', params);
  const more = rows.length > limit; if (more) rows.pop();
  const last = rows[rows.length - 1];
  return { rows: rows.map(row => ({ id: row.choice_key, values: { [settings.keyFieldId]: row.choice_key, [settings.labelFieldId]: row.choice_label === null || row.choice_label === '' ? row.choice_key : row.choice_label } })),
    nextCursor: more ? { id: last.choice_key, value: last.choice_key } : null };
};
`;
