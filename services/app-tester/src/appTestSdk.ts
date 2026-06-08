type Row = Record<string, unknown>

export type AppTestSeed = {
  collections?: Record<string, Row[]>
  docs?: Record<string, string>
  databases?: Record<string, Record<string, Row[]>>
}

export type SdkCall = {
  op: string
  collection?: string
  database?: string
  path?: string
  id?: string
  payload?: unknown
}

function cloneRows(rows: Row[] = []): Row[] {
  return rows.map((row) => ({ ...row }))
}

export function createAppTestSdk(seed: AppTestSeed = {}) {
  const collections: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed.collections ?? {})) {
    collections[name] = cloneRows(rows)
  }
  const docs = { ...(seed.docs ?? {}) }
  const databases: Record<string, Record<string, Row[]>> = {}
  for (const [path, tables] of Object.entries(seed.databases ?? {})) {
    databases[path] = {}
    for (const [table, rows] of Object.entries(tables)) {
      databases[path]![table] = cloneRows(rows)
    }
  }
  const calls: SdkCall[] = []

  function collectionApi(name: string, database?: string) {
    const rows = () =>
      database === undefined
        ? (collections[name] ??= [])
        : ((databases[database] ??= {})[name] ??= [])
    const pushCall = (call: SdkCall) => calls.push({ collection: name, database, ...call })
    return {
      async list() {
        pushCall({ op: 'collection.list' })
        return cloneRows(rows())
      },
      async get(id: string) {
        pushCall({ op: 'collection.get', id })
        return rows().find((row) => String(row.id ?? row.ID) === id) ?? null
      },
      async insert(record: Row) {
        pushCall({ op: 'collection.insert', payload: record })
        rows().push({ ...record })
        return { ok: true }
      },
      async update(id: string, patch: Row) {
        pushCall({ op: 'collection.update', id, payload: patch })
        const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
        if (index >= 0) rows()[index] = { ...rows()[index], ...patch }
        return { ok: true }
      },
      async upsert(id: string, record: Row) {
        pushCall({ op: 'collection.upsert', id, payload: record })
        const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
        if (index >= 0) rows()[index] = { ...rows()[index], ...record }
        else rows().push({ ...record, id })
        return { ok: true }
      },
      async delete(id: string) {
        pushCall({ op: 'collection.delete', id })
        const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
        if (index >= 0) rows().splice(index, 1)
        return { ok: true }
      },
    }
  }

  function docApi(path: string) {
    return {
      async get() {
        calls.push({ op: 'doc.get', path })
        return docs[path] ?? ''
      },
      async set(key: string, value: unknown) {
        calls.push({ op: 'doc.set', path, payload: { key, value } })
        docs[path] = `${docs[path] ?? ''}\n${key}: ${String(value)}`
        return { ok: true }
      },
      async append(markdown: string) {
        calls.push({ op: 'doc.append', path, payload: markdown })
        docs[path] = `${docs[path] ?? ''}\n${markdown}`
        return { ok: true }
      },
      async replaceText(args: { find?: string; with?: string; expectedText?: string; proposedText?: string }) {
        calls.push({ op: 'doc.replaceText', path, payload: args })
        const find = typeof args.find === 'string'
          ? args.find
          : typeof args.expectedText === 'string'
            ? args.expectedText
            : ''
        const withText = typeof args.with === 'string'
          ? args.with
          : typeof args.proposedText === 'string'
            ? args.proposedText
            : ''
        if (find && docs[path]?.includes(find)) {
          docs[path] = docs[path]!.replace(find, withText)
        }
        return { ok: true }
      },
      section(heading: string) {
        return {
          async append(markdown: string) {
            calls.push({ op: 'doc.section.append', path, payload: { heading, markdown } })
            docs[path] = `${docs[path] ?? ''}\n${markdown}`
            return { ok: true }
          },
          async replace(markdown: string) {
            calls.push({ op: 'doc.section.replace', path, payload: { heading, markdown } })
            docs[path] = `${docs[path] ?? ''}\n${markdown}`
            return { ok: true }
          },
        }
      },
    }
  }

  const dohc = {
    collection: (name: string) => collectionApi(name),
    database: (path: string) => ({
      table: (name: string) => collectionApi(name, path),
      query: async () => [],
      tables: async () => Object.keys(databases[path] ?? {}),
    }),
    doc: (path: string) => docApi(path),
  }

  return {
    dohc,
    calls,
    snapshot() {
      return {
        collections: Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, cloneRows(rows)])),
        docs: { ...docs },
        databases: Object.fromEntries(
          Object.entries(databases).map(([path, tables]) => [
            path,
            Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, cloneRows(rows)])),
          ]),
        ),
      }
    },
  }
}
