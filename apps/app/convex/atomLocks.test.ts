/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'
import {
  validateFolderPath,
  normalizeFolderPath,
  isFolderColor,
  isFolderIcon,
} from './atomLocks'
import { MAP_PATH } from './inlineAtom'

// file-org-v1 §5.1 / §5.2 / §5.4 — Track-4 D4.1a verification suite.
// Covers the 5 chokepoint lock guards, the §2-A Track-3 composition
// (locks compose cleanly with the structural skill guard), the
// folder-path normalize+validate edge cases, and the audit-by-grep
// allowlist for `_upsertSystem`.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_track4_locks'

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  path: string,
  opts: {
    body?: string
    source?: 'user' | 'agent'
    systemLocked?: boolean
    userLocked?: boolean
    starred?: boolean
  } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId: W,
      path,
      body: opts.body ?? `seed ${path}`,
      updatedAt: Date.now(),
      source: opts.source ?? 'agent',
      ...(opts.systemLocked ? { systemLocked: true } : {}),
      ...(opts.userLocked ? { userLocked: true } : {}),
      ...(opts.starred ? { starred: true } : {}),
    })
  })
}

async function getAtom(t: ReturnType<typeof convexTest>, path: string) {
  return await t.run(async (ctx) => {
    // convex-test's `t.run` provides an untyped GenericMutationCtx;
    // use `.collect()` + `.find()` (the established pattern in
    // atoms.test.ts) instead of `.withIndex(...)` for type safety.
    const rows = await ctx.db.query('atoms').collect()
    return rows.find((r: any) => r.workspaceId === W && r.path === path) ?? null
  })
}

// ────────────────────────────────────────────────────────────────
// §5.1 — Lock guard at the 5 chokepoints
// ────────────────────────────────────────────────────────────────

describe('lock guards — upsertAtomImpl (chokepoint #1)', () => {
  it('refuses agent overwrite of a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', { systemLocked: true, source: 'agent' })
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: '_map.md',
        body: 'spoof',
      }),
    ).rejects.toThrow(/system-managed/)
    expect((await getAtom(t, '_map.md'))?.systemLocked).toBe(true)
  })

  it('refuses agent overwrite of a userLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'me.md', { userLocked: true, source: 'user' })
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: 'me.md',
        body: 'spoof',
        allowUserOverwrite: true, // even with this — the lock wins
      }),
    ).rejects.toThrow(/locked this file/)
  })

  it('allows _upsertSystem to overwrite a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', { systemLocked: true, source: 'agent' })
    await t.mutation(internal.atoms._upsertSystem, {
      workspaceId: W,
      path: '_map.md',
      body: 'fresh map',
      source: 'agent',
    })
    const row = await getAtom(t, '_map.md')
    expect(row?.body).toMatch(/fresh map/)
    expect(row?.systemLocked).toBe(true) // re-asserted
  })

  it('lock-error taxonomy wins over user-content-overwrite error', async () => {
    const t = convexTest(schema, modules)
    // user-authored AND userLocked. The UserLockError must surface,
    // not the older "refusing to overwrite user-authored" message.
    await seedAtom(t, 'me.md', { userLocked: true, source: 'user' })
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: 'me.md',
        body: 'spoof',
      }),
    ).rejects.toThrow(/locked this file/)
  })
})

describe('lock guards — atoms.remove (chokepoint #2) [internal path]', () => {
  it('refuses removal of a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'system.md', { systemLocked: true })
    await expect(
      t.mutation(internal.atoms._removeInternal, {
        workspaceId: W,
        path: 'system.md',
      }),
    ).rejects.toThrow(/system-managed/)
    expect(await getAtom(t, 'system.md')).not.toBeNull()
  })

  it('deletes stale locked map files because _map is user-removable now', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, MAP_PATH, { systemLocked: true, userLocked: true })
    await seedAtom(t, '_map.md', { systemLocked: true, userLocked: true })

    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: W,
      path: MAP_PATH,
    })
    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: W,
      path: '_map.md',
    })

    expect(await getAtom(t, MAP_PATH)).toBeNull()
    expect(await getAtom(t, '_map.md')).toBeNull()
  })

  it('refuses removal of a userLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'me.md', { userLocked: true })
    await expect(
      t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'me.md' }),
    ).rejects.toThrow(/locked this file/)
  })

  it('removes unlocked atom normally', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'plain.md')
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'plain.md' })
    expect(await getAtom(t, 'plain.md')).toBeNull()
  })
})

describe('folder-path validation', () => {
  it('normalizes leading/trailing/double slashes', () => {
    expect(normalizeFolderPath('/a/b/')).toBe('a/b')
    expect(normalizeFolderPath('a//b')).toBe('a/b')
    expect(normalizeFolderPath('  /team/leads/  ')).toBe('team/leads')
  })

  it('rejects empty', () => {
    expect(validateFolderPath('').ok).toBe(false)
    expect(validateFolderPath('   ').ok).toBe(false)
    expect(validateFolderPath('//').ok).toBe(false)
  })

  it('rejects NUL', () => {
    expect(validateFolderPath('a\x00b').ok).toBe(false)
  })

  it('rejects spaces', () => {
    expect(validateFolderPath('a b').ok).toBe(false)
  })

  it("rejects '.' and '..' segments", () => {
    expect(validateFolderPath('a/./b').ok).toBe(false)
    expect(validateFolderPath('a/../b').ok).toBe(false)
    expect(validateFolderPath('.').ok).toBe(false)
  })

  it('rejects over-512 chars', () => {
    const long = 'a'.repeat(600)
    expect(validateFolderPath(long).ok).toBe(false)
  })

  it('accepts valid path', () => {
    const r = validateFolderPath('team/leads')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('team/leads')
  })
})

describe('FOLDER_COLORS / FOLDER_ICONS allowlists', () => {
  it('isFolderColor / isFolderIcon enforce the allowlist', () => {
    expect(isFolderColor('blue')).toBe(true)
    expect(isFolderColor('chartreuse')).toBe(false)
    expect(isFolderIcon('folder')).toBe(true)
    expect(isFolderIcon('atomic-nuke')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────
// Star mutations — public, lock-bypassing-by-design
// ────────────────────────────────────────────────────────────────

describe('atoms.setStar', () => {
  it('throws "not found" if the path is missing (no row creation)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.atoms.setStar, { path: 'ghost.md', starred: true }),
    ).rejects.toThrow(/not found/)
  })

  it('stars + unstars an atom WITHOUT touching its body or lock state', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'me.md', { source: 'user', userLocked: true })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setStar, { path: 'me.md', starred: true })
    let row = await getAtom(t, 'me.md')
    expect(row?.starred).toBe(true)
    expect(row?.userLocked).toBe(true) // unchanged
    expect(row?.body).toBe('seed me.md') // body untouched
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setStar, { path: 'me.md', starred: false })
    row = await getAtom(t, 'me.md')
    expect(row?.starred).toBeFalsy()
  })

  it('stars a systemLocked atom — line 39 says favorite, not "favorite if unlocked"', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', { systemLocked: true })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setStar, { path: '_map.md', starred: true })
    expect((await getAtom(t, '_map.md'))?.starred).toBe(true)
  })
})

// file-org-v1 §3.2 + §2-A.1 (Track-4 D4.1b ATOMIC) — public setLock
// mutation. The behavior contract:
//   setLock(true)  ⇒ atoms.userLocked = true
//   setLock(false) ⇒ atoms.userLocked = undefined (cleared)
//   setLock on a systemLocked atom ⇒ refuses (SystemLockError)
//   After setLock(true), an agent _upsertInternal call on that atom
//     fires UserLockError (the lock is enforced at chokepoint #1).
//   After setLock(false), the agent edit succeeds (lock cleared).
describe('atoms.setLock — public mutation behavior (D4.1b)', () => {
  it('toggles userLocked on then off', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'plan.md', { source: 'user' })
    const r1 = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: 'plan.md', locked: true })
    expect(r1.locked).toBe(true)
    expect(r1.changed).toBe(true)
    expect((await getAtom(t, 'plan.md'))?.userLocked).toBe(true)

    const r2 = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: 'plan.md', locked: false })
    expect(r2.locked).toBe(false)
    expect(r2.changed).toBe(true)
    expect((await getAtom(t, 'plan.md'))?.userLocked).toBeFalsy()
  })

  it('is idempotent — second setLock(true) reports changed:false', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'plan.md', { source: 'user', userLocked: true })
    const r = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: 'plan.md', locked: true })
    expect(r.changed).toBe(false)
  })

  it('throws "not found" for a missing path', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.atoms.setLock, { path: 'ghost.md', locked: true }),
    ).rejects.toThrow(/not found/)
  })

  // D4.1b R2-fold (indep FAIL-1): setLock used to refuse on a
  // systemLocked atom, creating a dual-lock trap (user locked an
  // agent-written atom before the loop tick, ended up unable to
  // clear their own decoration). Fix: setLock toggles userLocked
  // regardless of systemLocked. systemLocked stays untouched.
  it('toggles userLocked on a systemLocked atom (R2-fold) — systemLocked unaffected', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', { systemLocked: true })
    const r = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: '_map.md', locked: true })
    expect(r.locked).toBe(true)
    expect(r.changed).toBe(true)
    const row = await getAtom(t, '_map.md')
    // userLocked applied; systemLocked preserved.
    expect(row?.userLocked).toBe(true)
    expect(row?.systemLocked).toBe(true)
  })

  it('R2-fold dual-lock release path — setLock(false) on {systemLocked, userLocked} clears userLocked only', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', {
      systemLocked: true,
      userLocked: true,
    })
    const r = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: '_map.md', locked: false })
    expect(r.locked).toBe(false)
    expect(r.changed).toBe(true)
    const row = await getAtom(t, '_map.md')
    expect(row?.userLocked).toBeFalsy() // cleared
    expect(row?.systemLocked).toBe(true) // preserved
  })

  it('after setLock(true), agent _upsertInternal refuses with UserLockError', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'plan.md', { source: 'user' })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: 'plan.md', locked: true })
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: 'plan.md',
        body: 'agent spoof',
        allowUserOverwrite: true, // even with this — lock wins
      }),
    ).rejects.toThrow(/locked this file/)
  })

  it('after setLock(false), agent _upsertInternal succeeds', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'plan.md', {
      source: 'user',
      userLocked: true,
      body: 'before',
    })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.setLock, { path: 'plan.md', locked: false })
    // The user-content-overwrite guard still requires explicit
    // allowUserOverwrite (this is the OLDER guard, not the lock).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'plan.md',
      body: 'after-unlock',
      source: 'agent',
      allowUserOverwrite: true,
    })
    const row = await getAtom(t, 'plan.md')
    expect(row?.body).toContain('after-unlock')
    expect(row?.userLocked).toBeFalsy()
  })
})

// D4.1a R1-fold (indep FAIL-3): `_upsertSystem` must overwrite a
// dual-locked atom. Without the fold, a user who toggled their
// user-lock on `_map.md` would halt the next loop tick.
describe('_upsertSystem — dual-lock bypass (R1-fold FAIL-3)', () => {
  it('overwrites a {systemLocked:true, userLocked:true} atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', {
      systemLocked: true,
      userLocked: true,
    })
    await t.mutation(internal.atoms._upsertSystem, {
      workspaceId: W,
      path: '_map.md',
      body: 'fresh map after dual-lock',
      source: 'agent',
    })
    const row = await getAtom(t, '_map.md')
    expect(row?.body).toMatch(/fresh map/)
    expect(row?.systemLocked).toBe(true)
    // userLocked is preserved — _upsertSystem only re-asserts
    // systemLocked. The user's decoration on top survives.
    expect(row?.userLocked).toBe(true)
  })
})

// emoji-icons — setIcon writes the frontmatter `icon:` (file metadata)
describe('atoms.setIcon — file icon emoji (frontmatter)', () => {
  it('sets, updates, and clears the frontmatter icon; rejects over-long', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'note.md', { source: 'user', body: '---\nid: note\n---\nhi' })
    const as = t.withIdentity({ subject: W })

    await as.mutation(api.atoms.setIcon, { path: 'note.md', icon: '💰' })
    expect((await getAtom(t, 'note.md'))?.body).toContain('icon: 💰')

    await as.mutation(api.atoms.setIcon, { path: 'note.md', icon: '🚀' })
    const after = (await getAtom(t, 'note.md'))?.body ?? ''
    expect(after).toContain('icon: 🚀')
    expect(after).not.toContain('💰') // replaced, not duplicated
    expect(after).toContain('id: note') // id preserved

    // empty string clears the icon line
    await as.mutation(api.atoms.setIcon, { path: 'note.md', icon: '' })
    expect((await getAtom(t, 'note.md'))?.body ?? '').not.toContain('icon:')

    await expect(
      as.mutation(api.atoms.setIcon, { path: 'note.md', icon: 'x'.repeat(40) }),
    ).rejects.toThrow(/too long/)
  })
})
