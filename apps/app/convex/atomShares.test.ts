/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const GRANTEE = 'ws_grantee'
const STRANGER = 'ws_stranger'

async function seedOwnerAtom(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: string,
) {
  await t.mutation(internal.atoms._upsertInternal, {
    workspaceId: OWNER,
    path,
    body,
    source: 'user',
  })
}

const bodyAt = (t: ReturnType<typeof convexTest>, path: string) =>
  t.run(async (ctx) => {
    const r = (await ctx.db.query('atoms').collect()).find(
      (a) => a.workspaceId === OWNER && a.path === path,
    )
    return r?.body ?? null
  })

describe('sharing-v1 1a — share grant + gated read', () => {
  it('owner shares → grantee can read; stranger cannot', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\n# Doc\n{val: 42}')

    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })

    // grantee sees it + can read the body
    const mine = await t
      .withIdentity({ subject: GRANTEE })
      .query(api.atomShares.listSharedWithMe, {})
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ fileId: 'doc', permission: 'view', available: true })

    const got = await t
      .withIdentity({ subject: GRANTEE })
      .query(api.atomShares.getSharedAtom, { shareId })
    expect(got?.body).toContain('{val: 42}')
    expect(got?.path).toBe('doc.md')

    // stranger: nothing in their tree, and a guessed shareId is DENIED
    const strangerList = await t
      .withIdentity({ subject: STRANGER })
      .query(api.atomShares.listSharedWithMe, {})
    expect(strangerList).toHaveLength(0)
    const strangerGet = await t
      .withIdentity({ subject: STRANGER })
      .query(api.atomShares.getSharedAtom, { shareId })
    expect(strangerGet).toBeNull()
  })

  it('revoke cuts off the grantee', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nx')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })
    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.unshareAtom, { shareId })
    expect(
      await t
        .withIdentity({ subject: GRANTEE })
        .query(api.atomShares.getSharedAtom, { shareId }),
    ).toBeNull()
    expect(
      await t
        .withIdentity({ subject: GRANTEE })
        .query(api.atomShares.listSharedWithMe, {}),
    ).toHaveLength(0)
  })

  it('only the owner can revoke', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nx')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })
    await expect(
      t
        .withIdentity({ subject: GRANTEE })
        .mutation(api.atomShares.unshareAtom, { shareId }),
    ).rejects.toThrow(/owner/i)
  })

  it('cannot share a file you do not own, or with yourself', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nx')
    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: OWNER,
        permission: 'view',
      }),
    ).rejects.toThrow(/yourself/i)
    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.atomShares.shareAtom, {
        fileId: 'does-not-exist',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      }),
    ).rejects.toThrow(/don't own/i)
  })

  it('re-share is idempotent + updates the permission', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nx')
    const as = t.withIdentity({ subject: OWNER })
    const id1 = await as.mutation(api.atomShares.shareAtom, {
      fileId: 'doc',
      granteeWorkspaceId: GRANTEE,
      permission: 'view',
    })
    const id2 = await as.mutation(api.atomShares.shareAtom, {
      fileId: 'doc',
      granteeWorkspaceId: GRANTEE,
      permission: 'edit',
    })
    expect(id2).toBe(id1) // same row, not a duplicate
    const mine = await as.query(api.atomShares.listMyShares, {})
    expect(mine).toHaveLength(1)
    expect(mine[0].permission).toBe('edit')
  })
})

// ── 1a — scoped formula resolution (the exfil fix) ──────────────────
describe('sharing-v1 1a — formulas in a shared atom never leak owner data', () => {
  it('a shared dashboard resolves ONLY over the shared set; unshared refs → null; injection → null', async () => {
    const t = convexTest(schema, modules)
    // Owner has THREE files:
    //  - secret/salary.md (id secret.salary) {amount: 99999}  — NOT shared
    //  - clients/acme.md (id clients.acme) {amount: 10}        — shared too
    //  - dash.md (id dash) with a formula over clients.acme + an
    //    INJECTED exfil formula over the secret — this is the file we open.
    await seedOwnerAtom(t, 'secret/salary.md', '---\nid: secret.salary\n---\n{amount: 99999}')
    await seedOwnerAtom(t, 'clients/acme.md', '---\nid: clients.acme\n---\n{amount: 10}')
    await seedOwnerAtom(
      t,
      'dash.md',
      '---\nid: dash\n---\nlegit {= sum(clients.acme.amount) } exfil {= sum(secret.salary.amount) }',
    )
    const as = t.withIdentity({ subject: OWNER })
    // share dash + clients.acme with the grantee, but NOT secret.salary
    const shareId = await as.mutation(api.atomShares.shareAtom, {
      fileId: 'dash',
      granteeWorkspaceId: GRANTEE,
      permission: 'edit',
    })
    await as.mutation(api.atomShares.shareAtom, {
      fileId: 'clients.acme',
      granteeWorkspaceId: GRANTEE,
      permission: 'view',
    })

    const res = await t
      .withIdentity({ subject: GRANTEE })
      .query(api.formulaEval.evalFormulasShared, {
        shareId,
        srcs: [
          'sum(clients.acme.amount)', // shared → resolves
          'sum(secret.salary.amount)', // NOT shared → must be null (no leak)
          'sum(secret.*.amount)', // injection targeting the secret namespace
        ],
      })
    const byp = new Map(res.map((r) => [r.src, r.value]))
    expect(byp.get('sum(clients.acme.amount)')).toBe(10) // shared value resolves
    expect(byp.get('sum(secret.salary.amount)')).toBeNull() // LEAK BLOCKED
    // a glob injection into the owner's secret namespace resolves over
    // NOTHING (secret.* isn't in the shared set) → null, never 99999
    expect(byp.get('sum(secret.*.amount)')).toBeNull()
  })

  it('a non-grantee gets null for every formula', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'clients/acme.md', '---\nid: clients.acme\n---\n{amount: 10}')
    await seedOwnerAtom(t, 'dash.md', '---\nid: dash\n---\n{= sum(clients.acme.amount) }')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'dash',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })
    const res = await t
      .withIdentity({ subject: STRANGER })
      .query(api.formulaEval.evalFormulasShared, {
        shareId,
        srcs: ['sum(clients.acme.amount)'],
      })
    expect(res[0].value).toBeNull()
  })
})

// ── 1a — lifecycle: deleting a shared file revokes its grants ───────
describe('sharing-v1 1a — delete cascades the grants', () => {
  it('owner deleting a shared file removes the grant (no silent resurrect)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nx')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })
    // owner deletes the file
    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: OWNER,
      path: 'doc.md',
    })
    // grant is gone; grantee no longer sees it
    expect(
      await t.withIdentity({ subject: OWNER }).query(api.atomShares.listMyShares, {}),
    ).toHaveLength(0)
    expect(
      await t
        .withIdentity({ subject: GRANTEE })
        .query(api.atomShares.getSharedAtom, { shareId }),
    ).toBeNull()
  })
})

// ── 1a — review fix: folder bulk-delete revokes shares (codex+sec P1)
describe('sharing-v1 1a — folder delete cascades grants', () => {
  it('deleting a FOLDER of shared files revokes the grants (no zombie re-grant)', async () => {
    const t = convexTest(schema, modules)
    // a shared file inside folder "team"
    await seedOwnerAtom(t, 'team/lead.md', '---\nid: team.lead\n---\nsecret v1')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'team.lead',
        granteeWorkspaceId: GRANTEE,
        permission: 'view',
      })
    // owner deletes the whole folder
    await t.mutation(internal.folders._removeInternal, {
      workspaceId: OWNER,
      path: 'team',
    })
    // grant gone; grantee cut off
    expect(
      await t.withIdentity({ subject: OWNER }).query(api.atomShares.listMyShares, {}),
    ).toHaveLength(0)
    expect(
      await t
        .withIdentity({ subject: GRANTEE })
        .query(api.atomShares.getSharedAtom, { shareId }),
    ).toBeNull()
    // recreating the SAME id must NOT re-grant access to the new content
    await seedOwnerAtom(t, 'team/lead.md', '---\nid: team.lead\n---\nDIFFERENT secret v2')
    expect(
      await t
        .withIdentity({ subject: GRANTEE })
        .query(api.atomShares.getSharedAtom, { shareId }),
    ).toBeNull()
  })
})

// ── 1b — collaborative edit (version-guard write) ───────────────────
describe('sharing-v1 1b — edit-grantee writes the owner atom safely', () => {
  async function setupEditShare(t: ReturnType<typeof convexTest>) {
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nv1')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc',
        granteeWorkspaceId: GRANTEE,
        permission: 'edit',
      })
    const got = await t
      .withIdentity({ subject: GRANTEE })
      .query(api.atomShares.getSharedAtom, { shareId })
    return { shareId, baseBody: got!.body }
  }

  it('an edit-grantee can update the owner file; the owner sees it', async () => {
    const t = convexTest(schema, modules)
    const { shareId, baseBody } = await setupEditShare(t)
    await t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
      shareId,
      body: '---\nid: doc\n---\nv2 by grantee',
      baseBody,
    })
    expect((await bodyAt(t, 'doc.md')) ?? '').toContain('v2 by grantee')
  })

  it('a stale write is REJECTED (no silent clobber)', async () => {
    const t = convexTest(schema, modules)
    const { shareId, baseBody } = await setupEditShare(t)
    // owner edits in between → updatedAt moves
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: OWNER, path: 'doc.md', body: '---\nid: doc\n---\nowner edit',
      source: 'user', allowUserOverwrite: true,
    })
    await expect(
      t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
        shareId,
        body: '---\nid: doc\n---\nstale grantee write',
        baseBody, // the OLD version
      }),
    ).rejects.toThrow(/CONFLICT/i)
    // owner's edit survived
    expect((await bodyAt(t, 'doc.md')) ?? '').toContain('owner edit')
  })

  it('a VIEW grant cannot write', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nv1')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc', granteeWorkspaceId: GRANTEE, permission: 'view',
      })
    const got = await t.withIdentity({ subject: GRANTEE }).query(api.atomShares.getSharedAtom, { shareId })
    await expect(
      t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
        shareId, body: 'hax', baseBody: got!.body,
      }),
    ).rejects.toThrow(/view access/i)
  })

  it('revoke-while-editing: the next grantee write is denied', async () => {
    const t = convexTest(schema, modules)
    const { shareId, baseBody } = await setupEditShare(t)
    await t.withIdentity({ subject: OWNER }).mutation(api.atomShares.unshareAtom, { shareId })
    await expect(
      t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
        shareId, body: 'after revoke', baseBody,
      }),
    ).rejects.toThrow(/no longer have access/i)
  })

  it('refuse-on-missing: owner deleted the file → grantee write does not recreate it', async () => {
    const t = convexTest(schema, modules)
    const { shareId, baseBody } = await setupEditShare(t)
    await t.mutation(internal.atoms._removeInternal, { workspaceId: OWNER, path: 'doc.md' })
    await expect(
      t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
        shareId, body: 'zombie', baseBody,
      }),
    ).rejects.toThrow() // grant gone (cascade) OR file missing — either denies
    expect(await bodyAt(t, 'doc.md')).toBeNull() // no zombie recreated
  })
})

// ── 1b review P1 — a shared edit may not change the file id ─────────
describe('sharing-v1 1b — edit-grantee cannot rewrite the frontmatter id', () => {
  it('rejects a write whose body id differs from the granted fileId', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'secret/salary.md', '---\nid: secret.salary\n---\n{amount: 99999}')
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nv1')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc', granteeWorkspaceId: GRANTEE, permission: 'edit',
      })
    const got = await t.withIdentity({ subject: GRANTEE }).query(api.atomShares.getSharedAtom, { shareId })
    await expect(
      t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
        shareId,
        body: '---\nid: secret.salary\n---\nhijack attempt',
        baseBody: got!.body,
      }),
    ).rejects.toThrow(/may not change the file id/i)
    // owner's doc + secret are both intact
    expect((await bodyAt(t, 'doc.md')) ?? '').toContain('v1')
    expect((await bodyAt(t, 'secret/salary.md')) ?? '').toContain('99999')
  })

  it('a write with NO body id is fine (id re-injected from the binding)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerAtom(t, 'doc.md', '---\nid: doc\n---\nv1')
    const shareId = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.atomShares.shareAtom, {
        fileId: 'doc', granteeWorkspaceId: GRANTEE, permission: 'edit',
      })
    const got = await t.withIdentity({ subject: GRANTEE }).query(api.atomShares.getSharedAtom, { shareId })
    await t.withIdentity({ subject: GRANTEE }).mutation(api.atoms.upsertSharedAtom, {
      shareId, body: 'just content, no frontmatter', baseBody: got!.body,
    })
    const body = (await bodyAt(t, 'doc.md')) ?? ''
    expect(body).toContain('id: doc') // re-injected
    expect(body).toContain('just content')
  })
})
