/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const SERVER_TOKEN = 'test-hocuspocus-server-token'

function stubServerToken() {
  vi.stubEnv('HOCUSPOCUS_CONVEX_SERVER_TOKEN', SERVER_TOKEN)
}

async function seedAtom(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.atoms._upsertInternal, {
    workspaceId: OWNER,
    path: 'docs/intro.md',
    body: '---\nid: intro\n---\n# Intro\n\nOld body',
    source: 'user',
  })
}

async function setBodyCache(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    serverToken: string
    markdown: string
    projectionHash: string
    schemaVersion: number
    ydocStateVector: string
    lastEditedByUserId: string
    projectedAt: number
    atomId: string
  }> = {},
) {
  return await t.mutation(api.hocuspocusAuth.setBodyCache, {
    serverToken: overrides.serverToken ?? SERVER_TOKEN,
    workspaceId: OWNER,
    atomId: overrides.atomId ?? 'intro',
    markdown:
      overrides.markdown ?? '---\nid: intro\n---\n# Intro\n\nFresh projected body',
    projectionHash: overrides.projectionHash ?? 'sha256:projected',
    schemaVersion: overrides.schemaVersion ?? 1,
    ydocStateVector: overrides.ydocStateVector ?? 'AQID',
    lastEditedByUserId: overrides.lastEditedByUserId ?? 'user_1',
    projectedAt: overrides.projectedAt ?? 1_778_888_000_000,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Hocuspocus body cache projection bridge', () => {
  it('rejects projection writes without the server token', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()

    await expect(
      setBodyCache(t, { serverToken: 'wrong-token' }),
    ).rejects.toThrow(/server token/i)
  })

  it('patches atoms.body, search fields, last editor, and projection metadata', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedAtom(t)

    await expect(setBodyCache(t)).resolves.toEqual({ ok: true })

    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', OWNER).eq('path', 'docs/intro.md'),
        )
        .unique(),
    )
    expect(atom?.body).toContain('Fresh projected body')
    expect(atom?.searchText).toContain('Fresh projected body')
    expect(atom?.lastEditedByUserId).toBe('user_1')
    expect(atom?.bodyProjectionHash).toBe('sha256:projected')
    expect(atom?.bodyProjectionVersion).toBe(1)
    expect(atom?.bodyProjectionStateVector).toBe('AQID')
    expect(atom?.bodyProjectedAt).toBe(1_778_888_000_000)
  })

  it('does not let stale markdown projections erase view source code', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    const originalBody = [
      '---',
      'id: views.workspace.src.app',
      '---',
      'export default function App() {',
      '  return <main>{items.length}</main>',
      '}',
    ].join('\n')
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: OWNER,
      path: '.views/workspace/src/App.tsx',
      body: originalBody,
      source: 'agent',
    })

    await expect(
      setBodyCache(t, {
        atomId: 'views.workspace.src.app',
        markdown: '---\nid: views.workspace.src.app\n---\n',
      }),
    ).resolves.toEqual({ ok: true })

    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', OWNER).eq('path', '.views/workspace/src/App.tsx'),
        )
        .unique(),
    )
    expect(atom?.body).toBe(originalBody)
    expect(atom?.bodyProjectionHash).toBe('sha256:projected')
  })

  it('returns a miss when the atom file id is unknown', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()

    await expect(setBodyCache(t)).resolves.toEqual({
      ok: false,
      reason: 'missing-atom',
    })
  })

  it('rejects projections that would change the atom file id', async () => {
    const t = convexTest(schema, modules)
    stubServerToken()
    await seedAtom(t)

    await expect(
      setBodyCache(t, { markdown: '---\nid: other\n---\n# Bad' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'frontmatter-id-mismatch',
    })
  })
})
