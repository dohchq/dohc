import type { UIMessage } from '@convex-dev/agent/react'
import { collapsePastedFileBlocks } from './pastedFileDisplay'

export type OptimisticChatTurn = {
  id: string
  displayText: string
  serverText: string
  createdAt: number
  serverEchoAfter: number
  serverEchoCountBefore: number
}

export function uiMessageText(message: UIMessage): string {
  const direct = (message as { text?: unknown }).text
  if (typeof direct === 'string' && direct.length > 0) return direct
  return (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('')
}

export function uiMessageDisplayText(message: UIMessage): string {
  return collapsePastedFileBlocks(uiMessageText(message))
}

export function optimisticTurnHasServerEcho(
  turn: OptimisticChatTurn,
  messages: ReadonlyArray<UIMessage>,
): boolean {
  return (
    matchingUserEchoCount(messages, turn.serverText, turn.serverEchoAfter) >
    turn.serverEchoCountBefore
  )
}

export function matchingUserEchoCount(
  messages: ReadonlyArray<UIMessage>,
  serverText: string,
  after: number,
): number {
  const target = serverText.trim()
  if (!target) return 0
  let count = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (uiMessageTimestamp(message) <= after) continue
    if (uiMessageText(message).trim() === target) count += 1
  }
  return count
}

export function pendingTurnEchoCountBefore(
  turns: ReadonlyArray<OptimisticChatTurn>,
  serverText: string,
  serverEchoAfter: number,
): number {
  const target = serverText.trim()
  if (!target) return 0
  let count = 0
  for (const turn of turns) {
    if (turn.serverEchoAfter !== serverEchoAfter) continue
    if (turn.serverText.trim() === target) count += 1
  }
  return count
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
