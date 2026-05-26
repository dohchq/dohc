import { describe, expect, it } from 'vitest'
import { humanizeQuery } from './AtomEditor'

describe('query block chrome', () => {
  it('does not label empty query blocks as live data', () => {
    expect(humanizeQuery('')).toBeNull()
    expect(humanizeQuery('   \n\t')).toBeNull()
  })
})
