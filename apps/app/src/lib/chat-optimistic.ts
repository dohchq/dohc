import type { UIMessage } from '@convex-dev/agent/react'

export type OptimisticChatTurn = {
  id: string
  displayText: string
  serverText: string
  createdAt: number
  serverEchoAfter: number
}

export function uiMessageText(message: UIMessage): string {
  const direct = (message as { text?: unknown }).text
  if (typeof direct === 'string' && direct.length > 0) return direct
  return (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('')
}

export function optimisticTurnHasServerEcho(
  turn: OptimisticChatTurn,
  messages: ReadonlyArray<UIMessage>,
): boolean {
  const target = turn.serverText.trim()
  if (!target) return false
  return messages.some(
    (message) =>
      message.role === 'user' &&
      uiMessageText(message).trim() === target &&
      uiMessageTimestamp(message) > turn.serverEchoAfter,
  )
}

export function uiMessageTimestamp(message: UIMessage): number {
  const creationTime = (message as { _creationTime?: unknown })._creationTime
  if (typeof creationTime === 'number') return creationTime
  const createdAt = (message as { createdAt?: unknown }).createdAt
  return typeof createdAt === 'number' ? createdAt : 0
}

export function latestUserMessageTimestamp(
  messages: ReadonlyArray<UIMessage>,
): number {
  let latest = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    latest = Math.max(latest, uiMessageTimestamp(message))
  }
  return latest
}
