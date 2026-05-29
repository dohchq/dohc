import { internalMutation } from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { v } from 'convex/values'

// ──────────────────────────────────────────────────────────────────
// DEV-ONLY hard reset. Deletes EVERY row a single workspace owns,
// across all per-workspace tables, so you can re-run onboarding from
// a truly clean slate.
//
// SAFETY:
//  • `internalMutation` ⇒ NOT in the public API; unreachable from the
//    internet/clients. Only callable via `npx convex run` (which
//    needs deploy/CLI access) or another server function. This is the
//    correct boundary for a destructive dev tool.
//  • Requires the exact `workspaceId` AND `confirm: "WIPE"` — no
//    "current user" magic (a CLI call has no auth identity), so you
//    physically cannot wipe the wrong desk by accident.
//  • Bounded + truthfully resumable: a Convex mutation is ATOMIC, so
//    a single call that exceeded the per-transaction write cap would
//    roll back ENTIRELY (deleting nothing — "re-run" could never make
//    progress). So each call self-limits to MAX_DELETES, which is
//    well under Convex's hard cap ⇒ the transaction always COMMITS
//    its chunk. `done:false` ⇒ rows remain; just run it again and it
//    genuinely resumes (the prior chunk is already committed). For a
//    dev/test workspace (tiny) it's always one call, `done:true`.
//
// NOT deleted: the @convex-dev/agent component's own thread/message
// rows live in that component's internal tables (not app schema).
// Deleting `threadRefs` orphans them and `ensureThread` mints a FRESH
// thread next time, so the onboarding chat starts empty — the old
// messages are invisible + harmless, just not hard-purged.
// ──────────────────────────────────────────────────────────────────

const BATCH = 500
// Self-limit per call to well under Convex's per-transaction write
// cap so the mutation always COMMITS (never an atomic rollback that
// would make "re-run" a lie). Tiny dev workspaces finish in one call.
const MAX_DELETES = 6000

type Budget = { left: number }

/** take-drain delete, budget-capped: deleting what we took means the
 *  next take() returns the next batch ⇒ terminates + complete; stops
 *  early (rows remain) when the per-call budget is spent. */
async function drain(
  ctx: MutationCtx,
  b: Budget,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: () => any,
): Promise<number> {
  let n = 0
  while (b.left > 0) {
    const rows = await q().take(Math.min(BATCH, b.left))
    if (rows.length === 0) break
    for (const r of rows) {
      await ctx.db.delete(r._id)
      n++
      b.left--
    }
  }
  return n
}

export const wipeWorkspace = internalMutation({
  args: {
    workspaceId: v.string(),
    confirm: v.literal('WIPE'),
  },
  handler: async (ctx, { workspaceId: ws }) => {
    const deleted: Record<string, number> = {}
    const b: Budget = { left: MAX_DELETES }

    // Tables keyed by `workspaceId` (the index's first field), so an
    // `.eq('workspaceId', ws)` range covers the whole desk.
    const byWs: Array<[string, string]> = [
      ['atoms', 'by_workspace'],
      ['entities', 'by_workspace_type'],
      ['folders', 'by_workspace'],
      ['threadRefs', 'by_workspace'],
      ['onboarding', 'by_workspace'],
      ['trash', 'by_workspace'],
      ['captures', 'by_workspace'],
      ['sourceAtoms', 'by_workspace_path'],
      ['workspaceSettings', 'by_workspace'],
      ['memberships', 'by_workspace'],
      ['rollups', 'by_workspace_identifier'],
    ]
    for (const [table, index] of byWs) {
      deleted[table] = await drain(ctx, b, () =>
        ctx.db
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .query(table as any)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .withIndex(index as any, (qq: any) => qq.eq('workspaceId', ws)),
      )
    }

    // windows this desk OWNS — plus every grant ON those windows.
    let windowsDeleted = 0
    let ownedGrants = 0
    while (b.left > 0) {
      const wins = await ctx.db
        .query('windows')
        .withIndex('by_owner', (q) => q.eq('ownerWorkspaceId', ws))
        .take(Math.min(BATCH, b.left))
      if (wins.length === 0) break
      let stop = false
      for (const w of wins) {
        ownedGrants += await drain(ctx, b, () =>
          ctx.db
            .query('windowGrants')
            .withIndex('by_window', (q) => q.eq('windowId', w._id)),
        )
        if (b.left <= 0) {
          stop = true
          break
        }
        await ctx.db.delete(w._id)
        windowsDeleted++
        b.left--
      }
      if (stop) break
    }
    deleted['windows'] = windowsDeleted

    // grants where this desk is the VIEWER (windows others shared).
    const viewerGrants = await drain(ctx, b, () =>
      ctx.db
        .query('windowGrants')
        .withIndex('by_viewer', (q) => q.eq('viewerWorkspaceId', ws)),
    )
    deleted['windowGrants'] = ownedGrants + viewerGrants

    // sharing-v1 — file-level share grants, BOTH directions. Without
    // this, a wipe + re-onboard kept every share previously granted TO
    // this workspace (WorkOS reissues the same `sub`), silently
    // retaining cross-workspace access (final security review P1).
    // Mirrors the windowGrants handling above.
    const granteeShares = await drain(ctx, b, () =>
      ctx.db
        .query('atomShares')
        .withIndex('by_grantee', (q) => q.eq('granteeWorkspaceId', ws)),
    )
    const ownerShares = await drain(ctx, b, () =>
      ctx.db
        .query('atomShares')
        .withIndex('by_owner_fileId', (q) => q.eq('ownerWorkspaceId', ws)),
    )
    deleted['atomShares'] = granteeShares + ownerShares

    // sharing-v1 1c (review P2-2) — orgs this workspace CREATED would
    // otherwise be orphaned (no owner) but still readable by remaining
    // members. Tear each down: its memberships, its org-shares, then
    // the org row.
    let orgsDeleted = 0
    let orgMemberships = 0
    let orgShares = 0
    const myOrgs = await ctx.db
      .query('orgs')
      .filter((q) => q.eq(q.field('createdBy'), ws))
      .take(Math.min(BATCH, b.left))
    for (const org of myOrgs) {
      if (b.left <= 0) break
      orgMemberships += await drain(ctx, b, () =>
        ctx.db
          .query('memberships')
          .withIndex('by_org', (q) => q.eq('orgId', org._id)),
      )
      orgShares += await drain(ctx, b, () =>
        ctx.db
          .query('atomShares')
          .withIndex('by_org', (q) => q.eq('granteeOrgId', org._id)),
      )
      if (b.left <= 0) break
      await ctx.db.delete(org._id)
      orgsDeleted++
      b.left--
    }
    deleted['orgs'] = orgsDeleted
    deleted['memberships'] = (deleted['memberships'] ?? 0) + orgMemberships
    deleted['atomShares'] += orgShares

    const total = Object.values(deleted).reduce((x, y) => x + y, 0)
    // done:false ⇒ the per-call budget was spent and rows remain —
    // run it again (this call's deletions are committed; it resumes).
    return { workspaceId: ws, total, done: b.left > 0, deleted }
  },
})
