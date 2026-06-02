import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DEV_ADMIN_TOKEN,
  DEFAULT_DEV_ADMIN_URL,
  ensureConvexHocuspocusEnv,
} from './dev-sync.mjs'

function makeConvexEnv(existing = {}) {
  const calls = []
  const runConvexEnv = vi.fn((command, args, options = {}) => {
    calls.push({ command, args, options })
    if (command === 'get') {
      const value = existing[args[0]]
      return value === undefined
        ? { status: 1, stdout: '', stderr: 'not found' }
        : { status: 0, stdout: `${value}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  })
  return { calls, runConvexEnv }
}

describe('dev-sync Hocuspocus Convex env', () => {
  it('sets semantic admin env for local agent writes when Convex env is missing', () => {
    const { calls, runConvexEnv } = makeConvexEnv()

    ensureConvexHocuspocusEnv({ env: {}, runConvexEnv })

    expect(calls.filter((call) => call.command === 'set')).toEqual([
      {
        command: 'set',
        args: [
          'HOCUSPOCUS_JWT_SECRET',
          'dev-jwt-secret-change-me-with-at-least-32-bytes',
        ],
        options: { stdio: 'inherit' },
      },
      {
        command: 'set',
        args: ['HOCUSPOCUS_ADMIN_URL', DEFAULT_DEV_ADMIN_URL],
        options: { stdio: 'inherit' },
      },
      {
        command: 'set',
        args: ['HOCUSPOCUS_ADMIN_TOKEN', DEFAULT_DEV_ADMIN_TOKEN],
        options: { stdio: 'inherit' },
      },
    ])
  })

  it('does not update Convex env when values already match', () => {
    const { calls, runConvexEnv } = makeConvexEnv({
      HOCUSPOCUS_JWT_SECRET: 'jwt-secret',
      HOCUSPOCUS_ADMIN_URL: 'http://admin.local',
      HOCUSPOCUS_ADMIN_TOKEN: 'admin-token',
    })

    ensureConvexHocuspocusEnv({
      env: {
        HOCUSPOCUS_JWT_SECRET: 'jwt-secret',
        HOCUSPOCUS_ADMIN_URL: 'http://admin.local',
        HOCUSPOCUS_ADMIN_TOKEN: 'admin-token',
      },
      runConvexEnv,
    })

    expect(calls.map((call) => call.command)).toEqual(['get', 'get', 'get'])
  })

  it('sets blank Convex env values instead of treating them as unreadable', () => {
    const { calls, runConvexEnv } = makeConvexEnv({
      HOCUSPOCUS_JWT_SECRET: '',
      HOCUSPOCUS_ADMIN_URL: '',
      HOCUSPOCUS_ADMIN_TOKEN: '',
    })

    ensureConvexHocuspocusEnv({ env: {}, runConvexEnv })

    expect(calls.filter((call) => call.command === 'set')).toEqual([
      {
        command: 'set',
        args: [
          'HOCUSPOCUS_JWT_SECRET',
          'dev-jwt-secret-change-me-with-at-least-32-bytes',
        ],
        options: { stdio: 'inherit' },
      },
      {
        command: 'set',
        args: ['HOCUSPOCUS_ADMIN_URL', DEFAULT_DEV_ADMIN_URL],
        options: { stdio: 'inherit' },
      },
      {
        command: 'set',
        args: ['HOCUSPOCUS_ADMIN_TOKEN', DEFAULT_DEV_ADMIN_TOKEN],
        options: { stdio: 'inherit' },
      },
    ])
  })

  it('skips Convex env sync when explicitly disabled', () => {
    const { calls, runConvexEnv } = makeConvexEnv()

    ensureConvexHocuspocusEnv({
      env: { DOHC_SKIP_CONVEX_ENV_SYNC: '1' },
      runConvexEnv,
    })

    expect(calls).toEqual([])
  })
})
