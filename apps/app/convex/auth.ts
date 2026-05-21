// Auth helpers. Every public-facing query/mutation/action derives the
// caller's workspaceId from ctx.auth. Throws if unauthenticated.
//
// For v0 the workspace IS the user — workspaceId === WorkOS user id
// (the JWT's `sub` claim). Multi-user workspaces come later.

import { query } from './_generated/server'

type AuthCtx = {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
}

// SECURITY: there is intentionally NO "unauthenticated request →
// data" escape here. An earlier env-gated dev bypass
// (`DOHC_DEV_AUTH`) was a critical hole — Convex public functions
// are raw internet endpoints on the shared deployment, so the escape
// served the whole internet, not "local dev". It was removed and the
// env var unset on the live deployment. Backend behaviour is now
// tested with `convex-test` (mocked identity), never by widening auth.
export async function requireWorkspace(ctx: AuthCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    throw new Error('Not authenticated')
  }
  return identity.subject
}

// Track-3 P4 — minimal "who am I" query for the UI's share-text
// builder (skills-commands-v1 §2-B). Returns the caller's
// workspaceId so the client can construct a `source-share:
// <workspaceId>/<atom-id>` advisory frontmatter line on share.
// The workspaceId is the WorkOS subject claim — opaque to outsiders;
// no personal info leaked.
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const workspaceId = await requireWorkspace(ctx)
    return { workspaceId }
  },
})
