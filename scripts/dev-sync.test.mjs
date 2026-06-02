import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DEV_ADMIN_TOKEN,
  DEFAULT_DEV_ADMIN_URL,
  DEFAULT_DEV_CONVEX_SERVER_TOKEN,
  ensureConvexHocuspocusEnv,
  hocuspocusReady,
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

afterEach(() => {
  vi.unstubAllGlobals()
})

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
      {
        command: 'set',
        args: ['HOCUSPOCUS_CONVEX_SERVER_TOKEN', DEFAULT_DEV_CONVEX_SERVER_TOKEN],
        options: { stdio: 'inherit' },
      },
    ])
  })

  it('does not update Convex env when values already match', () => {
    const { calls, runConvexEnv } = makeConvexEnv({
      HOCUSPOCUS_JWT_SECRET: 'jwt-secret',
      HOCUSPOCUS_ADMIN_URL: 'http://admin.local',
      HOCUSPOCUS_ADMIN_TOKEN: 'admin-token',
      HOCUSPOCUS_CONVEX_SERVER_TOKEN: 'server-token',
    })

    ensureConvexHocuspocusEnv({
      env: {
        HOCUSPOCUS_JWT_SECRET: 'jwt-secret',
        HOCUSPOCUS_ADMIN_URL: 'http://admin.local',
        HOCUSPOCUS_ADMIN_TOKEN: 'admin-token',
        HOCUSPOCUS_CONVEX_SERVER_TOKEN: 'server-token',
      },
      runConvexEnv,
    })

    expect(calls.map((call) => call.command)).toEqual(['get', 'get', 'get', 'get'])
  })

  it('sets blank Convex env values instead of treating them as unreadable', () => {
    const { calls, runConvexEnv } = makeConvexEnv({
      HOCUSPOCUS_JWT_SECRET: '',
      HOCUSPOCUS_ADMIN_URL: '',
      HOCUSPOCUS_ADMIN_TOKEN: '',
      HOCUSPOCUS_CONVEX_SERVER_TOKEN: '',
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
      {
        command: 'set',
        args: ['HOCUSPOCUS_CONVEX_SERVER_TOKEN', DEFAULT_DEV_CONVEX_SERVER_TOKEN],
        options: { stdio: 'inherit' },
      },
    ])
  })

  it('exposes the Convex URL and server token to docker compose for local Hocuspocus bootstrap', () => {
    const { runConvexEnv } = makeConvexEnv({
      HOCUSPOCUS_JWT_SECRET: 'jwt-secret',
      HOCUSPOCUS_ADMIN_URL: DEFAULT_DEV_ADMIN_URL,
      HOCUSPOCUS_ADMIN_TOKEN: DEFAULT_DEV_ADMIN_TOKEN,
      HOCUSPOCUS_CONVEX_SERVER_TOKEN: DEFAULT_DEV_CONVEX_SERVER_TOKEN,
    })
    const env = {
      VITE_CONVEX_URL: 'https://example.convex.cloud',
    }

    ensureConvexHocuspocusEnv({ env, runConvexEnv })

    expect(env.HOCUSPOCUS_CONVEX_URL).toBe('https://example.convex.cloud')
    expect(env.HOCUSPOCUS_CONVEX_SERVER_TOKEN).toBe(
      DEFAULT_DEV_CONVEX_SERVER_TOKEN,
    )
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

describe('dev-sync Hocuspocus readiness', () => {
  it('requires Convex bootstrap support so stale dev containers are rebuilt', async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url).includes('/healthz')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (String(url).includes('/capabilities')) {
        return new Response(
          JSON.stringify({
            ok: true,
            capabilities: { atomBootstrap: false },
          }),
          { status: 200 },
        )
      }
      if (String(url).includes('/apply/preflight')) {
        return new Response(
          JSON.stringify({
            ok: true,
            semanticWrites: true,
            createAtom: true,
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    await expect(hocuspocusReady()).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/capabilities')
  })

  it('requires createAtom support before treating Hocuspocus as ready', async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url).includes('/healthz')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (String(url).includes('/capabilities')) {
        return new Response(
          JSON.stringify({
            ok: true,
            capabilities: { atomBootstrap: true },
          }),
          { status: 200 },
        )
      }
      if (String(url).includes('/apply/preflight')) {
        return new Response(
          JSON.stringify({
            ok: true,
            semanticWrites: true,
            createAtom: false,
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    await expect(hocuspocusReady()).resolves.toBe(false)
  })

  it('probes the configured admin URL instead of the default localhost base', async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url) === 'http://hocuspocus.test:4567/healthz') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (String(url) === 'http://hocuspocus.test:4567/capabilities') {
        return new Response(
          JSON.stringify({
            ok: true,
            capabilities: { atomBootstrap: true },
          }),
          { status: 200 },
        )
      }
      if (String(url) === 'http://hocuspocus.test:4567/apply/preflight') {
        return new Response(
          JSON.stringify({
            ok: true,
            semanticWrites: true,
            createAtom: true,
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    await expect(
      hocuspocusReady({
        HOCUSPOCUS_ADMIN_URL: 'http://hocuspocus.test:4567',
        HOCUSPOCUS_ADMIN_TOKEN: 'admin-token',
      }),
    ).resolves.toBe(true)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://hocuspocus.test:4567/healthz',
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://hocuspocus.test:4567/capabilities',
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'http://hocuspocus.test:4567/apply/preflight',
      { headers: { authorization: 'Bearer admin-token' } },
    )
  })
})
