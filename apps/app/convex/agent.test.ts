/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

// R1 / C1 + L8 — the agent chat thread is a cross-person surface
// OUTSIDE `windows`. tenancy-authz-v0.md §4 says there must be NO
// cross-person path except resolveWindow; the holistic review found
// sendMessage/listMessages took a client threadId with no ownership
// check (read another user's whole chat / inject into their thread).
// The §6 regex tripwire only covers `workspaceId` args — this
// behavioural test IS the control for resource-id ownership (same
// philosophy as the §6b contract: explicit test, not a regex proof).

const modules = import.meta.glob('./**/*.ts')
const A = 'ws_a'
const B = 'ws_b'

const seedThreads = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    await ctx.db.insert('threadRefs', {
      workspaceId: A,
      threadId: 'tA',
      updatedAt: 10,
    })
    await ctx.db.insert('threadRefs', {
      workspaceId: B,
      threadId: 'tB',
      updatedAt: 10,
    })
    await ctx.db.insert('threadRefs', {
      workspaceId: A,
      threadId: 'tA-dohc',
      projectPath: 'dohc/research',
      title: 'dohc planning',
      updatedAt: 20,
    })
    await ctx.db.insert('threadRefs', {
      workspaceId: A,
      threadId: 'tA-context',
      projectPath: '.context',
      title: '.context chat',
      updatedAt: 30,
    })
  })

describe('agent thread ownership — fail-closed (C1)', () => {
  it('_assertOwnThread: true ONLY for the caller’s own thread', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const check = (workspaceId: string, threadId: string) =>
      t.query(internal.agent._assertOwnThread, { workspaceId, threadId })
    expect(await check(A, 'tA')).toBe(true)
    expect(await check(A, 'tB')).toBe(false) // another user's thread
    expect(await check(B, 'tA')).toBe(false)
    expect(await check(A, 'guessed')).toBe(false) // forged/guessed id
    expect(await check('ws_nomap', 'tA')).toBe(false) // no threadRefs row
  })

  it('_assertOwnThread: project scope is exact when supplied', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const check = (
      workspaceId: string,
      threadId: string,
      projectPath: string | null,
    ) =>
      t.query(internal.agent._assertOwnThread, {
        workspaceId,
        threadId,
        projectPath,
      })
    expect(await check(A, 'tA', null)).toBe(true)
    expect(await check(A, 'tA', 'dohc/research')).toBe(false)
    expect(await check(A, 'tA-dohc', 'dohc')).toBe(false)
    expect(await check(A, 'tA-dohc', 'dohc/research')).toBe(true)
    expect(await check(A, 'tA-dohc', 'opnft-fun')).toBe(false)
    expect(await check(B, 'tA-dohc', 'dohc/research')).toBe(false)
  })

  it('listThreads returns real workspace chat history grouped by project path', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.map((r) => r.threadId)).toEqual(['tA-dohc', 'tA'])
    expect(rows[0]).toMatchObject({
      threadId: 'tA-dohc',
      projectPath: 'dohc/research',
      title: 'dohc planning',
    })
    expect(rows[1]).toMatchObject({
      threadId: 'tA',
      projectPath: null,
    })
    expect(rows.some((r) => r.threadId === 'tB')).toBe(false)
    expect(rows.some((r) => r.threadId === 'tA-context')).toBe(false)
  })

  it('setThreadPinned moves a chat to the top without changing ownership', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.setThreadPinned, {
        threadId: 'tA',
        pinned: true,
      })
    let rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows[0].threadId).toBe('tA')
    expect(typeof rows[0].pinnedAt).toBe('number')

    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.setThreadPinned, {
        threadId: 'tA',
        pinned: false,
      })
    rows = await t.withIdentity({ subject: A }).query(api.agent.listThreads, {})
    expect(rows[0].threadId).toBe('tA-dohc')
    expect(rows.find((r) => r.threadId === 'tA')?.pinnedAt).toBe(null)
  })

  it('deleteThread removes only a thread owned by the caller workspace', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.deleteThread, {
        threadId: 'tA-dohc',
      })
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.some((r) => r.threadId === 'tA-dohc')).toBe(false)
    expect(rows.some((r) => r.threadId === 'tA')).toBe(true)

    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.deleteThread, {
        threadId: 'tB',
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('renameThread updates only the caller-owned chat title', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.renameThread, {
        threadId: 'tA-dohc',
        title: 'Research cockpit',
      })
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.find((r) => r.threadId === 'tA-dohc')?.title).toBe(
      'Research cockpit',
    )

    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.renameThread, {
        threadId: 'tB',
        title: 'Nope',
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('renameProject retargets caller-owned project chat scopes without exposing internal folders', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.renameProject, {
        fromProjectPath: 'dohc/research',
        toProjectPath: 'dohc',
      })
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.find((r) => r.threadId === 'tA-dohc')?.projectPath).toBe(
      'dohc',
    )

    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.renameProject, {
        fromProjectPath: 'dohc',
        toProjectPath: '.context',
      }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('listMessages DENIES a thread the caller does not own', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t
        .withIdentity({ subject: A })
        .query(api.agent.listMessages, {
          threadId: 'tB', // B's thread — A must NOT read it
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ).rejects.toThrow(/does not belong/)
  })

  it('listMessages DENIES a guessed/unknown thread id', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t
        .withIdentity({ subject: A })
        .query(api.agent.listMessages, {
          threadId: 'totally-made-up',
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ).rejects.toThrow(/does not belong/)
  })

  it('listMessages DENIES a valid same-workspace thread under the wrong project scope', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t
        .withIdentity({ subject: A })
        .query(api.agent.listMessages, {
          threadId: 'tA-dohc',
          projectPath: 'opnft-fun',
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ).rejects.toThrow(/does not belong/)
  })

  it('sendMessage DENIES injecting into a thread the caller does not own', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    // gate throws BEFORE streamText, so the agent component is never
    // reached — a valid deny-path test.
    await expect(
      t
        .withIdentity({ subject: A })
        .action(api.agent.sendMessage, { threadId: 'tB', prompt: 'pwn' }),
    ).rejects.toThrow(/does not belong/)
  })

  it('multiple threadRefs for one workspace are legitimate chat history; cross-tenant stays denied', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', { workspaceId: A, threadId: 'tA1' })
      await ctx.db.insert('threadRefs', { workspaceId: A, threadId: 'tA2' })
    })
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: A,
        threadId: 'tA1',
      }),
    ).toBe(true)
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: A,
        threadId: 'tA2',
      }),
    ).toBe(true)
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: A,
        threadId: 'tB-foreign',
      }),
    ).toBe(false)
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: 'ws_other',
        threadId: 'tA1',
      }),
    ).toBe(false)
  })

  it('unauthenticated listMessages throws (no anonymous thread read)', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.query(api.agent.listMessages, {
        threadId: 'tA',
        paginationOpts: { numItems: 5, cursor: null },
      }),
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe('agent thread project scoping — ensureThread + createThread (C1 extended)', () => {
  it('ensureThread rejects internal project paths (dot-prefixed folders)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.ensureThread, {
        projectPath: '.context',
      }),
    ).rejects.toThrow(/Internal folders/)
    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.ensureThread, {
        projectPath: '.runs/archive',
      }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('ensureThread returns the most recent thread for the same projectPath', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const returned = await t
      .withIdentity({ subject: A })
      .mutation(api.agent.ensureThread, {
        projectPath: 'dohc/research',
      })
    expect(returned).toBe('tA-dohc')
  })

  it('ensureThread with no projectPath returns the most recent no-project thread', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const returned = await t
      .withIdentity({ subject: A })
      .mutation(api.agent.ensureThread, {})
    expect(returned).toBe('tA')
  })

  it('createThread rejects internal project paths', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.withIdentity({ subject: A }).mutation(api.agent.createThread, {
        projectPath: '.context',
      }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('createThread always creates a new thread (never reuses existing)', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const newId = await t
      .withIdentity({ subject: A })
      .mutation(api.agent.createThread, {
        projectPath: 'dohc/research',
        title: 'Second research chat',
      })
    expect(newId).toBeDefined()
    expect(newId).not.toBe('tA-dohc')
    // Both the original and the new thread should appear in the list
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    const researchThreads = rows.filter((r) => r.projectPath === 'dohc/research')
    expect(researchThreads.length).toBe(2)
  })

  it('createThread uses the supplied title, truncating to 80 chars', async () => {
    const t = convexTest(schema, modules)
    const longTitle = 'A'.repeat(120)
    const newId = await t
      .withIdentity({ subject: A })
      .mutation(api.agent.createThread, {
        title: longTitle,
      })
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    const created = rows.find((r) => r.threadId === newId)
    expect(created?.title.length).toBeLessThanOrEqual(80)
  })

  it('listThreads excludes threads scoped to internal folders', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    // tA-context has projectPath '.context' which is an internal path — must be excluded
    expect(rows.some((r) => r.threadId === 'tA-context')).toBe(false)
  })

  it('listThreads returns correct shape for each row', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    for (const row of rows) {
      expect(typeof row.threadId).toBe('string')
      expect(typeof row.title).toBe('string')
      expect(typeof row.updatedAt).toBe('number')
      expect(row.pinnedAt === null || typeof row.pinnedAt === 'number').toBe(true)
      expect(row.projectPath === null || typeof row.projectPath === 'string').toBe(true)
    }
  })
})
