import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

export type CollectionIndex = {
  indexId: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
}

export type CollectionQuery = {
  where?: Record<string, unknown>
  orderBy?: Array<{ field: string; direction?: 'asc' | 'desc' }>
  limit?: number
}

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

type RowOperation = 'insert' | 'update' | 'upsert' | 'delete'

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_SQL_BYTES = 64 * 1024

const require = createRequire(import.meta.url)
let sqliteModulePromise: Promise<SQLiteModule> | null = null

function sqliteModule() {
  sqliteModulePromise ??= Promise.resolve(require('node:sqlite') as SQLiteModule)
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

function primaryKeyFor(table: DatabaseTable): string {
  return table.columns.find((column) => column.primaryKey)?.name ?? 'id'
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
}

function loadDatabase(DatabaseSync: SQLiteModule['DatabaseSync'], snapshot: DatabaseSnapshot) {
  const db = new DatabaseSync(':memory:')
  createTables(db, snapshot)
  return db
}

function plainRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)))
}

function snapshotFromDatabase(db: SQLiteDatabase): DatabaseSnapshot {
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
  const snapshot: DatabaseSnapshot = {}
  for (const tableRow of tableRows) {
    const tableName = String(tableRow.name)
    const pragma = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all()
    const columns = pragma.map((row) => ({
      name: String(row.name),
      type: sqliteType(String(row.type || 'TEXT')),
      ...(Number(row.pk ?? 0) > 0 ? { primaryKey: true } : {}),
      ...(Number(row.notnull ?? 0) === 0 ? { nullable: true } : {}),
    }))
    snapshot[tableName] = {
      columns,
      rows: plainRows(db.prepare(`SELECT * FROM ${quoteIdent(tableName)}`).all()),
    }
  }
  return snapshot
}

function bytesFromBase64(bytesBase64: string): Buffer | null {
  try {
    const bytes = Buffer.from(bytesBase64, 'base64')
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
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

async function ingestSnapshotFromBytes(
  DatabaseSync: SQLiteModule['DatabaseSync'],
  bytes: Buffer,
) {
  return await withTempDir('dohc-sqlite-ingest-', async (dir) => {
    const file = join(dir, 'database.sqlite')
    await writeFile(file, bytes)
    const db = new DatabaseSync(file)
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all()
      const ok = integrity.length === 1 && String(integrity[0]?.integrity_check ?? '') === 'ok'
      if (!ok) {
        return error('invalid-sqlite-file', 'SQLite integrity check failed.')
      }
      return {
        ok: true as const,
        snapshot: snapshotFromDatabase(db),
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
      }
    } catch (cause) {
      return error('invalid-sqlite-file', cause instanceof Error ? cause.message : 'Invalid SQLite database.')
    } finally {
      db.close()
    }
  })
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

function isReadOnlySelect(sql: string): boolean {
  const trimmed = sql.trim()
  if (!trimmed || new TextEncoder().encode(trimmed).length > MAX_SQL_BYTES) return false
  if (!/^select\b/i.test(trimmed)) return false
  const withoutFinalSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
  return !withoutFinalSemicolon.includes(';')
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

function snapshotForIndex(rows: Array<Record<string, unknown>>): DatabaseSnapshot {
  const columns = columnNamesForRows(rows)
  return {
    rows: {
      columns: columns.map((name) => ({
        name,
        type: inferColumnType(rows, name),
        ...(name === 'id' ? { primaryKey: true } : {}),
      })),
      rows,
    },
  }
}

function queryToSql(query?: CollectionQuery) {
  const whereEntries = Object.entries(query?.where ?? {})
  for (const [field] of whereEntries) quoteIdent(field)
  const orderBy = query?.orderBy ?? []
  for (const item of orderBy) quoteIdent(item.field)
  const clauses = ['SELECT * FROM "rows"']
  const params: unknown[] = []
  if (whereEntries.length > 0) {
    clauses.push(`WHERE ${whereEntries.map(([field]) => `${quoteIdent(field)} = ?`).join(' AND ')}`)
    params.push(...whereEntries.map(([, value]) => bindValue(value)))
  }
  if (orderBy.length > 0) {
    clauses.push(
      `ORDER BY ${orderBy
        .map((item) => `${quoteIdent(item.field)} ${item.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ')}`,
    )
  }
  if (Number.isInteger(query?.limit) && Number(query?.limit) >= 0) {
    clauses.push(`LIMIT ${Number(query?.limit)}`)
  }
  return { sql: clauses.join(' '), params }
}

export async function createSqliteEngine() {
  const { DatabaseSync } = await sqliteModule()

  return {
    preflight() {
      return { ok: true as const, service: 'dohc-sqlite-worker', sqlite: true as const }
    },

    async ingest({ bytesBase64 }: { bytesBase64: string }) {
      const bytes = bytesFromBase64(bytesBase64)
      if (!bytes) return error('invalid-sqlite-file', 'SQLite bytes are missing or invalid.')
      return await ingestSnapshotFromBytes(DatabaseSync, bytes)
    },

    async materialize({ snapshot }: { snapshot: DatabaseSnapshot }) {
      try {
        assertSnapshot(snapshot)
      } catch (cause) {
        return error('invalid-database-snapshot', cause instanceof Error ? cause.message : 'Invalid database snapshot.')
      }
      return await materializeSnapshotToBytes(DatabaseSync, snapshot)
    },

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

    async query({
      snapshot,
      sql,
      params = [],
    }: {
      snapshot: DatabaseSnapshot
      sql: string
      params?: unknown[]
    }) {
      if (!isReadOnlySelect(sql)) {
        return error('unsupported-sql', 'Only read-only SELECT statements are supported.')
      }
      const db = loadDatabase(DatabaseSync, snapshot)
      try {
        return { ok: true as const, rows: plainRows(db.prepare(sql).all(...params.map(bindValue))) }
      } catch (cause) {
        return error('sqlite-query-failed', cause instanceof Error ? cause.message : 'Query failed.')
      } finally {
        db.close()
      }
    },

    async apply({
      snapshot,
      version,
      expectedVersion,
      operationId,
      op,
      table,
      rowId,
      payload,
    }: {
      snapshot: DatabaseSnapshot
      version: number
      expectedVersion?: number
      operationId: string
      op: RowOperation
      table: string
      rowId?: string
      payload: Record<string, unknown>
    }) {
      if (expectedVersion !== undefined && expectedVersion !== version) {
        return error('database-version-conflict', 'Database version changed.', {
          currentVersion: version,
        })
      }
      const sourceTable = snapshot[table]
      if (!sourceTable) return error('table-not-found', 'Table not found.', { version })
      const key = primaryKeyFor(sourceTable)
      const resolvedRowId = rowId ?? String(payload[key] ?? '')
      if (!resolvedRowId) return error('invalid-row-id', 'Row id is required.', { version })
      const db = loadDatabase(DatabaseSync, snapshot)
      try {
        db.exec('BEGIN')
        const existing = db
          .prepare(`SELECT ${quoteIdent(key)} FROM ${quoteIdent(table)} WHERE ${quoteIdent(key)} = ?`)
          .all(resolvedRowId)
        if (op === 'insert' && existing.length > 0) {
          db.exec('ROLLBACK')
          return error('database-row-conflict', 'Row already exists.', { version })
        }
        if ((op === 'update' || op === 'delete') && existing.length === 0) {
          db.exec('ROLLBACK')
          return error('database-row-not-found', 'Row not found.', { version })
        }
        if (op === 'delete') {
          db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(key)} = ?`).run(resolvedRowId)
        } else if (op === 'insert' || (op === 'upsert' && existing.length === 0)) {
          const row = { ...payload, [key]: resolvedRowId }
          const columns = sourceTable.columns.map((column) => column.name)
          db.prepare(
            `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          ).run(...columns.map((column) => bindValue(row[column])))
        } else {
          const patchColumns = Object.keys(payload).filter((column) => column !== key)
          if (patchColumns.length > 0) {
            db.prepare(
              `UPDATE ${quoteIdent(table)} SET ${patchColumns.map((column) => `${quoteIdent(column)} = ?`).join(', ')} WHERE ${quoteIdent(key)} = ?`,
            ).run(...patchColumns.map((column) => bindValue(payload[column])), resolvedRowId)
          }
        }
        db.exec('COMMIT')
        const nextVersion = version + 1
        return {
          ok: true as const,
          version: nextVersion,
          snapshot: snapshotFromDatabase(db),
          operation: { operationId, op, table, rowId: resolvedRowId, version: nextVersion },
        }
      } catch (cause) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        return error('sqlite-transaction-failed', cause instanceof Error ? cause.message : 'Transaction failed.', { version })
      } finally {
        db.close()
      }
    },

    async rebuildIndex({
      indexId,
      rows,
    }: {
      indexId: string
      rows: Array<Record<string, unknown>>
    }) {
      const snapshot = snapshotForIndex(rows)
      const db = loadDatabase(DatabaseSync, snapshot)
      try {
        const indexedRows = plainRows(db.prepare('SELECT * FROM "rows"').all())
        return {
          ok: true as const,
          index: {
            indexId,
            columns: snapshot.rows!.columns.map((column) => column.name),
            rows: indexedRows,
            rowCount: indexedRows.length,
          } satisfies CollectionIndex,
        }
      } finally {
        db.close()
      }
    },

    async queryIndex(index: CollectionIndex, query?: CollectionQuery) {
      const db = loadDatabase(DatabaseSync, snapshotForIndex(index.rows))
      try {
        const planned = queryToSql(query)
        return {
          ok: true as const,
          rows: plainRows(db.prepare(planned.sql).all(...planned.params)),
        }
      } catch (cause) {
        return error('sqlite-index-query-failed', cause instanceof Error ? cause.message : 'Index query failed.')
      } finally {
        db.close()
      }
    },
  }
}

export type SqliteEngine = Awaited<ReturnType<typeof createSqliteEngine>>
