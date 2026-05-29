import { v } from 'convex/values'
import { query } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import {
  isCommandAtomBody,
  isSkillAtomBody,
  isWorkspaceCommandPath,
  isWorkspaceSkillPath,
} from './atomId'

// Track-3 P3 — public query exposing the user's saved skills to
// the UI. The ⌘K palette / slash-command surface subscribes here
// to render the picker. Returns `{path, label}[]` per design §3.3
// (round-5 FAIL-2 fold — label is a deterministic pure-function
// derivation of path; the canonical IDENTIFIER is `path`).
//
// Mirrors the agent's `list_skills` tool in shape (path + label),
// but is a public query (not a tool) — the UI uses it; the agent
// uses the tool. Both produce the same data; consistency matters
// because the UI shows the user a label and the agent's tool
// surface uses the canonical path under the hood.

// Reused from convex/agent.ts; duplicated here to avoid a
// query→action dependency on the agent module (and to keep this
// file's surface area minimal). MUST stay byte-identical to
// `pathDeriveLabel` in convex/agent.ts — the lockstep test
// (convex/skills.test.ts → "pathDeriveLabel byte-identical
// across modules") catches drift on every CI run.
// P3+P4 indep fold F5: previously diverged — agent.ts had a
// `|| path || '(untitled)'` fallback that skills.ts lacked;
// for `path = ''` skills.ts returned `''` (would break the
// `- ${label} (${path})` listing format), agent.ts returned
// '(untitled)'. The fold reunifies.
export function pathDeriveLabel(path: string): string {
  const stripped = path.replace(/^.*\//, '').replace(/\.md$/i, '')
  return stripped || path || '(untitled)'
}

export const list = query({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // the caller's personal workspace if omitted. Membership-gated by
  // requireWorkspace when an org workspace is supplied.
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    const visible = []
    for (const r of rows) {
      if (
        isWorkspaceSkillPath(r.path) &&
        isSkillAtomBody(r.body) &&
        (await canReadAtom(ctx, r._id, identity.subject))
      ) {
        visible.push(r)
      }
    }
    return visible
      .map((r) => ({
        path: r.path,
        label: pathDeriveLabel(r.path),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  },
})

export const listCommands = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    const visible = []
    for (const r of rows) {
      if (
        isWorkspaceCommandPath(r.path) &&
        isCommandAtomBody(r.body) &&
        (await canReadAtom(ctx, r._id, identity.subject))
      ) {
        visible.push(r)
      }
    }
    return visible
      .map((r) => ({
        path: r.path,
        label: pathDeriveLabel(r.path),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  },
})
