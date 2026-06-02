import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentRuntimeSystemPrompt,
  buildAgentTurnSystemPrompt,
  checkSemanticWriteBackend,
  semanticWriteBackendStatusBlock,
  withSemanticWriteBackendStatus,
} from './agent'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('agent semantic write backend preflight', () => {
  it('reports missing Hocuspocus admin env as an offline write backend', async () => {
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', '')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const status = await checkSemanticWriteBackend()

    expect(status).toMatchObject({ ok: false, reason: 'missing-env' })
    expect(fetch).not.toHaveBeenCalled()
    expect(semanticWriteBackendStatusBlock(status)).toContain(
      'Semantic write backend: offline',
    )
    expect(semanticWriteBackendStatusBlock(status)).toContain(
      'Do not say you can create',
    )
    expect(semanticWriteBackendStatusBlock(status)).not.toContain(
      'HOCUSPOCUS_ADMIN_TOKEN',
    )
  })

  it('checks the token-protected semantic preflight endpoint', async () => {
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', 'http://hocuspocus.local:1234')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', 'admin-token')
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, semanticWrites: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetch)

    const status = await checkSemanticWriteBackend()

    expect(status).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledWith(
      'http://hocuspocus.local:1234/apply/preflight',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer admin-token',
        }),
      }),
    )
    expect(withSemanticWriteBackendStatus('base prompt', status)).toContain(
      'Semantic write backend: online',
    )
    expect(withSemanticWriteBackendStatus('base prompt', status)).not.toContain(
      'hocuspocus.local',
    )
  })

  it('builds runtime system prompts with the live preflight status before streaming', async () => {
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', 'http://hocuspocus.local:1234')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', 'admin-token')
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, semanticWrites: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const runQuery = vi.fn(async () => ({ kind: 'personal' as const }))

    const prompt = await buildAgentRuntimeSystemPrompt(
      { runQuery } as never,
      'workspace_1',
    )

    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      activeWorkspaceId: 'workspace_1',
    })
    expect(fetch).toHaveBeenCalledWith(
      'http://hocuspocus.local:1234/apply/preflight',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(prompt).toContain('Semantic write backend: online.')
    expect(prompt).toContain('Default permissions')
    expect(prompt).toContain('You are dohc')
  })

  it('times out a hung semantic preflight endpoint', async () => {
    vi.useFakeTimers()
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', 'http://hocuspocus.local:1234')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', 'admin-token')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TIMEOUT_MS', '5000')
    const fetch = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    vi.stubGlobal('fetch', fetch)

    const status = checkSemanticWriteBackend()
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(status).resolves.toMatchObject({
      ok: false,
      reason: 'unreachable',
      detail: 'Hocuspocus request timed out after 5000ms.',
    })
  })

  it('injects the preflight status into the runtime system prompt', () => {
    const prompt = buildAgentTurnSystemPrompt(
      { kind: 'personal' },
      {
        ok: false,
        reason: 'missing-env',
        detail: 'offline for test',
      },
      'auto-review',
    )

    expect(prompt).toContain('Semantic write backend: offline')
    expect(prompt).not.toContain('offline for test')
    expect(prompt).toContain('The user selected Auto-review')
  })
})
