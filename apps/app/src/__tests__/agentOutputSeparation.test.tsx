import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentActivityTimeline,
  agentActivityEventsFromMessage,
  agentMessageEventsFromMessage,
  agentRunDurationForMessage,
  assistantFinalMarkdownFromMessage,
  dedupeDuplicateUserPrompts,
} from '../components/AgentActivityTimeline'

const userMessage = (key: string, text: string, createdAt: number) => ({
  key,
  role: 'user',
  _creationTime: createdAt,
  parts: [{ type: 'text', text }],
})

describe('agent output separation', () => {
  it('keeps final markdown separate from progress and tool activity', () => {
    const message = {
      key: 'assistant-1',
      role: 'assistant',
      status: 'complete',
      _creationTime: 2_000,
      updatedAt: 8_000,
      parts: [
        { type: 'reasoning', text: 'Scanning files' },
        { type: 'tool-run_workspace_shell', toolName: 'run_workspace_shell', input: { command: 'rg' }, output: 'matched' },
        { type: 'tool-agent_gate', toolName: 'agent_gate', input: { kind: 'approval', path: 'old.md' } },
        { type: 'text', text: '## Final answer\n\n- **Done**' },
      ],
    }

    expect(assistantFinalMarkdownFromMessage(message)).toBe('## Final answer\n\n- **Done**')
    expect(agentMessageEventsFromMessage(message).map((event) => event.kind)).toEqual([
      'assistant_progress',
      'tool_call',
      'tool_result',
      'approval_request',
      'assistant_final',
    ])
    const events = agentActivityEventsFromMessage(message, {
      durationMs: agentRunDurationForMessage({
        previousMessage: userMessage('user-1', 'please check', 1_000),
        message,
        now: 9_000,
      }),
    })
    expect(events.map((event) => event.kind)).toEqual([
      'assistant_progress',
      'tool_call',
      'tool_result',
      'approval_request',
    ])
    expect(events.map((event) => event.text).join('\n')).not.toContain('Final answer')
  })

  it('renders a collapsed activity timeline with structured tools and duration', () => {
    const html = renderToStaticMarkup(
      createElement(AgentActivityTimeline, {
        complete: true,
        events: [
          { kind: 'assistant_progress', text: 'Scanning files' },
          { kind: 'tool_call', text: 'Ran command', detail: 'rg invoice' },
          { kind: 'tool_result', text: 'Tool result', detail: '3 matches' },
          { kind: 'approval_request', text: 'Approval requested', detail: 'Delete old file' },
          { kind: 'run_error', text: 'Run error', detail: 'timeout' },
        ],
        durationMs: 75_000,
      }),
    )

    expect(html).toContain('Agent activity')
    expect(html).toContain('1m 15s')
    expect(html).toContain('Ran command')
    expect(html).toContain('Approval requested')
    expect(html).not.toContain('<details open')
  })

  it('does not render duplicate echoed user prompts twice', () => {
    const messages = [
      userMessage('u1', 'same prompt', 100),
      userMessage('u1-copy', 'same prompt', 100),
      userMessage('u2', 'same prompt', 500),
    ]

    expect(dedupeDuplicateUserPrompts(messages).map((message) => message.key)).toEqual([
      'u1',
      'u2',
    ])
  })

  it('does not collapse unrelated user prompts when timestamps are missing', () => {
    const messages = [
      { key: 'u1', role: 'user', parts: [{ type: 'text', text: 'same prompt' }] },
      { key: 'u2', role: 'user', parts: [{ type: 'text', text: 'same prompt' }] },
    ]

    expect(dedupeDuplicateUserPrompts(messages).map((message) => message.key)).toEqual([
      'u1',
      'u2',
    ])
  })
})
