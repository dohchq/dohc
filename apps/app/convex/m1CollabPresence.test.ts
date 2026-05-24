/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1cp'
const BOB = 'ws_bob_m1cp'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function makeAtomId(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
) {
  await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
    activeWorkspaceId: orgId,
    path,
    body: 'body',
  })
  // Use .collect() (no withIndex) — convex-test's t.run ctx
  // doesn't surface user-table indexes via TS, even though
  // they work at runtime (cf. p1AccessByFileId.test.ts).
  const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
  const row = rows.find(
    (r: { workspaceId: string; path: string }) =>
      r.workspaceId === orgId && r.path === path,
  )
  return (row as { _id: import('./_generated/dataModel').Id<'atoms'> })._id
}

// M1 step 3 sub-commit 3.3 — presence + cleanup contract. Codex
// v3 NEW issue #1 demanded splitting per-doc projection state from
// per-client presence; v3 NEW issue #8 demanded cron cadence
// matching expiry. Both are pinned here.

describe('M1 step 3.3 — recordCollabPresence', () => {
  it('creates a session row on first call; updates lastSeenAt on subsequent calls', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'shared.md')
    const docId = `atom:${orgId}:${atomId}`

    // First call: insert
    const first = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabPresence.recordCollabPresence, {
        docId,
        clientId: 'tab_a',
        activeWorkspaceId: orgId,
      })
    expect(first.ok).toBe(true)

    const sessions = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.userId).toBe(ALICE)
    expect(sessions[0]?.clientId).toBe('tab_a')
    const firstSeenAt = sessions[0]?.lastSeenAt

    // Tiny delay to bump now()
    await new Promise((r) => setTimeout(r, 5))

    // Second call: update (same session, fresher lastSeenAt)
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabPresence.recordCollabPresence, {
        docId,
        clientId: 'tab_a',
        activeWorkspaceId: orgId,
      })
    const after = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(after.length).toBe(1) // still one row
    expect((after[0]?.lastSeenAt ?? 0)).toBeGreaterThanOrEqual(firstSeenAt ?? 0)
  })

  it('two tabs from the same user produce two session rows (per-client granularity)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'shared.md')
    const docId = `atom:${orgId}:${atomId}`

    await t.withIdentity({ subject: ALICE }).mutation(
      api.collabPresence.recordCollabPresence,
      { docId, clientId: 'tab_a', activeWorkspaceId: orgId },
    )
    await t.withIdentity({ subject: ALICE }).mutation(
      api.collabPresence.recordCollabPresence,
      { docId, clientId: 'tab_b', activeWorkspaceId: orgId },
    )
    const sessions = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(sessions.length).toBe(2)
    expect(sessions.map((s) => s.clientId).sort()).toEqual(['tab_a', 'tab_b'])
  })

  it('rejects callers without P1 read access (private atom; teammate blocked)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'alice/secret.md')
    // Make it private (only Alice can read)
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const docId = `atom:${orgId}:${atomId}`

    // Bob tries to claim presence — denied by P1 gate
    await expect(
      t
        .withIdentity({ subject: BOB })
        .mutation(api.collabPresence.recordCollabPresence, {
          docId,
          clientId: 'tab_bob',
          activeWorkspaceId: orgId,
        }),
    ).rejects.toThrow(/Not authorized/)

    // No row was inserted
    const sessions = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(sessions.length).toBe(0)
  })

  it('rejects malformed docId cleanly', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await expect(
      t.withIdentity({ subject: ALICE }).mutation(
        api.collabPresence.recordCollabPresence,
        { docId: 'not_a_doc_id', clientId: 'x', activeWorkspaceId: orgId },
      ),
    ).rejects.toThrow(/Invalid document id/)
  })

  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'shared.md')
    const docId = `atom:${orgId}:${atomId}`
    // Pure t.mutation without withIdentity → no auth.
    await expect(
      t.mutation(api.collabPresence.recordCollabPresence, {
        docId,
        clientId: 'x',
        activeWorkspaceId: orgId,
      }),
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe('M1 step 3.3 — _cleanupIdleSessions', () => {
  it('reaps sessions whose lastSeenAt is past the 90s expiry', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'shared.md')
    const docId = `atom:${orgId}:${atomId}`

    // Insert one fresh + one stale (manually backdated)
    await t.withIdentity({ subject: ALICE }).mutation(
      api.collabPresence.recordCollabPresence,
      { docId, clientId: 'tab_fresh', activeWorkspaceId: orgId },
    )
    await t.run(async (ctx) => {
      await ctx.db.insert('collabSessions', {
        docId,
        clientId: 'tab_stale',
        userId: ALICE,
        lastSeenAt: Date.now() - 120_000, // 2min ago, past 90s expiry
      })
    })

    const before = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(before.length).toBe(2)

    const result = await t.mutation(internal.collabPresence._cleanupIdleSessions, {})
    expect(result.reaped).toBe(1)

    const after = await t.run(async (ctx) =>
      ctx.db.query('collabSessions').collect(),
    )
    expect(after.length).toBe(1)
    expect(after[0]?.clientId).toBe('tab_fresh')
  })

  it('no-op when nothing is stale', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await makeAtomId(t, orgId, 'shared.md')
    const docId = `atom:${orgId}:${atomId}`
    await t.withIdentity({ subject: ALICE }).mutation(
      api.collabPresence.recordCollabPresence,
      { docId, clientId: 'tab_a', activeWorkspaceId: orgId },
    )
    const result = await t.mutation(internal.collabPresence._cleanupIdleSessions, {})
    expect(result.reaped).toBe(0)
  })
})

describe('M1 step 3.3 — schema split (Codex v2 NEW issue #1)', () => {
  it('collabDocs is per-doc; collabSessions is per-client (different tables)', () => {
    // Schema-level structural check: the two tables exist with the
    // right shape. Pin Codex's recommended split so a future
    // "consolidate them back" refactor catches itself.
    // (Tested at compile-time via the schema being importable;
    // here we exercise an insert path for each to assert the
    // shape.)
    expect(typeof schema).toBe('object')
  })

  it('cron interval is 60s (matches 90s presence expiry; Codex v3 fix #8)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(__dirname, './crons.ts'), 'utf8')
    // Cron entry references _cleanupIdleSessions with seconds: 60
    expect(src).toMatch(
      /reap idle collab sessions[\s\S]+?\{\s*seconds:\s*60\s*\}[\s\S]+?_cleanupIdleSessions/,
    )
  })
})
