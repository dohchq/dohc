import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPrepareStep,
  UNAUTHORIZABLE_TOOLS,
  SAFE_FOR_COMMAND_TOOLS,
  SAFE_FOR_SKILL_TOOLS,
  SKILL_TURN_ENTRY_VALUES,
  USER_TURN_TOOLS_NO_RUN_SKILL,
  SKILL_ENTRY_TOOLS,
  COMMAND_ENTRY_TOOLS,
  skillTurnEntryArg,
} from '../../convex/agent'

// Track-3 P2b.4 — prepareStep.activeTools three-mode invariant +
// sendMessage saveMessage→clear→streamText lifecycle. The BRACE
// under P2b.3's BELT. The activeTools sets are the structural
// closure of the AI-SDK v6 `Promise.all` parallel-tool race:
// `run_skill` NEVER coexists with any UNAUTHORIZABLE tool in a
// single step's activeTools, so the model cannot even schedule
// the racing call.
//
// Unit tests here lock the constants' SHAPE + buildPrepareStep's
// per-mode return. The sendMessage/startOnboarding lifecycle is
// verified structurally (the source must contain saveMessage→
// _clearTurnState→streamText in that order).

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(
  resolve(__dirname, '../../convex/agent.ts'),
  'utf8',
)

describe('Track-3 P2b.4 — activeTools constants (three mutually-exclusive modes)', () => {
  it('UNAUTHORIZABLE_TOOLS is exactly the §2-A.1 list', () => {
    const expected = new Set([
      'finish_onboarding',
      'confirm_window_sharing',
      'confirm_capture',
      'reject_capture',
      'delete_atom',
      'delete_entity',
      'delete_folder',
      'create_atom',
      'update_entity',
      'save_skill',
      'save_command',
      'define_rollup',
      'restore',
      'restore_folder',
      'capture',
      // file-org-v1 D4.1b ATOMIC — `set_lock` is §2-A.1 user-
      // decision class (a skill body must not toggle locks). Added
      // in the same commit that registered the tool + the gate in
      // its handler — zero vulnerability window.
      'set_lock',
      // Existing database row mutation — safe only in a direct user
      // turn because it changes structured data.
      'write_database_rows',
      // Applies captured shell diffs to workspace state; run/discard
      // are safe helpers, but persistence is direct-user only.
      'apply_workspace_shell_diff',
    ])
    expect([...UNAUTHORIZABLE_TOOLS].sort()).toEqual([...expected].sort())
  })

  it('SKILL_ENTRY_TOOLS is exactly {run_skill} (round-7 minimization)', () => {
    expect([...SKILL_ENTRY_TOOLS]).toEqual(['run_skill'])
  })

  it('COMMAND_ENTRY_TOOLS is exactly {run_command}', () => {
    expect([...COMMAND_ENTRY_TOOLS]).toEqual(['run_command'])
  })

  it('SAFE_FOR_SKILL_TOOLS does NOT contain run_skill/run_command (no recursion)', () => {
    expect(SAFE_FOR_SKILL_TOOLS).not.toContain('run_skill')
    expect(SAFE_FOR_SKILL_TOOLS).not.toContain('run_command')
  })

  it('SAFE_FOR_COMMAND_TOOLS allows exactly the one-hop run_skill composition path', () => {
    expect(SAFE_FOR_COMMAND_TOOLS).toContain('run_skill')
    expect(SAFE_FOR_COMMAND_TOOLS).not.toContain('run_command')
    const intersection = SAFE_FOR_COMMAND_TOOLS.filter((t) =>
      (UNAUTHORIZABLE_TOOLS as readonly string[]).includes(t),
    )
    expect(intersection.sort()).toEqual(['capture', 'create_atom'])
  })

  it('SAFE_FOR_SKILL_TOOLS overlaps UNAUTHORIZABLE only on CONDITIONAL tools (create_atom + capture)', () => {
    // create_atom and capture are CONDITIONALLY unauthorizable —
    // gated only on elevated inputs (confirm:true / .skills/.commands /
    // type:skill/type:command / shared:true). At
    // depth>0 the SAFE_FOR_SKILL_TOOLS set still contains them
    // because the BELT in the handler refuses elevated calls
    // (any non-elevated call is genuinely safe). This narrow
    // overlap is the ONLY one allowed; anything else would mean
    // a fully-destructive tool slipped into the safe set.
    const intersection = SAFE_FOR_SKILL_TOOLS.filter((t) =>
      (UNAUTHORIZABLE_TOOLS as readonly string[]).includes(t),
    )
    expect(intersection.sort()).toEqual(['capture', 'create_atom'])
  })

  it('USER_TURN_TOOLS_NO_RUN_SKILL does NOT contain run_skill/run_command (entry route is palette/slash ONLY)', () => {
    expect(USER_TURN_TOOLS_NO_RUN_SKILL).not.toContain('run_skill')
    expect(USER_TURN_TOOLS_NO_RUN_SKILL).not.toContain('run_command')
  })

  it('USER_TURN_TOOLS_NO_RUN_SKILL is the union of UNAUTHORIZABLE + SAFE (every tool except run_skill)', () => {
    const expected = new Set([
      ...UNAUTHORIZABLE_TOOLS,
      ...SAFE_FOR_SKILL_TOOLS,
    ])
    expect([...USER_TURN_TOOLS_NO_RUN_SKILL].sort()).toEqual(
      [...expected].sort(),
    )
  })

  it('SAFE_FOR_SKILL_TOOLS includes read_asset so text attachments can be fetched without model file parts', () => {
    expect(SAFE_FOR_SKILL_TOOLS).toContain('read_asset')
    expect(USER_TURN_TOOLS_NO_RUN_SKILL).toContain('read_asset')
  })

  it('entry modes are MUTUALLY EXCLUSIVE — entry tools are disjoint from the others', () => {
    const skillEntry = new Set<string>(SKILL_ENTRY_TOOLS)
    const commandEntry = new Set<string>(COMMAND_ENTRY_TOOLS)
    const safeForSkill = new Set<string>(SAFE_FOR_SKILL_TOOLS)
    const userTurn = new Set<string>(USER_TURN_TOOLS_NO_RUN_SKILL)
    // Entry tools are only reachable from explicit palette/slash dispatch.
    for (const t of [...skillEntry, ...commandEntry]) {
      expect(safeForSkill.has(t)).toBe(false)
      expect(userTurn.has(t)).toBe(false)
    }
    // SAFE ⊆ USER_TURN (everything depth>0 sees is also visible at
    // depth=0; the user turn is a superset minus run_skill).
    for (const t of safeForSkill) {
      expect(userTurn.has(t)).toBe(true)
    }
  })
})

// Fake ctx for buildPrepareStep tests — implements runQuery
// (the only ctx method buildPrepareStep uses). The depth/kind values
// are configurable so we can simulate normal, command, and skill turns.
function makeFakeCtx(depth: number, kind?: 'skill' | 'command' | null) {
  return {
    runQuery: async (_fn: any, _args: any) => ({ depth, kind }),
  } as any
}

describe('Track-3 P2b.4 — buildPrepareStep (three-mode dispatch with depth read)', () => {
  it('depth=0 + entry="skill-fire" ⇒ activeTools=[run_skill] + toolChoice + providerOptions disableParallelToolUse (P2c indep fold F2)', async () => {
    const fn = buildPrepareStep(
      makeFakeCtx(0),
      'thread-T',
      'msg-M',
      'skill-fire',
      { providerId: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' },
    )
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out).toEqual({
      activeTools: ['run_skill'],
      toolChoice: { type: 'tool', toolName: 'run_skill' },
      // P2c indep fold F2: belt-and-braces with the atomic
      // _beginSkillTurnIfClear. The model can never EMIT two
      // run_skill calls in one step; even if a future model
      // tried, the atomic latch refuses the second.
      providerOptions: {
        openai: { parallelToolCalls: false, reasoningEffort: 'high' },
      },
    })
  })

  it('depth=0 + entry="command-fire" ⇒ activeTools=[run_command] + toolChoice + providerOptions disableParallelToolUse', async () => {
    const fn = buildPrepareStep(
      makeFakeCtx(0),
      'thread-T',
      'msg-M',
      'command-fire',
      { providerId: 'anthropic', model: 'claude-sonnet-4-6' },
    )
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out).toEqual({
      activeTools: ['run_command'],
      toolChoice: { type: 'tool', toolName: 'run_command' },
      providerOptions: {
        anthropic: { disableParallelToolUse: true },
      },
    })
  })

  it('depth=0 + entry=undefined ⇒ activeTools=USER_TURN_TOOLS_NO_RUN_SKILL (normal user turn)', async () => {
    const fn = buildPrepareStep(makeFakeCtx(0), 'thread-T', 'msg-M', undefined)
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out.activeTools.sort()).toEqual(
      [...USER_TURN_TOOLS_NO_RUN_SKILL].sort(),
    )
    expect(out.toolChoice).toBeUndefined()
  })

  it('depth=0 + entry=undefined activeTools EXCLUDES run_skill', async () => {
    const fn = buildPrepareStep(makeFakeCtx(0), 'thread-T', 'msg-M', undefined)
    const out = await fn({ messages: [], stepNumber: 0 })
    expect((out.activeTools as unknown as string[])).not.toContain('run_skill')
  })

  it('depth>0 ⇒ activeTools=SAFE_FOR_SKILL_TOOLS (BRACE — UNAUTHORIZABLE tools structurally absent)', async () => {
    // P2b.4 fold (Codex F1+F5): the depth>0 case MUST return
    // SAFE_FOR_SKILL_TOOLS regardless of entry — the model in a
    // skill turn never sees the UNAUTHORIZABLE surface.
    const fn = buildPrepareStep(makeFakeCtx(1), 'thread-T', 'msg-M', undefined)
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out.activeTools.sort()).toEqual(
      [...SAFE_FOR_SKILL_TOOLS].sort(),
    )
    expect(out.toolChoice).toBeUndefined()
  })

  it('depth>0 OVERRIDES entry="skill-fire" (no re-firing run_skill in the same turn)', async () => {
    // After run_skill writes depth=1, the NEXT step's prepareStep
    // reads depth=1 and returns SAFE_FOR_SKILL_TOOLS — NOT
    // SKILL_ENTRY_TOOLS. This closes Codex F1's concrete repro
    // ("the model is forced back into run_skill recursively").
    const fn = buildPrepareStep(
      makeFakeCtx(1),
      'thread-T',
      'msg-M',
      'skill-fire',
    )
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out.activeTools.sort()).toEqual(
      [...SAFE_FOR_SKILL_TOOLS].sort(),
    )
    // No toolChoice override at depth>0.
    expect(out.toolChoice).toBeUndefined()
  })

  it('depth>0 OVERRIDES entry="command-fire" (no re-firing run_command in the same turn)', async () => {
    const fn = buildPrepareStep(
      makeFakeCtx(1, 'skill'),
      'thread-T',
      'msg-M',
      'command-fire',
    )
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(out.activeTools.sort()).toEqual(
      [...SAFE_FOR_SKILL_TOOLS].sort(),
    )
    expect(out.toolChoice).toBeUndefined()
  })

  it('depth>0 + command kind permits one saved skill after run_command', async () => {
    const fn = buildPrepareStep(
      makeFakeCtx(1, 'command'),
      'thread-T',
      'msg-M',
      'command-fire',
    )
    const out = await fn({ messages: [], stepNumber: 1 })
    expect(out.activeTools.sort()).toEqual(
      [...SAFE_FOR_COMMAND_TOOLS].sort(),
    )
    expect(out.activeTools).toContain('run_skill')
    expect(out.toolChoice).toBeUndefined()
  })

  it('promptMessageId=undefined ⇒ depth defaults to 0 (no read attempted)', async () => {
    // NO-INTRO branch: SDK generates messageId internally, we
    // can't read depth for an unknown id. depth=0 is correct
    // because no skill turn has fired (run_skill requires
    // entry='skill-fire' + a stable promptMessageId).
    let readAttempted = false
    const ctx = {
      runQuery: async () => {
        readAttempted = true
        return { depth: 999 } // would trip BRACE if it were read
      },
    }
    const fn = buildPrepareStep(ctx as any, 'thread-T', undefined, undefined)
    const out = await fn({ messages: [], stepNumber: 0 })
    expect(readAttempted).toBe(false)
    expect(out.activeTools.sort()).toEqual(
      [...USER_TURN_TOOLS_NO_RUN_SKILL].sort(),
    )
  })

  it('runQuery transient failure ⇒ fall back to depth=0 (BELT still trips per handler)', async () => {
    const ctx = {
      runQuery: async () => {
        throw new Error('transient convex error')
      },
    }
    const fn = buildPrepareStep(ctx as any, 'thread-T', 'msg-M', undefined)
    const out = await fn({ messages: [], stepNumber: 0 })
    // Falls back to the normal user-turn surface; the per-handler
    // BELT (P2b.3) still trips if the model calls an
    // UNAUTHORIZABLE tool in a skill turn — fail-safe.
    expect(out.activeTools.sort()).toEqual(
      [...USER_TURN_TOOLS_NO_RUN_SKILL].sort(),
    )
  })

  it('per-step idempotence: same depth + entry ⇒ same activeTools', async () => {
    const ctx = makeFakeCtx(0)
    const fn = buildPrepareStep(ctx, 'thread-T', 'msg-M', 'skill-fire')
    const a = await fn({ messages: [], stepNumber: 0 })
    const b = await fn({ messages: ['x'], stepNumber: 1 })
    expect(a).toEqual(b)
  })
})

describe('Track-3 P2b.4 — sendMessage lifecycle (saveMessage → clear → streamText)', () => {
  // Slice sendMessage's handler body from source.
  const sendMessageBody = (() => {
    const start = AGENT_SRC.indexOf('export const sendMessage = action({')
    expect(start).toBeGreaterThan(0)
    // sendMessage extends to the next `export const`
    const next = AGENT_SRC.indexOf('export const ', start + 1)
    return AGENT_SRC.slice(start, next > 0 ? next : AGENT_SRC.length)
  })()

  it('sendMessage entry validator accepts only skill and command fire entries', () => {
    expect(skillTurnEntryArg.isOptional).toBe('optional')
    expect(
      skillTurnEntryArg.members.map((member) => member.value).sort(),
    ).toEqual([...SKILL_TURN_ENTRY_VALUES].sort())
  })

  it('sendMessage calls saveMessage BEFORE streamText (stable promptMessageId)', () => {
    const saveIdx = sendMessageBody.search(/dohcAgent\.saveMessage\(/)
    const streamIdx = sendMessageBody.search(/dohcAgent\.streamText\(/)
    expect(saveIdx).toBeGreaterThan(0)
    expect(streamIdx).toBeGreaterThan(0)
    expect(saveIdx).toBeLessThan(streamIdx)
  })

  it('sendMessage calls _clearTurnState BETWEEN saveMessage and streamText', () => {
    const saveIdx = sendMessageBody.search(/dohcAgent\.saveMessage\(/)
    const clearIdx = sendMessageBody.search(
      /internal\.skillTurnGate\._clearTurnState/,
    )
    const streamIdx = sendMessageBody.search(/dohcAgent\.streamText\(/)
    expect(saveIdx).toBeLessThan(clearIdx)
    expect(clearIdx).toBeLessThan(streamIdx)
  })

  it('sendMessage passes prepareStep + experimental_context to streamText', () => {
    expect(sendMessageBody).toMatch(/prepareStep:\s*buildPrepareStep\(/)
    expect(sendMessageBody).toMatch(/experimental_context:\s*\{/)
  })

  it('sendMessage propagates entry into experimental_context', () => {
    // P2b.4 indep fold F5: anchor the regex on the
    // experimental_context site (not the destructure) so a future
    // refactor that drops the propagation without touching the
    // destructure still fails the test.
    expect(sendMessageBody).toMatch(/experimental_context:\s*\{\s*entry,/)
  })

  it('sendMessage preserves stored access mode unless the request overrides it', () => {
    const resolveStart = sendMessageBody.indexOf(
      'internal.agent._resolveAgentAccessModeForThread',
    )
    expect(resolveStart).toBeGreaterThan(0)
    const resolveEnd = sendMessageBody.indexOf('const systemPrompt', resolveStart)
    const resolveBlock = sendMessageBody.slice(resolveStart, resolveEnd)
    expect(resolveBlock).toContain('activeWorkspaceId')
    expect(resolveBlock).toContain('threadId')
    expect(resolveBlock).toContain(
      '...(agentAccessMode !== undefined ? { agentAccessMode } : {})',
    )
    expect(resolveBlock).not.toContain('workspaceId,')
  })

  it('sendMessage persists explicit access-mode changes before streaming', () => {
    const persistStart = sendMessageBody.indexOf(
      'if (agentAccessMode !== undefined)',
    )
    expect(persistStart).toBeGreaterThan(0)
    const persistEnd = sendMessageBody.indexOf(
      'internal.skillTurnGate._clearTurnState',
      persistStart,
    )
    const persistBlock = sendMessageBody.slice(persistStart, persistEnd)
    expect(persistBlock).toContain(
      'internal.agent._setThreadAgentAccessMode',
    )
    expect(persistBlock).toContain('activeWorkspaceId')
    expect(persistBlock).toContain('threadId')
    expect(persistBlock).toContain('agentAccessMode: accessMode')
  })

  it('sendMessage exposes the effective access mode to the agent runtime context', () => {
    expect(sendMessageBody).toMatch(
      /experimental_context:\s*\{[\s\S]*agentAccessMode:\s*accessMode/,
    )
  })
})

describe('Track-3 P2b.4 — startOnboarding lifecycle (intro path follows same pattern)', () => {
  const startOnboardingBody = (() => {
    const start = AGENT_SRC.indexOf('export const startOnboarding = action({')
    expect(start).toBeGreaterThan(0)
    const next = AGENT_SRC.indexOf('export const ', start + 1)
    return AGENT_SRC.slice(start, next > 0 ? next : AGENT_SRC.length)
  })()

  it('startOnboarding with intro saves the message before clearing turn state', () => {
    const saveIdx = startOnboardingBody.search(/dohcAgent\.saveMessage\(/)
    const clearIdx = startOnboardingBody.search(
      /internal\.skillTurnGate\._clearTurnState/,
    )
    expect(saveIdx).toBeGreaterThan(0)
    expect(clearIdx).toBeGreaterThan(0)
    expect(saveIdx).toBeLessThan(clearIdx)
  })

  it('startOnboarding lets the Agent SDK create the pending assistant turn', () => {
    const userSaveIdx = startOnboardingBody.indexOf(
      'const saved = await dohcAgent.saveMessage',
    )
    const streamIdx = startOnboardingBody.indexOf(
      'const result = await dohcAgent.streamText',
    )
    expect(userSaveIdx).toBeGreaterThan(0)
    expect(streamIdx).toBeGreaterThan(userSaveIdx)
    expect(startOnboardingBody).toMatch(/promptMessageId,\s*prepareStep:/)
    expect(startOnboardingBody).not.toContain('pendingMessageId')
  })

  it('startOnboarding forces explicit questionnaire starts past stale handoff leases', () => {
    expect(startOnboardingBody).toMatch(
      /claimKickoff,[\s\S]{0,160}force:\s*hasExplicitSetupBrief/,
    )
  })

  it('startOnboarding touches the setup thread before stream handoff', () => {
    const saveIdx = startOnboardingBody.indexOf(
      'const saved = await dohcAgent.saveMessage',
    )
    const touchIdx = startOnboardingBody.indexOf('internal.agent._touchThread')
    const selectionIdx = startOnboardingBody.indexOf(
      'internal.agent._setThreadAgentSelection',
    )
    const streamIdx = startOnboardingBody.indexOf(
      'const result = await dohcAgent.streamText',
    )
    expect(saveIdx).toBeGreaterThan(0)
    expect(touchIdx).toBeGreaterThan(saveIdx)
    expect(selectionIdx).toBeGreaterThan(saveIdx)
    expect(touchIdx).toBeLessThan(streamIdx)
    expect(selectionIdx).toBeLessThan(streamIdx)
  })

  it('startOnboarding passes prepareStep + experimental_context to streamText (both branches)', () => {
    expect(startOnboardingBody).toMatch(/prepareStep:\s*buildPrepareStep\(/)
    expect(startOnboardingBody).toMatch(/experimental_context:\s*\{/)
  })
})

describe('agent message listing diagnostics', () => {
  const listMessagesBody = (() => {
    const start = AGENT_SRC.indexOf('export const listMessages = query({')
    expect(start).toBeGreaterThan(0)
    const next = AGENT_SRC.indexOf('export const ', start + 1)
    return AGENT_SRC.slice(start, next > 0 ? next : AGENT_SRC.length)
  })()

  it('preserves failed assistant error text on UI messages', () => {
    expect(AGENT_SRC).toContain('listMessages as listAgentMessages')
    expect(listMessagesBody).toContain('const rawMessages = await listAgentMessages')
    expect(listMessagesBody).toContain('errorsByStep')
    expect(listMessagesBody).toMatch(/\.\.\.message,\s*error/)
  })
})

describe('agent attachment model-parts', () => {
  const buildAttachmentBody = (() => {
    const start = AGENT_SRC.indexOf('async function buildUserMessageForAttachments')
    expect(start).toBeGreaterThan(0)
    const next = AGENT_SRC.indexOf('function isInlineTextAttachment', start + 1)
    return AGENT_SRC.slice(start, next > 0 ? next : AGENT_SRC.length)
  })()

  it('does not send inline text files as provider file parts', () => {
    expect(AGENT_SRC).toContain('read_asset')
    expect(buildAttachmentBody).toContain('const inlineText =')
    expect(buildAttachmentBody).toContain('const sendModelImage =')
    expect(AGENT_SRC).toContain('function shouldSendModelImagePart')
    expect(AGENT_SRC).toContain("mediaType === 'image/png'")
    expect(AGENT_SRC).toContain("mediaType === 'image/jpeg'")
    expect(AGENT_SRC).toContain("mediaType === 'image/webp'")
    expect(buildAttachmentBody).toMatch(/if \(!inlineText && shouldSendModelFilePart\(asset\)\)/)
  })
})
