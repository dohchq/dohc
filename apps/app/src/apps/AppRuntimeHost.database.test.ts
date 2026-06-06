import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('AppRuntimeHost database RPC dispatch', () => {
  it('routes database SDK calls through first-class database APIs', () => {
    const source = readFileSync(join(here, 'AppRuntimeHost.tsx'), 'utf8')

    expect(source).toContain("case 'dohc.database.tables'")
    expect(source).toContain('api.databaseFiles.appTables')
    expect(source).toContain("case 'dohc.database.query'")
    expect(source).toContain('api.databaseFiles.appQuery')
    expect(source).toContain('api.databaseFiles.appCollectionRows')
    expect(source).toContain('api.databaseOps.appApply')
    expect(source).toContain('expectedVersion: request.args.expectedVersion')
  })
})
