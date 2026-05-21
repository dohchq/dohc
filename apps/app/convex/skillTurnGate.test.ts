/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { internal } from './_generated/api'
import schema from './schema'
import {
  SkillAuthRequiredError,
  requireDirectUserAuthorization,
} from './skillTurnGate'

const modules = import.meta.glob('./**/*.ts')

const T = 'thread_t1'
const M = 'msg_m1'

// Track-3 P2b.1 — the skillTurnState lifecycle + the in-process
// `requireDirectUserAuthorization` gate semantics. The integration
// of the gate into actual tool handlers is P2b.3; here we lock
// the primitive's behavior in isolation.

describe('skillTurnState lifecycle — write / clear / read', () => {
  it('_readTurnDepth returns 0 when no row exists', async () => {
    const t = convexTest(schema, modules)
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got).toEqual({ depth: 0 })
  })

  it('_writeTurnState inserts a new row', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got).toEqual({ depth: 1 })
  })

  it('_writeTurnState(depth:1) is upsert — single row per key, no duplicates', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    // Re-write with the SAME (T, M) — patches, does not duplicate.
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got).toEqual({ depth: 1 })
    // Only ONE row exists for the (T, M) key (upsert, not duplicate).
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('skillTurnState').collect()).filter(
        (r) => r.threadId === T && r.promptMessageId === M,
      ),
    )
    expect(rows.length).toBe(1)
  })

  it('_writeTurnState(depth:0) DELETES the row (canonical "no skill turn" = absent row)', async () => {
    // P2b.1 fold (Codex F2): depth is a closed domain {0, 1}.
    // depth:0 is semantically equivalent to row-absent; the mutation
    // collapses both representations into the single canonical one
    // (delete the row) so bounded growth holds (no zombie depth-0
    // rows accumulate).
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 0, // ⇒ deletes
    })
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got).toEqual({ depth: 0 })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('skillTurnState').collect()).filter(
        (r) => r.threadId === T && r.promptMessageId === M,
      ),
    )
    expect(rows.length).toBe(0)
  })

  it('_writeTurnState(depth:0) when no row exists is a safe no-op', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 0,
    })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('skillTurnState').collect()),
    )
    expect(rows.length).toBe(0)
  })

  it('_writeTurnState REJECTS depth outside {0, 1} (closed domain at the validator)', async () => {
    const t = convexTest(schema, modules)
    // The Convex validator rejects values outside `v.union(v.literal(0),
    // v.literal(1))`. NaN, negative, and arbitrary integers can never
    // be persisted — the `depth > 0` gate cannot be silently bypassed
    // by a malformed write.
    await expect(
      t.mutation(internal.skillTurnGate._writeTurnState, {
        threadId: T,
        promptMessageId: M,
        depth: 2 as any,
      }),
    ).rejects.toThrow(/Validator error|literal/i)
    await expect(
      t.mutation(internal.skillTurnGate._writeTurnState, {
        threadId: T,
        promptMessageId: M,
        depth: -1 as any,
      }),
    ).rejects.toThrow(/Validator error|literal/i)
    await expect(
      t.mutation(internal.skillTurnGate._writeTurnState, {
        threadId: T,
        promptMessageId: M,
        depth: Number.NaN as any,
      }),
    ).rejects.toThrow(/Validator error|literal/i)
  })

  it('_clearTurnState removes the row', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    await t.mutation(internal.skillTurnGate._clearTurnState, {
      threadId: T,
      promptMessageId: M,
    })
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got).toEqual({ depth: 0 })
  })

  it('_clearTurnState on a missing row is an idempotent no-op', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(internal.skillTurnGate._clearTurnState, {
        threadId: T,
        promptMessageId: M,
      }),
    ).resolves.not.toThrow()
  })

  it('lifecycle: each (threadId, promptMessageId) row is independent', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: 'msg_a',
      depth: 1,
    })
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: 'msg_b',
      depth: 0,
    })
    expect(
      await t.query(internal.skillTurnGate._readTurnDepth, {
        threadId: T,
        promptMessageId: 'msg_a',
      }),
    ).toEqual({ depth: 1 })
    expect(
      await t.query(internal.skillTurnGate._readTurnDepth, {
        threadId: T,
        promptMessageId: 'msg_b',
      }),
    ).toEqual({ depth: 0 })
    // Different threadId is fully independent too.
    expect(
      await t.query(internal.skillTurnGate._readTurnDepth, {
        threadId: 'other_thread',
        promptMessageId: 'msg_a',
      }),
    ).toEqual({ depth: 0 })
  })
})

// Track-3 P2b.1 fold (indep review F1) — close the gap on the
// `requireDirectUserAuthorization` helper's THREE semantic branches.
// The lifecycle tests above lock the primitives but not the gate
// function itself; a future refactor that silently disabled the
// no-op-on-missing-ctx branch (the most footgun-prone path) would
// otherwise sneak through. Lock each branch explicitly.
describe('requireDirectUserAuthorization — gate semantics', () => {
  it('no-ops when threadId is absent on ctx (non-agent caller)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await expect(
        // ctx has no threadId/promptMessageId — the "not an agent-tool
        // context" branch returns silently. Verified-safe per design
        // §2-A.2: skill bodies can ONLY reach destructive ops via the
        // agent's tool-execute surface (where both fields ARE present).
        requireDirectUserAuthorization(ctx as any, 'delete_atom'),
      ).resolves.toBeUndefined()
    })
  })

  it('no-ops when promptMessageId is absent (threadId only)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ctxWithThreadOnly = { ...(ctx as any), threadId: T }
      await expect(
        requireDirectUserAuthorization(ctxWithThreadOnly, 'delete_atom'),
      ).resolves.toBeUndefined()
    })
  })

  it('no-ops at depth=0 (normal user turn — gate passes through)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const agentCtx = {
        ...(ctx as any),
        threadId: T,
        promptMessageId: M,
      }
      // No skillTurnState row written ⇒ depth=0 ⇒ gate is silent no-op.
      await expect(
        requireDirectUserAuthorization(agentCtx, 'delete_atom'),
      ).resolves.toBeUndefined()
    })
  })

  it('THROWS SkillAuthRequiredError at depth>0 (skill turn — gate trips)', async () => {
    const t = convexTest(schema, modules)
    // Simulate the lifecycle: run_skill writes depth=1 for (T, M).
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    await t.run(async (ctx) => {
      const agentCtx = {
        ...(ctx as any),
        threadId: T,
        promptMessageId: M,
      }
      // Now any UNAUTHORIZABLE tool's gate must throw.
      await expect(
        requireDirectUserAuthorization(agentCtx, 'delete_atom'),
      ).rejects.toBeInstanceOf(SkillAuthRequiredError)
      await expect(
        requireDirectUserAuthorization(agentCtx, 'delete_atom'),
      ).rejects.toMatchObject({
        kind: 'needs-user-yes',
        op: 'delete_atom',
      })
    })
  })

  it('falls back to ctx.messageId when promptMessageId is absent (runtime-vs-exported drift safety)', async () => {
    const t = convexTest(schema, modules)
    // Write the row keyed by (T, M) — the agent's runtime supplies
    // `messageId`; the exported type may have driven prior callers to
    // omit `promptMessageId`. The helper widens to either.
    await t.mutation(internal.skillTurnGate._writeTurnState, {
      threadId: T,
      promptMessageId: M,
      depth: 1,
    })
    await t.run(async (ctx) => {
      const agentCtx = {
        ...(ctx as any),
        threadId: T,
        messageId: M, // ONLY messageId, no promptMessageId
      }
      await expect(
        requireDirectUserAuthorization(agentCtx, 'delete_atom'),
      ).rejects.toBeInstanceOf(SkillAuthRequiredError)
    })
  })
})

describe('SkillAuthRequiredError — structured "needs-user-yes"', () => {
  it('carries the op + the kind discriminator + a clear message', () => {
    const e = new SkillAuthRequiredError('delete_atom')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(SkillAuthRequiredError)
    expect(e.kind).toBe('needs-user-yes')
    expect(e.op).toBe('delete_atom')
    expect(e.name).toBe('SkillAuthRequiredError')
    expect(e.message).toContain('delete_atom')
    expect(e.message).toContain('direct user authorization')
    expect(e.message).toContain('skill body cannot pre-approve')
  })

  it('preserves stack trace + is instanceof both Error and the subclass', () => {
    try {
      throw new SkillAuthRequiredError('confirm_window_sharing')
    } catch (caught) {
      expect(caught).toBeInstanceOf(SkillAuthRequiredError)
      expect(caught).toBeInstanceOf(Error)
      expect((caught as SkillAuthRequiredError).kind).toBe('needs-user-yes')
      // The agent SDK propagates the message as the tool result; the
      // model sees the op + the "wait for yes" instruction.
      expect((caught as Error).message).toMatch(/confirm_window_sharing/)
    }
  })
})
