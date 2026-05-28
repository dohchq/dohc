/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'
import { TRASH_RETENTION_MS } from './trash'
import { splitFrontmatter } from './atomId'

// Verifies the STRUCTURAL recoverability guarantee at the data layer:
// destructive ops snapshot before destroying; nothing is irrecoverable
// within retention. No model, no auth bypass — pure Convex behaviour.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'

const live = (t: ReturnType<typeof convexTest>, table: 'atoms' | 'folders' | 'entities') =>
  t.run(async (ctx) =>
    (await ctx.db.query(table).collect()).filter(
      (r: any) => r.workspaceId === W,
    ),
  )
const trashRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('trash').collect()).filter((r) => r.workspaceId === W),
  )

describe('atom delete is recoverable', () => {
  it('snapshots before destroying, then restores byte-faithfully', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'me.md',
        body: 'my profile',
        updatedAt: 1,
        source: 'user',
      })
    })
    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: W,
      path: 'me.md',
    })
    expect(await live(t, 'atoms')).toHaveLength(0) // gone from live
    const tr = await trashRows(t)
    expect(tr).toHaveLength(1)
    expect(tr[0]).toMatchObject({ kind: 'atom', ref: 'me.md' })

    const res = await t.mutation(internal.trash._restore, {
      workspaceId: W,
      trashId: tr[0]._id,
    })
    expect(res).toMatchObject({ ok: true })
    const back = await live(t, 'atoms')
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ path: 'me.md', body: 'my profile', source: 'user' })
    expect(await trashRows(t)).toHaveLength(0)
  })
})

describe('confirmed user-overwrite is recoverable', () => {
  it('snapshots the prior version before a confirmed overwrite', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'me.md',
        body: 'ORIGINAL user content',
        updatedAt: 1,
        source: 'user',
      })
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'me.md',
      body: 'replaced',
      source: 'agent',
      allowUserOverwrite: true,
    })
    const tr = await trashRows(t)
    expect(tr).toHaveLength(1)
    expect(tr[0].payload).toMatchObject({ body: 'ORIGINAL user content' })
  })
})

describe('recursive folder delete is fully recoverable', () => {
  it('every contained atom + folder is snapshotted', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('folders', { workspaceId: W, path: 'proj', createdAt: 1 })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'proj/a.md', body: 'A', updatedAt: 1, source: 'agent' })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'proj/b.md', body: 'B', updatedAt: 1, source: 'user' })
    })
    const r = await t.mutation(internal.folders._removeInternal, {
      workspaceId: W,
      path: 'proj',
    })
    expect(r).toMatchObject({ atomCount: 2, folderCount: 1 })
    expect(await live(t, 'atoms')).toHaveLength(0)
    expect(await live(t, 'folders')).toHaveLength(0)
    expect((await trashRows(t)).map((x) => x.kind).sort()).toEqual([
      'atom',
      'atom',
      'folder',
    ])
  })
})

describe('entity delete is recoverable', () => {
  it('snapshots + restores entity data', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', {
        workspaceId: W,
        type: 'client',
        slug: 'acme',
        data: { rate: 150 },
        updatedAt: 1,
      })
    })
    await t.mutation(internal.entities._delete, {
      workspaceId: W,
      type: 'client',
      slug: 'acme',
    })
    expect(await live(t, 'entities')).toHaveLength(0)
    const tr = await trashRows(t)
    expect(tr[0]).toMatchObject({ kind: 'entity', ref: 'client/acme' })
    await t.mutation(internal.trash._restore, { workspaceId: W, trashId: tr[0]._id })
    expect((await live(t, 'entities'))[0]).toMatchObject({
      slug: 'acme',
      data: { rate: 150 },
    })
  })
})

describe('restore never clobbers a live item', () => {
  it('refuses when a live row already exists at the key', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'x.md', body: 'old', updatedAt: 1, source: 'agent' })
    })
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'x.md' })
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'x.md', body: 'NEW live', updatedAt: 2, source: 'user' })
    })
    const tr = await trashRows(t)
    const res = await t.mutation(internal.trash._restore, {
      workspaceId: W,
      trashId: tr[0]._id,
    })
    expect(res).toMatchObject({ ok: false, reason: 'live-exists' })
    // the live row is untouched, the trash row is preserved (nothing lost)
    expect((await live(t, 'atoms'))[0]).toMatchObject({ body: 'NEW live' })
    expect(await trashRows(t)).toHaveLength(1)
  })
})

// The review's central point: the previous tests only hit the AGENT's
// internal mutations. These hit the PUBLIC mutations the user's UI
// actually calls (api.atoms.*) — the paths that used to bypass trash.
describe('PUBLIC UI mutations are recoverable (root-cause fix)', () => {
  const asUser = (t: ReturnType<typeof convexTest>) =>
    t.withIdentity({ subject: W })

  it('api.atoms.remove (UI delete) snapshots + is restorable', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'note.md', body: 'mine', updatedAt: 1, source: 'user' })
    })
    await asUser(t).mutation(api.atoms.remove, { path: 'note.md' })
    expect(await live(t, 'atoms')).toHaveLength(0)
    const tr = await trashRows(t)
    expect(tr).toHaveLength(1)
    expect(tr[0].payload).toMatchObject({ body: 'mine', source: 'user' })
  })

  it('api.atoms.upsert (editor fat-finger) snapshots the pre-edit body, coalesced', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'me.md', body: 'CAREFULLY WRITTEN PROFILE', updatedAt: 1, source: 'user' })
    })
    // fat-finger: select-all, type one char (the #1 real data-loss event)
    await asUser(t).mutation(api.atoms.upsert, { path: 'me.md', body: 'x', source: 'user' })
    const tr = await trashRows(t)
    expect(tr).toHaveLength(1)
    expect(tr[0].payload).toMatchObject({ body: 'CAREFULLY WRITTEN PROFILE' })
    // 3 more rapid auto-saves in the window → still ONE snapshot (coalesced)
    await asUser(t).mutation(api.atoms.upsert, { path: 'me.md', body: 'xy', source: 'user' })
    await asUser(t).mutation(api.atoms.upsert, { path: 'me.md', body: 'xyz', source: 'user' })
    expect(await trashRows(t)).toHaveLength(1)
    // and the original is recoverable
    const back = await t.mutation(internal.trash._restore, {
      workspaceId: W,
      trashId: (await trashRows(t))[0]._id,
    })
    expect(back).toMatchObject({ ok: false }) // live exists → won't clobber; row preserved
    expect((await trashRows(t))[0].payload).toMatchObject({ body: 'CAREFULLY WRITTEN PROFILE' })
  })

  it('api.atoms.move (UI rename) snapshots the source', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'old.md', body: 'content', updatedAt: 1, source: 'user' })
    })
    await asUser(t).mutation(api.atoms.move, { fromPath: 'old.md', toPath: 'new.md' })
    const paths = (await live(t, 'atoms')).map((a: any) => a.path)
    expect(paths).toEqual(['new.md']) // moved
    const tr = await trashRows(t)
    expect(tr.some((x) => x.payload?.body === 'content')).toBe(true) // source snapshotted
  })
})

describe('entity + folder-move overwrites are recoverable too', () => {
  it('entities._upsertMany snapshots prior data before overwrite', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: W, type: 'client', slug: 'acme', data: { rate: 150 }, updatedAt: 1 })
    })
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'client', slug: 'acme', data: { rate: 9999 } }],
    })
    const tr = (await trashRows(t)).filter((r) => r.kind === 'entity')
    expect(tr).toHaveLength(1)
    expect(tr[0].payload).toMatchObject({ data: { rate: 150 } }) // prior value recoverable
  })

  it('folder move snapshots in-place link-rewrite bodies', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('folders', { workspaceId: W, path: 'a', createdAt: 1 })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'a/x.md', body: 'hi', updatedAt: 1, source: 'user' })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'ref.md', body: 'see [[a/x]] here', updatedAt: 1, source: 'user' })
    })
    await t.withIdentity({ subject: W }).mutation(api.folders.move, {
      fromPath: 'a',
      toPath: 'b',
    })
    // ref.md's body was rewritten in place → its prior body is snapshotted
    const tr = await trashRows(t)
    expect(tr.some((x) => x.payload?.body === 'see [[a/x]] here')).toBe(true)
  })
})

describe('group-restore: a deleted folder comes back whole (item 1)', () => {
  it('restoreSubtree restores the folder + every child in one op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('folders', { workspaceId: W, path: 'proj', createdAt: 1 })
      await ctx.db.insert('folders', { workspaceId: W, path: 'proj/sub', createdAt: 1 })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'proj/a.md', body: 'A', updatedAt: 1, source: 'user' })
      await ctx.db.insert('atoms', { workspaceId: W, path: 'proj/sub/b.md', body: 'B', updatedAt: 1, source: 'user' })
    })
    await t.mutation(internal.folders._removeInternal, { workspaceId: W, path: 'proj' })
    expect(await live(t, 'atoms')).toHaveLength(0)
    expect(await live(t, 'folders')).toHaveLength(0)

    const res = await t.mutation(internal.trash._restoreSubtree, {
      workspaceId: W,
      folderPath: 'proj',
    })
    expect(res).toMatchObject({ done: true, skipped: 0 })
    expect(res.restored).toBe(4) // 2 folders + 2 atoms, one call
    const atomPaths = (await live(t, 'atoms')).map((a: any) => a.path).sort()
    expect(atomPaths).toEqual(['proj/a.md', 'proj/sub/b.md'])
    expect((await live(t, 'folders')).map((f: any) => f.path).sort()).toEqual(['proj', 'proj/sub'])
    expect(await trashRows(t)).toHaveLength(0)
  })
})

describe('_restore payload validation: fail loud, never silent (item 2)', () => {
  it('a corrupt atom payload returns corrupt-payload and PRESERVES the trash row', async () => {
    const t = convexTest(schema, modules)
    const id = await t.run(async (ctx) =>
      ctx.db.insert('trash', {
        workspaceId: W,
        kind: 'atom' as const,
        ref: 'bad',
        payload: { path: 'x.md' /* body missing */ },
        deletedAt: Date.now(),
      }),
    )
    const res = await t.mutation(internal.trash._restore, { workspaceId: W, trashId: id })
    expect(res).toEqual({ ok: false, reason: 'corrupt-payload' })
    expect(await trashRows(t)).toHaveLength(1) // not lost
    expect(await live(t, 'atoms')).toHaveLength(0) // no "undefined" atom written
  })

  it('a NON-CANONICAL entity payload is refused (Phase-3: 3rd entity-write chokepoint) and PRESERVES the trash row', async () => {
    const t = convexTest(schema, modules)
    const id = await t.run(async (ctx) =>
      ctx.db.insert('trash', {
        workspaceId: W,
        kind: 'entity' as const,
        ref: 'person/vip/alice',
        // legacy/pre-guard payload — "/" in type makes the capture
        // ref ambiguous → would re-open the cross-tenant fail-open
        payload: { type: 'person/vip', slug: 'alice', data: { hours: 6 } },
        deletedAt: Date.now(),
      }),
    )
    const res = await t.mutation(internal.trash._restore, { workspaceId: W, trashId: id })
    expect(res).toEqual({ ok: false, reason: 'non-canonical' })
    expect(await trashRows(t)).toHaveLength(1) // PRESERVED — not lost
    expect(await live(t, 'entities')).toHaveLength(0) // no leaky entity written
  })
})

describe('large recursive delete is batched + completes via scheduler (item 3)', () => {
  it('deletes 410 atoms across batches, all recoverable, none lost', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('folders', { workspaceId: W, path: 'big', createdAt: 1 })
      for (let i = 0; i < 410; i++) {
        await ctx.db.insert('atoms', { workspaceId: W, path: `big/n${i}.md`, body: `b${i}`, updatedAt: 1, source: 'agent' })
      }
    })
    // First pass: bounded batch, signals not-done. (Prod reschedules
    // via ctx.scheduler — the exact pattern _purgeExpired's passing
    // test proves. convex-test's auto-scheduler chaining is unreliable
    // for self-rescheduling mutations, so we drive the continuation
    // explicitly here to test the batching CONTRACT deterministically.)
    const first = await t.mutation(internal.folders._removeInternal, { workspaceId: W, path: 'big' })
    expect(first.done).toBe(false) // batch exhausted → would reschedule
    expect(first.atomCount).toBe(400) // DELETE_BATCH cap honored
    let guard = 0
    let done = first.done
    while (!done && guard++ < 10) {
      const next = await t.mutation(internal.folders._removeContinue, { workspaceId: W, path: 'big' })
      done = next.done
    }
    expect(done).toBe(true) // converges
    expect(await live(t, 'atoms')).toHaveLength(0) // every one gone
    const tr = await trashRows(t)
    expect(tr.filter((r) => r.kind === 'atom')).toHaveLength(410) // all recoverable, none lost
  })
})

describe('re-review holes closed', () => {
  it('entities._patch snapshots prior data', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: W, type: 'client', slug: 'acme', data: { rate: 150, terms: 'net-30' }, updatedAt: 1 })
    })
    await t.mutation(internal.entities._patch, {
      workspaceId: W,
      type: 'client',
      slug: 'acme',
      data: { rate: 0 }, // overwrites the rate key
    })
    const tr = (await trashRows(t)).filter((r) => r.kind === 'entity')
    expect(tr).toHaveLength(1)
    expect(tr[0].payload).toMatchObject({ data: { rate: 150, terms: 'net-30' } })
  })

  it('entity snapshot path coalesces rapid overwrites', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: W, type: 'e', slug: 's', data: { n: 0 }, updatedAt: 1 })
    })
    for (let i = 1; i <= 5; i++) {
      await t.mutation(internal.entities._patch, { workspaceId: W, type: 'e', slug: 's', data: { n: i } })
    }
    // 5 rapid overwrites in the window → ONE snapshot, not 5
    expect((await trashRows(t)).filter((r) => r.kind === 'entity')).toHaveLength(1)
  })

  it('agent/confirmed overwrite ALWAYS snapshots (not coalesced)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'me.md', body: 'V1', updatedAt: 1, source: 'user' })
    })
    await t.mutation(internal.atoms._upsertInternal, { workspaceId: W, path: 'me.md', body: 'V2', source: 'agent', allowUserOverwrite: true })
    await t.mutation(internal.atoms._upsertInternal, { workspaceId: W, path: 'me.md', body: 'V3', source: 'agent', allowUserOverwrite: true })
    // both prior versions preserved (V1 and V2) — agent path never
    // coalesces. atom-address-v1 §1.1: a snapshot taken after seeding
    // carries the seeded `id:`; this test asserts the no-coalesce
    // invariant (2 distinct prior versions kept), so compare on the
    // frontmatter-stripped content.
    const bodies = (await trashRows(t))
      .map((r: any) => splitFrontmatter(String(r.payload?.body ?? '')).rest)
      .sort()
    expect(bodies).toEqual(['V1', 'V2'])
  })

  it('_restoreSubtree is COMPLETE past the page size, even with lots of unrelated older trash', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      // 250 unrelated OLD trash rows (would fall in earlier pages)
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert('trash', { workspaceId: W, kind: 'atom' as const, ref: `junk/${i}.md`, payload: { path: `junk/${i}.md`, body: 'j', source: 'agent' }, deletedAt: 1000 + i })
      }
      // then a folder + 30 children deleted (newer)
      await ctx.db.insert('trash', { workspaceId: W, kind: 'folder' as const, ref: 'proj', payload: { path: 'proj' }, deletedAt: 9000 })
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert('trash', { workspaceId: W, kind: 'atom' as const, ref: `proj/a${i}.md`, payload: { path: `proj/a${i}.md`, body: `b${i}`, source: 'user' }, deletedAt: 9001 + i })
      }
    })
    // Drive the cursor continuation deterministically (convex-test's
    // auto-scheduler is unreliable; prod self-reschedules via
    // ctx.scheduler — same pattern as _purgeExpired's passing test).
    let cursor: string | null | undefined = undefined
    let guard = 0
    let done = false
    while (!done && guard++ < 20) {
      const r: any = await t.mutation(internal.trash._restoreSubtree, {
        workspaceId: W,
        folderPath: 'proj',
        cursor,
      })
      cursor = r.nextCursor
      done = r.done
    }
    expect(done).toBe(true)
    expect(await live(t, 'atoms')).toHaveLength(30) // all 30 children back, despite 250 unrelated rows in earlier pages
    expect((await live(t, 'folders')).map((f: any) => f.path)).toEqual(['proj'])
  })
})

describe('retention purge is bounded + correct', () => {
  it('purges only rows older than retention, keeps fresh ones', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    await t.run(async (ctx) => {
      await ctx.db.insert('trash', {
        workspaceId: W,
        kind: 'atom',
        ref: 'old',
        payload: {},
        deletedAt: now - TRASH_RETENTION_MS - 1000, // expired
      })
      await ctx.db.insert('trash', {
        workspaceId: W,
        kind: 'atom',
        ref: 'fresh',
        payload: {},
        deletedAt: now, // within retention
      })
    })
    const res = await t.mutation(internal.trash._purgeExpired, {})
    expect(res).toMatchObject({ purged: 1 })
    const remaining = await trashRows(t)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].ref).toBe('fresh')
  })
})
