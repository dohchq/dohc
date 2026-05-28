/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1aw'
const BOB = 'ws_bob_p1aw'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — write-path enforcement
// at the internal layer the AGENT TOOLS call. The agent's
// write_atom / delete_atom land through `_upsertInternal` /
// `_removeInternal`; without these gates a tool call could
// silently clobber a teammate's private atom by guessing its path.
//
// Targets the INTERNAL mutations with explicit `viewerSubject`
// (end-to-end agent → tool exec → stream requires the agent SDK
// component registration which convex-test doesn't carry). The
// tool→internal wiring is covered structurally (grep).

describe('P1 — _upsertInternal gate (legacy/system write path)', () => {
  it('without viewerSubject: writes unconditionally (system path back-compat)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/private.md',
      body: 'v1',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // System path — no viewerSubject ⇒ unfiltered.
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: orgId,
      path: 'alice/private.md',
      body: 'system rewrite ok',
      source: 'system',
      allowUserOverwrite: true,
    })
    const after = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    expect(after?.body).toContain('system rewrite ok')
  })

  it('with viewerSubject = teammate: blocked on private atom', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/private.md',
      body: 'original',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: orgId,
        path: 'alice/private.md',
        body: 'tampered via agent',
        source: 'agent',
        allowUserOverwrite: true,
        viewerSubject: BOB,
      }),
    ).rejects.toThrow(/access to write/)
  })

  it('with viewerSubject = owner: writes succeed', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/private.md',
      body: 'v1',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: orgId,
      path: 'alice/private.md',
      body: 'v2 from agent',
      source: 'agent',
      allowUserOverwrite: true,
      viewerSubject: ALICE,
    })
    const after = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    expect(after?.body).toContain('v2 from agent')
  })
})

describe('P1 — _removeInternal gate (delete_atom path)', () => {
  it('with viewerSubject = teammate: blocked on private atom', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'p',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await expect(
      t.mutation(internal.atoms._removeInternal, {
        workspaceId: orgId,
        path: 'alice/secret.md',
        viewerSubject: BOB,
      }),
    ).rejects.toThrow(/access to delete/)
  })

  it('without viewerSubject: unconditional (system path)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'p',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: orgId,
      path: 'alice/secret.md',
    })
    const gone = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    expect(gone).toBeNull()
  })
})

describe('P1 — agent-tool wiring (structural)', () => {
  it('create_atom routes through semantic createAtom + reports access-denied', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

    // The create_atom execute body must (a) resolve viewerSubject,
    // (b) pass it as the semantic actor, (c) call Hocuspocus createAtom
    // instead of writing atoms.body directly, and (d) return a structured
    // REFUSED message for forbidden paths.
    const match = SRC.match(
      /create_atom:\s*createTool\([\s\S]+?execute[\s\S]+?callSemanticApply\('createAtom'[\s\S]+?\}\),/,
    )
    expect(match).not.toBeNull()
    const tool = match?.[0] ?? ''
    expect(tool).toContain('viewerSubjectFromTool(ctx)')
    expect(tool).toMatch(/userId:\s*viewerSubject/)
    expect(tool).not.toContain('_upsertInternal')
    expect(tool).toMatch(/forbidden/)
    expect(tool).toMatch(/REFUSED/)
  })

  it('delete_atom passes viewerSubject + catches access-denied', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './agent.ts'), 'utf8')

    const match = SRC.match(
      /delete_atom:\s*createTool\([\s\S]+?execute[\s\S]+?_removeInternal[\s\S]+?\}\),/,
    )
    expect(match).not.toBeNull()
    const tool = match?.[0] ?? ''
    expect(tool).toContain('viewerSubjectFromTool(ctx)')
    expect(tool).toMatch(/viewerSubject\s*,?\s*\}/)
    expect(tool).toMatch(/access to delete/)
    expect(tool).toMatch(/REFUSED/)
  })
})
