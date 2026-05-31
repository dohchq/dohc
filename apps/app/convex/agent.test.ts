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

describe('createThread — new multi-history chat creation', () => {
  it('creates a workspace-scoped thread without a project path', async () => {
    const t = convexTest(schema, modules)
    const threadId = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, {})
    expect(typeof threadId).toBe('string')
    expect(threadId.length).toBeGreaterThan(0)

    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      threadId,
      projectPath: null,
      title: 'Workspace chat',
    })
  })

  it('creates a project-scoped thread with a provided title', async () => {
    const t = convexTest(schema, modules)
    const threadId = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, {
        projectPath: 'myproject',
        title: 'Sprint planning',
      })
    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows[0]).toMatchObject({
      threadId,
      projectPath: 'myproject',
      title: 'Sprint planning',
    })
  })

  it('rejects project paths with internal (dot-prefixed) segments', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t
        .withIdentity({ subject: 'ws_c' })
        .mutation(api.agent.createThread, {
          projectPath: '.context',
        }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('strips leading/trailing slashes from the project path', async () => {
    const t = convexTest(schema, modules)
    const threadId = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, {
        projectPath: '/dohc/',
      })
    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows[0]).toMatchObject({ threadId, projectPath: 'dohc' })
  })

  it('truncates an overly long title to 80 characters', async () => {
    const t = convexTest(schema, modules)
    const longTitle = 'A'.repeat(120)
    const threadId = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, { title: longTitle })
    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toHaveLength(80)
    expect(rows[0].threadId).toBe(threadId)
  })

  it('uses a fallback title derived from projectPath when none is provided', async () => {
    const t = convexTest(schema, modules)
    await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, { projectPath: 'research' })
    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toBe('research chat')
  })

  it('multiple createThread calls create multiple independent threads', async () => {
    const t = convexTest(schema, modules)
    const id1 = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, { title: 'Thread 1' })
    const id2 = await t
      .withIdentity({ subject: 'ws_c' })
      .mutation(api.agent.createThread, { title: 'Thread 2' })
    expect(id1).not.toBe(id2)
    const rows = await t
      .withIdentity({ subject: 'ws_c' })
      .query(api.agent.listThreads, {})
    expect(rows).toHaveLength(2)
  })

  it('unauthenticated createThread throws', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.agent.createThread, {}),
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe('ensureThread — project-scoped chat session', () => {
  it('creates a new thread when none exists for the projectPath', async () => {
    const t = convexTest(schema, modules)
    const threadId = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'dohc' })
    expect(typeof threadId).toBe('string')
    const rows = await t
      .withIdentity({ subject: 'ws_e' })
      .query(api.agent.listThreads, {})
    expect(rows[0]).toMatchObject({ threadId, projectPath: 'dohc' })
  })

  it('returns the existing thread for the same projectPath on repeated calls', async () => {
    const t = convexTest(schema, modules)
    const id1 = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'dohc' })
    const id2 = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'dohc' })
    expect(id1).toBe(id2)
  })

  it('creates separate threads for different project paths', async () => {
    const t = convexTest(schema, modules)
    const idA = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'project-a' })
    const idB = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'project-b' })
    expect(idA).not.toBe(idB)
  })

  it('rejects internal project paths (dot-segment)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t
        .withIdentity({ subject: 'ws_e' })
        .mutation(api.agent.ensureThread, { projectPath: '.runs' }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('workspace-scoped ensureThread (null project) and project-scoped are separate threads', async () => {
    const t = convexTest(schema, modules)
    const wsThread = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, {})
    const projThread = await t
      .withIdentity({ subject: 'ws_e' })
      .mutation(api.agent.ensureThread, { projectPath: 'research' })
    expect(wsThread).not.toBe(projThread)
  })
})

describe('_touchThread — updatedAt and title update', () => {
  it('updates updatedAt on an existing threadRef', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_d',
        threadId: 'td1',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.agent._touchThread, {
      workspaceId: 'ws_d',
      threadId: 'td1',
    })
    const rows = await t
      .withIdentity({ subject: 'ws_d' })
      .query(api.agent.listThreads, {})
    expect(rows[0].updatedAt).toBeGreaterThan(1)
  })

  it('sets title from first non-empty line of titleHint when row has fallback title', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_d',
        threadId: 'td2',
        title: 'Workspace chat', // fallback title
        updatedAt: 1,
      })
    })
    await t.mutation(internal.agent._touchThread, {
      workspaceId: 'ws_d',
      threadId: 'td2',
      titleHint: 'Help me plan the sprint\nMore context here',
    })
    const rows = await t
      .withIdentity({ subject: 'ws_d' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toBe('Help me plan the sprint')
  })

  it('does not overwrite a user-set title with titleHint', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_d',
        threadId: 'td3',
        title: 'My custom title',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.agent._touchThread, {
      workspaceId: 'ws_d',
      threadId: 'td3',
      titleHint: 'New hint that should not overwrite',
    })
    const rows = await t
      .withIdentity({ subject: 'ws_d' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toBe('My custom title')
  })

  it('is a no-op when the threadRef does not exist', async () => {
    const t = convexTest(schema, modules)
    // Should not throw even if no rows match
    await expect(
      t.mutation(internal.agent._touchThread, {
        workspaceId: 'ws_d',
        threadId: 'nonexistent',
        titleHint: 'Some hint',
      }),
    ).resolves.not.toThrow()
  })

  it('truncates titleHint to 80 characters', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_d',
        threadId: 'td4',
        title: 'Workspace chat', // fallback title
        updatedAt: 1,
      })
    })
    const longHint = 'X'.repeat(100)
    await t.mutation(internal.agent._touchThread, {
      workspaceId: 'ws_d',
      threadId: 'td4',
      titleHint: longHint,
    })
    const rows = await t
      .withIdentity({ subject: 'ws_d' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title?.length).toBeLessThanOrEqual(80)
  })
})

describe('listThreads — sorting and filtering', () => {
  it('sorts pinned threads above unpinned by pinnedAt descending', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts1',
        title: 'First pinned',
        updatedAt: 100,
        pinnedAt: 200,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts2',
        title: 'Second pinned',
        updatedAt: 100,
        pinnedAt: 300,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts3',
        title: 'Unpinned',
        updatedAt: 999,
      })
    })
    const rows = await t
      .withIdentity({ subject: 'ws_s' })
      .query(api.agent.listThreads, {})
    // pinned threads first (higher pinnedAt first), then unpinned
    expect(rows[0].threadId).toBe('ts2')
    expect(rows[1].threadId).toBe('ts1')
    expect(rows[2].threadId).toBe('ts3')
  })

  it('uses fallback title when row has no title set', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts-notitle',
        projectPath: 'myproject',
        updatedAt: 100,
      })
    })
    const rows = await t
      .withIdentity({ subject: 'ws_s' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toBe('myproject chat')
  })

  it('filters out internal project paths from the listing', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts-visible',
        title: 'Normal chat',
        updatedAt: 100,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts-internal',
        projectPath: '.context',
        title: 'Internal chat',
        updatedAt: 200,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts-runs',
        projectPath: '.runs',
        title: 'Runs chat',
        updatedAt: 300,
      })
    })
    const rows = await t
      .withIdentity({ subject: 'ws_s' })
      .query(api.agent.listThreads, {})
    expect(rows.map((r) => r.threadId)).toEqual(['ts-visible'])
  })

  it('returns pinnedAt as null for unpinned threads', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_s',
        threadId: 'ts-nopinned',
        updatedAt: 100,
      })
    })
    const rows = await t
      .withIdentity({ subject: 'ws_s' })
      .query(api.agent.listThreads, {})
    expect(rows[0].pinnedAt).toBe(null)
  })
})

describe('renameThread — edge cases', () => {
  it('throws on empty or whitespace-only title', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.renameThread, {
        threadId: 'tA',
        title: '   ',
      }),
    ).rejects.toThrow(/chat title required/)
  })

  it('normalizes excess whitespace in titles', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await t
      .withIdentity({ subject: 'ws_a' })
      .mutation(api.agent.renameThread, {
        threadId: 'tA',
        title: '  Multi   Word   Title  ',
      })
    const rows = await t
      .withIdentity({ subject: 'ws_a' })
      .query(api.agent.listThreads, {})
    expect(rows.find((r) => r.threadId === 'tA')?.title).toBe('Multi Word Title')
  })
})

describe('renameProject — edge cases', () => {
  it('does nothing when from and to paths are the same after normalization', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    // Should not throw
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.renameProject, {
        fromProjectPath: 'dohc/research',
        toProjectPath: 'dohc/research',
      }),
    ).resolves.not.toThrow()
    // Row unchanged
    const rows = await t
      .withIdentity({ subject: 'ws_a' })
      .query(api.agent.listThreads, {})
    expect(
      rows.find((r) => r.threadId === 'tA-dohc')?.projectPath,
    ).toBe('dohc/research')
  })

  it('throws when the from project does not exist in this workspace', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.renameProject, {
        fromProjectPath: 'nonexistent',
        toProjectPath: 'some-new-path',
      }),
    ).rejects.toThrow(/project does not exist/)
  })

  it('rejects when from path is internal', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.renameProject, {
        fromProjectPath: '.context',
        toProjectPath: 'dohc',
      }),
    ).rejects.toThrow(/Internal folders/)
  })

  it('updates fallback title to match new project path', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_f',
        threadId: 'tf1',
        projectPath: 'old-path',
        title: 'old-path chat', // fallback-style title
        updatedAt: 100,
      })
    })
    await t
      .withIdentity({ subject: 'ws_f' })
      .mutation(api.agent.renameProject, {
        fromProjectPath: 'old-path',
        toProjectPath: 'new-path',
      })
    const rows = await t
      .withIdentity({ subject: 'ws_f' })
      .query(api.agent.listThreads, {})
    expect(rows[0].projectPath).toBe('new-path')
    expect(rows[0].title).toBe('new-path chat')
  })

  it('preserves user-set title when renaming project path', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_f',
        threadId: 'tf2',
        projectPath: 'old-path',
        title: 'My custom title', // user-set title
        updatedAt: 100,
      })
    })
    await t
      .withIdentity({ subject: 'ws_f' })
      .mutation(api.agent.renameProject, {
        fromProjectPath: 'old-path',
        toProjectPath: 'new-path',
      })
    const rows = await t
      .withIdentity({ subject: 'ws_f' })
      .query(api.agent.listThreads, {})
    expect(rows[0].title).toBe('My custom title')
  })
})

describe('setThreadPinned — access control', () => {
  it('throws when the thread does not belong to the caller workspace', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.setThreadPinned, {
        threadId: 'tB',
        pinned: true,
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('throws for a completely unknown threadId', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t.withIdentity({ subject: 'ws_a' }).mutation(api.agent.setThreadPinned, {
        threadId: 'totally-unknown',
        pinned: true,
      }),
    ).rejects.toThrow(/does not belong/)
  })
})
