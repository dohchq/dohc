/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerAgentComponent } from '@convex-dev/agent/test'
import { afterEach, describe, it, expect, vi } from 'vitest'
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

const convexAgentTest = () => {
  const t = convexTest(schema, modules)
  registerAgentComponent(t)
  return t
}

afterEach(() => {
  vi.unstubAllEnvs()
})

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

  it('listThreads includes each chat thread model selection', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 't-model',
        title: 'Model test',
        agentProviderId: 'openai',
        agentModel: 'gpt-5.5',
        agentReasoningEffort: 'medium',
        updatedAt: 10,
      })
    })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})

    expect(rows[0]).toMatchObject({
      threadId: 't-model',
      agentProviderId: 'openai',
      agentModel: 'gpt-5.5',
      agentReasoningEffort: 'medium',
    })
  })

  it('listThreads includes each chat thread access mode', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 't-access',
        title: 'Access test',
        agentAccessMode: 'auto-review',
        updatedAt: 10,
      })
    })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})

    expect(rows[0]).toMatchObject({
      threadId: 't-access',
      agentAccessMode: 'auto-review',
    })
  })

  it('_setThreadAgentAccessMode updates only caller-owned threadRefs', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)

    await t
      .withIdentity({ subject: A })
      .mutation(internal.agent._setThreadAgentAccessMode, {
        threadId: 'tA',
        agentAccessMode: 'full-access',
      })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.find((row) => row.threadId === 'tA')).toMatchObject({
      agentAccessMode: 'full-access',
    })
    await expect(
      t
        .withIdentity({ subject: A })
        .mutation(internal.agent._setThreadAgentAccessMode, {
          threadId: 'tB',
          agentAccessMode: 'auto-review',
        }),
    ).rejects.toThrow(/thread does not belong to this workspace/)
    await expect(
      t
        .withIdentity({ subject: B })
        .mutation(internal.agent._setThreadAgentAccessMode, {
          activeWorkspaceId: A,
          threadId: 'tA',
          agentAccessMode: 'auto-review',
        }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('_resolveAgentAccessModeForThread preserves stored mode unless request overrides it', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 't-access',
        agentAccessMode: 'auto-review',
        updatedAt: 10,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 't-default',
        updatedAt: 20,
      })
    })
    const asA = t.withIdentity({ subject: A })

    await expect(
      asA.query(internal.agent._resolveAgentAccessModeForThread, {
        threadId: 't-access',
      }),
    ).resolves.toBe('auto-review')
    await expect(
      asA.query(internal.agent._resolveAgentAccessModeForThread, {
        threadId: 't-access',
        agentAccessMode: 'full-access',
      }),
    ).resolves.toBe('full-access')
    await expect(
      asA.query(internal.agent._resolveAgentAccessModeForThread, {
        threadId: 't-access',
        agentAccessMode: 'default',
      }),
    ).resolves.toBe('default')
    await expect(
      asA.query(internal.agent._resolveAgentAccessModeForThread, {
        threadId: 't-default',
      }),
    ).resolves.toBe('default')
    await expect(
      t
        .withIdentity({ subject: B })
        .query(internal.agent._resolveAgentAccessModeForThread, {
          activeWorkspaceId: A,
          threadId: 't-access',
        }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('setAgentWorkspaceDefault validates and stores the workspace default model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    const t = convexTest(schema, modules)

    await t.withIdentity({ subject: A }).mutation(api.agent.setAgentWorkspaceDefault, {
      agentProviderId: 'openai',
      agentModel: 'gpt-5.5',
      agentReasoningEffort: 'high',
    })

    const providers = await t
      .withIdentity({ subject: A })
      .query(api.agent.listAgentProviders, {})

    expect(providers.workspaceDefault).toMatchObject({
      providerId: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })
    expect(providers.effectiveDefault).toMatchObject({
      providerId: 'openai',
      model: 'gpt-5.5',
    })
  })

  it('setAgentWorkspaceDefault stores non-reasoning models without a reasoning field', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
    const t = convexTest(schema, modules)

    await t.withIdentity({ subject: A }).mutation(api.agent.setAgentWorkspaceDefault, {
      agentProviderId: 'openai',
      agentModel: 'gpt-5.5',
      agentReasoningEffort: 'high',
    })
    await t.withIdentity({ subject: A }).mutation(api.agent.setAgentWorkspaceDefault, {
      agentProviderId: 'anthropic',
      agentModel: 'claude-haiku-4-5',
    })

    const settings = await t.run(async (ctx) =>
      await ctx.db
        .query('workspaceSettings')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .first(),
    )
    expect(settings).toMatchObject({
      workspaceId: A,
      agentProviderId: 'anthropic',
      agentModel: 'claude-haiku-4-5',
    })
    expect(settings).not.toHaveProperty('agentReasoningEffort')

    const providers = await t
      .withIdentity({ subject: A })
      .query(api.agent.listAgentProviders, {})

    expect(providers.workspaceDefault).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    })
    expect(providers.effectiveDefault).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('listThreads does not drop visible chats after many internal threadRefs', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert('threadRefs', {
          workspaceId: A,
          threadId: `internal-${i}`,
          projectPath: `.internal/${i}`,
          title: `Internal ${i}`,
          updatedAt: i,
        })
      }
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 'visible-project-chat',
        projectPath: 'dohc',
        title: 'Visible project chat',
        updatedAt: 999,
      })
    })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows.map((r) => r.threadId)).toEqual(['visible-project-chat'])
    expect(rows[0]).toMatchObject({
      projectPath: 'dohc',
      title: 'Visible project chat',
    })
  })

  it('listThreads returns a bounded recent page for large chat histories', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let i = 0; i < 90; i++) {
        await ctx.db.insert('threadRefs', {
          workspaceId: A,
          threadId: `visible-${i}`,
          projectPath: i % 2 === 0 ? 'dohc' : undefined,
          title: `Visible ${i}`,
          updatedAt: 1_000 + i,
        })
      }
    })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows).toHaveLength(80)
    expect(rows.at(0)).toMatchObject({
      threadId: 'visible-89',
      title: 'Visible 89',
    })
    expect(rows.at(-1)).toMatchObject({
      threadId: 'visible-10',
      title: 'Visible 10',
    })
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

  it('renameProjectAndMoveFolder moves matching folder state and chat scopes in one mutation', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('folders', {
        workspaceId: A,
        path: 'dohc',
        createdAt: 1,
      })
      await ctx.db.insert('folders', {
        workspaceId: A,
        path: 'dohc/research',
        createdAt: 2,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 'project-thread',
        projectPath: 'dohc',
        title: 'dohc chat',
        updatedAt: 10,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 'research-thread',
        projectPath: 'dohc/research',
        title: 'dohc/research chat',
        updatedAt: 11,
      })
    })

    await t
      .withIdentity({ subject: A })
      .mutation(api.agent.renameProjectAndMoveFolder, {
        fromProjectPath: 'dohc',
        toProjectPath: 'product',
      })

    const folders = await t.run((ctx) =>
      ctx.db
        .query('folders')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .collect(),
    )
    expect(folders.map((folder) => folder.path).sort()).toEqual([
      'product',
      'product/research',
    ])
    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: 'project-thread',
          projectPath: 'product',
          title: 'product chat',
        }),
        expect.objectContaining({
          threadId: 'research-thread',
          projectPath: 'product/research',
          title: 'product/research chat',
        }),
      ]),
    )
  })

  it('renameProject reaches project rows beyond a large workspace history', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert('threadRefs', {
          workspaceId: A,
          threadId: `archive-${i}`,
          projectPath: `.archive/${i}`,
          updatedAt: i,
        })
      }
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 'deep-project',
        projectPath: 'dohc/research',
        updatedAt: 999,
      })
    })

    await t.withIdentity({ subject: A }).mutation(api.agent.renameProject, {
      fromProjectPath: 'dohc/research',
      toProjectPath: 'dohc',
    })

    const rows = await t
      .withIdentity({ subject: A })
      .query(api.agent.listThreads, {})
    expect(rows).toEqual([
      expect.objectContaining({
        threadId: 'deep-project',
        projectPath: 'dohc',
        title: 'dohc chat',
      }),
    ])
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

  it('stopChat DENIES stopping a thread the caller does not own', async () => {
    const t = convexTest(schema, modules)
    await seedThreads(t)
    await expect(
      t
        .withIdentity({ subject: A })
        .action(api.agent.stopChat, { threadId: 'tB' }),
    ).rejects.toThrow(/does not belong/)
  })

  it('stopChat is a no-op for an owned thread with no active streams', async () => {
    const t = convexAgentTest()
    const threadId = await t
      .withIdentity({ subject: A })
      .mutation(api.agent.createThread, {})
    await expect(
      t
        .withIdentity({ subject: A })
        .action(api.agent.stopChat, { threadId }),
    ).resolves.toEqual({ aborted: 0 })
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
