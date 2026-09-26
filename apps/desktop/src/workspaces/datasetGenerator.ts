import { posix } from "node:path";
import { datasetColumnFields, parseDatasetDefinition, type DatasetColumnField, type DatasetDefinition } from "@dohc/security-contract/dataset";

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
    [definition.operationsPath]: `const definition = ${JSON.stringify(withoutButtons(definition))};\n${operationsSource}`,
  } };
}

// Operations read and write columns only, so their embedded definition leaves
// buttons out, and adding a button leaves the operations as they are.
function withoutButtons(definition: DatasetDefinition): DatasetDefinition {
  return { ...definition, tables: definition.tables.map(table => ({ ...table, fields: datasetColumnFields(table) })) };
}

/** Labels and captured source paths may change without changing executable rules. */
export function hasGeneratedDatasetOperations(source: string, definition: DatasetDefinition): boolean {
  const end = source.indexOf(";\n");
  if (!source.startsWith("const definition = ") || end < 0 || source.slice(end + 2) !== operationsSource) return false;
  try {
    const embedded = parseDatasetDefinition(JSON.parse(source.slice("const definition = ".length, end)));
    const normalize = (value: DatasetDefinition) => {
      const copy = structuredClone(withoutButtons(value)); copy.name = ""; copy.schemaPath = ""; copy.operationsPath = "";
      for (const table of copy.tables) { table.name = ""; for (const field of table.fields) field.name = ""; }
      return JSON.stringify(copy);
    };
    return normalize(embedded) === normalize(definition);
  } catch { return false; }
}

// This source runs inside the existing synchronous, transaction-scoped guest API.
const operationsSource = String.raw`
const q = name => '"' + name + '"';
const own = (object, key) => Object.hasOwn(object, key);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(ctx) { ctx.refuse('invalid_input', 'Check the fields and try again.'); }
function write(ctx, sql, params) {
  try { return ctx.db.execute(sql, params); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed/.test(message)) ctx.refuse('not_unique','A record already uses this value. Choose another value.');
    if (/FOREIGN KEY constraint failed|Unknown related record|Record is still linked/.test(message)) ctx.refuse('relation_conflict','Check the linked records before making this change.');
    throw error;
  }
}
function valid(field, value) {
  if (value === null) return !field.required;
  switch (field.type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'checkbox': return typeof value === 'boolean';
    case 'text': return typeof value === 'string';
    case 'date': { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const time = new Date(value + 'T00:00:00.000Z'); return Number.isFinite(time.getTime()) && time.toISOString().slice(0,10) === value; }
    case 'url': return typeof value === 'string' && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(value);
    case 'select': return field.options.includes(value);
    case 'multi-select': return Array.isArray(value) && value.every(item => field.options.includes(item)) && new Set(value).size === value.length;
    case 'attachment': return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
    case 'relation': {
      const table = definition.tables.find(table => table.tableId === field.relation.tableId);
      const target = table.fields.find(item => item.fieldId === field.relation.fieldId);
      const scalar = item => target.type === 'number' ? typeof item === 'number' && Number.isFinite(item) && (target.sqlColumn !== table.primaryKey || Number.isSafeInteger(item)) : typeof item === 'string';
      return field.relation.many ? Array.isArray(value) && value.length <= 100 && value.every(scalar) && new Set(value).size === value.length : scalar(value);
    }
  }
  return false;
}
function encode(field, value) {
  if (value === null) return null;
  return field.type === 'checkbox' ? Number(value) : field.type === 'multi-select' || field.relation?.many ? JSON.stringify(value) : value;
}
function decode(field, value) {
  if (value === null) return null;
  return field.type === 'checkbox' ? value === 1 : field.type === 'multi-select' || field.relation?.many ? JSON.parse(value) : value;
}
function values(ctx, table, operation, input) {
  if (!object(input) || Object.keys(input).some(id => !operation.fieldIds.includes(id))) invalid(ctx);
  return Object.entries(input).map(([id, value]) => {
    const field = table.fields.find(field => field.fieldId === id);
    if (!valid(field, value) || (field.sqlColumn === table.primaryKey && field.type === 'number' && !Number.isSafeInteger(value))) invalid(ctx);
    if (field.type === 'attachment' && value !== null) ctx.files.attach(value);
    return { field, value: encode(field, value) };
  });
}
function recordId(ctx, primary, id) {
  if (primary.type === 'number' ? !Number.isSafeInteger(id) : typeof id !== 'string' || !id.length) invalid(ctx);
  return id;
}
function projected(table, fields, row) {
  return { id: row[table.primaryKey], version: row._record_version, values: Object.fromEntries(fields.map(field => [field.fieldId, decode(field, row[field.sqlColumn])])) };
}
globalThis.operations = Object.fromEntries(definition.operations.map(operation => [operation.name, (ctx, input) => {
  if (ctx.caller.kind !== 'owner' && operation.access !== 'link' && !(operation.access === 'helper' && ctx.caller.kind === 'named' && ctx.caller.helper === true)) ctx.refuse('forbidden', 'You do not have access to this operation.');
  if (!object(input)) invalid(ctx);
  const table = definition.tables.find(table => table.tableId === operation.tableId);
  const primary = table.fields.find(field => field.sqlColumn === table.primaryKey);
  const fields = table.fields.filter(field => operation.fieldIds.includes(field.fieldId));
  const name = q(table.sqlName), pk = q(table.primaryKey);
  if (operation.kind === 'read') {
    if (Object.keys(input).some(key => !['limit','after','search','filters','sort','range','group','groupBy','groupAfter'].includes(key))) invalid(ctx);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid(ctx);
    let sortField = primary, direction = 'asc';
    if (input.sort !== undefined) {
      if (!object(input.sort) || Object.keys(input.sort).some(key => !['fieldId','direction'].includes(key))) invalid(ctx);
      sortField = fields.find(field => field.fieldId === input.sort.fieldId);
      direction = input.sort.direction;
      if (!sortField || !['asc','desc'].includes(direction) || ['attachment','multi-select'].includes(sortField.type) || sortField.relation?.many) invalid(ctx);
    }
    const column = q(sortField.sqlColumn), terms = [], params = [], compare = direction === 'asc' ? '>' : '<';
    if (input.after !== undefined && input.after !== null) {
      const cursor = input.after;
      if (!object(cursor) || Object.keys(cursor).some(key => !['id','value'].includes(key)) || !own(cursor,'value') || !valid(sortField,cursor.value)) invalid(ctx);
      const id = recordId(ctx, primary, cursor.id), value = encode(sortField,cursor.value);
      if (value === null) { terms.push('(' + column + ' IS NOT NULL OR (' + column + ' IS NULL AND ' + pk + compare + '?))'); params.push(id); }
      else { terms.push('(' + column + compare + '? OR (' + column + ' = ? AND ' + pk + compare + '?))'); params.push(value,value,id); }
    }
    if (input.search !== undefined) {
      if (typeof input.search !== 'string' || input.search.length > 200) invalid(ctx);
      const searchable = fields.filter(field => ['text','url','select'].includes(field.type));
      if (!searchable.length) terms.push('0');
      else { params.push(input.search); terms.push('(' + searchable.map(field => 'instr(lower(' + q(field.sqlColumn) + '),lower(?' + params.length + ')) > 0').join(' OR ') + ')'); }
    }
    if (input.filters !== undefined) {
      if (!Array.isArray(input.filters) || input.filters.length > 20) invalid(ctx);
      for (const filter of input.filters) {
        if (!object(filter) || Object.keys(filter).some(key => !['fieldId','value'].includes(key))) invalid(ctx);
        const field = fields.find(field => field.fieldId === filter.fieldId);
        if (!field || !valid(field,filter.value)) invalid(ctx);
        terms.push(q(field.sqlColumn) + ' IS ?'); params.push(encode(field,filter.value));
      }
    }
    if (input.group !== undefined) {
      const group = input.group, field = object(group) && fields.find(field => field.fieldId === group.fieldId);
      if (!field || Object.keys(group).some(key => !['fieldId','value'].includes(key)) || !valid(field,group.value)) invalid(ctx);
      terms.push(q(field.sqlColumn) + ' IS ?'); params.push(encode(field,group.value));
    }
    if (input.range !== undefined) {
      const range = input.range, field = object(range) && fields.find(field => field.fieldId === range.fieldId);
      if (!field || field.type !== 'date' || Object.keys(range).some(key => !['fieldId','start','end'].includes(key)) || typeof range.start !== 'string' || typeof range.end !== 'string' || !valid(field,range.start) || !valid(field,range.end) || range.start >= range.end) invalid(ctx);
      terms.push(q(field.sqlColumn) + ' >= ? AND ' + q(field.sqlColumn) + ' < ?'); params.push(range.start,range.end);
    }
    if (input.groupBy !== undefined) {
      const field = fields.find(field => field.fieldId === input.groupBy);
      if (!field || ['attachment','multi-select'].includes(field.type) || field.relation?.many || input.after !== undefined || input.sort !== undefined || limit > 8) invalid(ctx);
      const group = q(field.sqlColumn);
      if (input.groupAfter !== undefined) {
        const cursor = input.groupAfter;
        if (!object(cursor) || Object.keys(cursor).length !== 1 || !own(cursor,'value') || !valid(field,cursor.value)) invalid(ctx);
        if (cursor.value === null) terms.push(group + ' IS NOT NULL');
        else { terms.push(group + ' > ?'); params.push(encode(field,cursor.value)); }
      }
      params.push(limit + 1);
      const rows = ctx.db.query('SELECT DISTINCT ' + group + ' AS value FROM ' + name + (terms.length ? ' WHERE ' + terms.join(' AND ') : '') + ' ORDER BY ' + group + ' ASC NULLS FIRST LIMIT ?',params);
      const more = rows.length > limit; if (more) rows.pop();
      return { groupBy: field.fieldId, groups: rows.map(row => decode(field,row.value)), nextGroupCursor: more ? {value:decode(field,rows[rows.length-1].value)} : null };
    }
    if (input.groupAfter !== undefined) invalid(ctx);
    const selected = [...new Set([table.primaryKey,'_record_version',sortField.sqlColumn,...fields.map(field => field.sqlColumn)])].map(q).join(',');
    params.push(limit + 1);
    const rows = ctx.db.query('SELECT ' + selected + ' FROM ' + name + (terms.length ? ' WHERE ' + terms.join(' AND ') : '') + ' ORDER BY ' + column + ' ' + direction + ' NULLS FIRST,' + pk + ' ' + direction + ' LIMIT ?',params);
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows[rows.length - 1];
    return {rows:rows.map(row => projected(table,fields,row)),nextCursor:more ? {id:last[table.primaryKey],value:decode(sortField,last[sortField.sqlColumn])} : null,...(input.range ? {range:input.range} : {}),...(input.group ? {group:input.group} : {})};
  }
  if (operation.kind === 'create') {
    if (Object.keys(input).some(key => key !== 'values')) invalid(ctx);
    const supplied = values(ctx,table,operation,input.values);
    let id = supplied.find(entry => entry.field.sqlColumn === table.primaryKey)?.value;
    if (id === undefined) { if (primary.type !== 'text') invalid(ctx); id = ctx.requestId; supplied.push({field:primary,value:id}); }
    recordId(ctx,primary,id);
    for (const field of table.fields) if (field.required && !own(field,'default') && !supplied.some(entry => entry.field.fieldId === field.fieldId)) invalid(ctx);
    write(ctx,'INSERT INTO ' + name + ' (' + supplied.map(entry => q(entry.field.sqlColumn)).join(',') + ') VALUES (' + supplied.map(() => '?').join(',') + ')',supplied.map(entry => entry.value));
    return {id,version:1};
  }
  if (Object.keys(input).some(key => !['id','expectedVersion',...(operation.kind === 'edit' ? ['values'] : [])].includes(key))) invalid(ctx);
  const id = recordId(ctx,primary,input.id);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion >= Number.MAX_SAFE_INTEGER) invalid(ctx);
  const current = ctx.db.query('SELECT ' + [...new Set([table.primaryKey,'_record_version',...fields.map(field => field.sqlColumn)])].map(q).join(',') + ' FROM ' + name + ' WHERE ' + pk + '=?',[id])[0];
  if (!current) ctx.refuse('not_found','This record no longer exists. Refresh the table.');
  if (current._record_version !== input.expectedVersion) ctx.refuse('stale_record','This record changed. Refresh the table before editing it.');
  if (operation.kind === 'delete') {
    write(ctx,'DELETE FROM ' + name + ' WHERE ' + pk + '=? AND "_record_version"=?',[id,input.expectedVersion]);
    return {id,version:input.expectedVersion,deleted:true};
  }
  const supplied = values(ctx,table,operation,input.values);
  if (!supplied.length) invalid(ctx);
  write(ctx,'UPDATE ' + name + ' SET ' + supplied.map(entry => q(entry.field.sqlColumn) + '=?').join(',') + ',"_record_version"="_record_version"+1 WHERE ' + pk + '=? AND "_record_version"=' + input.expectedVersion,[...supplied.map(entry => entry.value),id]);
  return {id,version:input.expectedVersion+1,priorValues:Object.fromEntries(supplied.map(entry => [entry.field.fieldId,decode(entry.field,current[entry.field.sqlColumn])]))};
}]));
`;
