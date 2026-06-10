import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type {
  AtomAccessInput,
  AtomBodyCacheProjectionInput,
  AtomBodyCacheProjectionResult,
  AtomCreateInput,
  AtomCreateResult,
  HocuspocusAcl,
} from './hooks.js'
import { isPlainTextAtomPath } from './source-kind.js'

// The workspace db has no member-change counter yet, so every minted token and
// every ACL check agree on version 1 and the hooks' equality stale-check
// passes. Bump via a per-workspace member-change counter once share/member
// revocation needs to kick live connections.
export const WORKSPACE_AUTHZ_VERSION = 1

type AccessRow = {
  atom_exists: boolean
  is_member: boolean
  is_owner: boolean
  has_read_share: boolean
  has_edit_share: boolean
  is_locked: boolean
}

// One round-trip answers both canRead and canWrite:
// read  = atom exists AND (member OR owner OR view/edit share),
// write = read AND (member OR owner OR edit share) AND no active lock.
const ACCESS_SQL = `
  select
    exists(select 1 from atoms a
      where a.id = $2 and a.workspace_id = $1 and a.deleted_at is null) as atom_exists,
    exists(select 1 from workspace_members m
      where m.workspace_id = $1 and m.user_id = $3 and m.deleted_at is null) as is_member,
    exists(select 1 from workspaces w
      where w.workspace_id = $1 and w.owner_user_id = $3 and w.deleted_at is null) as is_owner,
    exists(select 1 from shares s
      where s.workspace_id = $1 and s.target_kind = 'atom' and s.target_id = $2
        and s.recipient_user_id = $3 and s.capability in ('view', 'edit')
        and s.deleted_at is null) as has_read_share,
    exists(select 1 from shares s
      where s.workspace_id = $1 and s.target_kind = 'atom' and s.target_id = $2
        and s.recipient_user_id = $3 and s.capability = 'edit'
        and s.deleted_at is null) as has_edit_share,
    exists(select 1 from locks l
      where l.workspace_id = $1 and l.target_kind = 'atom' and l.target_id = $2
        and l.deleted_at is null) as is_locked
`

const INSERT_REVISION_SQL = `
  insert into atom_revisions (id, workspace_id, atom_id, revision, body, actor_user_id)
  values ($1, $2, $3, $4, $5, $6)
`

function canRead(row: AccessRow): boolean {
  return row.atom_exists && (row.is_member || row.is_owner || row.has_read_share)
}

export function createPostgresAcl({ pool }: { pool: pg.Pool }): HocuspocusAcl {
  async function access(input: AtomAccessInput): Promise<AccessRow> {
    const { rows } = await pool.query<AccessRow>(ACCESS_SQL, [
      input.workspaceId,
      input.atomId,
      input.userId,
    ])
    return rows[0]
  }

  return {
    async getWorkspaceAuthzVersion() {
      return WORKSPACE_AUTHZ_VERSION
    },

    async canReadAtom(input) {
      return canRead(await access(input))
    },

    async canWriteAtom(input) {
      const row = await access(input)
      return (
        canRead(row) &&
        (row.is_member || row.is_owner || row.has_edit_share) &&
        !row.is_locked
      )
    },

    async loadAtomBootstrap(input) {
      const { rows } = await pool.query<{ body: string; path: string }>(
        `select body, path from atoms
         where id = $1 and workspace_id = $2 and deleted_at is null limit 1`,
        [input.atomId, input.workspaceId],
      )
      // Plain-text-canonical for every atom on this path: the only live editor
      // is the desktop's plain-text textarea, so the shared Y.Doc body MUST be
      // the `plainText` Y.Text it binds — and the markdown projection
      // (onChange -> setAtomBodyCache) reads that same field. Binding a rich
      // `body` XmlFragment here would open the desktop blank and let an empty
      // body-projection blank atoms.body (cross-channel data loss vs merge-sync).
      return rows[0]
        ? { markdown: rows[0].body, path: rows[0].path, plainText: true }
        : null
    },

    // The postgres body cache keeps only body + revision (+ an atom_revisions
    // audit row); projection hash/state-vector metadata stays in the ydoc
    // store. Update + revision insert commit atomically.
    async setAtomBodyCache(
      input: AtomBodyCacheProjectionInput,
    ): Promise<AtomBodyCacheProjectionResult> {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const updated = await client.query<{ revision: number }>(
          `update atoms
           set body = $3, revision = revision + 1, updated_at = now()
           where id = $1 and workspace_id = $2 and deleted_at is null
           returning revision`,
          [input.atomId, input.workspaceId, input.markdown],
        )
        const revision = updated.rows[0]?.revision
        if (revision === undefined) {
          await client.query('rollback')
          return { ok: false, reason: 'missing-atom' }
        }
        await client.query(INSERT_REVISION_SQL, [
          randomUUID(),
          input.workspaceId,
          input.atomId,
          revision,
          input.markdown,
          // atom_revisions.actor_user_id is NOT NULL; headless projections
          // (no live editor in context) are attributed to the service.
          input.lastEditedByUserId ?? 'hocuspocus',
        ])
        await client.query('commit')
        return { ok: true }
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    // Mirrors @dohc/workspace-postgres repositories/atoms.ts insertAtom (kept
    // in sync by hand: that package exports TS source, which this service's
    // NodeNext tsc build cannot consume). Only members/owners create atoms —
    // shares are atom-scoped and cannot mint new ones.
    async createAtom(input: AtomCreateInput): Promise<AtomCreateResult> {
      if (input.authzVersion !== WORKSPACE_AUTHZ_VERSION) {
        return { ok: false, reason: 'stale-authz' }
      }
      // WorkspacePath invariants: relative, no '..' segments.
      if (
        !input.path ||
        input.path.startsWith('/') ||
        input.path.split('/').includes('..')
      ) {
        throw new Error(`Invalid atom path: ${input.path}`)
      }
      const { rows } = await pool.query<Pick<AccessRow, 'is_member' | 'is_owner'>>(
        `select
           exists(select 1 from workspace_members m
             where m.workspace_id = $1 and m.user_id = $2 and m.deleted_at is null) as is_member,
           exists(select 1 from workspaces w
             where w.workspace_id = $1 and w.owner_user_id = $2 and w.deleted_at is null) as is_owner`,
        [input.workspaceId, input.userId],
      )
      if (!rows[0].is_member && !rows[0].is_owner) {
        return { ok: false, reason: 'forbidden' }
      }

      const atomId = randomUUID()
      try {
        await pool.query(
          `insert into atoms (id, workspace_id, path, kind, body, revision)
           values ($1, $2, $3, $4, $5, 1)`,
          [
            atomId,
            input.workspaceId,
            input.path,
            isPlainTextAtomPath(input.path) ? 'text' : 'markdown',
            input.content,
          ],
        )
        await pool.query(INSERT_REVISION_SQL, [
          randomUUID(),
          input.workspaceId,
          atomId,
          1,
          input.content,
          input.userId,
        ])
        return { ok: true, atomId, markdown: input.content }
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          return { ok: false, reason: 'already-exists' }
        }
        throw error
      }
    },
  }
}
