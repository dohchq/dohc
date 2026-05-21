import { internalMutation, internalQuery } from './_generated/server'
import type { GenericActionCtx } from 'convex/server'
import type { DataModel } from './_generated/dataModel'
import { v } from 'convex/values'
import { internal } from './_generated/api'

// skills-commands-v1 §2-A.2 (Track-3 P2b.1) — the STRUCTURAL gate
// behind the unauthorizable-set §2-A.1 rule. Track-2 proved over
// the html-atoms gate that prompt-only safety is strictly weaker
// than structural enforcement; the gate-cleared Track-3 design
// (8 rounds dual-review; commit 3497b40) commits to a per-turn
// `skillTurnState` Convex doc + a tool-handler-level
// `requireDirectUserAuthorization(ctx, op)` check at every
// UNAUTHORIZABLE-set tool's `execute`.
//
// LIFECYCLE:
//   1. `sendMessage`/`startOnboarding` CLEAR the row for the
//      pre-saved `(threadId, promptMessageId)` BEFORE invoking
//      `streamText({promptMessageId})`. (Round-6+7 fold: the
//      saveMessage → clear → streamText flow; the row genuinely
//      doesn't exist for the first step ⇒ prepareStep computes
//      depth=0.)
//   2. `run_skill` (Track-3 P2c) WRITES `{depth:1}` for the same
//      `(threadId, promptMessageId)` keyed by `ctx.promptMessageId`
//      (runtime ctx field per @convex-dev/agent's start.ts:180,
//      verified round-5 SOUND-G).
//   3. Every UNAUTHORIZABLE-set tool's handler (Track-3 P2b.3)
//      calls `await requireDirectUserAuthorization(ctx, '<op>')`
//      at the TOP of its execute. depth>0 ⇒ `SkillAuthRequiredError`
//      is thrown (the structured "stop & ask user" signal); the
//      tool's actual side effect NEVER runs.
//   4. The user's next direct chat turn is a FRESH
//      `(threadId, promptMessageId)`; sendMessage clears the new
//      row pre-stream; depth defaults to 0; the user's explicit
//      "yes" is the authorization edge.
//
// PARALLEL-TOOL RACE CLOSURE (round-4 Codex finding): even with
// this gate alone, AI-SDK v6 executes a step's tool_calls via
// Promise.all — a step containing run_skill + delete_atom(confirm)
// races the depth-write vs the depth-read. Track-3 P2b.4 closes
// this via `prepareStep.activeTools` (three mutually-exclusive
// modes; run_skill NEVER coexists with any unauthorizable tool).
// This gate is the BELT under the activeTools BRACE.

// P2b.1 fold (Codex F2): `depth` is a CLOSED domain {0, 1} — anything
// outside it would silently bypass the `depth > 0` gate (e.g. NaN
// passes `> 0` as false; negative depths confuse semantics; arbitrary
// integers invite "skill-within-skill" depth-counting scope creep
// the design explicitly rejected at v3 round 4). Validator-level
// rejection of any other value makes the primitive's domain
// self-evident from the type. `depth: 0` is semantically equivalent
// to "row absent", and we DELETE the row in that case (single
// canonical representation; bounded growth tightened).
export const _writeTurnState = internalMutation({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
    depth: v.union(v.literal(0), v.literal(1)),
  },
  handler: async (ctx, { threadId, promptMessageId, depth }) => {
    const existing = await ctx.db
      .query('skillTurnState')
      .withIndex('by_thread_msg', (q) =>
        q.eq('threadId', threadId).eq('promptMessageId', promptMessageId),
      )
      .unique()
    if (depth === 0) {
      // Single canonical state for "no skill turn in progress" — the
      // row's ABSENCE. `_writeTurnState({depth:0})` is therefore an
      // alias for `_clearTurnState`. Bounded growth: no zombie depth-0
      // rows can persist.
      if (existing) await ctx.db.delete(existing._id)
      return
    }
    if (existing) {
      await ctx.db.patch(existing._id, { depth })
    } else {
      await ctx.db.insert('skillTurnState', {
        threadId,
        promptMessageId,
        depth,
        startedAt: Date.now(),
      })
    }
  },
})

// P2c fold (Codex F3) — ATOMIC begin-if-clear. The two-step
// read-then-write at `run_skill`'s execute (read depth via
// _readTurnDepth, then conditionally write depth=1 via
// _writeTurnState) opens a race: at the entry step the
// `toolChoice: {type:'tool', toolName:'run_skill'}` forces the
// model to call run_skill, but AI-SDK v6 ALLOWS the model to
// emit MULTIPLE run_skill tool_calls in the same step
// (Promise.all). Two concurrent run_skill calls would both read
// depth=0 then both insert depth=1 — Convex's OCC retries one
// of them, so storage is fine, but BOTH would return bodies,
// violating "ONE skill per turn".
//
// This mutation is the atomic primitive: in ONE transaction,
// reads the row; if absent OR depth=0, inserts/patches to
// depth=1 and returns `{ok: true}`. If present with depth>0,
// returns `{ok: false}` (the caller refuses to execute that
// skill's body).
export const _beginSkillTurnIfClear = internalMutation({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, { threadId, promptMessageId }) => {
    const existing = await ctx.db
      .query('skillTurnState')
      .withIndex('by_thread_msg', (q) =>
        q.eq('threadId', threadId).eq('promptMessageId', promptMessageId),
      )
      .unique()
    if (existing && existing.depth > 0) {
      return { ok: false as const, reason: 'already-started' as const }
    }
    if (existing) {
      await ctx.db.patch(existing._id, { depth: 1 })
    } else {
      await ctx.db.insert('skillTurnState', {
        threadId,
        promptMessageId,
        depth: 1,
        startedAt: Date.now(),
      })
    }
    return { ok: true as const }
  },
})

export const _clearTurnState = internalMutation({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, { threadId, promptMessageId }) => {
    const row = await ctx.db
      .query('skillTurnState')
      .withIndex('by_thread_msg', (q) =>
        q.eq('threadId', threadId).eq('promptMessageId', promptMessageId),
      )
      .unique()
    if (row) await ctx.db.delete(row._id)
  },
})

export const _readTurnDepth = internalQuery({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, { threadId, promptMessageId }) => {
    const row = await ctx.db
      .query('skillTurnState')
      .withIndex('by_thread_msg', (q) =>
        q.eq('threadId', threadId).eq('promptMessageId', promptMessageId),
      )
      .unique()
    return { depth: row?.depth ?? 0 }
  },
})

/**
 * Thrown by `requireDirectUserAuthorization` when a tool handler
 * tries to execute a destructive/sharing operation while the
 * per-turn `skillTurnState.depth > 0`. The agent SDK propagates
 * the thrown error back to the model as the tool's result; the
 * model surfaces the message text to the user in plain English.
 * The user's NEXT chat turn (fresh promptMessageId; row cleared
 * pre-stream ⇒ depth=0) is the authorization edge.
 *
 * STRUCTURED SIGNAL CAVEAT (P2b.1 fold — Codex F1): AI SDK v6
 * propagates a thrown tool error to the model via
 * `createToolModelOutput → getErrorMessage(err)`, which for any
 * `Error` instance returns ONLY `.message`. The model and the
 * chat UI therefore see the MESSAGE TEXT — NOT the `.kind` /
 * `.op` fields. Those fields are useful for IN-PROCESS code
 * (test assertions, an in-server `try/catch` that wants to
 * branch on the discriminator) but they DO NOT cross the
 * tool-result boundary. The `.message` is the canonical
 * model-visible surface; design any user-facing structure into
 * the message text. If true structured propagation is ever
 * needed, return a structured tool RESULT (not throw); the
 * SDK passes that as JSON.
 */
export class SkillAuthRequiredError extends Error {
  readonly kind = 'needs-user-yes' as const
  constructor(public readonly op: string) {
    super(
      `(${op} requires direct user authorization — a skill body cannot pre-approve this. Surface the proposed operation to the user in plain English and wait for an explicit "yes" in a fresh chat turn.)`,
    )
    this.name = 'SkillAuthRequiredError'
  }
}

/** The shape of the ctx received by a `@convex-dev/agent` tool's
 *  `execute` handler. `threadId` is in the EXPORTED type;
 *  `promptMessageId` is set at RUNTIME (start.ts:180 verified
 *  round-3 SOUND-G). We accept either `promptMessageId` or
 *  `messageId` to be safe across exported-vs-runtime drift. */
export type ToolCtxWithSkillTurn = GenericActionCtx<DataModel> & {
  threadId?: string
  messageId?: string
  promptMessageId?: string
}

/**
 * Tool-handler gate. Call from the TOP of EVERY UNAUTHORIZABLE-set
 * tool's `execute` before any side effect. depth>0 ⇒ throw the
 * structured `SkillAuthRequiredError`; depth=0 ⇒ no-op (the
 * normal user-turn / agent path proceeds as today).
 *
 * Safe at the agent-tool boundary: if `ctx` has no `threadId` or
 * `promptMessageId` (e.g., a non-agent caller invoked this code
 * path — direct UI mutation, internal test, system action), the
 * gate is a NO-OP. The gate ONLY enforces inside the agent's
 * tool-execution surface — that is precisely where the design's
 * §2-A enforcement applies (a skill body cannot run anywhere
 * else).
 */
export async function requireDirectUserAuthorization(
  ctx: ToolCtxWithSkillTurn,
  op: string,
): Promise<void> {
  const threadId = ctx.threadId
  const promptMessageId = ctx.promptMessageId ?? ctx.messageId
  if (!threadId || !promptMessageId) return // not an agent-tool context
  const { depth } = await ctx.runQuery(
    internal.skillTurnGate._readTurnDepth,
    { threadId, promptMessageId },
  )
  if (depth > 0) throw new SkillAuthRequiredError(op)
}
