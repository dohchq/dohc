export type AgentAccessMode = 'default' | 'auto-review' | 'full-access'

export const DEFAULT_AGENT_ACCESS_MODE: AgentAccessMode = 'default'

export const AGENT_ACCESS_MODE_OPTIONS: ReadonlyArray<{
  value: AgentAccessMode
  label: string
  description: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    description: 'Use dohc review gates for writes, sharing, and destructive work.',
  },
  {
    value: 'auto-review',
    label: 'Auto-review',
    description: 'Let dohc review low-risk work while preserving required gates.',
  },
  {
    value: 'full-access',
    label: 'Full access',
    description: 'Proceed freely inside this workspace, bounded by dohc safeguards.',
  },
]

export function normalizeAgentAccessMode(
  value: unknown,
): AgentAccessMode {
  return AGENT_ACCESS_MODE_OPTIONS.some((option) => option.value === value)
    ? (value as AgentAccessMode)
    : DEFAULT_AGENT_ACCESS_MODE
}
