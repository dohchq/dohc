import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// §6 CI guard (tenancy-authz-v0.md §6 / §6b).
//
// HONESTY (Phase-3 Codex review): a regex guard CANNOT prove the
// data-flow property "viewerWorkspaceId is the authenticated caller"
// — aliasing (`const w = args.x; resolveWindow({viewerWorkspaceId:w})`)
// evades any pattern match. This is a TRIPWIRE for the most common,
// statically-detectable smell, NOT a proof. The binding control is
// the §6b adapter contract + human review. The tripwire chosen is the
// one that is reliably detectable and that catches the real bug class
// (and would have caught the seed.ts cross-tenant wipe had it stayed
// public): a PUBLIC Convex function that accepts a workspace id as a
// client argument at all. Public functions MUST derive the workspace
// from requireWorkspace(ctx); only internal* functions (trusted
// server callers) may take workspaceId as an arg.

const CONVEX = join(__dirname, '..', '..', 'convex')

function walk(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '_generated' || e.startsWith('.')) continue
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) out = out.concat(walk(p))
    else if (/\.ts$/.test(e) && !e.endsWith('.test.ts')) out.push(p)
  }
  return out
}

// REVIEWED share-target exceptions (§6b). grant/revoke MUST take the
// GRANTEE's workspace id as a client arg — the OWNER is naming who may
// later read their OWN window. This is NOT the dangerous pattern the
// tripwire targets: the caller's authority still comes from
// requireWorkspace(ctx) (verified: window-ownership check), and the
// arg cannot read anyone's data — it only writes a grant row over the
// caller's own window. The actual cross-desk READ (windows.resolve)
// correctly takes NO workspace arg (viewer = requireWorkspace).
// Suppression is keyed by exact file:fn AND is VOID unless the fn
// still calls requireWorkspace — delete the auth and it re-trips.
const SHARE_TARGET_ALLOW = new Set([
  'windows.ts:grant',
  'windows.ts:revoke',
  // sharing-v1 1a — file-level share grant. Same shape as windows.grant:
  // the caller's authority is requireWorkspace(ctx) (verified to OWN the
  // fileId); `granteeWorkspaceId` only names who may later read the
  // owner's own file (writes a grant row, reads nobody's data). The
  // cross-workspace READ (atomShares.getSharedAtom) correctly takes NO
  // workspace arg — viewer = requireWorkspace via resolveShareAccess.
  'atomShares.ts:shareAtom',
  // org-plan §6 — Owner-gated member ops. `memberWorkspaceId` names the
  // GRANTEE (which member to remove / change role for); the caller's
  // authority is requireRole(ctx, orgId, 'owner') which internally calls
  // requireWorkspace. Same grant-style shape as windows.grant.
  'orgs.ts:removeMember',
  'orgs.ts:changeRole',
])

// crude export-block splitter: `export const NAME = (mutation|query|
// action|internalMutation|…)({ … })` up to the args/handler region.
// Also reports whether the fn body calls requireWorkspace (so an
// allowlisted exception cannot silently lose its auth check).
//
// Org-plan §5 NOTE: a NEW shape entered the codebase in Phase B —
// `activeWorkspaceId: v.optional(v.string())`. Unlike the legacy
// `workspaceId` / `viewerWorkspaceId` / `granteeWorkspaceId` args (which
// claim to BE someone's workspace and are the dangerous bug class), the
// `activeWorkspaceId` arg is the URL-derived ACTIVE workspace handle:
// the caller is asking "evaluate this in workspace X" and the gate is
// `requireWorkspace(ctx, activeWorkspaceId)` which membership-checks it.
// Spoofing `activeWorkspaceId` to point at someone else's workspace is
// caught by the membership lookup in convex/auth.ts. We therefore strip
// `activeWorkspaceId` from the args head BEFORE scanning for "workspace"
// so it doesn't trigger the tripwire — but the regex still catches every
// other workspace-naming arg shape.
function publicFnsTakingWorkspace(
  src: string,
): Array<{ name: string; kind: string; authed: boolean }> {
  const hits: Array<{ name: string; kind: string; authed: boolean }> = []
  const re =
    /export\s+const\s+(\w+)\s*=\s*(internalMutation|internalQuery|internalAction|mutation|query|action)\s*\(\{([\s\S]{0,600}?)handler/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const [, name, kind, head] = m
    const isPublic = !kind.startsWith('internal')
    if (!isPublic) continue
    const body = src.slice(m.index, m.index + 2000)
    // Codex round-2 LOW tightening: only exempt `activeWorkspaceId`
    // from the workspace-arg detection when the body ACTUALLY routes
    // it through a known auth check. Otherwise a future fn could
    // declare `activeWorkspaceId` as args + ignore it (or pass it
    // directly into a db query as a workspaceId) and silently pass
    // CI. The exemption now requires one of:
    //   - `requireWorkspace(ctx, activeWorkspaceId)`  (mutation/query)
    //   - `runQuery(... _resolveWorkspaceForCaller ..., { activeWorkspaceId })` (action-bridge)
    //   - `requireRole(ctx, activeWorkspaceId, ...)` (Owner-gated; internally calls requireWorkspace)
    //   - P1 (multiplayer-and-h-followups): `recoverTombstonedAtom`
    //     uses required `v.string()` form because the recovery action
    //     only makes sense in an org context (no `me` sentinel value).
    const validatesActive =
      /requireWorkspace\s*\(\s*ctx\s*,\s*(?:args\.)?activeWorkspaceId\s*\)/.test(
        body,
      ) ||
      /runQuery\([\s\S]{0,80}_resolveWorkspaceForCaller[\s\S]{0,200}activeWorkspaceId/.test(
        body,
      ) ||
      /requireRole\s*\(\s*ctx\s*,\s*(?:args\.)?activeWorkspaceId\s*,/.test(
        body,
      )
    // Strip BOTH optional + required shapes of activeWorkspaceId when
    // validated (P1's recoverTombstonedAtom uses the required form).
    const headWithoutActive = validatesActive
      ? head
          .replace(
            /\bactiveWorkspaceId\s*:\s*v\.optional\(v\.string\(\)\)\s*,?/g,
            '',
          )
          .replace(/\bactiveWorkspaceId\s*:\s*v\.string\(\)\s*,?/g, '')
      : head
    if (/\bargs\s*:\s*\{[\s\S]*?workspace/i.test(headWithoutActive)) {
      // `requireRole(ctx, …)` internally calls `requireWorkspace` — it
      // is also a valid auth check (org-plan §6 introduced it).
      hits.push({
        name,
        kind,
        authed: /\b(requireWorkspace|requireRole)\s*\(/.test(body),
      })
    }
  }
  return hits
}

describe('authz boundary (§6 tripwire — not a proof; see §6b contract)', () => {
  const files = walk(CONVEX)

  it('no PUBLIC Convex function accepts a workspace id as a client arg', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.split('/convex/')[1]
      for (const h of publicFnsTakingWorkspace(readFileSync(f, 'utf8'))) {
        const allowed =
          SHARE_TARGET_ALLOW.has(`${rel}:${h.name}`) && h.authed
        if (allowed) continue
        offenders.push(`${rel}: ${h.name} (${h.kind})`)
      }
    }
    // Public fns must derive workspace from requireWorkspace(ctx).
    // internal* fns taking workspaceId (e.g. atoms._listInternal) are
    // fine — called only by authed server actions.
    expect(offenders).toEqual([])
  })

  it('the share-target allowlist is VOID without requireWorkspace (meta)', () => {
    // A grant-shaped fn that DROPPED its auth check must still be
    // flagged even though its file:name is allowlisted — the
    // suppression is gated on h.authed, not on the name alone.
    const insecure = `
export const grant = mutation({
  args: { windowId: v.id('windows'), viewerWorkspaceId: v.string() },
  handler: async (ctx, { windowId, viewerWorkspaceId }) => {
    await ctx.db.insert('windowGrants', { windowId, viewerWorkspaceId })
    return { ok: true }
  },
})`
    const [h] = publicFnsTakingWorkspace(insecure)
    expect(h).toMatchObject({ name: 'grant', authed: false })
    const allowed = SHARE_TARGET_ALLOW.has(`windows.ts:${h.name}`) && h.authed
    expect(allowed).toBe(false) // allowlist does NOT save an unauthed fn

    const secure = insecure.replace(
      'async (ctx, { windowId, viewerWorkspaceId }) => {',
      'async (ctx, { windowId, viewerWorkspaceId }) => {\n    await requireWorkspace(ctx)',
    )
    const [h2] = publicFnsTakingWorkspace(secure)
    expect(h2.authed).toBe(true)
    expect(SHARE_TARGET_ALLOW.has(`windows.ts:${h2.name}`) && h2.authed).toBe(true)
  })

  it('resolveWindow is never called with a client-sourced viewer (direct-form tripwire)', () => {
    // Catches the obvious `resolveWindow({ viewerWorkspaceId: args.x })`.
    // Aliased forms are NOT caught here by design (documented above) —
    // the §6b contract + review is the real control.
    const offenders: string[] = []
    for (const f of [...walk(join(__dirname, '..')), ...files]) {
      if (f.endsWith('resolveWindow.ts') || f.endsWith('.test.ts')) continue
      const src = readFileSync(f, 'utf8')
      const re = /resolveWindow\s*\(([\s\S]{0,300}?)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        if (/viewerWorkspaceId[\s\S]{0,40}\b(args|params|body|input|request|payload)\b/.test(m[1])) {
          offenders.push(`${f}: ${m[1].replace(/\s+/g, ' ').slice(0, 100)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
