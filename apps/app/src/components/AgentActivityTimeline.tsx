import { memo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  ListChecks,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react'
import {
  formatToolPayload,
  formatWorkedDuration,
  isToolActivityPart,
  toolCallPresentation,
  type ToolActivityPart,
} from '../lib/chatActivity'

export type AgentActivityEventKind =
  | 'assistant_progress'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_result'
  | 'assistant_final'
  | 'run_error'

export type AgentActivityEvent = {
  kind: AgentActivityEventKind
  text: string
  detail?: string | null
}

type MessageLike = {
  key?: string
  role?: string
  status?: string
  _creationTime?: number
  updatedAt?: number
  error?: unknown
  parts?: Array<Record<string, unknown>>
}

function textPartsMarkdownFromMessage(message: MessageLike): string {
  return (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
}

export function assistantFinalMarkdownFromMessage(message: MessageLike): string {
  return textPartsMarkdownFromMessage(message)
}

export function agentRunDurationForMessage({
  previousMessage,
  message,
  now,
}: {
  previousMessage: MessageLike | null
  message: MessageLike
  now: number
}): number | null {
  const previousTime =
    previousMessage?.role === 'user' ? previousMessage._creationTime : null
  if (typeof previousTime !== 'number') return null
  const end =
    message.status === 'streaming'
      ? now
      : typeof message.updatedAt === 'number'
        ? message.updatedAt
        : message._creationTime
  if (typeof end !== 'number') return null
  return Math.max(0, end - previousTime)
}

export function agentMessageEventsFromMessage(
  message: MessageLike,
  _options: { durationMs?: number | null } = {},
): AgentActivityEvent[] {
  const events: AgentActivityEvent[] = []
  for (const part of message.parts ?? []) {
    if (part.type === 'reasoning') {
      const text = typeof part.text === 'string' ? part.text.trim() : ''
      if (text) events.push({ kind: 'assistant_progress', text })
      continue
    }
    if (!isToolActivityPart(part)) continue
    const presentation = toolCallPresentation(part as ToolActivityPart)
    if (presentation.kind === 'approval') {
      events.push({
        kind: presentation.state === 'result' ? 'approval_result' : 'approval_request',
        text: presentation.label,
        detail: presentation.detail,
      })
      continue
    }
    events.push({
      kind: 'tool_call',
      text: presentation.label,
      detail: presentation.detail,
    })
    const output =
      presentation.errorText ?? formatToolPayload(presentation.output)
    if (output) {
      events.push({
        kind: 'tool_result',
        text: presentation.errorText ? 'Tool error' : 'Tool result',
        detail: output,
      })
    }
  }
  if (message.status === 'failed') {
    events.push({
      kind: 'run_error',
      text: 'Run error',
      detail:
        typeof message.error === 'string'
          ? message.error
          : message.error
            ? String(message.error)
            : null,
    })
  }
  const finalMarkdown = assistantFinalMarkdownFromMessage(message)
  if (finalMarkdown.trim()) {
    events.push({
      kind: 'assistant_final',
      text: 'Final answer',
      detail: finalMarkdown,
    })
  }
  return events
}

export function agentActivityEventsFromMessage(
  message: MessageLike,
  options: { durationMs?: number | null } = {},
): AgentActivityEvent[] {
  return agentMessageEventsFromMessage(message, options).filter(
    (event) => event.kind !== 'assistant_final',
  )
}

export function dedupeDuplicateUserPrompts<T extends MessageLike>(
  messages: T[],
): T[] {
  const seen = new Set<string>()
  return messages.filter((message, index) => {
    if (message.role !== 'user') return true
    const text = textPartsMarkdownFromMessage(message)
    const timestampKey =
      typeof message._creationTime === 'number'
        ? String(message._creationTime)
        : `missing:${message.key ?? index}`
    const key = `${timestampKey}\u0000${text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const AgentActivityTimeline = memo(function AgentActivityTimeline({
  events,
  durationMs = null,
  complete,
  compact = false,
}: {
  events: AgentActivityEvent[]
  durationMs?: number | null
  complete: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(!complete)
  if (events.length === 0) return null
  const duration = formatWorkedDuration(durationMs)

  return (
    <details
      className={`${compact ? 'text-[11px]' : 'text-[12px]'} rounded-md border border-rule bg-panel/45`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink [&::-webkit-details-marker]:hidden">
        <ListChecks className="size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate font-medium">
          Agent activity
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
          {duration}
        </span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.8}
        />
      </summary>
      <div className="space-y-1.5 px-2.5 pb-2">
        {events.map((event, index) => (
          <ActivityRow key={`${event.kind}-${index}`} event={event} />
        ))}
      </div>
    </details>
  )
})

function ActivityRow({ event }: { event: AgentActivityEvent }) {
  const Icon =
    event.kind === 'tool_call'
      ? SquareTerminal
      : event.kind === 'tool_result'
        ? CheckCircle2
        : event.kind === 'approval_request' || event.kind === 'approval_result'
          ? ShieldCheck
          : event.kind === 'run_error'
            ? AlertCircle
            : FileDiff
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-ink-dim">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-ink">
          {event.text}
        </div>
        {event.detail && (
          <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug text-ink-faint">
            {event.detail}
          </div>
        )}
      </div>
    </div>
  )
}
