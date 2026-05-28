import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasIndexeddbYDocState, markIndexeddbYDocState } from './indexeddbState'

function stubStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('IndexedDB Y.Doc state detection', () => {
  it('uses a successful-sync marker when database enumeration is unavailable', async () => {
    vi.stubGlobal('indexedDB', {})
    stubStorage()

    markIndexeddbYDocState('workspace/ws/atom/doc')

    await expect(
      hasIndexeddbYDocState('workspace/ws/atom/doc'),
    ).resolves.toBe(true)
  })

  it('does not assume a cache exists without enumeration or a marker', async () => {
    vi.stubGlobal('indexedDB', {})
    stubStorage()

    await expect(
      hasIndexeddbYDocState('workspace/ws/atom/missing'),
    ).resolves.toBe(false)
  })
})
