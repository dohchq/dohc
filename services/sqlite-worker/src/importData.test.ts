import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createSqliteEngine } from './sqliteEngine'

// Open the materialized bytes as a real SQLite file and read a table back.
async function readTable(bytes: Uint8Array, table: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dohc-import-test-'))
  const file = join(dir, 'database.sqlite')
  await writeFile(file, bytes)
  const db = new DatabaseSync(file)
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('sqlite worker data imports', () => {
  it.each([
    { name: 'mixed-kinds.csv', mediaType: 'text/csv', body: 'id,qty\na,5\nb,TRUE' },
    { name: 'mixed-kinds.md', mediaType: 'text/markdown', body: '| id | qty |\n| --- | --- |\n| a | 5 |\n| b | TRUE |' },
  ])('preserves mixed boolean and numeric lexemes from $name', async source => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ ...source, tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([{ id: 'a', qty: '5' }, { id: 'b', qty: 'TRUE' }])
  })

  it.each(['json', 'jsonl'])('imports a leading BOM once before %s parsing', async format => {
    const row = { id: 'a', zip: '02134', note: 'inside\uFEFFtext' }
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: `bom.${format}`, mediaType: 'application/json', tableName: 'rows',
      body: '\uFEFF' + JSON.stringify(format === 'json' ? [row] : row) })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([row])
  })

  it('does not strip repeated BOMs from a malformed JSON source', async () => {
    const engine = await createSqliteEngine()
    await expect(engine.materializeImport({ name: 'bad.json', mediaType: 'application/json', tableName: 'rows',
      body: '\uFEFF\uFEFF[{"id":"a"}]' })).resolves.toMatchObject({ ok: false })
  })

  it.each([
    { name: 'short-row.md', body: '| id | note |\n| --- | --- |\n| a | first |\n| b |\n| c | third |',
      rows: [{ id: 'a', note: 'first' }, { id: 'b', note: null }, { id: 'c', note: 'third' }] },
    { name: 'one-column.md', body: '| note |\n| --- |\n| first |\n| second |',
      rows: [{ id: 'row_1', note: 'first' }, { id: 'row_2', note: 'second' }] },
  ])('imports all contiguous rows from $name', async ({ rows, ...source }) => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ ...source, mediaType: 'text/markdown', tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual(rows)
  })

  it('imports quoted CSV headers after a UTF-8 BOM', async () => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'export.csv', mediaType: 'text/csv', tableName: 'rows',
      body: '\uFEFF"id","note","amount"\r\n"a","first",4.5\r\n' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([{ id: 'a', note: 'first', amount: 4.5 }])
  })

  it.each([
    { name: 'mixed.csv', mediaType: 'text/csv', body: 'id,version,flag,count\na,1.10,TRUE,2\nb,2.0-beta,maybe,3', },
    { name: 'mixed.md', mediaType: 'text/markdown', body: '| id | version | flag | count |\n| --- | --- | --- | --- |\n| a | 1.10 | TRUE | 2 |\n| b | 2.0-beta | maybe | 3 |', },
  ])('preserves original text lexemes in mixed columns from $name', async source => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ ...source, tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'a', version: '1.10', flag: 'TRUE', count: 2 },
      { id: 'b', version: '2.0-beta', flag: 'maybe', count: 3 },
    ])
  })

  it('preserves padding inside quoted CSV text fields', async () => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'padding.csv', mediaType: 'text/csv', tableName: 'rows',
      body: 'id,note,value\n" a ","  hello  "," 1.10 "\n" b ","  "," other "' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: ' a ', note: '  hello  ', value: ' 1.10 ' },
      { id: ' b ', note: '  ', value: ' other ' },
    ])
  })

  it('keeps uniform numeric and boolean text columns inferred', async () => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'scalars.csv', mediaType: 'text/csv', tableName: 'rows',
      body: 'id,amount,count,flag\na,1.10,2,TRUE\nb,2.25,-3,FALSE\nc,,,' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'a', amount: 1.1, count: 2, flag: 1 }, { id: 'b', amount: 2.25, count: -3, flag: 0 },
      { id: 'c', amount: null, count: null, flag: null },
    ])
  })

  it('refuses a complete PDF document', async () => {
    const body = await readFile(new URL('./test-fixtures/minimal.pdf', import.meta.url), 'utf8')
    const engine = await createSqliteEngine()
    await expect(engine.materializeImport({ name: 'minimal.pdf', mediaType: 'application/pdf', body, tableName: 'rows' }))
      .resolves.toMatchObject({ ok: false, code: 'unsupported-import-source' })
  })

  it.each(['json', 'jsonl'])('preserves declared strings and scalar types in %s', async format => {
    const rows = [{ id: ' a ', zip: '02134', flag: 'true', text: ' 42 ', empty: '', count: 42, active: true, missing: null }]
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: `data.${format}`, mediaType: 'application/json', tableName: 'rows',
      body: format === 'json' ? JSON.stringify(rows) : JSON.stringify(rows[0]) })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([{ ...rows[0], active: 1 }])
  })

  it('preserves leading-zero text while inferring safe numbers and booleans', async () => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'data.csv', mediaType: 'text/csv', tableName: 'rows',
      body: 'id,zip,negative,decimal,exponent,count,flag,blank\na,02134,-001,01.5,01e2,-42,true,' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'a', zip: '02134', negative: '-001', decimal: '01.5', exponent: '01e2', count: -42, flag: 1, blank: null },
    ])
  })

  it.each([
    'id,note\na,first,discarded', 'id,note\na,"unfinished',
    'id,note\na,un"quoted', 'id,note\na,"finished"extra',
  ])('refuses malformed CSV: %s', async body => {
    const engine = await createSqliteEngine()
    await expect(engine.materializeImport({ name: 'bad.csv', mediaType: 'text/csv', body, tableName: 'rows' }))
      .resolves.toMatchObject({ ok: false })
  })

  it('imports only the first contiguous Markdown table and preserves escaped pipes', async () => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'data.md', mediaType: 'text/markdown', tableName: 'rows', body:
      'Prose | with a pipe\n\n| id | note |\n| --- | --- |\n| a | one\\|two |\n\nUnrelated | prose\n\n| id | other |\n| --- | --- |\n| b | discarded |' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([{ id: 'a', note: 'one|two' }])
  })

  it.each([
    { name: 'receipt.pdf', mediaType: 'application/pdf', body: '%PDF-1.7\n| id | value |\n| --- | --- |\n| a | 1 |\n%%EOF' },
    { name: 'disguised.csv', mediaType: 'application/pdf', body: 'id,value\na,1' },
    { name: 'disguised.csv', mediaType: 'application/pdf; charset=binary', body: 'id,value\na,1' },
    { name: 'receipt.pdf', mediaType: 'text/plain', body: '| id | value |\n| --- | --- |\n| a | 1 |' },
  ])('refuses PDF source $name', async source => {
    const engine = await createSqliteEngine()
    await expect(engine.materializeImport({ ...source, tableName: 'rows' })).resolves.toMatchObject({ ok: false })
  })

  it.each([
    { headers: 'name,name,name_2', expected: { name: 'first', name_3: 'second', name_2: 'third' } },
    { headers: 'name_2,name,name', expected: { name_2: 'first', name: 'second', name_3: 'third' } },
    { headers: 'Name,name,NAME_2', expected: { Name: 'first', name_3: 'second', NAME_2: 'third' } },
    { headers: ',,column_2', expected: { column_1: 'first', column_2: 'second', column_2_2: 'third' } },
    { headers: 'ID,id_2,id', expected: { ID_3: 'first', id_2: 'second', id: 'third' } },
  ])('preserves colliding CSV columns: $headers', async ({ headers, expected }) => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: 'data.csv', mediaType: 'text/csv',
      body: `${headers}\nfirst,second,third`, tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'row_1', ...expected },
    ])
  })

  it.each(['json', 'jsonl'])('keeps normalized keys distinct and stable across %s rows', async format => {
    const rows = [
      { id: 'a', 'a-b': 'first', 'a b': 'second', a_b_2: 'third', X: 'upper', x: 'lower' },
      { id: 'b', 'a b': 'fourth', a_b_2: 'fifth', 'a-b': 'sixth' },
      { id: 'c', 'a b': 'seventh' },
    ]
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: `data.${format}`, mediaType: 'application/json',
      body: format === 'json' ? JSON.stringify(rows) : rows.map(row => JSON.stringify(row)).join('\n'), tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'a', a_b: 'first', a_b_3: 'second', a_b_2: 'third', X: 'upper', x_2: 'lower' },
      { id: 'b', a_b: 'sixth', a_b_3: 'fourth', a_b_2: 'fifth', X: null, x_2: null },
      { id: 'c', a_b: null, a_b_3: 'seventh', a_b_2: null, X: null, x_2: null },
    ])
  })

  it.each(['csv', 'json', 'jsonl'])('preserves integer boundaries in mixed %s columns', async format => {
    const values = ['42', '9007199254740991', '9007199254740992', '9007199254740993',
      '-9007199254740991', '-9007199254740992', '-9007199254740993', '9223372036854775808', '1e999']
    const rows = values.map((value, index) => ({ id: String(index), value }))
    const body = format === 'csv' ? 'id,value\n' + rows.map(row => `${row.id},${row.value}`).join('\n')
      : format === 'json' ? JSON.stringify(rows) : rows.map(row => JSON.stringify(row)).join('\n')
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: `data.${format}`, mediaType: format === 'csv' ? 'text/csv' : 'application/json', body, tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual(rows)
  })

  it.each(['json', 'jsonl'])('preserves unquoted large integer tokens in %s', async format => {
    const records = ['{"id":"a","value":42}', '{"id":"b","value":9007199254740993}', '{"id":"c","value":-9007199254740993}']
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ name: `data.${format}`, mediaType: 'application/json',
      body: format === 'json' ? `[${records.join(',')}]` : records.join('\n'), tableName: 'rows' })
    if (!result.ok) throw new Error(result.message)
    expect(await readTable(result.bytes, result.tableName)).toEqual([
      { id: 'a', value: '42' }, { id: 'b', value: '9007199254740993' }, { id: 'c', value: '-9007199254740993' },
    ])
  })

  it.each([
    { name: 'quoted.csv', mediaType: 'text/csv', body: 'id,note,amount\na,"one,two ""quoted""\nnext",4.5\nb,short',
      rows: [{ id: 'a', note: 'one,two "quoted"\nnext', amount: 4.5 }, { id: 'b', note: 'short', amount: null }] },
    { name: 'data.json', mediaType: 'application/json', body: '[{"id":"a","value":true},{"id":"b","value":false}]',
      rows: [{ id: 'a', value: 1 }, { id: 'b', value: 0 }] },
    { name: 'data.jsonl', mediaType: 'application/x-ndjson', body: '{"id":"a","value":2}\n{"id":"b","value":3}',
      rows: [{ id: 'a', value: 2 }, { id: 'b', value: 3 }] },
    { name: 'data.md', mediaType: 'text/markdown', body: 'Intro\n\n| id | value |\n| --- | --- |\n| a | 2 |\n| b | 3 |\nOutro',
      rows: [{ id: 'a', value: 2 }, { id: 'b', value: 3 }] },
  ])('reads back every imported value from $name', async ({ rows, ...source }) => {
    const engine = await createSqliteEngine()
    const result = await engine.materializeImport({ ...source, tableName: 'imported data' })
    if (!result.ok) throw new Error(result.message)
    expect(result).toMatchObject({ tableName: 'imported_data', rowCount: rows.length })
    expect(await readTable(result.bytes, result.tableName)).toEqual(rows)
  })

  it.each([
    { name: 'empty.csv', mediaType: 'text/csv', body: 'id,value', code: 'empty-import-source' },
    { name: 'unsupported.bin', mediaType: 'application/octet-stream', body: 'data', code: 'unsupported-import-source' },
    { name: 'duplicate.csv', mediaType: 'text/csv', body: 'id,value\na,1\na,2', code: 'sqlite-materialize-failed' },
  ])('refuses $name', async ({ code, ...source }) => {
    const engine = await createSqliteEngine()
    await expect(engine.materializeImport({ ...source, tableName: 'rows' })).resolves.toMatchObject({ ok: false, code })
  })
})
