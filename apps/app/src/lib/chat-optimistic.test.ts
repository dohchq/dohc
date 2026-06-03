import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@convex-dev/agent/react'
import {
  optimisticTurnHasServerEcho,
  type OptimisticChatTurn,
} from './chat-optimistic'

function optimisticTurn(serverText: string): OptimisticChatTurn {
  return {
    id: 'local-1',
    displayText: serverText,
    serverText,
    createdAt: 1,
  }
}

function message(
  role: 'user' | 'assistant',
  text: string,
): UIMessage {
  return {
    key: `${role}-${text}`,
    role,
    parts: [{ type: 'text', text }],
  } as UIMessage
}

describe('optimistic chat turns', () => {
  it('keeps a local turn until the server echoes the same user text', () => {
    const turn = optimisticTurn('Move the invoice into Finance')

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('assistant', 'Thinking...'),
        message('user', 'Something else'),
      ]),
    ).toBe(false)

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('assistant', 'Thinking...'),
        message('user', 'Move the invoice into Finance'),
      ]),
    ).toBe(true)
  })

  it('matches the sent prompt text even when the displayed text is shorter', () => {
    const turn: OptimisticChatTurn = {
      id: 'local-skill',
      displayText: '$plan Launch notes',
      serverText: '.skills/plan.md\n\n$plan Launch notes',
      createdAt: 1,
    }

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('user', '.skills/plan.md\n\n$plan Launch notes'),
      ]),
    ).toBe(true)
  })
})
