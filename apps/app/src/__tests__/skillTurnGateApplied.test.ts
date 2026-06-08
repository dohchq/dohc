import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Track-3 P2b.3 — STRUCTURAL coverage of "every UNAUTHORIZABLE-set
// tool handler calls `requireDirectUserAuthorization`". The gate's
// per-branch behavior is unit-locked in
// `convex/skillTurnGate.test.ts` (depth=0 no-op; depth>0 throw;
// missing-ctx no-op); here we lock that each of the design's 17
// UNAUTHORIZABLE-set ops has the gate call physically present in
// the agent's tool-handler source.
//
// A behavioral end-to-end test ("at depth=1, every tool's execute
// throws") would require breaking the @convex-dev/agent
// encapsulation to extract each tool's execute closure; the
// structural assertion + the unit-locked gate primitive together
// give equivalent confidence with zero coupling. (The P2c agent-
// flow integration test will exercise the gate ON THE WIRE once
// `run_skill` is the sole entry tool.)
//
// File lives in src/__tests__ (not convex/) because it uses
// `node:fs` to read the agent source, which the edge-runtime env
// configured for convex/** doesn't expose.

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(
  resolve(__dirname, '../../convex/agent.ts'),
  'utf8',
)

// §2-A.1 UNAUTHORIZABLE-set (skills-commands-v1.md lines 391-419,
// design v9 / gate-cleared at commit 3497b40). Every op-name here
// MUST be paired with a `requireDirectUserAuthorization(ctx, '<op>')`
// call somewhere in agent.ts. `create_atom` and `capture` are
// CONDITIONAL gates (gated by input shape); the call still exists.
const UNAUTHORIZABLE_OPS: ReadonlyArray<string> = [
  // State flips / user-decision class
  'finish_onboarding',
  'confirm_window_sharing',
  'confirm_capture',
  'reject_capture',
  // Destructive class (post-confirm-prompt)
  'delete_atom',
  'delete_entity',
  'delete_folder',
  // Destructive overwrite / elevated capability
  'create_atom',
  'update_entity',
  // Self-modifying / sharing class
  'save_skill',
  'save_command',
  'define_rollup',
  // Resurrection class
  'restore',
  'restore_folder',
  // Sharing-flag class (conditional on shared:true)
  'capture',
  // file-org-v1 D4.1b ATOMIC — lock-toggle (user-decision class)
  'set_lock',
]

describe('Track-3 P2b.3 — UNAUTHORIZABLE-set gate coverage', () => {
  it('imports the gate helper at the top of agent.ts', () => {
    expect(AGENT_SRC).toMatch(
      /import\s+\{\s*requireDirectUserAuthorization\s*\}\s+from\s+['"]\.\/skillTurnGate['"]/,
    )
  })

  for (const op of UNAUTHORIZABLE_OPS) {
    it(`gates \`${op}\` via requireDirectUserAuthorization`, () => {
      const safeOp = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(
        `requireDirectUserAuthorization\\(ctx,\\s*['"]${safeOp}['"]\\)`,
      )
      expect(AGENT_SRC).toMatch(re)
    })
  }

  it('create_entities reads skillTurnState.depth + passes mode:strictCreate when depth>0', () => {
    // The §7 P2 step 5 design wire-up: a skill-turn create_entities
    // call (depth>0) MUST flow through `_upsertMany({mode:
    // 'strictCreate'})`. Lock the structural shape of that wiring.
    expect(AGENT_SRC).toMatch(/skillTurnGate\._readTurnDepth/)
    expect(AGENT_SRC).toMatch(/mode\s*=\s*['"]strictCreate['"]/)
    expect(AGENT_SRC).toMatch(
      /internal\.entities\._upsertMany,\s*\{\s*[\s\S]*?mode\b/,
    )
  })

  it('no UNAUTHORIZABLE op is silently un-gated (sanity guard against future edits)', () => {
    // Count callsites: file must have ≥ UNAUTHORIZABLE_OPS.length
    // `requireDirectUserAuthorization(` occurrences (one per gated
    // handler). Extra calls allowed (future expansion); fewer means
    // a handler regressed silently.
    const matches = AGENT_SRC.match(
      /requireDirectUserAuthorization\(ctx,/g,
    )
    expect(matches).toBeTruthy()
    expect(matches!.length).toBeGreaterThanOrEqual(UNAUTHORIZABLE_OPS.length)
  })
})

// P2b.3 fold (Codex F2/F3) — structural tests proved PRESENCE but
// not PLACEMENT. A regression that moves a handler's gate AFTER
// the first side-effect call would still pass the per-op presence
// test. These tests slice each tool's `execute` body and assert
// the gate appears BEFORE the first side-effect token (a
// `ctx.runMutation` / `ctx.runAction` / `requireWorkspace` call
// for unconditional gates; for delete handlers, gate must appear
// after the `requestAgentApproval` early-return but before
// `requireWorkspace` / the mutation).
//
// The slicer reads from `<op>: createTool({` up to the NEXT
// `<some_name>: createTool({` (the next tool's declaration) — that
// bounds each handler's source.
const TOOL_BODIES: Record<string, string> = (() => {
  const bodies: Record<string, string> = {}
  const re = /(\w+):\s*createTool\(\{/g
  const matches: Array<{ name: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(AGENT_SRC))) {
    matches.push({ name: m[1], start: m.index })
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const next = matches[i + 1]
    const end = next ? next.start : AGENT_SRC.length
    bodies[cur.name] = AGENT_SRC.slice(cur.start, end)
  }
  return bodies
})()

const SIDE_EFFECT_RE =
  /\bctx\.run(Mutation|Action|Query)\b|\brequireWorkspace\(ctx\)/

// Ops where the gate is UNCONDITIONAL at the top of the handler.
// For these, the gate MUST precede the first side-effect token.
const UNCONDITIONAL_TOP_GATE_OPS = [
  'finish_onboarding',
  'define_rollup',
  'confirm_window_sharing',
  'confirm_capture',
  'reject_capture',
  'restore',
  'restore_folder',
  'save_skill',
  'save_command',
  'update_entity',
  // file-org-v1 D4.1b ATOMIC — set_lock gate is at the top of the
  // handler (no early-return branch; no conditional input).
  'set_lock',
] as const

// Ops where the gate is INSIDE a conditional (create_atom, capture).
// Verify the conditional gate exists; placement covered by the
// surrounding conditional logic in the source.
const CONDITIONAL_GATE_OPS = ['create_atom', 'capture'] as const

// Ops where the gate is AFTER a `requestAgentApproval` early-return
// branch (delete_*). Verify the gate is below that approval request
// AND above the first destructive side-effect call.
const POST_CONFIRM_GATE_OPS = [
  'delete_atom',
  'delete_entity',
  'delete_folder',
] as const

describe('Track-3 P2b.3 fold (Codex F2/F3) — gate PLACEMENT, not just presence', () => {
  for (const op of UNCONDITIONAL_TOP_GATE_OPS) {
    it(`\`${op}\`: gate fires BEFORE any side effect`, () => {
      const body = TOOL_BODIES[op]
      expect(body, `missing handler body for ${op}`).toBeTruthy()
      const safeOp = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const gateIdx = body.search(
        new RegExp(`requireDirectUserAuthorization\\(ctx,\\s*['"]${safeOp}['"]\\)`),
      )
      const sideIdx = body.search(SIDE_EFFECT_RE)
      expect(gateIdx).toBeGreaterThanOrEqual(0)
      expect(sideIdx).toBeGreaterThanOrEqual(0)
      expect(gateIdx).toBeLessThan(sideIdx)
    })
  }

  for (const op of POST_CONFIRM_GATE_OPS) {
    it(`\`${op}\`: gate is AFTER requestAgentApproval early-return AND BEFORE first side effect`, () => {
      const body = TOOL_BODIES[op]
      expect(body).toBeTruthy()
      // The approval request call is the new structured user-decision
      // edge; the tool must not mutate before it either returns
      // pending or falls through with an approved policy.
      const confirmReturnIdx = body.search(/requestAgentApproval\(ctx,\s*options/)
      const safeOp = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const gateIdx = body.search(
        new RegExp(`requireDirectUserAuthorization\\(ctx,\\s*['"]${safeOp}['"]\\)`),
      )
      const sideIdx = body.search(SIDE_EFFECT_RE)
      expect(confirmReturnIdx).toBeGreaterThanOrEqual(0)
      expect(gateIdx).toBeGreaterThan(confirmReturnIdx)
      expect(gateIdx).toBeLessThan(sideIdx)
    })
  }

  for (const op of CONDITIONAL_GATE_OPS) {
    it(`\`${op}\`: conditional gate appears inside an \`if\` block before side effect`, () => {
      const body = TOOL_BODIES[op]
      expect(body).toBeTruthy()
      const safeOp = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const gateMatch = body.match(
        new RegExp(
          `if\\s*\\([^)]+\\)\\s*\\{\\s*await\\s+requireDirectUserAuthorization\\(ctx,\\s*['"]${safeOp}['"]\\)`,
          's',
        ),
      )
      expect(
        gateMatch,
        `${op} gate must be inside an if-block (conditional)`,
      ).toBeTruthy()
      const gateIdx = gateMatch ? body.indexOf(gateMatch[0]) : -1
      const sideIdx = body.search(SIDE_EFFECT_RE)
      // Conditional gates sit BEFORE the side effect (the if-block
      // wraps the gate; side effect happens in the always-flow
      // below).
      expect(gateIdx).toBeGreaterThan(0)
      // Side effect must exist downstream; for capture/create_atom
      // both `requireWorkspace` and `ctx.runMutation` follow.
      expect(sideIdx).toBeGreaterThan(gateIdx)
    })
  }
})

// P2b.3 fold (indep F2) — the static UNAUTHORIZABLE_OPS allowlist
// catches REMOVALS of any of the 16 gates, but it fails-OPEN
// against ADDITIONS: a future PR introducing a `nuke_workspace`
// tool without a gate would still pass every existing test. This
// bidirectional test enumerates EVERY `createTool` in agent.ts
// and asserts: tools NOT in the SAFE_NO_GATE_OPS allowlist MUST
// contain a `requireDirectUserAuthorization(ctx,` call somewhere
// in their handler body. New unauthorizable tools added without
// gating will fail this test.
//
// SAFE_NO_GATE_OPS is the design's SKILL-MAY-CALL list
// (skills-commands-v1.md §2-A.1 "SKILL MAY CALL without further
// human confirm"). Read-only or explicitly-additive writes.
// `create_atom` and `capture` are CONDITIONAL — they have gates
// inside an `if` and DO NOT belong on this allowlist (the gate
// MUST be present so the regression test catches a removal of
// the `if`-block).
const SAFE_NO_GATE_OPS = new Set<string>([
  // pure reads
  'list_atoms',
  'read_atom', // post-P2c: returns INERT preview for skill bodies (§3.1 structural refusal)
  'list_trash',
  'list_entities',
  'find_entity',
  'list_skills',
  'list_commands',
  'pending_captures',
  'review_window_sharing',
  'onboarding_state',
  'read_asset', // read-only saved attachment fetch; scoped by activeWorkspaceFromTool and no mutation path
  // sanity-check
  'run_query',
  'test_app', // app verification only; server-side resolver gathers authorized app/source data and records a test result, but does not change workspace content or permissions
  // explicitly-additive writes (no overwrite path)
  'create_entities', // gated via mutation-level strictCreate (P2b.2 BRACE) — no `requireDirectUserAuthorization` needed at the tool layer; the depth-read + strictCreate mode is the structural enforcement
  'create_folder',
  'insert_after_heading',
  'propose_replace_text',
  'rewrite_section',
  'write_atom', // retired v1 tool: always refuses, no side effect
  'suggest_in_doc', // retired v1 tool: always refuses, no side effect
  // P2c — the skill-fire entry. Structurally restricted to
  // SKILL_ENTRY_TOOLS activeTools mode (depth=0 + entry='skill-
  // fire'); refuses depth>0 recursion via its own internal
  // depth-read; never coexists with UNAUTHORIZABLE tools in any
  // step (the prepareStep BRACE). Its only side effect is writing
  // skillTurnState({depth:1}) — the SUBSEQUENT step's
  // UNAUTHORIZABLE tools trip the gate (BELT). Gating run_skill
  // itself would defeat the whole §2-A model.
  'run_skill',
  'run_command',
])

describe('Track-3 P2b.3 fold (indep F2) — bidirectional gate coverage (catches ADDITIONS too)', () => {
  it('every tool NOT in SAFE_NO_GATE_OPS contains a requireDirectUserAuthorization call', () => {
    const allTools = Object.keys(TOOL_BODIES)
    // Sanity: we discovered the expected count of tools.
    expect(allTools.length).toBeGreaterThanOrEqual(
      UNAUTHORIZABLE_OPS.length + SAFE_NO_GATE_OPS.size,
    )

    const ungated: string[] = []
    for (const op of allTools) {
      if (SAFE_NO_GATE_OPS.has(op)) continue
      const body = TOOL_BODIES[op]
      const hasGate = /requireDirectUserAuthorization\(ctx,/.test(body)
      if (!hasGate) ungated.push(op)
    }

    // The error message names each ungated tool so a regression
    // tells the developer EXACTLY which tool needs the gate (or
    // needs to be added to SAFE_NO_GATE_OPS with a justification).
    expect(
      ungated,
      `Tools not on the SAFE_NO_GATE_OPS allowlist must call requireDirectUserAuthorization. Ungated: ${ungated.join(', ')}. If a new tool is genuinely safe, add it to SAFE_NO_GATE_OPS in this test file with a justification comment.`,
    ).toEqual([])
  })

  it('SAFE_NO_GATE_OPS allowlist is exactly the design-listed SKILL-MAY-CALL set (no silent expansion)', () => {
    // The SAFE_NO_GATE_OPS list mirrors design §2-A.1 lines 360-389.
    // Lock the EXACT membership so an attempt to silently add a
    // dangerous tool to the allowlist (to make the bidirectional
    // test pass) is itself flagged here.
    const expectedSafe = new Set([
      'list_atoms', 'read_atom', 'list_trash', 'list_entities',
      'find_entity', 'list_skills', 'list_commands',
      'pending_captures', 'review_window_sharing',
      'onboarding_state', 'read_asset', 'run_query', 'test_app',
      'create_entities', 'create_folder',
      'insert_after_heading', 'propose_replace_text', 'rewrite_section',
      'run_skill', // P2c — structurally safe; see SAFE_NO_GATE_OPS comment
      'run_command',
      'write_atom', // retired v1 tool: always refuses
      'suggest_in_doc', // retired v1 tool: always refuses
    ])
    expect([...SAFE_NO_GATE_OPS].sort()).toEqual([...expectedSafe].sort())
  })

  it('read_asset derives workspace scope server-side before reading saved attachments', () => {
    const body = TOOL_BODIES.read_asset
    expect(body).toBeTruthy()
    const workspaceIdx = body.indexOf('activeWorkspaceFromTool(ctx, options)')
    const readIdx = body.indexOf('readAssetTextForAgent(')

    expect(workspaceIdx).toBeGreaterThanOrEqual(0)
    expect(readIdx).toBeGreaterThan(workspaceIdx)
  })
})
