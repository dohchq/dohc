import { mutation } from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'

const RESERVED = new Set([
  'agent',
  'api',
  'files',
  'graph',
  'me',
  'p',
  'personal',
  'r',
  'shared',
  'signed-out',
  'v',
  'views',
  'w',
])

type SlugCtx = QueryCtx | MutationCtx
type IdentityLabelSource = {
  email?: string | null
  name?: string | null
  preferredUsername?: string | null
  nickname?: string | null
  givenName?: string | null
}

const GENERIC_PERSONAL_SLUGS = new Set(['personal', 'workspace'])

function cleanSlug(input: string): string {
  const slug = slugToken(input)
  if (!slug || RESERVED.has(slug)) return 'workspace'
  return slug
}

function slugToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function lookupSlug(input: string): string | null {
  const slug = slugToken(input)
  if (!slug || RESERVED.has(slug)) return null
  return slug
}

function canWriteSlug(ctx: SlugCtx): ctx is MutationCtx {
  return 'insert' in ctx.db
}

function idSuffix(workspaceId: string): string {
  const compact = workspaceId.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return compact.slice(-6) || '1'
}

function preferredPersonalLabel(identity: IdentityLabelSource): string {
  for (const value of [
    identity.name,
    identity.preferredUsername,
    identity.nickname,
    identity.givenName,
  ]) {
    const clean = value?.trim()
    if (clean) return clean
  }
  const local = identity.email?.split('@')[0]?.trim()
  return local || 'personal'
}

export function workspaceSlugBase(label: string): string {
  return cleanSlug(label)
}

export async function readWorkspaceSlug(
  ctx: SlugCtx,
  workspaceId: string,
  fallbackLabel: string,
): Promise<string | null> {
  const row = await ctx.db
    .query('workspaceSlugs')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .first()
  if (row) return row.slug
  if (canWriteSlug(ctx)) {
    return await ensureWorkspaceSlug(ctx, workspaceId, fallbackLabel)
  }
  return null
}

export async function ensureWorkspaceSlug(
  ctx: MutationCtx,
  workspaceId: string,
  label: string,
  options?: { replaceGeneric?: boolean },
): Promise<string> {
  const existing = await ctx.db
    .query('workspaceSlugs')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .first()

  const base = cleanSlug(label)
  if (existing) {
    if (
      options?.replaceGeneric === true &&
      GENERIC_PERSONAL_SLUGS.has(existing.slug) &&
      !GENERIC_PERSONAL_SLUGS.has(base)
    ) {
      const replacement = await availableSlug(ctx, workspaceId, base)
      await ctx.db.patch(existing._id, {
        slug: replacement,
        updatedAt: Date.now(),
      })
      return replacement
    }
    return existing.slug
  }

  const slug = await availableSlug(ctx, workspaceId, base)
  const now = Date.now()
  await ctx.db.insert('workspaceSlugs', {
    workspaceId,
    slug,
    createdAt: now,
    updatedAt: now,
  })
  return slug
}

async function availableSlug(
  ctx: MutationCtx,
  workspaceId: string,
  base: string,
): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`
    const clash = await ctx.db
      .query('workspaceSlugs')
      .withIndex('by_slug', (q) => q.eq('slug', candidate))
      .first()
    if (clash && clash.workspaceId !== workspaceId) continue
    return candidate
  }
  return `${base}-${idSuffix(workspaceId)}`
}

export async function workspaceIdForSlug(
  ctx: QueryCtx | MutationCtx,
  slug: string,
): Promise<string | null> {
  const token = slugToken(slug)
  if (token === 'personal') {
    try {
      return await requireWorkspace(ctx)
    } catch {
      return null
    }
  }
  const lookup = lookupSlug(slug)
  if (!lookup) return null
  const row = await ctx.db
    .query('workspaceSlugs')
    .withIndex('by_slug', (q) => q.eq('slug', lookup))
    .first()
  return row?.workspaceId ?? null
}

export const ensureMine = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const caller = await requireWorkspace(ctx)
    const profile = await ctx.db
      .query('userProfiles')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', caller))
      .first()
    const personalLabel = preferredPersonalLabel({
      email: profile?.email ?? identity.email,
      name: profile?.name ?? identity.name,
      preferredUsername: (identity as IdentityLabelSource).preferredUsername,
      nickname: (identity as IdentityLabelSource).nickname,
      givenName: (identity as IdentityLabelSource).givenName,
    })
    const out: Array<{ workspaceId: string; slug: string }> = []

    out.push({
      workspaceId: caller,
      slug: await ensureWorkspaceSlug(ctx, caller, personalLabel, {
        replaceGeneric: true,
      }),
    })

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', caller))
      .collect()
    for (const membership of memberships) {
      if (membership.status !== undefined && membership.status !== 'active') {
        continue
      }
      const org = await ctx.db.get(membership.orgId as Id<'orgs'>)
      if (!org || org.status === 'archived') continue
      out.push({
        workspaceId: membership.orgId,
        slug: await ensureWorkspaceSlug(ctx, membership.orgId, org.name),
      })
    }

    return out
  },
})
