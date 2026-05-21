/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

// Track-3 P2c fold — behavioral lockfile for the architectural
// fixes Codex flagged in the P2c review (commit b4b95b3):
//   F1: save_skill must inject type:skill (compatibility with
//       run_skill's isSkillAtomBody check).
//   F2: SKILL_MAX_BYTES enforced by BYTE count, not char count.
//   F3: ATOMIC begin-if-clear mutation closes the same-step
//       Promise.all race where two run_skill calls each pass
//       the depth=0 read then both insert depth=1.

const T = 'thread_p2c_fold'
const M = 'msg_p2c_fold'

describe('Track-3 P2c fold (Codex F3) — _beginSkillTurnIfClear is atomic', () => {
  it('first call latches depth=1 and returns {ok:true}', async () => {
    const t = convexTest(schema, modules)
    const r = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: M },
    )
    expect(r).toEqual({ ok: true })
    const got = await t.query(internal.skillTurnGate._readTurnDepth, {
      threadId: T,
      promptMessageId: M,
    })
    expect(got.depth).toBe(1)
  })

  it('SECOND call (on a depth=1 row) returns {ok:false, reason:already-started}', async () => {
    const t = convexTest(schema, modules)
    const first = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: M },
    )
    expect(first).toEqual({ ok: true })
    const second = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: M },
    )
    expect(second).toEqual({ ok: false, reason: 'already-started' })
    // STILL exactly one row; depth still 1 (not 2).
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('skillTurnState').collect()).filter(
        (r) => r.threadId === T && r.promptMessageId === M,
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].depth).toBe(1)
  })

  it('call AFTER a clear (back to depth=0/absent) succeeds again', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.skillTurnGate._beginSkillTurnIfClear, {
      threadId: T,
      promptMessageId: M,
    })
    await t.mutation(internal.skillTurnGate._clearTurnState, {
      threadId: T,
      promptMessageId: M,
    })
    const r = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: M },
    )
    expect(r).toEqual({ ok: true })
  })

  it('different (threadId, promptMessageId) keys are independent', async () => {
    const t = convexTest(schema, modules)
    const a = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: 'msg-A' },
    )
    const b = await t.mutation(
      internal.skillTurnGate._beginSkillTurnIfClear,
      { threadId: T, promptMessageId: 'msg-B' },
    )
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('skillTurnState').collect()).filter(
        (r) => r.threadId === T,
      ),
    )
    expect(rows).toHaveLength(2)
  })
})
