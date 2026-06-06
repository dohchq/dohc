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

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function normalizeWorkspacePath(path: string): string | null {
  const raw = (path ?? '').trim()
  if (
    !raw ||
    raw.startsWith('/') ||
    raw.includes('\\') ||
    raw.includes('\u0000') ||
    raw.includes('//')
  ) {
    return null
  }
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  return segments.join('/')
}

export function isSQLiteLikeFile({
  path,
  filename,
  mediaType,
}: {
  path: string
  filename: string
  mediaType: string
}): boolean {
  const normalizedPath = normalizeWorkspacePath(path)
  if (!normalizedPath || normalizedPath !== path.trim()) return false
  return (
    /\.(sqlite|sqlite3|db)$/i.test(path) &&
    /\.(sqlite|sqlite3|db)$/i.test(filename) &&
    new Set([
      'application/vnd.sqlite3',
      'application/x-sqlite3',
      'application/octet-stream',
    ]).has(mediaType)
  )
}

export function normalizeDatabaseSnapshot(value: unknown): DatabaseSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: DatabaseSnapshot = {}
  for (const [tableName, rawTable] of Object.entries(value as Record<string, unknown>)) {
    if (!TABLE_RE.test(tableName)) return null
    if (!rawTable || typeof rawTable !== 'object' || Array.isArray(rawTable)) return null
    const table = rawTable as Record<string, unknown>
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return null
    const columns: DatabaseColumn[] = []
    for (const rawColumn of table.columns) {
      if (!rawColumn || typeof rawColumn !== 'object' || Array.isArray(rawColumn)) return null
      const column = rawColumn as Record<string, unknown>
      if (typeof column.name !== 'string' || !IDENT_RE.test(column.name)) return null
      if (typeof column.type !== 'string' || !column.type.trim()) return null
      columns.push({
        name: column.name,
        type: column.type.trim().toUpperCase(),
        ...(column.primaryKey === true ? { primaryKey: true } : {}),
        ...(column.nullable === true ? { nullable: true } : {}),
      })
    }
    const columnNames = new Set(columns.map((column) => column.name))
    const rows = table.rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null
      const clean: Record<string, unknown> = {}
      for (const [field, cell] of Object.entries(row as Record<string, unknown>)) {
        if (!columnNames.has(field)) return null
        if (
          cell === null ||
          typeof cell === 'string' ||
          typeof cell === 'number' ||
          typeof cell === 'boolean'
        ) {
          clean[field] = cell
        } else {
          return null
        }
      }
      return clean
    })
    if (rows.some((row) => row === null)) return null
    out[tableName] = { columns, rows: rows as Array<Record<string, unknown>> }
  }
  return out
}

export function introspectTables(snapshot: DatabaseSnapshot) {
  return Object.entries(snapshot)
    .map(([name, table]) => ({ name, columns: table.columns }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function primaryKeyFor(table: DatabaseTable): string {
  return table.columns.find((column) => column.primaryKey)?.name ?? 'id'
}

export function querySnapshot(
  snapshot: DatabaseSnapshot,
  sql: string,
  params: unknown[] = [],
) {
  const match = sql.trim().match(
    /^select\s+\*\s+from\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+where\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?)?(?:\s+order\s+by\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?\s*;?$/i,
  )
  if (!match) {
    return { ok: false as const, code: 'unsupported-sql' as const, message: 'Only simple read-only SELECT queries are supported.' }
  }
  const [, tableName, whereField, orderField, direction, limitRaw] = match
  const table = snapshot[tableName!]
  if (!table) return { ok: false as const, code: 'table-not-found' as const, message: 'Table not found.' }
  let rows = [...table.rows]
  if (whereField) {
    rows = rows.filter((row) => row[whereField] === params[0])
  }
  if (orderField) {
    rows.sort((a, b) => {
      const delta = String(a[orderField] ?? '').localeCompare(String(b[orderField] ?? ''))
      return direction?.toLowerCase() === 'desc' ? -delta : delta
    })
  }
  if (limitRaw) rows = rows.slice(0, Number(limitRaw))
  return { ok: true as const, rows }
}
