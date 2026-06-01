import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(new URL('./dev-sync.mjs', import.meta.url), 'utf8')

describe('dev-sync Hocuspocus Convex env', () => {
  it('syncs semantic admin env for local agent writes', () => {
    expect(SRC).toContain('DEFAULT_DEV_ADMIN_URL')
    expect(SRC).toContain('DEFAULT_DEV_ADMIN_TOKEN')
    expect(SRC).toContain('HOCUSPOCUS_ADMIN_URL')
    expect(SRC).toContain('HOCUSPOCUS_ADMIN_TOKEN')
    expect(SRC).toContain('ensureConvexHocuspocusEnv()')
  })
})
