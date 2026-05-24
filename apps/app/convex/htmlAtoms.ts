import { v } from 'convex/values'
import { query } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import {
  extractFrontmatterId,
  isHtmlAtomBody,
  isHtmlPath,
  splitFrontmatter,
} from './atomId'

// html-atoms-v1 §2-B — the render route's ONLY data source.
//
// CONFUSED-DEPUTY DEFENSE (design §2, line 90): the workspace is
// derived from the SESSION via requireWorkspace(ctx) — NEVER from
// the URL `atomId`. The atomId is only a lookup KEY *within the
// caller's own workspace*; a user can never read another
// workspace's atom by guessing its id. Every negative case (missing
// / tombstoned / wrong workspace / not an html atom) collapses to
// the SAME `null` → the route 404s. We never distinguish "exists
// elsewhere" from "does not exist" (no cross-workspace existence
// oracle).
//
// Sanitization is intentionally NOT done here: sanitizeAtomHtml
// needs jsdom (Node) and MUST run in the TanStack server route, not
// the Convex runtime. This returns the raw post-frontmatter HTML;
// the route sanitizes + wraps + sets the §2-C headers.
export const getRenderable = query({
  // Phase B.3 (org-plan §5 — NON-DEFAULTABLE surface).
  // The /r/<atomId> server-side route forwards `?w=<wsId>` here; the
  // client-side HtmlAtomFrame appends that param to the iframe URL
  // from `useActiveWorkspaceId()`. Backend stays optional for URL
  // back-compat: old shared links without `?w=` resolve against the
  // caller's personal workspace via requireWorkspace(ctx, undefined),
  // which is the documented v0 surface — not a regression.
  args: { atomId: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { atomId, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    if (!atomId) return null

    // .take(2), NOT .unique(): a duplicate (ws,fileId) row is index
    // corruption — fail CLOSED to null (→ a 404), never throw (which
    // the route would mis-map to a false 401). Track-1's invariant is
    // ≤1 bound row per (ws,fileId); >1 ⇒ refuse to guess. (P2
    // dual-review: Codex FAIL-1.)
    const idRows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) =>
        q.eq('workspaceId', workspaceId).eq('fileId', atomId),
      )
      .take(2)
    if (idRows.length !== 1) return null
    const idRow = idRows[0]
    if (idRow.state !== 'bound' || idRow.path === null) return null
    const path = idRow.path

    const atoms = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', path),
      )
      .take(2)
    if (atoms.length !== 1) return null
    const atom = atoms[0]
    // D4.13 — render an atom whose PATH ends in `.html` (case-
    // insensitive), OR (backward-compat) one carrying `type: html`
    // frontmatter. Anything else fails closed — never serve an
    // arbitrary markdown atom as HTML.
    if (!isHtmlPath(path) && !isHtmlAtomBody(atom.body)) return null
    // Defense-in-depth (P2 dual-review M1): the resolved atom must
    // actually carry the requested id. Unreachable via Track-1
    // writers today, but this keeps the data source self-consistent
    // under any future reconcile regression / manual data
    // corruption — and is never cross-workspace (both lookups are
    // ws-scoped). A legacy atom with NO frontmatter id is allowed
    // through (ws+path scoping is the real boundary); only a
    // POSITIVE id mismatch is rejected.
    const fid = extractFrontmatterId(atom.body)
    if (fid !== null && fid !== atomId) return null

    // P1 (multiplayer-and-h-followups §6.5) — access gate. Render
    // route returns null for atoms the viewer can't read (the /r
    // route maps this to 404, consistent with the M5 fix from the
    // org-tenancy round-2 review — never confirms the atom exists).
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canReadAtom(ctx, atom._id, viewerSubject))) return null

    const { rest } = splitFrontmatter(atom.body)
    return { html: rest, updatedAt: atom.updatedAt }
  },
})
