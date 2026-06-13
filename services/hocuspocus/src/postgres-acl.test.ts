import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPostgresAcl, WORKSPACE_AUTHZ_VERSION } from './postgres-acl.js'

// Live workspace-db test, mirroring the workspace-postgres suites: apply the
// idempotent migration, seed rows scoped to this file's ids, clean up by
// workspace id. ECONNREFUSED here is an environment failure, not a test bug.
const migrationUrl = new URL(
  '../../../packages/workspace-postgres/src/db/migrations/0001_initial.sql',
  import.meta.url,
)

const ws = 'phase10-pgacl-ws'
const ownerId = 'phase10-pgacl-owner'
const memberId = 'phase10-pgacl-member'
const viewerId = 'phase10-pgacl-viewer'
const editorId = 'phase10-pgacl-editor'
const strangerId = 'phase10-pgacl-stranger'
const atomId = 'phase10-pgacl-atom'
const sourceAtomId = 'phase10-pgacl-source-atom'
const deletedAtomId = 'phase10-pgacl-atom-deleted'
const lockedAtomId = 'phase10-pgacl-atom-locked'

let pool: pg.Pool
const acl = () => createPostgresAcl({ pool })

const input = (userId: string, atom = atomId) => ({
  workspaceId: ws,
  atomId: atom,
  userId,
  actorKind: 'user' as const,
  authzVersion: WORKSPACE_AUTHZ_VERSION,
})

beforeEach(async () => {
  pool = new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ?? 'postgres://dohc:dohc@localhost:54329/dohc_v2',
  })
  await pool.query(await readFile(migrationUrl, 'utf8'))
  await clearWorkspace()
  // The owner intentionally has NO workspace_members row, pinning the
  // member-OR-owner branch; memberId pins plain membership.
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'PG ACL', 'personal')`,
    [ws, ownerId],
  )
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('phase10-pgacl-membership', $1, $2, 'member')`,
    [ws, memberId],
  )
  await pool.query(
    `insert into atoms (id, workspace_id, path, kind, body, revision, deleted_at)
     values
       ($2, $1, 'notes/hello.md', 'markdown', '# Hello', 1, null),
       ($3, $1, '.apps/workspace/src/App.tsx', 'text', 'export default 1', 1, null),
       ($4, $1, 'notes/gone.md', 'markdown', '# Gone', 1, now()),
       ($5, $1, 'notes/locked.md', 'markdown', '# Locked', 1, null)`,
    [ws, atomId, sourceAtomId, deletedAtomId, lockedAtomId],
  )
  await pool.query(
    `insert into shares (id, workspace_id, target_kind, target_id, recipient_user_id, capability)
     values
       ('phase10-pgacl-share-view', $1, 'atom', $2, $3, 'view'),
       ('phase10-pgacl-share-edit', $1, 'atom', $2, $4, 'edit')`,
    [ws, atomId, viewerId, editorId],
  )
  await pool.query(
    `insert into locks (id, workspace_id, target_kind, target_id, reason, locked_by_user_id)
     values ('phase10-pgacl-lock', $1, 'atom', $2, 'review', $3)`,
    [ws, lockedAtomId, ownerId],
  )
})

afterEach(async () => {
  await clearWorkspace()
  await pool.end()
})

async function clearWorkspace() {
  for (const table of [
    'locks',
    'shares',
    'atom_revisions',
    'atoms',
    'workspace_members',
    'workspaces',
  ]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [ws])
  }
}

describe('Postgres ACL', () => {
  it('reports the hardcoded authz version', async () => {
    await expect(acl().getWorkspaceAuthzVersion(input(memberId))).resolves.toBe(1)
  })

  it('grants member and owner read+write; stranger neither', async () => {
    for (const userId of [memberId, ownerId]) {
      await expect(acl().canReadAtom(input(userId))).resolves.toBe(true)
      await expect(acl().canWriteAtom(input(userId))).resolves.toBe(true)
    }
    await expect(acl().canReadAtom(input(strangerId))).resolves.toBe(false)
    await expect(acl().canWriteAtom(input(strangerId))).resolves.toBe(false)
  })

  it('lets a view share read but never write; an edit share does both', async () => {
    await expect(acl().canReadAtom(input(viewerId))).resolves.toBe(true)
    await expect(acl().canWriteAtom(input(viewerId))).resolves.toBe(false)
    await expect(acl().canReadAtom(input(editorId))).resolves.toBe(true)
    await expect(acl().canWriteAtom(input(editorId))).resolves.toBe(true)
  })

  it('denies access to deleted atoms even for members', async () => {
    await expect(acl().canReadAtom(input(memberId, deletedAtomId))).resolves.toBe(false)
  })

  it('blocks member writes on locked atoms but keeps reads', async () => {
    await expect(acl().canReadAtom(input(memberId, lockedAtomId))).resolves.toBe(true)
    await expect(acl().canWriteAtom(input(memberId, lockedAtomId))).resolves.toBe(false)
  })

  it('bootstraps markdown as rich and source files as plain-text canonical', async () => {
    await expect(acl().loadAtomBootstrap?.(input(memberId))).resolves.toEqual({
      markdown: '# Hello',
      path: 'notes/hello.md',
      plainText: false,
    })
    await expect(acl().loadAtomBootstrap?.(input(memberId, sourceAtomId))).resolves.toEqual({
      markdown: 'export default 1',
      path: '.apps/workspace/src/App.tsx',
      plainText: true,
    })
    await expect(
      acl().loadAtomBootstrap?.(input(memberId, deletedAtomId)),
    ).resolves.toBeNull()
    await expect(
      acl().loadAtomBootstrap?.(input(memberId, 'phase10-pgacl-missing')),
    ).resolves.toBeNull()
  })

  it('setAtomBodyCache bumps revision, appends atom_revisions, and reports missing atoms', async () => {
    const projection = {
      workspaceId: ws,
      atomId,
      markdown: '# Projected',
      projectionHash: 'sha256:test',
      schemaVersion: 1,
      ydocStateVector: 'AQID',
      lastEditedByUserId: memberId,
      projectedAt: Date.now(),
    }
    await expect(acl().setAtomBodyCache?.(projection)).resolves.toEqual({ ok: true })

    const atom = await pool.query('select body, revision from atoms where id = $1', [atomId])
    expect(atom.rows).toEqual([{ body: '# Projected', revision: 2 }])
    const revisions = await pool.query(
      'select revision, body, actor_user_id from atom_revisions where atom_id = $1',
      [atomId],
    )
    expect(revisions.rows).toEqual([
      { revision: 2, body: '# Projected', actor_user_id: memberId },
    ])

    await expect(
      acl().setAtomBodyCache?.({ ...projection, atomId: 'phase10-pgacl-missing' }),
    ).resolves.toEqual({ ok: false, reason: 'missing-atom' })
  })

  it('createAtom inserts atom + revision for members and rejects everyone else', async () => {
    const created = await acl().createAtom?.({
      workspaceId: ws,
      path: 'notes/new.md',
      content: '# New',
      userId: memberId,
      actorKind: 'user',
      authzVersion: WORKSPACE_AUTHZ_VERSION,
    })
    if (!created?.ok) throw new Error('expected createAtom to succeed')
    expect(created.markdown).toBe('# New')

    const row = await pool.query(
      'select path, kind, body, revision from atoms where id = $1',
      [created.atomId],
    )
    expect(row.rows).toEqual([
      { path: 'notes/new.md', kind: 'markdown', body: '# New', revision: 1 },
    ])
    const revisions = await pool.query(
      'select revision, actor_user_id from atom_revisions where atom_id = $1',
      [created.atomId],
    )
    expect(revisions.rows).toEqual([{ revision: 1, actor_user_id: memberId }])

    const again = { workspaceId: ws, path: 'notes/new.md', content: 'x', userId: memberId, actorKind: 'user' as const, authzVersion: 1 }
    await expect(acl().createAtom?.(again)).resolves.toEqual({ ok: false, reason: 'already-exists' })
    await expect(
      acl().createAtom?.({ ...again, path: 'notes/other.md', userId: strangerId }),
    ).resolves.toEqual({ ok: false, reason: 'forbidden' })
    await expect(
      acl().createAtom?.({ ...again, path: 'notes/other.md', authzVersion: 2 }),
    ).resolves.toEqual({ ok: false, reason: 'stale-authz' })
    await expect(
      acl().createAtom?.({ ...again, path: '../escape.md' }),
    ).rejects.toThrow(/Invalid atom path/)
  })

  it('the postgres ACL source never touches the legacy backend', async () => {
    // Pins the plan requirement: this path must not import or mention the
    // Phase-13-doomed backend in any form.
    const source = await readFile(new URL('./postgres-acl.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/convex/i)
  })
})
