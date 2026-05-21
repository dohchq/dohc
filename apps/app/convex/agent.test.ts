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
    await ctx.db.insert('threadRefs', { workspaceId: A, threadId: 'tA' })
    await ctx.db.insert('threadRefs', { workspaceId: B, threadId: 'tB' })
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

  it('duplicate threadRefs (same-user tab race) ⇒ TOLERATE the canonical (earliest), never brick the owner; cross-tenant still denied (P1 design v2)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      // two rows for ONE workspace (the ensureThread race). 'tA1' is
      // inserted first ⇒ canonical (by_workspace index is
      // _creationTime-ascending; ensureThread converges to it).
      await ctx.db.insert('threadRefs', { workspaceId: A, threadId: 'tA1' })
      await ctx.db.insert('threadRefs', { workspaceId: A, threadId: 'tA2' })
    })
    // v2: the owner's OWN first run must NOT be bricked by a dup —
    // the canonical (earliest) thread is accepted. The OLD behaviour
    // denied BOTH, fail-closed-bricking the make-or-break first run.
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: A,
        threadId: 'tA1',
      }),
    ).toBe(true)
    // a stale/non-canonical dup id is still denied (the client must
    // use the threadId ensureThread returns — the canonical one).
    expect(
      await t.query(internal.agent._assertOwnThread, {
        workspaceId: A,
        threadId: 'tA2',
      }),
    ).toBe(false)
    // C1 PRESERVED: a FOREIGN id is still denied even WITH
    // same-workspace dups present (cross-tenant fail-closed).
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
    // listMessages on a non-canonical dup id still throws controlled.
    await expect(
      t
        .withIdentity({ subject: A })
        .query(api.agent.listMessages, {
          threadId: 'tA2',
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ).rejects.toThrow(/does not belong/)
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
