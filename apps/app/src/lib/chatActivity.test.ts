import { describe, expect, it } from 'vitest'
import {
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
