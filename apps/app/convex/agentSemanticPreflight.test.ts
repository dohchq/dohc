import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentRuntimeSystemPrompt,
  checkSemanticWriteBackend,
  semanticWriteBackendStatusBlock,
  withSemanticWriteBackendStatus,
} from './agent'

afterEach(() => {
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
    expect(prompt).toContain('You are dohc')
  })
})
