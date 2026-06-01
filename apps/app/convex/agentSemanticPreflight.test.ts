import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkSemanticWriteBackend,
  semanticWriteBackendStatusBlock,
  withSemanticWriteBackendStatus,
} from './agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

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
  })

  it('injects the preflight status into each runtime system prompt before streaming', () => {
    expect(SRC).toContain('checkSemanticWriteBackend()')
    expect(SRC).toContain('withSemanticWriteBackendStatus(')
    expect(SRC).toContain('system: systemPrompt')
  })
})
