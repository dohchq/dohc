import { query } from './_generated/server'
import { requireWorkspace } from './auth'
import { isSkillAtomBody, isLegacySkillPath } from './atomId'

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
  args: {},
  handler: async (ctx) => {
    const workspaceId = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
    // A skill atom either declares `type: skill` in its frontmatter
    // (the canonical Track-3 form) OR lives at the legacy
    // `skills/*` path (the compat-window term still recognized
    // until §6.4.5 cleanup). Both sources project as a `skill`
    // entry the user can fire from ⌘K.
    return rows
      .filter((r) => isSkillAtomBody(r.body) || isLegacySkillPath(r.path))
      .map((r) => ({
        path: r.path,
        label: pathDeriveLabel(r.path),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  },
})
