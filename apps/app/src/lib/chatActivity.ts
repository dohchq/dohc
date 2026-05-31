export type ToolActivityKind =
  | 'command'
  | 'read'
  | 'file_change'
  | 'search'
  | 'other'

export type ToolActivityPart = {
  type?: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

export type ToolActivityPresentation = {
  kind: ToolActivityKind
  toolName: string
  label: string
  detail: string | null
  state: string | null
  input: unknown
  output: unknown
  errorText: string | null
}

export function isToolActivityPart(part: { type?: string }): boolean {
  return Boolean(part.type?.startsWith('tool-'))
}

export function toolActivityKind(
  toolName: string,
  input?: Record<string, unknown>,
): ToolActivityKind {
  const name = toolName.toLowerCase()
  const kind = typeof input?.kind === 'string' ? input.kind.toLowerCase() : ''
  if (
    kind === 'execute' ||
    name.includes('command') ||
    name.includes('shell') ||
    name.includes('terminal') ||
    name.includes('exec')
  ) {
    return 'command'
  }
  if (
    kind === 'search' ||
    name.includes('search') ||
    name.includes('grep') ||
    name.includes('find') ||
    typeof input?.query === 'string' ||
    typeof input?.pattern === 'string'
  ) {
    return 'search'
  }
  if (
    kind === 'edit' ||
    kind === 'write' ||
    kind === 'move' ||
    kind === 'delete' ||
    name.includes('patch') ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('create') ||
    name.includes('delete') ||
    name.includes('rename')
  ) {
    return 'file_change'
  }
  if (
    kind === 'read' ||
    name.includes('read') ||
    name.includes('fetch') ||
    name.includes('open') ||
    typeof input?.path === 'string' ||
    typeof input?.filePath === 'string'
  ) {
    return 'read'
  }
  return 'other'
}

export function toolActivityLabel(
  kind: ToolActivityKind,
  fallback: string,
): string {
  if (kind === 'command') return 'Ran command'
  if (kind === 'search') return 'Searched'
  if (kind === 'file_change') return 'Changed file'
  if (kind === 'read') return 'Read file'
  return humanizeToolName(fallback)
}

export function summarizeToolInput(
  tool: string,
  input?: Record<string, unknown>,
): string | null {
  if (!input) return null
  if (typeof input.path === 'string') return input.path
  if (typeof input.filePath === 'string') return input.filePath
  if (typeof input.query === 'string') return input.query
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.searchTerm === 'string') return input.searchTerm
  if (typeof input.command === 'string') return input.command
  if (typeof input.cmd === 'string') return input.cmd
  if (Array.isArray(input.command)) {
    const command = input.command.filter((item) => typeof item === 'string')
    if (command.length > 0) return command.join(' ')
  }
  if (Array.isArray(input.cmd)) {
    const command = input.cmd.filter((item) => typeof item === 'string')
    if (command.length > 0) return command.join(' ')
  }
  if (typeof input.type === 'string' && typeof input.slug === 'string') {
    return `${input.type}/${input.slug}`
  }
  if (Array.isArray(input.items)) return `${input.items.length} items`
  if (typeof input.src === 'string') return input.src.slice(0, 80)
  if (typeof input.type === 'string') return String(input.type)
  return humanizeToolName(tool)
}

export function toolCallPresentation(
  part: ToolActivityPart,
): ToolActivityPresentation {
  const toolName = part.toolName ?? (part.type ?? 'tool').replace(/^tool-/, '')
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined
  const kind = toolActivityKind(toolName, input)
  return {
    kind,
    toolName,
    label: toolActivityLabel(kind, toolName),
    detail: summarizeToolInput(toolName, input),
    state: part.state ?? null,
    input: part.input,
    output: part.output,
    errorText: part.errorText ?? null,
  }
}

export function agentWorkTraceSummary(
  parts: ReadonlyArray<ToolActivityPart>,
): {
  total: number
  byKind: Record<ToolActivityKind, number>
  label: string
} {
  const byKind: Record<ToolActivityKind, number> = {
    command: 0,
    file_change: 0,
    other: 0,
    read: 0,
    search: 0,
  }
  for (const part of parts) {
    const presentation = toolCallPresentation(part)
    byKind[presentation.kind] += 1
  }
  const fragments = [
    pluralFragment('Changed', byKind.file_change, 'file'),
    pluralFragment('read', byKind.read, 'file'),
    pluralFragment('searched', byKind.search, 'time'),
    pluralFragment('ran', byKind.command, 'command'),
    pluralFragment('used', byKind.other, 'tool'),
  ].filter(Boolean)

  return {
    total: parts.length,
    byKind,
    label: fragments.join(', ') || 'Used tools',
  }
}

export function formatWorkedDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return 'a moment'
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  if (totalSeconds === 0) return '<1s'
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

export function formatToolPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const raw =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!raw) return null
  return raw.length > 4000 ? `${raw.slice(0, 4000)}\n...` : raw
}

function pluralFragment(
  verb: string,
  count: number,
  noun: string,
): string | null {
  if (count === 0) return null
  return `${verb} ${count} ${noun}${count === 1 ? '' : 's'}`
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/^tool-/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}
