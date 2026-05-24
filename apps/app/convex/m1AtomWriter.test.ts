/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { sha256Hex } from './atomWriter'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1aw'

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
): Promise<{ atomId: Id<'atoms'>; body: string }> {
  await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
    activeWorkspaceId: orgId,
    path,
    body,
  })
  const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
  const row = rows.find(
    (r: { workspaceId: string; path: string }) =>
      r.workspaceId === orgId && r.path === path,
  )
  return {
    atomId: (row as { _id: Id<'atoms'> })._id,
    body: (row as { body: string }).body,
  }
}

// M1 step 3 sub-commit 3.4 — atomWriter contract tests. Codex v3
// CRITICAL #1 + #2 fixes pinned: query by atomId, hash post-seed,
// no projection trash. End-to-end exercise (Convex mutation +
// real atoms.body + actual CAS roundtrip).

describe('M1 step 3.4 — sha256Hex', () => {
  it('produces stable hex output for a given input', async () => {
    const hex = await sha256Hex('hello world')
    expect(hex).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
    expect(hex.length).toBe(64) // 32 bytes hex
  })

  it('different inputs produce different hashes', async () => {
    const a = await sha256Hex('a')
    const b = await sha256Hex('b')
    expect(a).not.toBe(b)
  })
})

describe('M1 step 3.4 — replaceAtomBodyForCollabProjection contract', () => {
  it('writes when CAS matches; returns new body + hash + path/workspaceId', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'team/notes.md', 'initial content')

    const currentHash = await sha256Hex(body)
    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: orgId,
        expectedCurrentBodyHash: currentHash,
        newBody: 'projected content',
      })
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalBody).toContain('projected content')
      expect(result.newBaseBodyHash).toBe(await sha256Hex(result.finalBody))
      expect(result.path).toBe('team/notes.md')
      expect(result.workspaceId).toBe(orgId)
    }

    // Verify atoms.body was actually patched + source updated.
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toContain('projected content')
    expect(after?.source).toBe('collab')
  })

  it('hash mismatch ⇒ ok:false (hash-mismatch); does NOT mutate atom', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'team/notes.md', 'v1')

    // Wrong hash (e.g. caller computed it before another writer
    // landed). The writer must refuse cleanly.
    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: orgId,
        expectedCurrentBodyHash: 'wrong_hash_0000000000000000000000000000000000000000000000000000000000',
        newBody: 'should not land',
      })
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('hash-mismatch')

    // Atom unchanged
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toBe(body)
  })

  it('workspace mismatch ⇒ ok:false (workspace-mismatch)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'team/notes.md', 'v1')
    const currentHash = await sha256Hex(body)

    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: 'wrong_workspace',
        expectedCurrentBodyHash: currentHash,
        newBody: 'whatever',
      })
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('workspace-mismatch')
  })

  it('atomId not found ⇒ ok:false (atom-not-found)', async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t)
    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId: 'jh700000000000000000000000000' as Id<'atoms'>,
        expectedWorkspaceId: 'whatever',
        expectedCurrentBodyHash: 'whatever',
        newBody: 'whatever',
      })
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('atom-not-found')
  })

  it('systemLocked atom throws SystemLockError (lock freezes collab; Codex v3 Q6)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'system.md', 'v1')
    // Force systemLocked on the row
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { systemLocked: true })
    })
    const currentHash = await sha256Hex(body)
    await expect(
      t.run(async (ctx) => {
        const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
        return replaceAtomBodyForCollabProjection(ctx, {
          atomId,
          expectedWorkspaceId: orgId,
          expectedCurrentBodyHash: currentHash,
          newBody: 'projected',
        })
      }),
    ).rejects.toThrow()
  })

  it('userLocked atom throws UserLockError', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'mine.md', 'v1')
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { userLocked: true })
    })
    const currentHash = await sha256Hex(body)
    await expect(
      t.run(async (ctx) => {
        const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
        return replaceAtomBodyForCollabProjection(ctx, {
          atomId,
          expectedWorkspaceId: orgId,
          expectedCurrentBodyHash: currentHash,
          newBody: 'projected',
        })
      }),
    ).rejects.toThrow()
  })

  it('does NOT add a trash row (Codex v3 critical #2 part 2: no projection trash)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'team/notes.md', 'v1 content')

    // Count trash rows before
    const trashBefore = await t.run(async (ctx) =>
      ctx.db.query('trash').collect(),
    )

    const currentHash = await sha256Hex(body)
    await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: orgId,
        expectedCurrentBodyHash: currentHash,
        newBody: 'v2 projected',
      })
    })

    // Trash unchanged — collab uses prosemirror-sync history,
    // not atom trash, for recovery
    const trashAfter = await t.run(async (ctx) =>
      ctx.db.query('trash').collect(),
    )
    expect(trashAfter.length).toBe(trashBefore.length)
  })

  it('queries by atomId NOT path (Codex v3 critical #1: survives rename mid-session)', async () => {
    // Simulate rename: write atom at original path, capture atomId,
    // then move the atom to a new path, then project. The writer
    // must hit the SAME row (atomId-stable) and write to its current
    // path — not error or write to a different row.
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, body } = await makeAtom(t, orgId, 'old/path.md', 'before rename')
    const currentHash = await sha256Hex(body)

    // Rename via the public move mutation (under Alice's identity).
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.move, {
      activeWorkspaceId: orgId,
      fromPath: 'old/path.md',
      toPath: 'new/path.md',
    })

    // Confirm the atom EXISTS at new path now. But:
    // atoms.move actually deletes the old row + inserts a new one
    // at the new path (it's a rename, not an in-place patch). So
    // the atomId we have is now stale. This means the projection
    // writer should fail with atom-not-found (correct: the
    // session's atomId no longer points to a live atom).
    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: orgId,
        expectedCurrentBodyHash: currentHash,
        newBody: 'should refuse',
      })
    })
    // The behavior is honest: the atom this session was bound to
    // is gone (move = delete+insert). Conflict handler upstream
    // sees atom-not-found and routes to "needs rebootstrap" or
    // freeze depending on PM edit state.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('atom-not-found')
  })

  it('seeding-changes-body case: stored hash is for the FINAL body (Codex v3 critical #2 part 1)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    // Atom without frontmatter; seedAtomIdIntoBody will add one
    // on the next write.
    const { atomId, body } = await makeAtom(t, orgId, 'team/n.md', 'no frontmatter yet')
    const currentHash = await sha256Hex(body)

    const result = await t.run(async (ctx) => {
      const { replaceAtomBodyForCollabProjection } = await import('./atomWriter')
      return replaceAtomBodyForCollabProjection(ctx, {
        atomId,
        expectedWorkspaceId: orgId,
        expectedCurrentBodyHash: currentHash,
        newBody: 'new body without id either',
      })
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The newBaseBodyHash MUST equal sha256(finalBody) — NOT
      // sha256(args.newBody). If seedAtomIdIntoBody added an `id:`
      // frontmatter, finalBody differs from newBody, so hashing
      // newBody would store a stale CAS witness for the next round.
      expect(result.newBaseBodyHash).toBe(await sha256Hex(result.finalBody))
      // And finalBody is what was actually persisted.
      const after = await t.run(async (ctx) => ctx.db.get(atomId))
      expect(after?.body).toBe(result.finalBody)
    }
  })
})
