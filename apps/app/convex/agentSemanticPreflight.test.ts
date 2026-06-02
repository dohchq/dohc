import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentRuntimeSystemPrompt,
  buildAgentTurnSystemPrompt,
  checkSemanticWriteBackend,
  createAtomDirectlyForAgent,
  projectScopedCreatePathViolation,
  semanticWriteBackendStatusBlock,
  withSemanticWriteBackendStatus,
} from './agent'
import { internal } from './_generated/api'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('agent semantic write backend preflight', () => {
  it('keeps new atom writes available when Hocuspocus admin env is missing', async () => {
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', '')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const status = await checkSemanticWriteBackend()

    expect(status).toMatchObject({ ok: true, mode: 'direct-create' })
    expect(fetch).not.toHaveBeenCalled()
    expect(semanticWriteBackendStatusBlock(status)).toContain(
      'New atom writes: online',
    )
    expect(semanticWriteBackendStatusBlock(status)).toContain(
      'Existing-document semantic edits: offline',
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

    expect(status).toMatchObject({ ok: true, mode: 'semantic' })
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

  it('falls back to create-only writes when Hocuspocus admin is unreachable from Convex', async () => {
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', 'http://127.0.0.1:1234')
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', 'admin-token')
    const fetch = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    vi.stubGlobal('fetch', fetch)

    const status = await checkSemanticWriteBackend()

    expect(status).toMatchObject({ ok: true, mode: 'direct-create' })
    const block = semanticWriteBackendStatusBlock(status)
    expect(block).toContain('New atom writes: online')
    expect(block).toContain('Existing-document semantic edits: offline')
    expect(block).not.toContain('Semantic write backend: offline')
  })

  it('direct create fallback routes through Convex atom gates with the viewer subject', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('---\nid: atom_direct\n---\nBody')
    const runMutation = vi.fn(async () => 'atom_row')

    const result = await createAtomDirectlyForAgent(
      { runQuery, runMutation } as never,
      {
        workspaceId: 'workspace_1',
        path: 'notes/direct.md',
        content: 'Body',
        actor: {
          userId: 'user_1',
          actorKind: 'agent',
        },
      },
    )

    expect(runQuery).toHaveBeenCalledWith(internal.atoms._getInternal, {
      workspaceId: 'workspace_1',
      path: 'notes/direct.md',
      viewerSubject: 'user_1',
    })
    expect(runMutation).toHaveBeenCalledWith(internal.atoms._upsertInternal, {
      workspaceId: 'workspace_1',
      path: 'notes/direct.md',
      body: 'Body',
      source: 'agent',
      viewerSubject: 'user_1',
    })
    expect(result).toEqual({ ok: true, atomId: 'atom_direct' })
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
      ok: true,
      mode: 'direct-create',
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
      undefined,
    )

    expect(prompt).toContain('Semantic write backend: offline')
    expect(prompt).not.toContain('offline for test')
    expect(prompt).toContain('The user selected Auto-review')
  })

  it('injects active project scope into the runtime system prompt', () => {
    const prompt = buildAgentTurnSystemPrompt(
      { kind: 'personal' },
      { ok: true, mode: 'direct-create', detail: 'test' },
      'default',
      'valorant',
    )

    expect(prompt).toContain('## ACTIVE PROJECT SCOPE')
    expect(prompt).toContain('This chat is scoped to `valorant/`')
    expect(prompt).toContain('write under `valorant/...`')
    expect(prompt).toContain('Do not create sibling taxonomies')
  })

  it('refuses project-chat create paths outside the active folder', () => {
    expect(
      projectScopedCreatePathViolation('valorant/profile.md', 'valorant'),
    ).toBeNull()
    expect(
      projectScopedCreatePathViolation(
        'valorant/.views/home/src/App.tsx',
        'valorant',
      ),
    ).toBeNull()
    expect(
      projectScopedCreatePathViolation('games/valorant/profile.md', 'valorant'),
    ).toMatch(/outside the active project scope "valorant"/)
  })
})
