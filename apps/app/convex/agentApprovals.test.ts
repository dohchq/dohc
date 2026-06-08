/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_agent_approvals_alice'
const BOB = 'ws_agent_approvals_bob'
const THREAD = 'thread_agent_approval_1'

async function seedThread(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  threadId = THREAD,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('threadRefs', {
      workspaceId,
      threadId,
      title: 'Approval thread',
      updatedAt: Date.now(),
    })
  })
}

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Approval Org' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

describe('agent approval requests', () => {
  it('turns a pending delete_atom approval into a server-side button decision', async () => {
    const t = convexTest(schema, modules)
    const asAlice = t.withIdentity({ subject: ALICE })
    await seedThread(t, ALICE)
    await asAlice.mutation(api.atoms.upsert, {
      path: '.runs/setup.md',
      body: '# Setup Run\n\nold',
    })

    const created = (await t.mutation((internal as any).agent._requestApproval, {
      workspaceId: ALICE,
      threadId: THREAD,
      createdByUserId: ALICE,
      operation: 'delete_atom',
      title: 'Delete .runs/setup.md',
      detail: 'Delete .runs/setup.md so the setup run can be recreated.',
      targetPaths: ['.runs/setup.md'],
      args: { path: '.runs/setup.md' },
    })) as { status: 'pending'; approvalId: string }

    const pending = await asAlice.query((api as any).agent.listPendingApprovals, {
      threadId: THREAD,
    })
    expect(pending).toEqual([
      expect.objectContaining({
        _id: created.approvalId,
        operation: 'delete_atom',
        title: 'Delete .runs/setup.md',
        targetPaths: ['.runs/setup.md'],
      }),
    ])

    const result = await asAlice.mutation((api as any).agent.respondToApproval, {
      approvalId: created.approvalId,
      decision: 'allow_once',
    })
    expect(result).toEqual(
      expect.objectContaining({
        status: 'approved',
        decision: 'allow_once',
        result: 'deleted .runs/setup.md',
      }),
    )
    expect(result.resumePrompt).toContain('The user clicked Allow')
    expect(result.resumePrompt).toContain('delete_atom')
    expect(result.resumePrompt).toContain('.runs/setup.md')
    expect(result.resumePrompt).toContain('Continue from where you paused')
    expect(result.resumeDisplayText).toBe('Approved: Delete .runs/setup.md')

    const gone = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', ALICE).eq('path', '.runs/setup.md'),
        )
        .unique(),
    )
    expect(gone).toBeNull()
    expect(
      await asAlice.query((api as any).agent.listPendingApprovals, {
        threadId: THREAD,
      }),
    ).toEqual([])
  })

  it('keeps denial side-effect free', async () => {
    const t = convexTest(schema, modules)
    const asAlice = t.withIdentity({ subject: ALICE })
    await seedThread(t, ALICE)
    await asAlice.mutation(api.atoms.upsert, {
      path: 'finance/.apps/tracker/old.md',
      body: 'superseded',
    })

    const created = (await t.mutation((internal as any).agent._requestApproval, {
      workspaceId: ALICE,
      threadId: THREAD,
      createdByUserId: ALICE,
      operation: 'delete_atom',
      title: 'Delete superseded file',
      detail: 'Delete finance/.apps/tracker/old.md.',
      targetPaths: ['finance/.apps/tracker/old.md'],
      args: { path: 'finance/.apps/tracker/old.md' },
    })) as { approvalId: string }

    const result = await asAlice.mutation((api as any).agent.respondToApproval, {
      approvalId: created.approvalId,
      decision: 'deny',
    })
    expect(result).toEqual(
      expect.objectContaining({
        status: 'denied',
        decision: 'deny',
      }),
    )
    expect(result).not.toHaveProperty('resumePrompt')

    const stillThere = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q
            .eq('workspaceId', ALICE)
            .eq('path', 'finance/.apps/tracker/old.md'),
        )
        .unique(),
    )
    expect(stillThere?.body).toContain('superseded')
  })

  it('does not let another org member list or answer a request created for this user', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await seedThread(t, orgId)

    const created = (await t.mutation((internal as any).agent._requestApproval, {
      workspaceId: orgId,
      threadId: THREAD,
      createdByUserId: ALICE,
      operation: 'delete_folder',
      title: 'Delete old tracker',
      detail: 'Delete finance/.apps/tracker and nested files.',
      targetPaths: ['finance/.apps/tracker'],
      args: { path: 'finance/.apps/tracker' },
    })) as { approvalId: string }

    const asBob = t.withIdentity({ subject: BOB })
    await expect(
      asBob.query((api as any).agent.listPendingApprovals, {
        activeWorkspaceId: orgId,
        threadId: THREAD,
      }),
    ).resolves.toEqual([])
    await expect(
      asBob.mutation((api as any).agent.respondToApproval, {
        activeWorkspaceId: orgId,
        approvalId: created.approvalId,
        decision: 'allow_once',
      }),
    ).rejects.toThrow(/approval was not created for this user/)
  })

  it('records an always-allow policy for the exact thread, user, operation, and target', async () => {
    const t = convexTest(schema, modules)
    const asAlice = t.withIdentity({ subject: ALICE })
    await seedThread(t, ALICE)
    await asAlice.mutation(api.atoms.upsert, {
      path: 'tmp/retry.md',
      body: 'retry',
    })

    const created = (await t.mutation((internal as any).agent._requestApproval, {
      workspaceId: ALICE,
      threadId: THREAD,
      createdByUserId: ALICE,
      operation: 'delete_atom',
      title: 'Delete tmp/retry.md',
      detail: 'Delete tmp/retry.md.',
      targetPaths: ['tmp/retry.md'],
      args: { path: 'tmp/retry.md' },
    })) as { approvalId: string }

    await asAlice.mutation((api as any).agent.respondToApproval, {
      approvalId: created.approvalId,
      decision: 'always_allow',
    })

    const policy = await t.run(async (ctx) =>
      ctx.db
        .query('agentApprovalPolicies')
        .withIndex('by_workspace_user_thread_operation_target', (q) =>
          q
            .eq('workspaceId', ALICE)
            .eq('createdByUserId', ALICE)
            .eq('threadId', THREAD)
            .eq('operation', 'delete_atom')
            .eq('targetKey', 'tmp/retry.md'),
        )
        .unique(),
    )
    expect(policy).toMatchObject({
      workspaceId: ALICE,
      createdByUserId: ALICE,
      threadId: THREAD,
      operation: 'delete_atom',
      targetKey: 'tmp/retry.md',
    })
  })
})
