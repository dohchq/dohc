import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('AppRuntimeHost collection RPC dispatch', () => {
  it('routes collection list/get reads through source-backed collectionData APIs', () => {
    const source = readFileSync(join(here, 'AppRuntimeHost.tsx'), 'utf8')

    expect(source).toContain("case 'dohc.collection.list'")
    expect(source).toContain('api.collectionData.list')
    expect(source).toContain("case 'dohc.collection.get'")
    expect(source).toContain('api.collectionData.get')
    expect(source).toContain("case 'dohc.collection.insert'")
    expect(source).toContain('api.appData.runCollectionMutation')
  })
})
