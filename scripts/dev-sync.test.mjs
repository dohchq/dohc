import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DEV_ADMIN_TOKEN,
  DEFAULT_DEV_ADMIN_URL,
  ensureConvexHocuspocusEnv,
} from './dev-sync.mjs'

function okGet(value = '') {
  return { status: 0, stdout: value, stderr: '' }
}

describe('dev-sync Hocuspocus Convex env', () => {
  it('sets local semantic admin env in Convex when values are missing', () => {
    const convexEnv = vi.fn((command) =>
      command === 'get' ? { status: 1, stdout: '', stderr: 'not found' } : okGet(),
    )

    ensureConvexHocuspocusEnv({
      env: {},
      convexEnv,
    })

    expect(convexEnv).toHaveBeenCalledWith('set', [
      'HOCUSPOCUS_ADMIN_URL',
      DEFAULT_DEV_ADMIN_URL,
    ], {
      stdio: 'inherit',
    })
    expect(convexEnv).toHaveBeenCalledWith('set', [
      'HOCUSPOCUS_ADMIN_TOKEN',
      DEFAULT_DEV_ADMIN_TOKEN,
    ], {
      stdio: 'inherit',
    })
  })

  it('respects DOHC_SKIP_CONVEX_ENV_SYNC without touching Convex env', () => {
    const convexEnv = vi.fn()

    ensureConvexHocuspocusEnv({
      env: {
        DOHC_SKIP_CONVEX_ENV_SYNC: '1',
        HOCUSPOCUS_ADMIN_URL: 'http://example.invalid',
        HOCUSPOCUS_ADMIN_TOKEN: 'token',
      },
      convexEnv,
    })

    expect(convexEnv).not.toHaveBeenCalled()
  })
})
