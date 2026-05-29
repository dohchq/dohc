/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1at'
const BOB = 'ws_bob_p1at'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function makeOrgDefault(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
) {
  const atom = await t.run(async (ctx) => {
    const atoms = await ctx.db.query('atoms').collect()
    return atoms.find(
      (row: { workspaceId: string; path: string }) =>
        row.workspaceId === orgId && row.path === path,
    )
  })
  await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
    atomId: atom!._id,
    activeWorkspaceId: orgId,
    mode: null,
  })
}

// P1 (multiplayer-and-h-followups §6.5) — verify the internal atom-read
// queries the agent tools call (_listInternal, _getInternal) actually
// filter by access when `viewerSubject` is passed. The agent tools
// themselves (list_atoms, read_atom) thread viewerSubject via
// `viewerSubjectFromTool(ctx)` — without this filtering, the agent
// could surface a teammate's private atom paths to the user's chat
// (or read the body via read_atom) even though the user can't see it.
//
// Tests target the INTERNAL queries with explicit `viewerSubject` arg
// — the tool wiring + viewerSubjectFromTool helper are structurally
// tested via grep. End-to-end (action → tool → stream) requires the
// agent SDK component registration which convex-test doesn't carry.

describe('P1 — _listInternal filters by viewerSubject', () => {
  it('without viewerSubject: returns ALL paths (back-compat for system callers)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public.md',
      body: 'p',
    })
    await makeOrgDefault(t, orgId, 'public.md')
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // System call (no viewerSubject): sees both — legacy callers don't filter.
    const all = await t.query(internal.atoms._listInternal, {
      workspaceId: orgId,
    })
    expect(all.sort()).toEqual(['alice/secret.md', 'public.md'])
  })

  it('with viewerSubject: filters out atoms the viewer cannot read', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public.md',
      body: 'p',
    })
    await makeOrgDefault(t, orgId, 'public.md')
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Bob's view: only public.md.
    const bobView = await t.query(internal.atoms._listInternal, {
      workspaceId: orgId,
      viewerSubject: BOB,
    })
    expect(bobView).toEqual(['public.md'])
    // Alice's view: both (owner of the private atom).
    const aliceView = await t.query(internal.atoms._listInternal, {
      workspaceId: orgId,
      viewerSubject: ALICE,
    })
    expect(aliceView.sort()).toEqual(['alice/secret.md', 'public.md'])
  })
})

describe('P1 — _getInternal filters by viewerSubject', () => {
  it('with viewerSubject: returns null for atoms the viewer cannot read', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'hello secret',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice reads.
    expect(
      await t.query(internal.atoms._getInternal, {
        workspaceId: orgId,
        path: 'alice/secret.md',
        viewerSubject: ALICE,
      }),
    ).toContain('hello secret') // body includes auto-injected frontmatter
    // Bob gets null (private to Alice).
    expect(
      await t.query(internal.atoms._getInternal, {
        workspaceId: orgId,
        path: 'alice/secret.md',
        viewerSubject: BOB,
      }),
    ).toBeNull()
  })

  it('without viewerSubject: returns the body regardless (legacy callers)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'hello secret',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // System call: unfiltered.
    expect(
      await t.query(internal.atoms._getInternal, {
        workspaceId: orgId,
        path: 'alice/secret.md',
      }),
    ).toContain('hello secret') // body includes auto-injected frontmatter
  })
})

describe('P1 — tool wiring (structural)', () => {
  it('list_atoms agent tool threads viewerSubject via viewerSubjectFromTool', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

    // The list_atoms tool execute body MUST call viewerSubjectFromTool
    // AND pass viewerSubject to _listInternal — both are required for
    // the filter to actually fire.
    const listAtomsMatch = SRC.match(
      /list_atoms:\s*createTool\([\s\S]+?inputSchema[\s\S]+?execute[\s\S]+?_listInternal[\s\S]{0,500}?\)\)/,
    )
    expect(listAtomsMatch).not.toBeNull()
    const tool = listAtomsMatch?.[0] ?? ''
    expect(tool).toContain('viewerSubjectFromTool(ctx)')
    expect(tool).toMatch(/viewerSubject\s*,?\s*\}/)
  })

  it('read_atom agent tool threads viewerSubject via viewerSubjectFromTool', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

    const readAtomMatch = SRC.match(
      /read_atom:\s*createTool\([\s\S]+?inputSchema[\s\S]+?execute[\s\S]+?_getInternal[\s\S]{0,500}?\)\)/,
    )
    expect(readAtomMatch).not.toBeNull()
    const tool = readAtomMatch?.[0] ?? ''
    expect(tool).toContain('viewerSubjectFromTool(ctx)')
    expect(tool).toMatch(/viewerSubject\s*,?\s*\}/)
  })

  it('run_skill and run_command agent tools gate bodies with viewerSubject', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

    const toolSource = (name: 'run_skill' | 'run_command') => {
      const start = SRC.indexOf(`    ${name}: createTool({`)
      expect(start).toBeGreaterThan(0)
      const nextTool = SRC.indexOf('\n\n    ', start + 1)
      expect(nextTool).toBeGreaterThan(start)
      return SRC.slice(start, nextTool)
    }

    for (const name of ['run_skill', 'run_command'] as const) {
      const tool = toolSource(name)
      const viewerIdx = tool.indexOf(
        'const viewerSubject = await viewerSubjectFromTool(ctx)',
      )
      const getInternalIdx = tool.indexOf('internal.atoms._getInternal')
      expect(viewerIdx).toBeGreaterThan(0)
      expect(getInternalIdx).toBeGreaterThan(viewerIdx)
      expect(tool.slice(getInternalIdx)).toMatch(
        /_getInternal[\s\S]{0,200}\{[\s\S]{0,250}\bviewerSubject\b[\s\S]{0,250}\}\s*\)/,
      )
    }
  })

  it('viewerSubjectFromTool helper + _viewerSubjectForCaller bridge exist', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')
    expect(SRC).toMatch(/export const _viewerSubjectForCaller = internalQuery/)
    expect(SRC).toMatch(/async function viewerSubjectFromTool/)
  })
})
