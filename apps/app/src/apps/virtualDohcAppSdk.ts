type Bridge = (op: string, args: Record<string, unknown>) => Promise<unknown>
type AppActionInput = Record<string, unknown>
type CollectionMutationOptions = { expectedVersion?: number }

function actionArgs(
  nameOrArgs: string | { name: string; input?: AppActionInput },
  input?: AppActionInput,
): { name: string; input?: AppActionInput } {
  if (typeof nameOrArgs === 'string') {
    return input === undefined ? { name: nameOrArgs } : { name: nameOrArgs, input }
  }
  return nameOrArgs
}

function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function failureMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const row = result as { ok?: unknown; message?: unknown; error?: { message?: unknown } }
  if (row.ok !== false) return null
  return String(row.message ?? row.error?.message ?? 'Request failed.')
}

function rowsResult(result: unknown): unknown {
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: unknown[] }).rows
  }
  return result
}

function rowResult(result: unknown): unknown {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'row')) {
    return (result as { row: unknown }).row
  }
  return result
}

async function call(
  bridge: Bridge,
  label: string,
  op: string,
  args: Record<string, unknown>,
) {
  const result = await bridge(op, args)
  const message = failureMessage(result)
  if (message) throw new Error(`${label} failed: ${message}`)
  return result
}

function collectionApi(bridge: Bridge, name: string, database?: string) {
  const base = database === undefined ? { name } : { name, database }
  const label = database === undefined
    ? `dohc.collection(${quote(name)})`
    : `dohc.database(${quote(database)}).table(${quote(name)})`
  return {
    list: (query?: Record<string, unknown>) =>
      call(bridge, `${label}.list`, 'dohc.collection.list', compact({ ...base, query }))
        .then(rowsResult),
    get: (id: string) =>
      call(bridge, `${label}.get`, 'dohc.collection.get', { ...base, id })
        .then(rowResult),
    insert: (record: Record<string, unknown>, options: CollectionMutationOptions = {}) =>
      call(bridge, `${label}.insert`, 'dohc.collection.insert', compact({ ...base, record, ...options })),
    update: (id: string, patch: Record<string, unknown>, options: CollectionMutationOptions = {}) =>
      call(bridge, `${label}.update`, 'dohc.collection.update', compact({ ...base, id, patch, ...options })),
    upsert: (id: string, record: Record<string, unknown>, options: CollectionMutationOptions = {}) =>
      call(bridge, `${label}.upsert`, 'dohc.collection.upsert', compact({ ...base, id, record, ...options })),
    delete: (id: string, options: CollectionMutationOptions = {}) =>
      call(bridge, `${label}.delete`, 'dohc.collection.delete', compact({ ...base, id, ...options })),
  }
}

function docApi(bridge: Bridge, path: string) {
  const label = `dohc.doc(${quote(path)})`
  return {
    get: () => call(bridge, `${label}.get`, 'dohc.doc.get', { path }),
    set: (key: string, value: string | number | boolean | null) =>
      call(bridge, `${label}.set`, 'dohc.doc.set', { path, key, value }),
    append: (markdown: string) =>
      call(bridge, `${label}.append`, 'dohc.doc.append', { path, markdown }),
    replaceText: (args: { find: string; with: string; occurrence?: number }) =>
      call(bridge, `${label}.replaceText`, 'dohc.doc.replaceText', compact({ path, ...args })),
    section: (heading: string) => ({
      append: (markdown: string) =>
        call(bridge, `${label}.section(${quote(heading)}).append`, 'dohc.doc.section.append', {
          path,
          heading,
          markdown,
        }),
      replace: (markdown: string) =>
        call(bridge, `${label}.section(${quote(heading)}).replace`, 'dohc.doc.section.replace', {
          path,
          heading,
          markdown,
        }),
    }),
  }
}

function databaseApi(bridge: Bridge, path: string) {
  const label = `dohc.database(${quote(path)})`
  return {
    tables: () => call(bridge, `${label}.tables`, 'dohc.database.tables', { path }),
    query: (sql: string, params?: unknown[]) =>
      call(bridge, `${label}.query`, 'dohc.database.query', compact({ path, sql, params })),
    table: (name: string) => collectionApi(bridge, name, path),
  }
}

export function createDohcClient(bridge: Bridge) {
  return {
    collection: (name: string) => collectionApi(bridge, name),
    doc: (path: string) => docApi(bridge, path),
    database: (path: string) => databaseApi(bridge, path),
    asset: (assetId: string) => ({
      resolve: () => call(bridge, `dohc.asset(${quote(assetId)}).resolve`, 'dohc.asset.resolve', { assetId }),
    }),
    presence: {
      list: () => call(bridge, 'dohc.presence.list', 'dohc.presence.list', {}),
    },
    sources: {
      list: (args: { source?: string } = {}) =>
        call(bridge, 'dohc.sources.list', 'dohc.sources.list', args),
    },
    atom: {
      get: (args: { path: string }) => call(bridge, 'dohc.atom.get', 'dohc.atom.get', args),
    },
    fields: {
      query: (args: { source?: string; keys?: string[] } = {}) =>
        call(bridge, 'dohc.fields.query', 'dohc.fields.query', args),
    },
    imports: {
      list: () => call(bridge, 'dohc.imports.list', 'dohc.imports.list', {}),
    },
    exports: {
      list: () => call(bridge, 'dohc.exports.list', 'dohc.exports.list', {}),
    },
    source: {
      open: (args: { path: string }) => call(bridge, 'dohc.source.open', 'dohc.source.open', args),
    },
    agent: {
      run: (args: { prompt: string; sources?: string[] }) =>
        call(bridge, 'dohc.agent.run', 'dohc.agent.run', args),
    },
    actions: {
      run: (
        nameOrArgs: string | { name: string; input?: AppActionInput },
        input?: AppActionInput,
      ) => call(bridge, 'dohc.actions.run', 'dohc.actions.run', actionArgs(nameOrArgs, input)),
    },
    patch: {
      propose: (args: {
        path: string
        summary: string
        patch: Record<string, unknown>
      }) => call(bridge, 'dohc.patch.propose', 'dohc.patch.propose', args),
    },
  }
}

export const VIRTUAL_DOHC_SDK = `
import { useEffect, useState } from 'react'

export const dohc = window.dohc

function stableKey(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function escapeRegExpChar(char) {
  return '\\\\^$.*+?()[]{}|'.includes(char) ? '\\\\' + char : char
}

function patternToRegExp(pattern) {
  const input = String(pattern || '**/*').trim() || '**/*'
  let output = '^'
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char === '*') {
      if (input[i + 1] === '*') {
        if (input[i + 2] === '/') {
          output += '(?:.*/)?'
          i += 2
        } else {
          output += '.*'
          i += 1
        }
      } else {
        output += '[^/]*'
      }
    } else {
      output += escapeRegExpChar(char)
    }
  }
  return new RegExp(output + '$')
}

function sourceFromPattern(pattern) {
  const input = String(pattern || '.').trim() || '.'
  if (input === '*' || input.startsWith('**')) return '.'
  const globIndex = input.search(/[?*\\[]/)
  const prefix = globIndex >= 0 ? input.slice(0, globIndex) : input
  const clean = prefix.replace(/^\\/+|\\/+$/g, '').replace(/\\/+/g, '/')
  const parts = clean.split('/').filter(Boolean)
  if (globIndex >= 0) {
    if (prefix.endsWith('/')) return clean || '.'
    return parts.slice(0, -1).join('/') || '.'
  }
  const last = parts[parts.length - 1] || ''
  if (/\\.[a-z0-9]+$/i.test(last)) return parts.slice(0, -1).join('/') || '.'
  return clean || '.'
}

function parseFrontmatter(body) {
  if (typeof body !== 'string' || !body.startsWith('---\\n')) return {}
  const end = body.indexOf('\\n---', 4)
  if (end < 0) return {}
  const out = {}
  const lines = body.slice(4, end).split('\\n')
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function normalizeAtom(atom, row) {
  const body = atom && typeof atom.body === 'string' ? atom.body : ''
  return {
    ...(row || {}),
    ...(atom || {}),
    body,
    content: body,
    markdown: body,
    frontmatter: parseFrontmatter(body),
  }
}

async function loadDocs(pattern) {
  const matcher = patternToRegExp(pattern || '**/*')
  const listed = await dohc.sources.list({ source: sourceFromPattern(pattern) })
  if (!listed || listed.ok !== true || !Array.isArray(listed.rows)) return []
  const rows = listed.rows.filter((row) => {
    const path = typeof row?.path === 'string' ? row.path : ''
    return path && matcher.test(path)
  })
  const docs = await Promise.all(rows.map(async (row) => {
    try {
      const result = await dohc.atom.get({ path: row.path })
      if (result && result.ok === true) return normalizeAtom(result.atom, row)
    } catch {
      // Keep the source row visible even if the body read is not available.
    }
    return normalizeAtom(null, row)
  }))
  return docs
}

export function useDocs(pattern = '**/*') {
  const [docs, setDocs] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadDocs(pattern)
      .then((rows) => {
        if (!cancelled) setDocs(rows)
      })
      .catch((err) => {
        if (!cancelled) {
          setDocs([])
          setError(err?.message || 'App query failed.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [pattern])

  docs.error = error
  return docs
}

export const useDocsGlob = useDocs

export function useLiveQuery(query) {
  const match = String(query || '').match(/^docs\\.glob\\(["'](.+)["']\\)$/)
  return useDocs(match ? match[1] : '**/*')
}

export const useQuery = useLiveQuery

export function useDohcQuery(key, loader) {
  const [state, setState] = useState({
    data: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: null }))
    Promise.resolve()
      .then(loader)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: error?.message || 'App query failed.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, loader])

  return state
}

export function useCollection(name, query) {
  const state = useDohcQuery('collection:' + name + ':' + stableKey(query || {}), () =>
    dohc.collection(name).list(query),
  )
  const rows = Array.isArray(state.data) ? state.data : []
  rows.loading = state.loading
  rows.error = state.error
  rows.reload = () => dohc.collection(name).list(query)
  return rows
}

export function useDoc(path) {
  return useDohcQuery('doc:' + path, () => dohc.doc(path).get())
}

export function useDatabase(path) {
  return dohc.database(path)
}

export function usePresence() {
  const state = useDohcQuery('presence', () => dohc.presence.list())
  return {
    users: Array.isArray(state.data?.users) ? state.data.users : [],
    loading: state.loading,
    error: state.error,
  }
}

export function useAgentRun() {
  return dohc.agent.run
}
`
