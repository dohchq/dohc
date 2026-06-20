import { describe, expect, it } from 'vitest'
import { isPlainTextAtomPath } from './source-kind.js'

describe('isPlainTextAtomPath', () => {
  it('treats site source files as plain text', () => {
    expect(isPlainTextAtomPath('sites/workspace/src/App.tsx')).toBe(true)
    expect(isPlainTextAtomPath('sites/workspace/index.html')).toBe(true)
    expect(isPlainTextAtomPath('finance/sites/ledger/styles.css')).toBe(true)
    expect(isPlainTextAtomPath('finance\\sites\\ledger\\config.json')).toBe(true)
  })

  it('does not classify arbitrary source-looking files as site source', () => {
    expect(isPlainTextAtomPath('src/App.tsx')).toBe(false)
    expect(isPlainTextAtomPath('notes/config.json')).toBe(false)
  })
})
