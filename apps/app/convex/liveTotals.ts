import { query, internalMutation } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import { resolveWindowForViewer } from './windows'
import { resolveLiveTotal, type ValueAtom } from './liveTotal'
import { parseInlineAtomsFromMarkdown } from './inlineAtom'
import { isNonDataAtom } from './atomId'

// Convex adapter that RENDERS a `{identifier}` live-total. A live total
// is a rendered
// PROJECTION — `resolve` is a QUERY (read-only, one snapshot). It
// NEVER writes a note body / never persists the computed value. The
// markdown keeps the literal `{identifier}` token forever; the UI
// decorates it. Fail-soft by the FROZEN format contract: anything
// that does not resolve returns `{ value: null }` → the editor
// renders `___`, never an error string, never a throw.
//
// Binding = the explicit `rollups` registry: predictable and
// auditable. Cross-workspace values go through the same resolveWindow
// core with export grants enforced there.

// FROZEN inline-atom identifier/key grammar (inline-atom-format-v0.md).
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Bounded; fail-soft on overflow (a wrong authoritative-looking number
// is worse than `___` — never silently under-count).
const NOTE_SCAN_CAP = 5000

const specValidator = v.union(
  v.object({
    kind: v.literal('ownDesk'),
    op: v.union(v.literal('sum'), v.literal('count')),
    key: v.string(),
  }),
  v.object({ kind: v.literal('window'), windowId: v.id('windows') }),
)

/**
 * Resolve a `{identifier}` live-total FOR a given workspace. Pure
 * read; never writes. Viewer is passed in from requireWorkspace in
 * the query or trusted server code, never re-derived. Returns the
 * number or null (render `___`).
 */
export async function resolveLiveTotalValue(
  ctx: QueryCtx,
  workspace: string,
  identifier: string,
): Promise<number | null> {
  if (!IDENT_RE.test(identifier)) return null

  // .take(2): _define is the sole writer + Convex OCC makes a
  // duplicate (workspace,identifier) unreachable, but a READ path
  // MUST honor the fail-soft contract — require EXACTLY one binding
  // (none OR a pathological dup → `___`, never an arbitrary pick,
  // never a throw).
  const bindings = await ctx.db
    .query('rollups')
    .withIndex('by_workspace_identifier', (q) =>
      q.eq('workspaceId', workspace).eq('identifier', identifier),
    )
    .take(2)
  if (bindings.length !== 1) return null
  const binding = bindings[0]

  if (binding.spec.kind === 'window') {
    // Cross-desk: the SAME gather + pure resolveWindow core. Gate on
    // aggregateOperandCount (atoms that ACTUALLY fed the aggregate;
    // finite numbers only for sum) — NEVER selected.length or view
    // keys (rename/as collisions, selector!=aggregate key). 0
    // operands ⇒ withheld/empty ⇒ `___`, never a misleading
    // authoritative 0.
    const win = await ctx.db.get(binding.spec.windowId)
    const as = win?.shape?.aggregate?.as
    if (!win || typeof as !== 'string') return null
    const { result, aggregateOperandCount } = await resolveWindowForViewer(
      ctx,
      binding.spec.windowId,
      workspace,
    )
    if (!result.ok || aggregateOperandCount < 1) return null
    const val = result.view[as]
    return typeof val === 'number' && Number.isFinite(val) ? val : null
  }

  // ownDesk: markdown is the truth — parse the workspace's OWN notes
  // with the single FROZEN parser; never the entities store, never a
  // write.
  const notes = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspace))
    .take(NOTE_SCAN_CAP + 1)
  if (notes.length > NOTE_SCAN_CAP) return null // fail-soft
  const atoms: ValueAtom[] = []
  for (const n of notes) {
    // `.context/_map.md` is a dohc-GENERATED index that echoes note
    // text; it is a derived artifact, NEVER a source of truth for value atoms.
    // Counting it would double-count atoms it copied into summaries.
    if (isNonDataAtom(n.path, n.body ?? '')) continue // §6 unified (Track-3 P1)
    // PROSE ONLY — `{billable: 999}` inside a code block is not data
    // (FROZEN contract).
    for (const a of parseInlineAtomsFromMarkdown(n.body ?? '')) {
      if (a.kind === 'value') atoms.push({ key: a.key, value: a.value })
    }
  }
  return resolveLiveTotal(
    { op: binding.spec.op, key: binding.spec.key },
    atoms,
  )
}

/**
 * Resolve a `{identifier}` live-total for the AUTHENTICATED caller.
 * Read-only. Returns `{ value: number | null }`; null ⇒ render `___`.
 */
export const resolve = query({
  args: { identifier: v.string() },
  handler: async (
    ctx,
    { identifier },
  ): Promise<{ value: number | null }> => {
    const viewer = await requireWorkspace(ctx)
    return { value: await resolveLiveTotalValue(ctx, viewer, identifier) }
  },
})

/**
 * Batched resolve — ONE reactive query for every `{identifier}` in a
 * document, so the editor can render live values inline (the doc is
 * genuinely connected to the user's other files; it updates as the
 * underlying value-atoms change — that is the whole "live total"
 * point). Same auth + same per-identifier path as `resolve`; deduped
 * and length-capped so a pathological doc can't fan out unbounded.
 * Unknown/undefinable identifiers map to null (render literal).
 */
export const resolveMany = query({
  args: { identifiers: v.array(v.string()) },
  handler: async (
    ctx,
    { identifiers },
  ): Promise<Record<string, number | null>> => {
    const viewer = await requireWorkspace(ctx)
    const uniq = Array.from(new Set(identifiers)).slice(0, 64)
    const out: Record<string, number | null> = {}
    for (const id of uniq) {
      out[id] = await resolveLiveTotalValue(ctx, viewer, id)
    }
    return out
  },
})

/**
 * Define / update a `{identifier}` binding (dohc authors this when it
 * builds a workflow/dashboard). Internal — the agent tool derives the
 * workspace from requireWorkspace and calls this. Idempotent: one
 * binding per (workspace, identifier); redefining updates it. Fails
 * LOUD on a non-canonical identifier/key (so a bad binding can't
 * silently render `___` forever).
 */
export const _define = internalMutation({
  args: {
    workspaceId: v.string(),
    identifier: v.string(),
    spec: specValidator,
  },
  handler: async (ctx, { workspaceId, identifier, spec }) => {
    if (!IDENT_RE.test(identifier)) {
      throw new Error(
        `invalid rollup identifier ${JSON.stringify(identifier)} — must match the frozen atom grammar [A-Za-z_][A-Za-z0-9_]*`,
      )
    }
    if (spec.kind === 'ownDesk' && !IDENT_RE.test(spec.key)) {
      throw new Error(
        `invalid rollup key ${JSON.stringify(spec.key)} — must match the frozen atom grammar`,
      )
    }
    const existing = await ctx.db
      .query('rollups')
      .withIndex('by_workspace_identifier', (q) =>
        q.eq('workspaceId', workspaceId).eq('identifier', identifier),
      )
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { spec })
      return { ok: true as const, updated: true }
    }
    await ctx.db.insert('rollups', { workspaceId, identifier, spec })
    return { ok: true as const, updated: false }
  },
})
