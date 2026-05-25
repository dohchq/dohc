import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'

type DisconnectArgs = {
  workspaceId: string
  userId: string
}

type SchedulerCtx = {
  scheduler: MutationCtx['scheduler']
}

function collabAdminRequired(): boolean {
  return (
    process.env.HOCUSPOCUS_ADMIN_REQUIRED === 'true' ||
    Boolean(process.env.HOCUSPOCUS_JWT_SECRET)
  )
}

function adminEnv(): { url: string; token: string } | null {
  const url = process.env.HOCUSPOCUS_ADMIN_URL
  const token = process.env.HOCUSPOCUS_ADMIN_TOKEN
  if (url && token) return { url, token }
  if (!url && !token && !collabAdminRequired()) return null

  const missing = [
    !url ? 'HOCUSPOCUS_ADMIN_URL' : null,
    !token ? 'HOCUSPOCUS_ADMIN_TOKEN' : null,
  ].filter(Boolean)
  throw new Error(
    `${missing.join(' and ')} required for Hocuspocus live revocation`,
  )
}

export async function scheduleHocuspocusDisconnect(
  ctx: SchedulerCtx,
  args: DisconnectArgs,
): Promise<void> {
  if (!adminEnv()) return
  await ctx.scheduler.runAfter(0, internal.hocuspocusAdmin.disconnectWorkspaceUser, args)
}

export const disconnectWorkspaceUser = internalAction({
  args: {
    workspaceId: v.string(),
    userId: v.string(),
  },
  handler: async (_ctx, args) => {
    const env = adminEnv()
    if (!env) {
      return { ok: false as const, skipped: 'missing-env' as const }
    }

    const response = await fetch(
      new URL('/admin/disconnect-by-workspace-user', env.url).toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(args),
      },
    )
    if (!response.ok) {
      throw new Error(`Hocuspocus admin disconnect failed: ${response.status}`)
    }
    return (await response.json()) as { ok: true; disconnected?: number }
  },
})
