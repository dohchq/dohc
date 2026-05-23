'use node'
/**
 * org-plan §10 Phase E — WorkOS Organizations bridge.
 *
 * Wraps `orgs.createOrg` + `orgs.renameOrg` in actions that ALSO sync
 * the WorkOS Organization. The bridge is GRACEFUL — if `WORKOS_API_KEY`
 * is not set in the Convex deploy env, the Convex side still operates
 * (org is created/renamed in our DB; workosOrgId stays unset; a
 * future bridge run can backfill). This keeps dohc usable in any
 * environment (local dev without the key, single-tenant deployments).
 *
 * Why an action (not a mutation): the @workos-inc/node SDK uses Node
 * APIs (fetch, crypto) and must run in Convex's Node runtime. The
 * `'use node'` directive on this file is the established convention.
 *
 * Why a separate file: directives apply file-wide. Mixing 'use node'
 * actions with V8 mutations/queries in one file isn't supported.
 *
 * Future extensions (not in this MVP):
 *   - sendInvitation (WorkOS email invites alongside our invite-code)
 *   - webhook receiver for member sync
 *   - role-change sync via member-role updates
 */
import { v } from 'convex/values'
import { action } from './_generated/server'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

// Returns null if not configured — the caller skips WorkOS sync.
// Importing the SDK is also deferred so the action doesn't pay the
// load cost when the bridge is disabled.
async function getWorkOS() {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  if (!apiKey || !clientId) return null
  const { WorkOS } = await import('@workos-inc/node')
  return new WorkOS(apiKey, { clientId })
}

/** Create an org in dohc AND in WorkOS (when configured). Falls back
 *  to dohc-only if WORKOS_API_KEY is absent — the org still works
 *  inside dohc and can be backfilled later. */
export const createOrgWithBridge = action({
  args: { name: v.string() },
  handler: async (
    ctx,
    { name },
  ): Promise<{
    orgId: Id<'orgs'>
    name: string
    inviteCode: string
    workosOrgId: string | null
  }> => {
    // 1. Always create the Convex side first. If WorkOS fails after,
    // the dohc org still exists (and is usable); we lose only the
    // sync, which is recoverable. The reverse order (WorkOS first)
    // would risk an orphan WorkOS org if the Convex mutation failed.
    const created = await ctx.runMutation(api.orgs.createOrg, { name })

    // 2. Try to sync to WorkOS. Failures are logged + swallowed so the
    // user's create-org click doesn't fail because of a transient
    // WorkOS outage. A later rename re-attempts (and could optionally
    // backfill on first successful call — kept simple here).
    let workosOrgId: string | null = null
    try {
      const workos = await getWorkOS()
      if (workos) {
        const org = await workos.organizations.createOrganization({
          name: created.name,
          // externalId pins the WorkOS row to our Convex orgs._id so
          // we can recover from a lost workosOrgId field by listing
          // WorkOS orgs and matching externalId. The Convex _id is
          // already opaque + stable.
          externalId: created.orgId,
        })
        workosOrgId = org.id
        await ctx.runMutation(internal.orgs._patchWorkosOrgId, {
          orgId: created.orgId,
          workosOrgId,
        })
      } else {
        console.warn(
          '[orgsBridge] WORKOS_API_KEY not set in Convex env — org created in dohc only. Run `npx convex env set WORKOS_API_KEY=...` to enable WorkOS sync.',
        )
      }
    } catch (err) {
      // Don't fail the user's create — log and move on.
      console.error('[orgsBridge] WorkOS createOrganization failed:', err)
    }

    return { ...created, workosOrgId }
  },
})

/** Rename an org in dohc AND (when configured + linked) in WorkOS. */
export const renameOrgWithBridge = action({
  args: { orgId: v.id('orgs'), name: v.string() },
  handler: async (
    ctx,
    { orgId, name },
  ): Promise<{ ok: true; changed: boolean; syncedToWorkOS: boolean }> => {
    // 1. Convex first (same reasoning as createOrgWithBridge).
    const res = await ctx.runMutation(api.orgs.renameOrg, { orgId, name })

    // No-op rename ⇒ skip WorkOS too (no diff to push).
    if (!res.changed) {
      return { ok: true as const, changed: false, syncedToWorkOS: false }
    }

    // 2. Sync to WorkOS if linked. Read the patched row to find the
    // workosOrgId (the action can't ctx.db; use the public myOrgs
    // query… actually we need an internal getter that returns the
    // workosOrgId for a specific orgId, gated to a member).
    let syncedToWorkOS = false
    try {
      const workosOrgId: string | null = await ctx.runQuery(
        internal.orgs._getWorkosOrgIdForCaller,
        { orgId },
      )
      if (!workosOrgId) {
        return { ok: true as const, changed: true, syncedToWorkOS: false }
      }
      const workos = await getWorkOS()
      if (workos) {
        await workos.organizations.updateOrganization({
          organization: workosOrgId,
          name: name.trim(),
        })
        syncedToWorkOS = true
      }
    } catch (err) {
      console.error('[orgsBridge] WorkOS updateOrganization failed:', err)
    }

    return { ok: true as const, changed: true, syncedToWorkOS }
  },
})
