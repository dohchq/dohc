import { describe, expect, it } from 'vitest'
import {
  AGENT_ACCESS_MODE_OPTIONS,
  DEFAULT_AGENT_ACCESS_MODE,
  normalizeAgentAccessMode,
  type AgentAccessMode,
} from './agentAccess'

describe('agent chat access modes', () => {
  it('matches the dohc-first access menu labels', () => {
    expect(DEFAULT_AGENT_ACCESS_MODE).toBe('default')
    expect(AGENT_ACCESS_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'default',
      'auto-review',
      'full-access',
    ] satisfies AgentAccessMode[])
    expect(AGENT_ACCESS_MODE_OPTIONS.map((option) => option.label)).toEqual([
      'Default permissions',
      'Auto-review',
      'Full access',
    ])
  })

  it('normalizes unknown or missing values back to default permissions', () => {
    expect(normalizeAgentAccessMode('auto-review')).toBe('auto-review')
    expect(normalizeAgentAccessMode('full-access')).toBe('full-access')
    expect(normalizeAgentAccessMode('surprise')).toBe('default')
    expect(normalizeAgentAccessMode(null)).toBe('default')
    expect(normalizeAgentAccessMode(undefined)).toBe('default')
  })
})
