import { describe, expect, it } from 'vitest'
import { inlineAtomsEnabled } from './featureFlags'

describe('inlineAtomsEnabled', () => {
  it('is always on because {} atoms are the live data surface', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => '0',
        setItem: () => undefined,
      },
    })

    expect(inlineAtomsEnabled()).toBe(true)
  })
})
