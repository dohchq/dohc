/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UNAUTHORIZABLE_TOOLS,
  SAFE_FOR_SKILL_TOOLS,
  USER_TURN_TOOLS_NO_RUN_SKILL,
} from './agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

describe('agent workspace shell integration', () => {
  it('registers workspace shell tools with apply gated to direct user turns', () => {
    for (const tool of ['run_workspace_shell', 'discard_workspace_shell_diff']) {
      expect(AGENT_SRC).toContain(`${tool}: createTool({`)
      expect(SAFE_FOR_SKILL_TOOLS).toContain(tool)
      expect(USER_TURN_TOOLS_NO_RUN_SKILL).toContain(tool)
    }
    expect(AGENT_SRC).toContain('apply_workspace_shell_diff: createTool({')
    expect(UNAUTHORIZABLE_TOOLS).toContain('apply_workspace_shell_diff')
    expect(SAFE_FOR_SKILL_TOOLS).not.toContain('apply_workspace_shell_diff')
    expect(USER_TURN_TOOLS_NO_RUN_SKILL).toContain('apply_workspace_shell_diff')
  })

  it('teaches the model when to use shell and that shell output is not persisted until apply', () => {
    expect(AGENT_SRC).toContain('use shell for large data/file/app work')
    expect(AGENT_SRC).toContain('use dohc tools for permissions, approvals, sharing, app trust, and finalization')
    expect(AGENT_SRC).toContain('never claim shell changes are persisted until the diff is applied')
  })
})
