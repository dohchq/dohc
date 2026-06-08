import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(
  resolve(__dirname, '../../convex/agent.ts'),
  'utf8',
)
const CHAT_SRC = readFileSync(
  resolve(__dirname, '../components/Chat.tsx'),
  'utf8',
)

function toolBody(name: string): string {
  const re = /(\w+):\s*createTool\(\{/g
  const matches: Array<{ name: string; start: number }> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(AGENT_SRC))) {
    matches.push({ name: match[1], start: match.index })
  }
  const index = matches.findIndex((item) => item.name === name)
  if (index < 0) return ''
  const next = matches[index + 1]
  return AGENT_SRC.slice(matches[index].start, next ? next.start : AGENT_SRC.length)
}

describe('agent approvals UI/source contract', () => {
  it('destructive tools request structured approval instead of telling users to type yes', () => {
    for (const op of ['delete_atom', 'delete_entity', 'delete_folder']) {
      const body = toolBody(op)
      expect(body, `missing ${op} tool body`).toContain('requestAgentApproval')
      expect(body).not.toMatch(/CONFIRMATION REQUIRED|get an explicit yes|explicit "yes"|re-call with confirm:true/i)
    }
  })

  it('skill-turn gate message points to approval buttons, not typed confirmations', () => {
    expect(AGENT_SRC).toContain('approval')
    expect(AGENT_SRC).not.toMatch(/wait for an explicit "yes"|get an explicit yes/i)
  })

  it('chat renders pending approval actions with allow, always allow, and deny decisions', () => {
    expect(CHAT_SRC).toContain('api.agent.listPendingApprovals')
    expect(CHAT_SRC).toContain('api.agent.respondToApproval')
    expect(CHAT_SRC).toContain('Allow')
    expect(CHAT_SRC).toContain('Always allow')
    expect(CHAT_SRC).toContain('Deny')
  })

  it('chat resumes the agent automatically after an approved button decision', () => {
    expect(CHAT_SRC).toContain('resumePrompt')
    expect(CHAT_SRC).toContain('resumeDisplayText')
    expect(CHAT_SRC).toContain('attachmentIds: []')
    expect(CHAT_SRC).toMatch(/await\s+sendResolvedPrompt\(\{[\s\S]*resumePrompt/)
  })
})
