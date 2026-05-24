/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

// M1 step 3.9.14 — behavioral coverage for atomSuggestions
// (the M3 sidecar table introduced in 3.9.0). Karen's holistic
// review flagged this file as having zero tests despite >340
// LOC of mutations + queries. Closing the gap.
//
// Each suite exercises one external behavior. Tests run
// against the real schema via convexTest; auth identity is
// applied via withIdentity. We DON'T register the
// prosemirror-sync component because none of these tests
// exercise the collab transport — only the suggestion
// sidecar lifecycle.

const ALICE = 'ws_alice_m1as'
const BOB = 'ws_bob_m1as'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  return orgId
}

async function makeAtom(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
  body: string,
): Promise<{ atomId: Id<'atoms'>; finalBody: string }> {
  await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
    activeWorkspaceId: orgId,
    path,
    body,
  })
  const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
  const row = rows.find(
    (r: { workspaceId: string; path: string }) =>
      r.workspaceId === orgId && r.path === path,
  ) as { _id: Id<'atoms'>; body: string }
  return { atomId: row._id, finalBody: row.body }
}

async function createSuggestion(
  t: ReturnType<typeof convexTest>,
  args: {
    atomId: Id<'atoms'>
    workspaceId: string
    rangeFrom: number
    rangeTo: number
    proposedText: string
    expectedText: string
    instruction?: string
    authorUserId?: string
    agentSecret?: string
  },
) {
  return (await t.mutation(internal.atomSuggestions._createSuggestion, {
    atomId: args.atomId,
    workspaceId: args.workspaceId,
    rangeFrom: args.rangeFrom,
    rangeTo: args.rangeTo,
    proposedText: args.proposedText,
    expectedText: args.expectedText,
    instruction: args.instruction ?? 'rewrite',
    authorUserId: args.authorUserId ?? ALICE,
    agentSecret: args.agentSecret,
  })) as { ok: true; id: Id<'atomSuggestions'> } | { ok: false; reason: string }
}

describe('atomSuggestions — create', () => {
  it('creates a pending row with the supplied fields', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'note.md', 'hello world')
    const result = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: finalBody.indexOf('world'),
      rangeTo: finalBody.indexOf('world') + 'world'.length,
      proposedText: 'planet',
      expectedText: 'world',
      instruction: 'less basic',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await t.run(async (ctx) => ctx.db.get(result.id))
    expect(row?.status).toBe('pending')
    expect(row?.proposedText).toBe('planet')
    expect(row?.expectedText).toBe('world')
    expect(row?.atomId).toBe(atomId)
  })

  it('rejects proposedText exceeding PER_SUGGESTION_CHAR_CAP (1000)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'x')
    const huge = 'a'.repeat(1001)
    const result = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 1,
      proposedText: huge,
      expectedText: finalBody.slice(0, 1),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/exceeds 1000/)
  })

  it('rejects invalid range (negative or inverted)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId } = await makeAtom(t, orgId, 'n.md', 'abc')
    const r1 = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: -1,
      rangeTo: 1,
      proposedText: 'x',
      expectedText: '',
    })
    expect(r1.ok).toBe(false)
    const r2 = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 5,
      rangeTo: 2,
      proposedText: 'x',
      expectedText: '',
    })
    expect(r2.ok).toBe(false)
  })

  it('per-atom rate cap: 5 pending suggestions per author per minute', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello')
    for (let i = 0; i < 5; i++) {
      const r = await createSuggestion(t, {
        atomId,
        workspaceId: orgId,
        rangeFrom: 0,
        rangeTo: 0,
        proposedText: `x${i}`,
        expectedText: '',
      })
      expect(r.ok).toBe(true)
    }
    const r6 = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 0,
      proposedText: 'x6',
      expectedText: '',
    })
    expect(r6.ok).toBe(false)
    if (!r6.ok) expect(r6.reason).toMatch(/cap reached/i)
    // finalBody reference for lint
    expect(finalBody.length).toBeGreaterThan(0)
  })
})

describe('atomSuggestions — agent secret', () => {
  beforeEach(() => {
    delete (process.env as Record<string, string | undefined>).DOHC_AGENT_SECRET
  })
  afterEach(() => {
    delete (process.env as Record<string, string | undefined>).DOHC_AGENT_SECRET
  })

  it('authorIsAgent is FALSE when no env secret is set', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId } = await makeAtom(t, orgId, 'n.md', 'a')
    const result = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 0,
      proposedText: 'x',
      expectedText: '',
      agentSecret: 'anything',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await t.run(async (ctx) => ctx.db.get(result.id))
    expect(row?.authorIsAgent).toBe(false)
  })

  it('authorIsAgent is TRUE only when supplied secret matches env', async () => {
    process.env.DOHC_AGENT_SECRET = 'test-secret-xyz'
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId } = await makeAtom(t, orgId, 'n.md', 'a')
    const matched = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 0,
      proposedText: 'x',
      expectedText: '',
      agentSecret: 'test-secret-xyz',
    })
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    const matchedRow = await t.run(async (ctx) => ctx.db.get(matched.id))
    expect(matchedRow?.authorIsAgent).toBe(true)

    const mismatched = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 0,
      proposedText: 'y',
      expectedText: '',
      agentSecret: 'wrong',
    })
    expect(mismatched.ok).toBe(true)
    if (!mismatched.ok) return
    const mismatchedRow = await t.run(async (ctx) => ctx.db.get(mismatched.id))
    expect(mismatchedRow?.authorIsAgent).toBe(false)
  })
})

describe('atomSuggestions — listPending', () => {
  it('returns pending rows; gates on P1 read access', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'abc')
    await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 1,
      proposedText: 'X',
      expectedText: finalBody.slice(0, 1),
    })
    const list = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomSuggestions.listPending, {
        atomId,
        activeWorkspaceId: orgId,
      })
    expect(list.length).toBe(1)
    expect(list[0]?.status).toBe('pending')
    expect(list[0]?.expectedText).toBe(finalBody.slice(0, 1))
  })

  it('includes recently-resolved rows for fade UI window (10s)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'abc')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 1,
      proposedText: 'X',
      expectedText: finalBody.slice(0, 1),
    })
    if (!created.ok) throw new Error('create failed')
    // Resolve it (reject is simpler — no body write)
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.rejectSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    const list = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomSuggestions.listPending, {
        atomId,
        activeWorkspaceId: orgId,
      })
    expect(list.length).toBe(1)
    expect(list[0]?.status).toBe('rejected')
    expect(list[0]?.resolvedByUserId).toBe(ALICE)
  })
})

describe('atomSuggestions — acceptSuggestion CAS', () => {
  it('returns ok:false reason="drift" when expectedText mismatches', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello world')
    const idx = finalBody.indexOf('world')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: idx,
      rangeTo: idx + 5,
      proposedText: 'planet',
      expectedText: 'world',
    })
    if (!created.ok) throw new Error('create failed')
    const oobBody =
      finalBody.slice(0, idx) + 'unive' + finalBody.slice(idx + 5)
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { body: oobBody, updatedAt: Date.now() })
    })
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('drift')
      expect(result.message).toMatch(/drifted/)
    }
    // 3.9.15 — return-instead-of-throw means the row patch
    // PERSISTS. status='rejected' visible to the client via
    // listPending reactivity. Bubble transitions as designed.
    const row = await t.run(async (ctx) => ctx.db.get(created.id))
    expect(row?.status).toBe('rejected')
    expect(row?.resolvedByUserId).toBe(ALICE)
    // Body unchanged from the OOB write
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toBe(oobBody)
  })

  it('rejects suggestion missing expectedText (3.9.3)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId } = await makeAtom(t, orgId, 'n.md', 'abc')
    // Insert a pre-3.9.2 style row (no expectedText) directly
    const sid = await t.run(async (ctx) =>
      ctx.db.insert('atomSuggestions', {
        atomId,
        workspaceId: orgId,
        rangeFrom: 0,
        rangeTo: 1,
        proposedText: 'Z',
        instruction: 'legacy',
        authorIsAgent: false,
        authorUserId: ALICE,
        status: 'pending',
        createdAt: Date.now(),
        // expectedText intentionally omitted
      }),
    )
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: sid as Id<'atomSuggestions'>,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing-cas-witness')
      expect(result.message).toMatch(/expectedText/)
    }
    // Row patched to 'rejected' (3.9.15: return preserves patch)
    const row = await t.run(async (ctx) => ctx.db.get(sid as Id<'atomSuggestions'>))
    expect(row?.status).toBe('rejected')
  })

  it('rejects out-of-bounds range BEFORE CAS comparison (3.9.3 [P1])', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'abc')
    // Range past end of body, with expectedText="" which would
    // collapse to body.slice(end,end)="" and bypass CAS if we
    // clamped before comparing. The 3.9.3 fix rejects raw OOB.
    const sid = await t.run(async (ctx) =>
      ctx.db.insert('atomSuggestions', {
        atomId,
        workspaceId: orgId,
        rangeFrom: finalBody.length + 100,
        rangeTo: finalBody.length + 100,
        proposedText: 'should not append',
        expectedText: '',
        instruction: 'attack',
        authorIsAgent: false,
        authorUserId: ALICE,
        status: 'pending',
        createdAt: Date.now(),
      }),
    )
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: sid as Id<'atomSuggestions'>,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('oob')
      expect(result.message).toMatch(/out of bounds/)
    }
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toBe(finalBody) // body unchanged
    // Row patched to 'rejected' (3.9.15: return preserves patch)
    const row = await t.run(async (ctx) => ctx.db.get(sid as Id<'atomSuggestions'>))
    expect(row?.status).toBe('rejected')
  })

  it('happy path: splices proposedText at exact range when CAS passes', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello world')
    const idx = finalBody.indexOf('world')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: idx,
      rangeTo: idx + 5,
      proposedText: 'planet',
      expectedText: 'world',
    })
    if (!created.ok) throw new Error('create failed')
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.alreadyResolved).toBe(false)
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toContain('hello planet')
    const row = await t.run(async (ctx) => ctx.db.get(created.id))
    expect(row?.status).toBe('accepted')
    expect(row?.resolvedByUserId).toBe(ALICE)
  })

  it('idempotent on re-accept (returns alreadyResolved)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 5,
      proposedText: 'hola!',
      expectedText: finalBody.slice(0, 5),
    })
    if (!created.ok) throw new Error('create failed')
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    const second = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.alreadyResolved).toBe(true)
  })
})

describe('atomSuggestions — accept + active collab session (3.9.10/3.9.12)', () => {
  it('patches collabDocs.baseBodyHash with PERSISTED body hash + sets needsRebootstrap', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello world')

    // Seed an active collab row
    const docId = `atom:${orgId}:${atomId}`
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: 'stale-hash-placeholder',
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
    })

    const idx = finalBody.indexOf('world')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: idx,
      rangeTo: idx + 5,
      proposedText: 'planet',
      expectedText: 'world',
    })
    if (!created.ok) throw new Error('create failed')
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })

    // collabDocs row must be patched: baseBodyHash + needsRebootstrap
    const collabRow = await t.run(async (ctx) =>
      ctx.db
        .query('collabDocs')
        .withIndex('by_docId', (q) => q.eq('docId', docId))
        .unique(),
    )
    expect(collabRow?.needsRebootstrap).toBe(true)
    expect(collabRow?.baseBodyHash).not.toBe('stale-hash-placeholder')
    // baseBodyHash must equal hash of PERSISTED body (which may
    // have been mutated by seedAtomIdIntoBody — 3.9.12 fix)
    const persisted = await t.run(async (ctx) => ctx.db.get(atomId))
    const { sha256Hex } = await import('./atomWriter')
    const persistedHash = await sha256Hex(persisted!.body)
    expect(collabRow?.baseBodyHash).toBe(persistedHash)
  })

  it('skips collab-row patch when no active collab session', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'hello world')
    const idx = finalBody.indexOf('world')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: idx,
      rangeTo: idx + 5,
      proposedText: 'planet',
      expectedText: 'world',
    })
    if (!created.ok) throw new Error('create failed')
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.acceptSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    // No collab row exists → query returns null; accept still succeeds
    const collabRow = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').first(),
    )
    expect(collabRow).toBeNull()
  })
})

describe('atomSuggestions — rejectSuggestion', () => {
  it('marks rejected without touching body; records resolver', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody } = await makeAtom(t, orgId, 'n.md', 'abc')
    const created = await createSuggestion(t, {
      atomId,
      workspaceId: orgId,
      rangeFrom: 0,
      rangeTo: 1,
      proposedText: 'X',
      expectedText: finalBody.slice(0, 1),
    })
    if (!created.ok) throw new Error('create failed')
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomSuggestions.rejectSuggestion, {
        suggestionId: created.id,
        activeWorkspaceId: orgId,
      })
    const row = await t.run(async (ctx) => ctx.db.get(created.id))
    expect(row?.status).toBe('rejected')
    expect(row?.resolvedByUserId).toBe(ALICE)
    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toBe(finalBody)
    // BOB reference kept for future workspace-membership test
    void BOB
  })
})
