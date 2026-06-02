type Bridge = (op: string, args: Record<string, unknown>) => Promise<unknown>

export function createDohcClient(bridge: Bridge) {
  return {
    sources: {
      list: (args: { source?: string } = {}) =>
        bridge('dohc.sources.list', args),
    },
    atom: {
      get: (args: { path: string }) => bridge('dohc.atom.get', args),
    },
    fields: {
      query: (args: { source?: string; keys?: string[] } = {}) =>
        bridge('dohc.fields.query', args),
    },
    imports: {
      list: () => bridge('dohc.imports.list', {}),
    },
    exports: {
      list: () => bridge('dohc.exports.list', {}),
    },
    source: {
      open: (args: { path: string }) => bridge('dohc.source.open', args),
    },
    agent: {
      run: (args: { prompt: string; sources?: string[] }) =>
        bridge('dohc.agent.run', args),
    },
    patch: {
      propose: (args: {
        path: string
        summary: string
        patch: Record<string, unknown>
      }) => bridge('dohc.patch.propose', args),
    },
  }
}

export const VIRTUAL_DOHC_SDK = `
import { useEffect, useState } from 'react'

export const dohc = window.dohc

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
          setError(err?.message || 'View query failed.')
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
            error: error?.message || 'View query failed.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, loader])

  return state
}
`
