import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import {
  atomPlaintext,
  basename,
  isAtomSearchable,
  normalizeQuery,
  queryTerms,
  snippetParts,
  type SnippetPart,
} from './searchText'
import {
  deriveTitle,
  extractFrontmatterId,
  isHtmlAtomBody,
  isHtmlPath,
  isLegacySkillPath,
  isSkillAtomBody,
} from './atomId'

// Top-N relevance results scanned from the index, and how many we return.
const SCAN = 40
const LIMIT = 30
// Recent-docs shown for an empty/too-short query.
const RECENT = 8

export type SearchResult = {
  path: string
  fileId: string | null
  title: string
  type: 'html' | 'skill' | null
  updatedAt: number
  starred: boolean
  snippet: SnippetPart[]
}

function atomType(a: Doc<'atoms'>): 'html' | 'skill' | null {
  if (isHtmlPath(a.path) || isHtmlAtomBody(a.body)) return 'html'
  if (isSkillAtomBody(a.body) || isLegacySkillPath(a.path)) return 'skill'
  return null
}

function toResult(a: Doc<'atoms'>, snippetQuery: string): SearchResult {
  const plain = atomPlaintext(a.path, a.body)
  return {
    path: a.path,
    fileId: extractFrontmatterId(a.body),
    title: deriveTitle(a.body, a.path) ?? basename(a.path),
    type: atomType(a),
    updatedAt: a.updatedAt,
    starred: a.starred === true,
    snippet: snippetParts(plain, snippetQuery),
  }
}

// Re-order FTS hits so title/path matches lead (Convex one-field relevance
// under-weights titles even with the ×3 composition). Stable: ties keep the
// FTS order. Only re-orders the rows FTS already returned — it can't rescue
// a title hit that didn't make the top SCAN (see plan §6).
function postRank(rows: Doc<'atoms'>[], raw: string): Doc<'atoms'>[] {
  const q = normalizeQuery(raw)
  const terms = queryTerms(raw)
  const rank = (a: Doc<'atoms'>): number => {
    const title = (deriveTitle(a.body, a.path) ?? basename(a.path)).toLowerCase()
    const base = basename(a.path).toLowerCase()
    if (title === q) return 0
    if (title.startsWith(q)) return 1
    if (terms.length > 0 && terms.every((t) => title.includes(t))) return 2
    if (base.includes(q) || a.path.toLowerCase().includes(q)) return 3
    return 4
  }
  return rows
    .map((a, i) => ({ a, k: rank(a), i }))
    .sort((x, y) => x.k - y.k || x.i - y.i)
    .map((r) => r.a)
}

/**
 * Workspace-scoped full-text search across all atoms (title + content,
 * incl. HTML visible text and ASCII sketches). Empty/too-short query →
 * recent docs. Tenancy is enforced by the `workspaceId` filter on the
 * search index — never search globally and filter client-side.
 */
export const run = query({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // personal if omitted. Search is workspace-scoped via the searchText
  // index `eq('workspaceId', workspaceId)` filter below; no cross-tenant
  // bleed possible even if a non-member spoofed the arg (requireWorkspace
  // would throw before reaching the index lookup).
  args: { query: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { query: raw, activeWorkspaceId }): Promise<SearchResult[]> => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const norm = normalizeQuery(raw)

    // Empty / 1-char / punctuation-only → recent searchable docs.
    if (norm.length < 2) {
      const recent = await ctx.db
        .query('atoms')
        .withIndex('by_workspace_updated', (q) => q.eq('workspaceId', workspaceId))
        .order('desc')
        .take(RECENT * 3)
      // P1 — filter access BEFORE the slice so the viewer sees their
      // top N readable recent docs (not the top N where some are then
      // dropped because they're private to someone else).
      const visible: typeof recent = []
      for (const a of recent) {
        if (a.searchable === false || !isAtomSearchable(a.path)) continue
        if (await canReadAtom(ctx, a._id, viewerSubject)) visible.push(a)
        if (visible.length >= RECENT) break
      }
      return visible.map((a) => toResult(a, ''))
    }

    const rows = await ctx.db
      .query('atoms')
      .withSearchIndex('search_text', (q) =>
        q
          .search('searchText', norm)
          .eq('workspaceId', workspaceId)
          .eq('searchable', true),
      )
      .take(SCAN)
    // P1 — filter results by access. Apply BEFORE the LIMIT slice so
    // the viewer doesn't see a truncated result set where their N
    // best matches are masked by private atoms they can't read.
    const allowed: typeof rows = []
    for (const a of rows) {
      if (await canReadAtom(ctx, a._id, viewerSubject)) allowed.push(a)
    }
    return postRank(allowed, raw)
      .slice(0, LIMIT)
      .map((a) => toResult(a, raw))
  },
})

/**
 * Self-healing trigger: schedules a one-shot, workspace-scoped backfill of
 * `searchText`/`searchable` on this user's atoms. Idempotent — the
 * backfill patches only rows whose fields aren't in sync. The client
 * fires this once per browser when the search overlay opens, so a
 * workspace whose atoms predate the search feature heals itself the
 * first time the user touches search instead of returning a silently
 * empty result.
 */
export const ensureIndexed = mutation({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // personal. Schedules a backfill scoped to the resolved workspace.
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    await ctx.scheduler.runAfter(0, internal.atoms._backfillSearch, {
      workspaceId,
    })
  },
})
