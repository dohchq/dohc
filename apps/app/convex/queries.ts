import { v } from 'convex/values'
import { action, internalQuery, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import { MAP_PATH } from './inlineAtom'
import { splitFrontmatter } from './atomId'

// docs.find dumping a whole note's RAW markdown body (frontmatter +
// all) as a grey blob is "slop wearing a card" — the user's exact
// screenshotted case (independent P4-review SHOULD-FIX). Digest it:
// drop the leading frontmatter, cap the length, mark truncation.
//
// Frontmatter strip REUSES the Phase-1 audited `splitFrontmatter`
// (single source of truth; its `[ \t]*\r?\n` form is linear) — NOT a
// hand-rolled `^---\s*\n[\s\S]*?\n---\s*\n?` regex, whose `\s*\n`
// (\s overlaps \n) backtracks quadratically on a leading `---` +
// whitespace run with no closing fence (the project's documented
// ReDoS class — Codex P4-fold). This runs reactively per-keystroke
// over a user-controlled body, so ReDoS-safety is mandatory.
const FIND_MAX_LINES = 40
function digestBody(path: string, body: string): string {
  const noFm = splitFrontmatter(body ?? '').rest
  // CAP FIRST, then trim — NEVER run a regex over the whole body.
  // `String.split('\n')` is linear (one pass); `.trimEnd()` is a
  // linear builtin operating only on the ≤40-line head. The prior
  // `noFm.replace(/\s+$/, '')` over the whole body was O(n²) on a
  // long INTERNAL whitespace run not ending in ws (Codex P4-fold —
  // a distinct ReDoS from splitFrontmatter's).
  const lines = noFm.split('\n')
  const text = lines.slice(0, FIND_MAX_LINES).join('\n').trimEnd()
  // truncated IFF there is a NON-EMPTY line past the cap — a bare
  // trailing newline (split's empty last element) is NOT truncation
  // (Codex P4-fold-2: `lines.length > N` falsely flagged a 40-line
  // note + trailing `\n`). `.some` is linear; no regex.
  const more = lines.slice(FIND_MAX_LINES).some((l) => l.trim() !== '')
  if (!more) return text || `_(empty note)_`
  return text + `\n\n_(… truncated — open [[${path}]] for the rest)_`
}

// DSL parser + executor.
//
// Grammar: namespace.verb("resource", { filters })
//
// Namespaces (v0): entities | docs | capacity
//   (`vault` is still accepted as a legacy alias for `docs`.)
// Verbs: list | count | recent | glob | find | heatmap

// atom-address-v1 §5.2 Phase-4 precondition 1 — every internal list
// read on this eval path is bounded by this NOTE_SCAN_CAP-class cap
// (the eval runs reactively per-keystroke once Phase-4 renders it; an
// unbounded scan is the live-crash class the project already hit).
// Over the cap we DISCLOSE truncation honestly (a partial list with a
// marker / a `+` count / a fail-soft notice for aggregates) — never a
// silently-wrong authoritative number.
const QUERY_SCAN_CAP = 5000
// Per-doc cap on distinct query blocks evaluated reactively (mirrors
// the ≤64 formula cap — a doc can't fan out unbounded work).
const MAX_QUERY_BLOCKS = 64

// §5.2 precondition 1 — the SINGLE place the eval-path cap lives now
// (4B moves it from the internal-query `limit` indirection into these
// direct ctx.db reads so the evaluator is query-callable/reactive;
// 4A's `limit` arg on _listByType/_listInternal stays a tested,
// non-breaking capability for the agent callers). `take(CAP+1)` so a
// caller detects + honestly discloses truncation.
async function listEntitiesCapped(
  ctx: QueryCtx,
  workspaceId: string,
  type: string,
): Promise<Array<{ slug: string; data: any }>> {
  const rows = await ctx.db
    .query('entities')
    .withIndex('by_workspace_type', (q) =>
      q.eq('workspaceId', workspaceId).eq('type', type),
    )
    .take(QUERY_SCAN_CAP + 1)
  return rows.map((r) => ({ slug: r.slug, data: r.data }))
}
async function listAtomPathsCapped(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(QUERY_SCAN_CAP + 1)
  // `_map.md` is a dohc-GENERATED derived index, never a queryable
  // source (design §4 double-count guard; Phase-4 made this
  // pre-existing wart visible — independent P4-review NIT).
  return rows
    .map((r) => r.path)
    .filter((p) => p !== MAP_PATH)
    .sort()
}
async function getAtomBody(
  ctx: QueryCtx,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  if (path === MAP_PATH) return null // derived index — not findable
  const row = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', path),
    )
    .unique()
  return row?.body ?? null
}

export type ParsedQuery = {
  namespace: string
  verb: string
  resource: string
  filters: Record<string, unknown>
}

const QUERY_RE =
  /^(\w+)\.(\w+)\s*\(\s*(?:"([^"]*)")?\s*(?:,\s*)?(\{[\s\S]*\})?\s*\)\s*$/

export function parseQuery(src: string): ParsedQuery {
  const s = src.trim()
  const m = QUERY_RE.exec(s)
  if (!m) throw new Error(`bad query syntax: ${s.slice(0, 80)}`)
  const [, namespace, verb, resource, filtersSrc] = m

  let filters: Record<string, unknown> = {}
  if (filtersSrc) {
    const normalised = filtersSrc
      .replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":')
      .replace(/:\s*([a-zA-Z_][\w-]*)(\s*[,}])/g, ': "$1"$2')
    try {
      filters = JSON.parse(normalised)
    } catch (e) {
      throw new Error(`bad query filters: ${filtersSrc}`)
    }
  }
  return {
    namespace: namespace!,
    verb: verb!,
    resource: resource ?? '',
    filters,
  }
}

export const _listGithub = internalQuery({
  args: { workspaceId: v.string(), kind: v.string() },
  handler: async () => {
    // Legacy stub — no GitHub integration in this v0.
    return [] as Array<unknown>
  },
})

// THE shared evaluator — PURE-of-IO except `ctx.db` reads, so it is
// QUERY-callable (Context7-confirmed: a Convex query reads ctx.db
// directly; only actions/mutations have ctx.runQuery — so a reactive
// query-block render REQUIRES this ctx.db form, mirroring Phase-3's
// formulaEval). `ok:false` flags an error WITHOUT throwing and
// WITHOUT the message ever leaving the server on the reactive path
// (§5.2 precondition 2 — strongest fail-soft boundary); `md` is the
// display string (incl. the legacy `_(error)_` text so the `run`
// action's contract is byte-preserved for non-editor callers/tests).
async function evalQuery(
  ctx: QueryCtx,
  workspaceId: string,
  src: string,
): Promise<{ ok: boolean; md: string }> {
  let parsed: ParsedQuery
  try {
    parsed = parseQuery(src)
  } catch (e) {
    return { ok: false, md: `_(query error: ${(e as Error).message})_` }
  }
  try {
    if (parsed.namespace === 'entities')
      return { ok: true, md: await runEntities(ctx, workspaceId, parsed) }
    // `docs` is the canonical document namespace; `vault` is kept as a
    // silent backward-compat alias so query blocks authored before the
    // rename keep resolving (no body migration needed).
    if (parsed.namespace === 'docs' || parsed.namespace === 'vault')
      return { ok: true, md: await runDocs(ctx, workspaceId, parsed) }
    if (parsed.namespace === 'capacity')
      return { ok: true, md: await runCapacity(ctx, workspaceId, parsed) }
    return { ok: false, md: `_(unknown namespace: ${parsed.namespace})_` }
  } catch (e) {
    return { ok: false, md: `_(runtime error: ${(e as Error).message})_` }
  }
}

export const _evalOne = internalQuery({
  args: { workspaceId: v.string(), src: v.string() },
  handler: async (ctx, { workspaceId, src }) =>
    await evalQuery(ctx, workspaceId, src),
})

// Kept for backward-compat / any non-editor caller — its STRING
// contract is byte-unchanged (delegates through the internalQuery so
// the action stays ctx.db-free per Convex; Context7 action→runQuery
// pattern). The editor does NOT use this (it uses the reactive
// `evalQueryBlocks` query below).
export const run = action({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // personal. NOTE: actions cannot validate membership (no ctx.db); the
  // default-personal path is the only safe branch when omitted. A caller
  // passing an org workspaceId here would error in requireWorkspace.
  args: { src: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { src, activeWorkspaceId }): Promise<string> => {
    // Actions can only use the default-personal `requireWorkspace(ctx)`
    // form (the active-membership lookup needs db). Org callers must
    // route via a mutation/query that forwards to the action.
    if (activeWorkspaceId !== undefined) {
      throw new Error(
        'queries.run (action) cannot validate an active workspace; route via a query/mutation that calls evalQueryBlocks instead.',
      )
    }
    const workspaceId = await requireWorkspace(ctx)
    const r: { ok: boolean; md: string } = await ctx.runQuery(
      internal.queries._evalOne,
      { workspaceId, src },
    )
    return r.md
  },
})

// atom-address-v1 §5.2 Phase-4 — the REACTIVE batched query-block
// evaluator: ONE owner-scoped query for the editor (mirrors Phase-3
// evalFormulas). Array (NOT an object keyed by author-influenceable
// src — the Phase-3-fold lesson: prototype/`_`-field poison).
// `value: null` ⇒ an error (raw message NEVER leaves the server →
// editor renders a calm `—`, source stays hand-editable); a string
// ⇒ render that result markdown (incl. honest `_(no match)_` /
// truncation markers, which are legitimate results, not errors).
// Never throws.
export const evalQueryBlocks = query({
  // Phase B.3 (org-plan §5 — NON-DEFAULTABLE surface).
  // Frontend caller (AtomEditor) MUST pass activeWorkspaceId from
  // `useActiveWorkspaceId()`. Backend keeps the arg optional only so
  // that backend tests calling this with a single-workspace user
  // (personal === subject) can still pass without per-test threading;
  // in that path `requireWorkspace(ctx, undefined)` returns the
  // caller's personal workspace, which IS the right answer for any
  // single-workspace caller. The cross-tenant safety property holds
  // either way: a non-member supplying another user's workspace id
  // here is rejected by requireWorkspace's membership lookup.
  args: {
    srcs: v.array(v.string()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { srcs, activeWorkspaceId },
  ): Promise<Array<{ src: string; value: string | null }>> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const uniq = Array.from(new Set(srcs)).slice(0, MAX_QUERY_BLOCKS)
    const out: Array<{ src: string; value: string | null }> = []
    for (const src of uniq) {
      const r = await evalQuery(ctx, workspaceId, src)
      out.push({ src, value: r.ok ? r.md : null })
    }
    return out
  },
})

async function runEntities(
  ctx: QueryCtx,
  workspaceId: string,
  q: ParsedQuery,
): Promise<string> {
  const type = q.resource
  if (!type) throw new Error('entities requires a type') // → ok:false → —
  const raw = await listEntitiesCapped(ctx, workspaceId, type)
  const truncated = raw.length > QUERY_SCAN_CAP
  const all = truncated ? raw.slice(0, QUERY_SCAN_CAP) : raw

  const filtered = all.filter((e) => matches(e.data, q.filters))
  if (q.verb === 'count') {
    // a capped count is a wrong authoritative number — disclose it as
    // a lower bound, never a confident total (project posture).
    return truncated
      ? `_(≥${filtered.length} — too many to count exactly; refine the query)_`
      : String(filtered.length)
  }
  if (q.verb === 'find') {
    if (!filtered[0]) {
      return truncated
        ? `_(no match in the first ${QUERY_SCAN_CAP} — refine the query)_`
        : `_(no match)_`
    }
    return formatEntity(filtered[0])
  }
  if (q.verb === 'list' || q.verb === 'recent') {
    if (filtered.length === 0) {
      return truncated
        ? `_(no match in the first ${QUERY_SCAN_CAP} — refine the query)_`
        : `_(nothing)_`
    }
    const body = filtered
      .sort((a, b) =>
        String(a.data?.name ?? a.slug).localeCompare(
          String(b.data?.name ?? b.slug),
        ),
      )
      .map((e) => `- **${e.data?.name ?? e.slug}**${formatInline(type, e)}`)
      .join('\n')
    return truncated
      ? `${body}\n\n_(… and more — refine the query)_`
      : body
  }
  throw new Error(`verb ${q.verb} not implemented for entities`)
}

function matches(data: any, filters: Record<string, unknown>): boolean {
  if (!data) return Object.keys(filters).length === 0
  for (const [k, v] of Object.entries(filters)) {
    if (String(data[k]) !== String(v)) return false
  }
  return true
}

function formatEntity(e: { slug: string; data: any }): string {
  const lines: string[] = [`**${e.data?.name ?? e.slug}** (${e.slug})`]
  for (const [k, v] of Object.entries(e.data ?? {})) {
    if (k === 'name') continue
    lines.push(`- ${k}: ${formatValue(v)}`)
  }
  return lines.join('\n')
}

function formatInline(type: string, e: { slug: string; data: any }): string {
  if (type === 'person') {
    const role = e.data?.role
    const fte = e.data?.fte
    const kind = e.data?.kind ?? e.data?.type
    return ` — ${[role, fte && `${fte}%`, kind].filter(Boolean).join(' · ')}`
  }
  if (type === 'project') {
    const client = e.data?.client
    const status = e.data?.status
    const end = e.data?.end
    return ` — ${[client, status, end && `→ ${end}`].filter(Boolean).join(' · ')}`
  }
  if (type === 'booking') {
    return ` — ${e.data?.person ?? '?'} on ${e.data?.project ?? '?'} · ${e.data?.percent ?? '?'}% · ${e.data?.weekStart ?? '?'} · ${e.data?.status ?? '?'}`
  }
  if (type === 'client') {
    return ` — ${e.data?.status ?? ''}`
  }
  return ''
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object') return '`' + JSON.stringify(v) + '`'
  return String(v)
}

async function runDocs(
  ctx: QueryCtx,
  workspaceId: string,
  q: ParsedQuery,
): Promise<string> {
  if (q.verb === 'glob') {
    const pattern = q.resource
    const raw = await listAtomPathsCapped(ctx, workspaceId)
    const truncated = raw.length > QUERY_SCAN_CAP
    const paths = truncated ? raw.slice(0, QUERY_SCAN_CAP) : raw
    const matches = paths.filter((p) => globMatch(p, pattern))
    if (matches.length === 0) {
      return truncated
        ? `_(no matches in the first ${QUERY_SCAN_CAP} — refine the pattern)_`
        : `_(no matches)_`
    }
    const body = matches.map((p) => `- [[${p}]]`).join('\n')
    return truncated ? `${body}\n\n_(… and more — refine the pattern)_` : body
  }
  if (q.verb === 'find') {
    const body = await getAtomBody(ctx, workspaceId, q.resource)
    return body === null
      ? `_(missing: ${q.resource})_`
      : digestBody(q.resource, body)
  }
  throw new Error(`verb ${q.verb} not implemented for docs`)
}

function globMatch(path: string, pattern: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '___DOUBLESTAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/___DOUBLESTAR___/g, '.*') +
      '$',
  )
  return re.test(path)
}

async function runCapacity(
  ctx: QueryCtx,
  workspaceId: string,
  q: ParsedQuery,
): Promise<string> {
  if (q.verb === 'heatmap') {
    return await renderHeatmap(ctx, workspaceId, q.filters)
  }
  if (q.verb === 'risks') {
    return await renderOverbookRisks(ctx, workspaceId)
  }
  throw new Error(`verb ${q.verb} not implemented for capacity`)
}

async function renderHeatmap(
  ctx: QueryCtx,
  workspaceId: string,
  filters: Record<string, unknown>,
): Promise<string> {
  const windowSpec = (filters.window as string | undefined) ?? 'next-8w'
  const weeks = computeWeeks(windowSpec)
  if (weeks.length === 0) throw new Error(`empty window: ${windowSpec}`)

  const people = await listEntitiesCapped(ctx, workspaceId, 'person')
  const bookings = await listEntitiesCapped(ctx, workspaceId, 'booking')

  // An aggregate over a TRUNCATED set is a wrong authoritative
  // picture — fail soft (the project's "wrong number is worse than
  // —" posture) rather than render a misleading heatmap.
  if (people.length > QUERY_SCAN_CAP || bookings.length > QUERY_SCAN_CAP) {
    return `_(too much data to compute a heatmap — narrow the window or filters)_`
  }
  if (people.length === 0) {
    return `_(no people yet — ask the agent to add some)_`
  }

  const grid = new Map<string, Map<string, { status: string; percent: number }>>()
  for (const p of people) grid.set(p.slug, new Map())
  for (const b of bookings) {
    const personSlug = b.data?.person
    const weekStart = b.data?.weekStart
    if (typeof personSlug !== 'string' || typeof weekStart !== 'string') continue
    if (!weeks.includes(weekStart)) continue
    const cell = grid.get(personSlug)
    if (!cell) continue
    const existing = cell.get(weekStart)
    const status = String(b.data.status ?? 'potential')
    const percent = Number(b.data.percent ?? 0)
    if (
      !existing ||
      statusPriority(status) > statusPriority(existing.status)
    ) {
      cell.set(weekStart, { status, percent })
    }
  }

  const nameWidth = Math.max(
    8,
    ...people.map((p) => String(p.data?.name ?? p.slug).length),
  )
  const cellW = 4
  const header =
    ' '.repeat(nameWidth + 2) +
    weeks.map((w) => weekLabel(w).padEnd(cellW)).join('')
  const rows = people
    .sort((a, b) =>
      String(a.data?.name ?? a.slug).localeCompare(
        String(b.data?.name ?? b.slug),
      ),
    )
    .map((p) => {
      const name = String(p.data?.name ?? p.slug).padEnd(nameWidth)
      const cells = weeks
        .map((w) => glyph(grid.get(p.slug)?.get(w)?.status).padEnd(cellW))
        .join('')
      return `${name}  ${cells}`
    })

  const legend =
    '\n\nlegend:  ██ hard-booked   ▓▓ pre-booked   ░░ potential   ·· open'
  return '```\n' + [header, ...rows].join('\n') + legend + '\n```'
}

async function renderOverbookRisks(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<string> {
  const people = await listEntitiesCapped(ctx, workspaceId, 'person')
  const bookings = await listEntitiesCapped(ctx, workspaceId, 'booking')

  if (people.length > QUERY_SCAN_CAP || bookings.length > QUERY_SCAN_CAP) {
    return `_(too much data to compute risks — narrow the filters)_`
  }

  const cap = new Map<string, Map<string, number>>()
  for (const p of people) cap.set(p.slug, new Map())
  for (const b of bookings) {
    const personSlug = b.data?.person
    const weekStart = b.data?.weekStart
    if (typeof personSlug !== 'string' || typeof weekStart !== 'string') continue
    const cell = cap.get(personSlug)
    if (!cell) continue
    cell.set(weekStart, (cell.get(weekStart) ?? 0) + Number(b.data.percent ?? 0))
  }

  const risks: string[] = []
  for (const p of people) {
    const cell = cap.get(p.slug)
    if (!cell) continue
    for (const [week, total] of cell.entries()) {
      if (total > 100) {
        risks.push(
          `- **${p.data?.name ?? p.slug}** is at ${total}% on ${week} (over by ${total - 100}%)`,
        )
      }
    }
  }
  if (risks.length === 0) return `_(no risks — looks healthy)_`
  return risks.join('\n')
}

function statusPriority(status: string): number {
  switch (status) {
    case 'hard-booked':
      return 3
    case 'pre-booked':
      return 2
    case 'potential':
      return 1
    default:
      return 0
  }
}

function glyph(status?: string): string {
  switch (status) {
    case 'hard-booked':
      return '██'
    case 'pre-booked':
      return '▓▓'
    case 'potential':
      return '░░'
    default:
      return '··'
  }
}

function weekLabel(isoMonday: string): string {
  const d = new Date(isoMonday + 'T00:00:00Z')
  return `w${getISOWeek(d).toString().padStart(2, '0')}`
}

function getISOWeek(d: Date): number {
  const target = new Date(d.valueOf())
  const dayNr = (d.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = target.valueOf()
  target.setUTCMonth(0, 1)
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000)
}

function computeWeeks(spec: string): string[] {
  const m = /^next-(\d+)w$/.exec(spec)
  if (!m) return []
  const count = parseInt(m[1]!, 10)
  const out: string[] = []
  const now = new Date()
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const day = (monday.getUTCDay() + 6) % 7
  monday.setUTCDate(monday.getUTCDate() - day)
  for (let i = 0; i < count; i++) {
    const d = new Date(monday.valueOf())
    d.setUTCDate(d.getUTCDate() + i * 7)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
