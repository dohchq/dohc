/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

// file-org-v1 §3.1 (Track-4 D4.4a) — `api.atoms.list` projects
// systemLocked / userLocked / starred so the FileTree can render
// the lock + star affordances without an extra round-trip.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_list_projection'

describe('api.atoms.list — Track-4 flag projection', () => {
  it('projects systemLocked, userLocked, starred (defaults false)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'plain.md',
        body: 'x',
        updatedAt: Date.now(),
      })
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '_map.md',
        body: 'y',
        updatedAt: Date.now(),
        source: 'agent',
        systemLocked: true,
      })
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'me.md',
        body: 'z',
        updatedAt: Date.now(),
        source: 'user',
        userLocked: true,
        starred: true,
      })
    })
    const rows = await t.withIdentity({ subject: W }).query(api.atoms.list, {})
    const byPath = new Map(rows.map((r) => [r.path, r]))
    expect(byPath.get('plain.md')).toMatchObject({
      systemLocked: false,
      userLocked: false,
      starred: false,
    })
    expect(byPath.get('_map.md')).toMatchObject({
      systemLocked: true,
      userLocked: false,
      starred: false,
    })
    expect(byPath.get('me.md')).toMatchObject({
      systemLocked: false,
      userLocked: true,
      starred: true,
    })
  })
})
