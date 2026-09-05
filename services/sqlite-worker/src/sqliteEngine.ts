import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type DatabaseColumn = {
  name: string
  type: string
  primaryKey?: boolean
  nullable?: boolean
}

export type DatabaseTable = {
  columns: DatabaseColumn[]
  rows: Array<Record<string, unknown>>
}

export type DatabaseSnapshot = Record<string, DatabaseTable>

export type ImportDataInput = {
  name: string
  mediaType: string
  body: string
  tableName: string
  mode?: 'infer-schema' | 'provided-schema'
  schema?: Record<string, 'text' | 'integer' | 'real' | 'boolean' | 'datetime'>
}

type SQLiteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>
    run(...params: unknown[]): unknown
  }
  close(): void
}

type SQLiteModule = {
  DatabaseSync: new (location: string) => SQLiteDatabase
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Named requireModule (not `require`): bundlers that emit an ESM chunk with a
// CommonJS shim inject their own top-level `const require`, and a second
// declaration is a SyntaxError at load time.
const requireModule = createRequire(import.meta.url)
let sqliteModulePromise: Promise<SQLiteModule> | null = null

function sqliteModule() {
  sqliteModulePromise ??= Promise.resolve(requireModule('node:sqlite') as SQLiteModule)
  return sqliteModulePromise
}

function error(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, message, ...extra }
}

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQLite identifier: ${name}`)
  return `"${name}"`
}

function sqliteType(type: string): string {
  const clean = type.trim().toUpperCase()
  if (clean === 'INTEGER' || clean === 'REAL' || clean === 'TEXT' || clean === 'BLOB') {
    return clean
  }
  if (clean.includes('INT')) return 'INTEGER'
  if (clean.includes('REAL') || clean.includes('FLOA') || clean.includes('DOUB')) return 'REAL'
  return 'TEXT'
}

function bindValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value ?? null)
}

function assertSnapshot(snapshot: DatabaseSnapshot) {
  for (const [tableName, table] of Object.entries(snapshot)) {
    quoteIdent(tableName)
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error('Invalid database snapshot.')
    }
    const seen = new Set<string>()
    for (const column of table.columns) {
      quoteIdent(column.name)
      if (seen.has(column.name)) throw new Error(`Duplicate column: ${column.name}`)
      seen.add(column.name)
    }
  }
}

function createTables(db: SQLiteDatabase, snapshot: DatabaseSnapshot) {
  assertSnapshot(snapshot)
  // One transaction for the whole load: without it every INSERT autocommits
  // (its own fsync on file-backed databases), which turned a 10,000-row CSV
  // import into minutes of frozen main process. Batched, it is sub-second.
  db.exec('BEGIN')
  try {
    for (const [tableName, table] of Object.entries(snapshot)) {
      const columns = table.columns.map((column) => {
        const parts = [quoteIdent(column.name), sqliteType(column.type)]
        if (column.primaryKey) parts.push('PRIMARY KEY')
        if (column.nullable !== true && column.primaryKey) parts.push('NOT NULL')
        return parts.join(' ')
      })
      db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${columns.join(', ')})`)
      if (table.rows.length === 0) continue
      const columnNames = table.columns.map((column) => column.name)
      const placeholders = columnNames.map(() => '?').join(', ')
      const statement = db.prepare(
        `INSERT INTO ${quoteIdent(tableName)} (${columnNames.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
      )
      for (const row of table.rows) {
        statement.run(...columnNames.map((column) => bindValue(row[column])))
      }
    }
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function materializeSnapshotToBytes(
  DatabaseSync: SQLiteModule['DatabaseSync'],
  snapshot: DatabaseSnapshot,
) {
  return await withTempDir('dohc-sqlite-materialize-', async (dir) => {
    const file = join(dir, 'database.sqlite')
    const db = new DatabaseSync(file)
    try {
      createTables(db, snapshot)
      db.close()
      const bytes = await readFile(file)
      return {
        ok: true as const,
        bytesBase64: bytes.toString('base64'),
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
      }
    } catch (cause) {
      try {
        db.close()
      } catch {}
      return error('sqlite-materialize-failed', cause instanceof Error ? cause.message : 'Could not materialize SQLite database.')
    }
  })
}

function columnNamesForRows(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>(['id'])
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      quoteIdent(key)
      columns.add(key)
    }
  }
  return Array.from(columns)
}

function inferColumnType(rows: Array<Record<string, unknown>>, column: string): string {
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    if (typeof value === 'boolean') return 'INTEGER'
  }
  return 'TEXT'
}

function sqliteTypeForSchemaType(type: string): string {
  switch (type) {
    case 'integer':
    case 'boolean':
      return 'INTEGER'
    case 'real':
      return 'REAL'
    default:
      return 'TEXT'
  }
}

function safeIdentifier(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const candidate = normalized || fallback
  return /^[A-Za-z_]/.test(candidate) ? candidate : `_${candidate}`
}

function uniqueIdentifiers(values: string[]): string[] {
  const seen = new Map<string, number>()
  return values.map((value, index) => {
    const base = safeIdentifier(value, `column_${index + 1}`)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function parseScalar(value: unknown, columnName?: string): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (columnName === 'id') return trimmed
  if (trimmed === '') return null
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed)
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?(?:\d+\.\d+|\d+e[+-]?\d+|\d+\.\d+e[+-]?\d+)$/i.test(trimmed)) {
    return Number(trimmed)
  }
  return trimmed
}

function parseCsvRecords(body: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    const next = body[index + 1]
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      record.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }
  record.push(field)
  records.push(record)

  return records.filter((row, index) =>
    index < records.length - 1 || row.some((cell) => cell.trim() !== ''),
  )
}

function rowsFromDelimitedRecords(records: string[][]): Array<Record<string, unknown>> {
  if (records.length < 1) return []
  const headers = uniqueIdentifiers(records[0].map((cell) => cell.trim()))
  return records.slice(1).filter((row) => row.some((cell) => cell.trim() !== '')).map((row, rowIndex) => {
    const out: Record<string, unknown> = {}
    for (let index = 0; index < headers.length; index += 1) {
      const column = headers[index]
      out[column] = parseScalar(row[index] ?? '', column)
    }
    if (out.id === undefined || out.id === null || String(out.id).trim() === '') {
      out.id = `row_${rowIndex + 1}`
    }
    return out
  })
}

function parseCsv(body: string): Array<Record<string, unknown>> {
  return rowsFromDelimitedRecords(parseCsvRecords(body))
}

function parseJsonArray(body: string): Array<Record<string, unknown>> | null {
  try {
    const value = JSON.parse(body)
    if (!Array.isArray(value)) return null
    return normalizeImportedRows(value)
  } catch {
    return null
  }
}

function parseJsonl(body: string): Array<Record<string, unknown>> | null {
  try {
    return normalizeImportedRows(
      body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
  } catch {
    return null
  }
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isMarkdownSeparator(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function parseMarkdownTable(body: string): Array<Record<string, unknown>> | null {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitMarkdownRow(lines[index])
    const separator = splitMarkdownRow(lines[index + 1])
    if (!isMarkdownSeparator(separator)) continue
    const columns = uniqueIdentifiers(headers)
    const records: string[][] = [columns]
    for (const line of lines.slice(index + 2)) {
      const cells = splitMarkdownRow(line)
      if (cells.length < 2) break
      records.push(cells)
    }
    return rowsFromDelimitedRecords(records)
  }
  return null
}

function normalizeImportedRows(values: unknown[]): Array<Record<string, unknown>> {
  return values.map((value, index) => {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : { value }
    const row: Record<string, unknown> = {}
    const keys = uniqueIdentifiers(Object.keys(source))
    Object.entries(source).forEach(([key, item], keyIndex) => {
      const column = keys[keyIndex] ?? safeIdentifier(key, `column_${keyIndex + 1}`)
      row[column] = parseScalar(item, column)
    })
    if (row.id === undefined || row.id === null || String(row.id).trim() === '') {
      row.id = `row_${index + 1}`
    } else {
      row.id = String(row.id)
    }
    return row
  })
}

function rowsForImport(input: ImportDataInput) {
  const mediaType = input.mediaType.toLowerCase()
  const name = input.name.toLowerCase()
  if (mediaType.includes('jsonl') || mediaType.includes('ndjson') || name.endsWith('.jsonl')) {
    return parseJsonl(input.body)
  }
  if (mediaType.includes('json') || name.endsWith('.json')) {
    return parseJsonArray(input.body)
  }
  if (
    mediaType.includes('markdown') ||
    mediaType === 'application/pdf' ||
    name.endsWith('.md') ||
    name.endsWith('.markdown') ||
    name.endsWith('.pdf')
  ) {
    return parseMarkdownTable(input.body)
  }
  if (mediaType.includes('csv') || name.endsWith('.csv') || mediaType.startsWith('text/')) {
    return parseCsv(input.body)
  }
  return null
}

function snapshotForImport(input: ImportDataInput, rows: Array<Record<string, unknown>>): DatabaseSnapshot {
  const tableName = safeIdentifier(input.tableName, 'rows')
  quoteIdent(tableName)
  const columns = columnNamesForRows(rows)
  const schema = input.schema ?? {}
  return {
    [tableName]: {
      columns: columns.map((name) => ({
        name,
        type: schema[name] ? sqliteTypeForSchemaType(schema[name]) : inferColumnType(rows, name),
        ...(name === 'id' ? { primaryKey: true } : {}),
      })),
      rows,
    },
  }
}

export async function createSqliteEngine() {
  const { DatabaseSync } = await sqliteModule()

  return {
    async importData(input: ImportDataInput) {
      const tableName = safeIdentifier(input.tableName, 'rows')
      try {
        quoteIdent(tableName)
      } catch (cause) {
        return error('invalid-table-name', cause instanceof Error ? cause.message : 'Invalid table name.')
      }
      const rows = rowsForImport(input)
      if (!rows) {
        return error('unsupported-import-source', 'Could not parse this import source.')
      }
      if (rows.length === 0) {
        return error('empty-import-source', 'Import source did not contain any rows.')
      }
      let snapshot: DatabaseSnapshot
      try {
        snapshot = snapshotForImport({ ...input, tableName }, rows)
        assertSnapshot(snapshot)
      } catch (cause) {
        return error('invalid-import-schema', cause instanceof Error ? cause.message : 'Import schema is invalid.')
      }
      const materialized = await materializeSnapshotToBytes(DatabaseSync, snapshot)
      if (!materialized.ok) return materialized
      const sourceHash = sha256Text(input.body)
      const table = snapshot[tableName]
      return {
        ok: true as const,
        tableName,
        sourceMediaType: input.mediaType,
        rowCount: table.rows.length,
        sourceHash,
        tableSchema: table.columns,
        snapshot,
        operation: {
          op: 'import_data',
          table: tableName,
          rowCount: table.rows.length,
          sourceHash,
        },
        bytesBase64: materialized.bytesBase64,
        size: materialized.size,
        sha256: materialized.sha256,
      }
    },
  }
}

export type SqliteEngine = Awaited<ReturnType<typeof createSqliteEngine>>
