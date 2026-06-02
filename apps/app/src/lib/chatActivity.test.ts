import { describe, expect, it } from 'vitest'
import {
  agentWorkTraceSummary,
  formatToolPayload,
  formatWorkedDuration,
  toolCallPresentation,
} from './chatActivity'

describe('chat activity presentation', () => {
  it('formats agent worked duration labels', () => {
    expect(formatWorkedDuration(800)).toBe('<1s')
    expect(formatWorkedDuration(15_000)).toBe('15s')
    expect(formatWorkedDuration(75_000)).toBe('1m 15s')
    expect(formatWorkedDuration(15 * 60_000 + 55_000)).toBe('15m 55s')
    expect(formatWorkedDuration(2 * 60 * 60_000 + 3 * 60_000 + 4_000)).toBe(
      '2h 03m',
    )
  })

  it('summarizes tool work into human activity instead of raw tool names', () => {
    const calls = [
      { type: 'tool-read_atom', input: { path: 'notes/plan.md' } },
      { type: 'tool-search', input: { query: 'agent view' } },
      { type: 'tool-apply_patch', input: { path: 'apps/app/src/Chat.tsx' } },
      { type: 'tool-exec_command', input: { cmd: 'vitest run' } },
    ]

    expect(agentWorkTraceSummary(calls)).toEqual({
      total: 4,
      byKind: {
        command: 1,
        file_change: 1,
        other: 0,
        read: 1,
        search: 1,
      },
      label: 'Changed 1 file, read 1 file, searched 1 time, ran 1 command',
    })
  })

  it('capitalizes the first work summary fragment even without file edits', () => {
    const calls = [
      { type: 'tool-read_atom', input: { path: 'notes/plan.md' } },
      { type: 'tool-search', input: { query: 'agent view' } },
    ]

    expect(agentWorkTraceSummary(calls).label).toBe(
      'Read 1 file, searched 1 time',
    )
  })

  it('derives compact labels and expandable payloads for individual tools', () => {
    const presentation = toolCallPresentation({
      type: 'tool-exec_command',
      input: { command: ['git', 'diff', '--check'] },
      state: 'output-available',
      output: { ok: true },
    })

    expect(presentation).toMatchObject({
      kind: 'command',
      label: 'Ran command',
      detail: 'git diff --check',
      state: 'output-available',
    })
    expect(formatToolPayload({ command: ['git', 'diff', '--check'] })).toBe(
      '{\n  "command": [\n    "git",\n    "diff",\n    "--check"\n  ]\n}',
    )
  })
})
