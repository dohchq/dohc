import { internalMutation } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { MAP_PATH } from './inlineAtom'
import { reconcileAtomIdIndex, seedAtomIdIntoBody } from './atomId'
import { deriveSearchFields } from './searchText'

const MAP_SCAN_CAP = 5000
const WIKILINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
const MAP_MAX_LINKS_PER_NOTE = 12
const MAP_MAX_CHARS = 256_000

// Map summaries echo note text. Neutralise `{}` so a copied
// `Logged {billable: 10}` can never be parsed as a real atom.
const firstProseLine = (body: string): string => {
  for (const raw of (body ?? '').split('\n')) {
    const line = raw
      .replace(/^#+\s*/, '')
      .replace(/\{/g, '(')
      .replace(/\}/g, ')')
      .trim()
    if (line) return line.length > 80 ? line.slice(0, 79) + '...' : line
  }
  return ''
}

type NoteRow = { path: string; body?: string; source?: string }

async function loadNotes(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<{ overflow: true } | { overflow: false; notes: NoteRow[] }> {
  const rows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(MAP_SCAN_CAP + 1)
  if (rows.length > MAP_SCAN_CAP) return { overflow: true }
  return {
    overflow: false,
    notes: rows.map((r) => ({ path: r.path, body: r.body, source: r.source })),
  }
}

function buildMapBody(notes: NoteRow[]): string {
  const indexed = notes
    .filter((n) => n.path !== MAP_PATH)
    .sort((a, b) => a.path.localeCompare(b.path))
  const byFolder = new Map<string, NoteRow[]>()
  for (const n of indexed) {
    const slash = n.path.lastIndexOf('/')
    const folder = slash >= 0 ? n.path.slice(0, slash) : '(root)'
    ;(byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(n)
  }

  const cap = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 3) + '...' : s
  const out: string[] = [
    '# _map',
    '',
    '> Auto-maintained by dohc. This is a generated index; edit your',
    '> notes, not this file. Delete it and dohc rebuilds it after the',
    '> next workspace edit.',
    '',
    `total notes: ${indexed.length}`,
    '',
  ]
  let used = out.reduce((a, l) => a + l.length + 1, 0)
  const TRUNC = '\n> ... map truncated (workspace too large for one index).\n'
  let truncated = false
  const tryPush = (line: string): boolean => {
    if (used + line.length + 1 > MAP_MAX_CHARS - TRUNC.length) {
      truncated = true
      return false
    }
    out.push(line)
    used += line.length + 1
    return true
  }

  outer: for (const folder of [...byFolder.keys()].sort()) {
    if (!tryPush(`## ${cap(folder, 200)}`) || !tryPush('')) break
    for (const n of byFolder.get(folder)!) {
      const summary = cap(firstProseLine(n.body ?? ''), 80)
      const links = [
        ...new Set(
          [...(n.body ?? '').matchAll(WIKILINK)].map((m) =>
            cap(m[1].trim(), 80),
          ),
        ),
      ].slice(0, MAP_MAX_LINKS_PER_NOTE)
      const linkHint = links.length ? ` -> ${links.join(', ')}` : ''
      const line = `- [[${cap(n.path, 200)}]]${summary ? ` - ${summary}` : ''}${linkHint}`
      if (!tryPush(line)) break outer
    }
    if (!tryPush('')) break
  }

  let body = out.join('\n').trimEnd() + '\n'
  if (truncated) body += TRUNC
  return body
}

export async function regenerateMap(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<
  | 'written'
  | 'skipped-not-agent-owned'
  | 'skipped-ambiguous-map'
  | 'skipped-overflow'
  | 'skipped-locked'
> {
  const existingRows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', MAP_PATH),
    )
    .take(2)
  if (existingRows.length > 1) return 'skipped-ambiguous-map'
  const existing = existingRows[0]
  if (existing && existing.source !== 'agent') {
    return 'skipped-not-agent-owned'
  }
  if (existing?.systemLocked || existing?.userLocked) {
    return 'skipped-locked'
  }
  const loaded = await loadNotes(ctx, workspaceId)
  if (loaded.overflow) return 'skipped-overflow'
  const body = await seedAtomIdIntoBody(
    ctx,
    workspaceId,
    MAP_PATH,
    buildMapBody(loaded.notes),
  )
  const updatedAt = Date.now()
  if (existing) {
    await ctx.db.patch(existing._id, {
      body,
      updatedAt,
      source: 'agent',
      ...deriveSearchFields(MAP_PATH, body),
    })
    await reconcileAtomIdIndex(ctx, workspaceId, MAP_PATH, body, {
      isRestore: false,
    })
  } else {
    const id = await ctx.db.insert('atoms', {
      workspaceId,
      path: MAP_PATH,
      body,
      updatedAt,
      source: 'agent',
      ...deriveSearchFields(MAP_PATH, body),
    })
    await reconcileAtomIdIndex(ctx, workspaceId, MAP_PATH, body, {
      isRestore: false,
    })
  }
  return 'written'
}

async function regenerateMapForWorkspace(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<{ mapRegen: Awaited<ReturnType<typeof regenerateMap>> }> {
  return { mapRegen: await regenerateMap(ctx, workspaceId) }
}

export const _regenerateMapForWorkspace = internalMutation({
  args: { workspaceId: v.string() },
  handler: (ctx, { workspaceId }) => regenerateMapForWorkspace(ctx, workspaceId),
})

export const REGEN_DEBOUNCE_MS = 2_000

export async function scheduleMapRegen(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<void> {
  const existing = await ctx.db
    .query('mapRegenSchedule')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .unique()
  const now = Date.now()
  if (existing && existing.scheduledFor > now) return

  if (existing && existing.scheduledJobId) {
    try {
      await ctx.scheduler.cancel(existing.scheduledJobId)
    } catch {
      /* already fired or cancelled */
    }
  }

  const scheduledFor = now + REGEN_DEBOUNCE_MS
  const jobId = await ctx.scheduler.runAfter(
    REGEN_DEBOUNCE_MS,
    internal.map._regenerateMapDebounced,
    { workspaceId },
  )
  if (existing) {
    await ctx.db.patch(existing._id, { scheduledFor, scheduledJobId: jobId })
  } else {
    await ctx.db.insert('mapRegenSchedule', {
      workspaceId,
      scheduledFor,
      scheduledJobId: jobId,
    })
  }
}

export const _regenerateMapDebounced = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const row = await ctx.db
      .query('mapRegenSchedule')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .unique()
    if (!row) return
    await ctx.db.delete(row._id)
    return await regenerateMapForWorkspace(ctx, workspaceId)
  },
})
