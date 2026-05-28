import { describe, expect, it } from 'vitest'
import { isQueryFenceLanguage, QUERY_FENCE_RE } from './dslparse'

function collectQuerySources(markdown: string): string[] {
  QUERY_FENCE_RE.lastIndex = 0
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = QUERY_FENCE_RE.exec(markdown)) !== null) {
    out.push((match[2] ?? '').trim())
  }
  return out
}

describe('query fence parsing', () => {
  it('accepts legacy query fences and v2 dohc-query fences', () => {
    expect(
      collectQuerySources(
        [
          '```query',
          'vault.find("notes")',
          '```',
          '```dohc-query',
          'tasks.list("open")',
          '```',
        ].join('\n'),
      ),
    ).toEqual(['vault.find("notes")', 'tasks.list("open")'])
  })

  it('recognizes both query block language names', () => {
    expect(isQueryFenceLanguage('query')).toBe(true)
    expect(isQueryFenceLanguage('dohc-query')).toBe(true)
    expect(isQueryFenceLanguage('ts')).toBe(false)
  })
})
