// Auth helpers. Every public-facing query/mutation/action derives the
// caller's workspaceId from ctx.auth. Throws if unauthenticated.
//
// Phase 3 (org-plan.md): `requireWorkspace(ctx, activeWorkspaceId?)`
// is the migration valve. With no second arg, returns the caller's
// PERSONAL workspace (workspaceId === WorkOS user subject — the v0
// semantics). With a second arg, the user must be an `active` member
// of that workspace via the `memberships` table, or the call throws.
// Personal workspaces grant implicit Owner to the WorkOS subject; no
// membership row is needed (workspaceId == subject ⇒ self-access).

import { SignJWT } from 'jose'
import { v } from 'convex/values'
import { action, mutation, query } from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'

type AuthIdentity = {
  subject: string
  email?: string | null
  name?: string | null
}

// Structural type for callers that pass NO `active` arg (the
// default-to-personal path). Actions have `auth` but no `db`, so this
// is the loosest shape we accept. Explicit non-personal active requires
// QueryCtx | MutationCtx (membership lookup needs db).
type AuthOnlyCtx = {
  auth: { getUserIdentity: () => Promise<AuthIdentity | null> }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// SECURITY: there is intentionally NO "unauthenticated request →
// data" escape here. An earlier env-gated dev bypass
// (`DOHC_DEV_AUTH`) was a critical hole — Convex public functions
// are raw internet endpoints on the shared deployment, so the escape
// served the whole internet, not "local dev". It was removed and the
// env var unset on the live deployment. Backend behaviour is now
// tested with `convex-test` (mocked identity), never by widening auth.
export function requireWorkspace(ctx: AuthOnlyCtx): Promise<string>
export function requireWorkspace(
  ctx: QueryCtx | MutationCtx,
  active?: string,
): Promise<string>
export async function requireWorkspace(
  ctx: AuthOnlyCtx | QueryCtx | MutationCtx,
  active?: string,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    throw new Error('Not authenticated')
  }
  const subject = identity.subject
  // Default (no `active` arg) → personal workspace. Preserves v0 behavior
  // for the long tail of callers that don't yet pass an active workspace.
  if (active === undefined || active === subject) return subject
  // Active workspace ≠ caller's personal subject → must be an `active`
  // member of that org workspace. Membership rows that predate the
  // `status` field are treated as 'active' for back-compat.
  const dbCtx = ctx as QueryCtx | MutationCtx
  if (!('db' in dbCtx)) {
    throw new Error(
      'requireWorkspace(ctx, active) requires a query/mutation ctx (actions cannot read membership)',
    )
  }
  const m = await dbCtx.db
    .query('memberships')
    .withIndex('by_org_workspace', (q) =>
      q.eq('orgId', active).eq('workspaceId', subject),
    )
    .unique()
  if (!m) throw new Error(`Not a member of workspace ${active}`)
  if (m.status !== undefined && m.status !== 'active') {
    throw new Error(`Membership not active (status=${m.status})`)
  }
  const org = await dbCtx.db.get(active as Id<'orgs'>)
  if (!org || org.status === 'archived') {
    throw new Error(`Workspace ${active} has been archived`)
  }
  return active
}

const COLLAB_TOKEN_TTL_SECONDS = 5 * 60

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function secondsNow(): number {
  return Math.floor(Date.now() / 1000)
}

export const getCollabToken = action({
  args: {
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId: targetWorkspaceArg }) => {
    const callerWorkspaceId = await requireWorkspace(ctx)
    const targetWorkspaceId = targetWorkspaceArg ?? callerWorkspaceId
    const issuedAt = secondsNow()

    return await new SignJWT({
      sub: callerWorkspaceId,
      ws: targetWorkspaceId,
      actorKind: 'user',
      authzVersion: 1,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + COLLAB_TOKEN_TTL_SECONDS)
      .sign(secretKey(requiredEnv('HOCUSPOCUS_JWT_SECRET')))
  },
})

// Track-3 P4 — minimal "who am I" query for the UI's share-text
// builder (skills-commands-v1 §2-B). Returns the caller's
// workspaceId so the client can construct a `source-share:
// <workspaceId>/<atom-id>` advisory frontmatter line on share.
// The workspaceId is the WorkOS subject claim — opaque to outsiders;
// no personal info leaked.
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    const workspaceId = await requireWorkspace(ctx)
    return {
      workspaceId,
      email: identity?.email ?? null,
      name: identity?.name ?? null,
    }
  },
})

export const upsertMyProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const email = normalizeEmail(identity.email ?? '')
    if (!email) {
      return {
        workspaceId: identity.subject,
        email: null,
        profileId: null,
      }
    }

    const existing = await ctx.db
      .query('userProfiles')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', identity.subject))
      .first()
    const patch: {
      email: string
      normalizedEmail: string
      updatedAt: number
      name?: string
    } = {
      email,
      normalizedEmail: email,
      updatedAt: Date.now(),
    }
    if (identity.name?.trim()) {
      patch.name = identity.name.trim()
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch)
      return {
        workspaceId: identity.subject,
        email,
        profileId: existing._id,
      }
    }

    const profileId = await ctx.db.insert('userProfiles', {
      workspaceId: identity.subject,
      ...patch,
    })
    return {
      workspaceId: identity.subject,
      email,
      profileId,
    }
  },
})

export const routeCurrentEmailToWorkspace = mutation({
  args: {
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { activeWorkspaceId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const email = normalizeEmail(identity.email ?? '')
    if (!email || !email.includes('@')) {
      throw new Error('Sign in with an email address before routing it.')
    }

    const targetWorkspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    let label: string | undefined
    if (targetWorkspaceId !== identity.subject) {
      const org = await ctx.db.get(targetWorkspaceId as Id<'orgs'>)
      label = org?.name
    }

    const now = Date.now()
    const existing = await ctx.db
      .query('workspaceAddressRoutes')
      .withIndex('by_normalizedEmail', (q) => q.eq('normalizedEmail', email))
      .first()

    const patch = {
      accountWorkspaceId: identity.subject,
      targetWorkspaceId,
      email,
      normalizedEmail: email,
      label,
      status: 'verified' as const,
      updatedAt: now,
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch)
      return {
        routeId: existing._id,
        email,
        targetWorkspaceId,
        accountWorkspaceId: identity.subject,
      }
    }

    const routeId = await ctx.db.insert('workspaceAddressRoutes', {
      ...patch,
      createdAt: now,
    })
    return {
      routeId,
      email,
      targetWorkspaceId,
      accountWorkspaceId: identity.subject,
    }
  },
})

export const myAddressRoutes = query({
  args: {},
  handler: async (ctx) => {
    const accountWorkspaceId = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('workspaceAddressRoutes')
      .withIndex('by_accountWorkspaceId', (q) =>
        q.eq('accountWorkspaceId', accountWorkspaceId),
      )
      .collect()
    return rows.map((row) => ({
      routeId: row._id,
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      targetWorkspaceId: row.targetWorkspaceId,
      label: row.label ?? null,
      status: row.status,
    }))
  },
})
