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
    createdAt: 10,
    serverEchoAfter: 10,
    serverEchoCountBefore: 0,
  }
}

function message(
  role: 'user' | 'assistant',
  text: string,
  createdAt = 20,
): UIMessage {
  return {
    id: `${role}-${createdAt}-${text}`,
    key: `${role}-${createdAt}-${text}`,
    role,
    order: createdAt,
    stepOrder: 0,
    status: 'success',
    text,
    createdAt,
    _creationTime: createdAt,
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

  it('ignores older identical user messages when matching a server echo', () => {
    const turn = optimisticTurn('Try the same prompt again')

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('user', 'Try the same prompt again', 5),
      ]),
    ).toBe(false)

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('user', 'Try the same prompt again', 5),
        message('user', 'Try the same prompt again', 15),
      ]),
    ).toBe(true)
  })

  it('settles only the first matching optimistic turn for duplicate sends', () => {
    const first = {
      ...optimisticTurn('Repeat this'),
      id: 'local-1',
      serverEchoCountBefore: 0,
    }
    const second = {
      ...optimisticTurn('Repeat this'),
      id: 'local-2',
      serverEchoCountBefore: 1,
    }

    const firstEcho = [message('user', 'Repeat this', 15)]

    expect(optimisticTurnHasServerEcho(first, firstEcho)).toBe(true)
    expect(optimisticTurnHasServerEcho(second, firstEcho)).toBe(false)

    expect(
      optimisticTurnHasServerEcho(second, [
        ...firstEcho,
        message('user', 'Repeat this', 16),
      ]),
    ).toBe(true)
  })

  it('matches the sent prompt text even when the displayed text is shorter', () => {
    const turn: OptimisticChatTurn = {
      id: 'local-skill',
      displayText: '$plan Launch notes',
      serverText: '.skills/plan.md\n\n$plan Launch notes',
      createdAt: 10,
      serverEchoAfter: 10,
      serverEchoCountBefore: 0,
    }

    expect(
      optimisticTurnHasServerEcho(turn, [
        message('user', '.skills/plan.md\n\n$plan Launch notes'),
      ]),
    ).toBe(true)
  })
})
