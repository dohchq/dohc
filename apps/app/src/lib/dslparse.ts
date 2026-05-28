// Client-side DSL parser. Mirrors convex/queries.ts:parseQuery so the
// renderer can understand query blocks before it runs them.

export type ParsedQueryLite = {
  namespace: string
  verb: string
  resource: string
  filters: Record<string, unknown>
}

const QUERY_RE =
  /^(\w+)\.(\w+)\s*\(\s*(?:"([^"]*)")?\s*(?:,\s*)?(\{[\s\S]*\})?\s*\)\s*$/

export function parseQuerySrc(src: string): ParsedQueryLite | null {
  const s = src.trim()
  const m = QUERY_RE.exec(s)
  if (!m) return null
  const [, namespace, verb, resource, filtersSrc] = m
  let filters: Record<string, unknown> = {}
  if (filtersSrc) {
    const normalised = filtersSrc
      .replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":')
      .replace(/:\s*([a-zA-Z_][\w-]*)(\s*[,}])/g, ': "$1"$2')
    try {
      filters = JSON.parse(normalised)
    } catch {
      filters = {}
    }
  }
  return {
    namespace: namespace!,
    verb: verb!,
    resource: resource ?? '',
    filters,
  }
}

// Parse ```query render="text" theme="dark"\n...\n``` hints from the
// fence's info line. Returns the hint map + the inner source.
export type QueryFence = {
  hints: Record<string, string>
  src: string
}

export function isQueryFenceLanguage(language: unknown): boolean {
  const normalized = String(language ?? '').trim().toLowerCase()
  return normalized === 'query' || normalized === 'dohc-query'
}

// Same RE used in AtomView splitQueries but with the info-string captured.
export const QUERY_FENCE_RE =
  /```(?:query|dohc-query)(?:[ \t]+([^\n]*))?\n([\s\S]*?)```/g

export function parseFenceInfo(info: string | undefined): Record<string, string> {
  if (!info) return {}
  const out: Record<string, string> = {}
  const re = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(info))) {
    const key = m[1]!
    const val = m[3] ?? m[4] ?? m[5] ?? ''
    out[key] = val
  }
  return out
}
