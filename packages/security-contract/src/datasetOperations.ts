import { datasetColumnFields, parseDatasetDefinition, type DatasetDefinition } from "./dataset";

/** Display names, source paths and buttons do not change executable rules. */
export function generateDatasetOperations(value: DatasetDefinition): string {
  const definition = parseDatasetDefinition(value);
  definition.name = definition.datasetId;
  definition.schemaPath = "schema.sql";
  definition.operationsPath = "operations.js";
  for (const table of definition.tables) {
    table.name = table.tableId;
    table.fields = datasetColumnFields(table);
    for (const field of table.fields) field.name = field.fieldId;
  }
  return `const definition = ${JSON.stringify(definition)};\n${operationsSource}`;
}

export function hasGeneratedDatasetOperations(source: string, definition: DatasetDefinition): boolean {
  return source === generateDatasetOperations(definition);
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
  if (ctx.caller.kind !== 'owner' && operation.access !== 'link' && !(operation.kind === 'read' && operation.access === 'helper' && (ctx.caller.kind === 'link' || ctx.caller.kind === 'named') && ctx.caller.approvedRead === operation.operationId) && !(operation.access === 'helper' && ctx.caller.kind === 'named' && ctx.caller.helper === true)) ctx.refuse('forbidden', 'You do not have access to this operation.');
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
