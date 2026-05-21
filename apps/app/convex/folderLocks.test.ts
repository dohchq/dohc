/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

// file-org-v1 §5.1 / §5.4 — folder-side chokepoints (#3 atoms.move,
// #4 folders.move, #5 folders.remove) + folder cosmetic mutations +
// wikilink-skip-on-locked + folderMetadata persistence/restore.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_track4_folder'

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

async function seedFolder(t: ReturnType<typeof convexTest>, path: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert('folders', {
      workspaceId: W,
      path,
      createdAt: Date.now(),
    })
  })
}

async function getAtom(t: ReturnType<typeof convexTest>, path: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query('atoms').collect()
    return rows.find((r: any) => r.workspaceId === W && r.path === path) ?? null
  })
}

async function getMeta(t: ReturnType<typeof convexTest>, path: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query('folderMetadata').collect()
    return rows.find((r: any) => r.workspaceId === W && r.path === path) ?? null
  })
}

// ────────────────────────────────────────────────────────────────
// §5.1 chokepoint #3 — atoms.move
// ────────────────────────────────────────────────────────────────

describe('atoms.move — chokepoint #3', () => {
  it('refuses to rename a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '_map.md', { systemLocked: true })
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.atoms.move, { fromPath: '_map.md', toPath: 'oldmap.md' }),
    ).rejects.toThrow(/system-managed/)
    expect(await getAtom(t, '_map.md')).not.toBeNull()
    expect(await getAtom(t, 'oldmap.md')).toBeNull()
  })

  it('refuses to rename a userLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'me.md', { userLocked: true, source: 'user' })
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.atoms.move, { fromPath: 'me.md', toPath: 'old-me.md' }),
    ).rejects.toThrow(/locked this file/)
  })

  it('carries starred + userLocked through a successful rename', async () => {
    const t = convexTest(schema, modules)
    // Seed a non-locked starred atom (so the move is allowed but
    // the cosmetic + soft-lock state still rides along).
    await seedAtom(t, 'draft.md', { starred: true, source: 'user' })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.move, { fromPath: 'draft.md', toPath: 'shipped.md' })
    const row = await getAtom(t, 'shipped.md')
    expect(row?.starred).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────
// §5.1 chokepoint #4 — folders.move (subtree pre-scan)
// ────────────────────────────────────────────────────────────────

describe('folders.move — chokepoint #4', () => {
  it('refuses to move a folder if ANY moved atom is systemLocked', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    await seedAtom(t, 'team/_map.md', { systemLocked: true })
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' }),
    ).rejects.toThrow(/system-managed/)
    // No partial move on refuse.
    expect(await getAtom(t, 'team/anna.md')).not.toBeNull()
    expect(await getAtom(t, 'crew/anna.md')).toBeNull()
  })

  it('refuses if ANY moved atom is userLocked', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    await seedAtom(t, 'team/me.md', { userLocked: true, source: 'user' })
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' }),
    ).rejects.toThrow(/locked this file/)
  })

  it('moves a clean folder successfully (no lock)', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    await seedAtom(t, 'team/ben.md')
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' })
    expect(await getAtom(t, 'team/anna.md')).toBeNull()
    expect(await getAtom(t, 'crew/anna.md')).not.toBeNull()
    expect(await getAtom(t, 'crew/ben.md')).not.toBeNull()
  })

  // D4.1a R1-fold (Codex FAIL-2 + indep FAIL-2): the write cap
  // MUST include the wikilink-rewrite cascade upper-bound. Without
  // the fold, a single-atom move with thousands of bystanders
  // would pass the cap (planned=2) then blow Convex's hard limit
  // mid-cascade.
  it('refuses move with bystander cascade past cap (R1-fold)', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    // Seed bystanders. 4001 of them each link to team/anna ⇒
    // bystanderUpperBound=4001, planned=2+4001=4003 > 4000 cap.
    await t.run(async (ctx) => {
      for (let i = 0; i < 4001; i++) {
        await ctx.db.insert('atoms', {
          workspaceId: W,
          path: `b/${i}.md`,
          body: 'see [[team/anna]]',
          updatedAt: Date.now(),
        })
      }
    })
    await expect(
      t
        .withIdentity({ subject: W })
        .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' }),
    ).rejects.toThrow(/folder move too large|bystander rewrites/)
    // No partial move — source still there.
    expect(await getAtom(t, 'team/anna.md')).not.toBeNull()
  }, 30_000)

  it('follows folderMetadata recursively (Option B)', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    // Decorate the parent + a nested-but-non-existent folder.
    await t.run(async (ctx) => {
      await ctx.db.insert('folderMetadata', {
        workspaceId: W,
        path: 'team',
        icon: 'folder-heart',
        color: 'blue',
        updatedAt: Date.now(),
      })
      await ctx.db.insert('folderMetadata', {
        workspaceId: W,
        path: 'team/leads',
        starred: true,
        updatedAt: Date.now(),
      })
    })
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' })
    expect(await getMeta(t, 'team')).toBeNull()
    expect(await getMeta(t, 'team/leads')).toBeNull()
    const root = await getMeta(t, 'crew')
    expect(root?.icon).toBe('folder-heart')
    expect(root?.color).toBe('blue')
    const nested = await getMeta(t, 'crew/leads')
    expect(nested?.starred).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────
// §5.1 chokepoint #5 — folders.remove (first-invocation pre-scan)
// ────────────────────────────────────────────────────────────────

describe('folders.remove — chokepoint #5', () => {
  it('refuses to delete a folder containing a systemLocked atom', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    await seedAtom(t, 'team/_locked.md', { systemLocked: true })
    await expect(
      t.withIdentity({ subject: W }).mutation(api.folders.remove, { path: 'team' }),
    ).rejects.toThrow(/system-managed/)
    // No partial delete.
    expect(await getAtom(t, 'team/anna.md')).not.toBeNull()
    expect(await getAtom(t, 'team/_locked.md')).not.toBeNull()
  })

  it('refuses with userLocked child', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/me.md', { userLocked: true, source: 'user' })
    await expect(
      t.withIdentity({ subject: W }).mutation(api.folders.remove, { path: 'team' }),
    ).rejects.toThrow(/locked this file/)
  })

  it('deletes a clean folder', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await seedAtom(t, 'team/anna.md')
    await t.withIdentity({ subject: W }).mutation(api.folders.remove, { path: 'team' })
    expect(await getAtom(t, 'team/anna.md')).toBeNull()
  })

  // D4.1a R1-fold (indep FAIL-1): metadata sweep MUST clean
  // decorated-empty subfolders even when atom deletion runs into a
  // continuation. Without the fold, the metadata orphan survived.
  // R5 fold (Codex full-app FAIL-1) — folders.move MUST reconcile
  // the Track-1 atomId index for every moved atom. Without this,
  // formula `{=…id…}` resolution silently breaks after a folder
  // rename (atomIds.path still points at the OLD path).
  it('R5 fold — folders.move reconciles atomId for each moved atom', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    // Seed an atom WITH a frontmatter id (Track-1 invariant: id
    // seeded once; rename moves the path but keeps the id).
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'team/anna.md',
        body: '---\nid: my-anna-id\n---\nhello',
        updatedAt: Date.now(),
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'my-anna-id',
        path: 'team/anna.md',
        state: 'bound',
      })
    })
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.move, { fromPath: 'team', toPath: 'crew' })
    // atomIds row's path MUST follow the move (else `{=my-anna-id}`
    // resolves to the gone path and renders '—').
    const idRow = await t.run(async (ctx) => {
      const rows = await ctx.db.query('atomIds').collect()
      return rows.find(
        (r: any) => r.workspaceId === W && r.fileId === 'my-anna-id',
      )
    })
    expect(idRow?.path).toBe('crew/anna.md')
    expect(idRow?.state).toBe('bound')
  })

  // R5 fold (Codex full-app FAIL-2) — folders.remove MUST act on each
  // deleted atom's id. D4.14: it now RELEASES (deletes the index row)
  // so a same-name recreate reclaims the clean id — instead of the
  // old permanent tombstone. The chokepoint is still exercised per
  // contained atom; only the IO changed (delete vs patch-to-released).
  it('R5 fold / D4.14 — folders.remove releases (deletes) each atom id row', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'team/anna.md',
        body: '---\nid: my-anna-id\n---\nhello',
        updatedAt: Date.now(),
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'my-anna-id',
        path: 'team/anna.md',
        state: 'bound',
      })
    })
    await t.withIdentity({ subject: W }).mutation(api.folders.remove, { path: 'team' })
    // D4.14 — the atomIds row is GONE (released, not tombstoned).
    const idRow = await t.run(async (ctx) => {
      const rows = await ctx.db.query('atomIds').collect()
      return rows.find(
        (r: any) => r.workspaceId === W && r.fileId === 'my-anna-id',
      )
    })
    // `find` → undefined → serialized to null across the t.run boundary.
    expect(idRow ?? null).toBeNull()
  })

  it('cleans orphan folderMetadata via continuation (R1-fold FAIL-1)', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    // Decorated-empty subfolder (metadata row only, no folders row).
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setMeta, {
        path: 'team/archive',
        icon: 'folder-archive',
      })
    expect(await getMeta(t, 'team/archive')).not.toBeNull()
    // Remove the parent. Even on the first pass the budget covers
    // both the (zero) atoms and the metadata sweep; the regression
    // is that BEFORE the fold, the metadata sweep was gated on
    // `isFirstInvocation && budget>0`, but the sweep order put it
    // AFTER the folders loop, so a budget-exhaust-on-folders would
    // skip it and continuations could never re-run it. The fold
    // drops the isFirstInvocation gate.
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.remove, { path: 'team' })
    expect(await getMeta(t, 'team/archive')).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────
// Wikilink-skip-on-locked (atoms.move + folders.move rewrite loops)
// ────────────────────────────────────────────────────────────────

describe('wikilink rewrite — SKIP-ON-LOCKED (§2.5)', () => {
  // D4.7d — Milkdown Crepe escapes opening brackets when
  // serializing typed content to markdown: typing `[[a]]` in the
  // editor saves as `\[\[a]]` (CommonMark only requires the
  // opening `[`s to be escaped to suppress link parsing). The
  // cascade regex must match BOTH forms; this regression test
  // proves it.
  it('D4.7d — cascade matches both [[path]] and Crepe-escaped \\[\\[path]] forms', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'draft.md', { body: 'x' })
    // Two ref atoms — one with the bare form (agent-seeded /
    // legacy), one with the Crepe-escaped form. Both should
    // rewrite to the bare new form.
    await seedAtom(t, 'ref-bare.md', {
      source: 'user',
      body: 'see [[draft]] here',
    })
    await seedAtom(t, 'ref-escaped.md', {
      source: 'user',
      body: 'see \\[\\[draft]] here',
    })
    const result = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.move, { fromPath: 'draft.md', toPath: 'shipped.md' })
    expect(result.linkUpdates).toBe(2)
    expect((await getAtom(t, 'ref-bare.md'))?.body).toContain('[[shipped]]')
    expect((await getAtom(t, 'ref-escaped.md'))?.body).toContain('[[shipped]]')
  })

  it('does NOT rewrite [[old]] in a locked atom; counts it; samples it', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'draft.md', { body: 'untouched' })
    await seedAtom(t, 'ref-locked.md', {
      userLocked: true,
      source: 'user',
      body: 'see [[draft]] here',
    })
    await seedAtom(t, 'ref-open.md', {
      source: 'user',
      body: 'see [[draft]] here',
    })
    const result = await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.move, { fromPath: 'draft.md', toPath: 'shipped.md' })
    expect(result.linkUpdates).toBe(1) // ref-open rewritten
    expect(result.skippedLockedCount).toBe(1) // ref-locked skipped
    expect(result.skippedLockedSample).toContain('ref-locked.md')
    expect((await getAtom(t, 'ref-locked.md'))?.body).toContain('[[draft]]')
    expect((await getAtom(t, 'ref-open.md'))?.body).toContain('[[shipped]]')
  })
})

// ────────────────────────────────────────────────────────────────
// §5.4 — folder cosmetic mutations (setMeta + setStar + list union)
// ────────────────────────────────────────────────────────────────

describe('folders.setMeta + setStar', () => {
  it('accepts a chosen emoji icon, rejects an over-long icon + invalid color', async () => {
    const t = convexTest(schema, modules)
    // emoji-icons — `icon` now holds a chosen emoji (or legacy token),
    // so a short string is VALID; only absurdly long icons are rejected.
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'team',
      icon: '💰',
    })
    await expect(
      t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
        path: 'team',
        icon: 'x'.repeat(40),
      }),
    ).rejects.toThrow(/invalid folder icon/)
    await expect(
      t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
        path: 'team',
        color: 'chartreuse',
      }),
    ).rejects.toThrow(/invalid folder color/)
  })

  it('creates, updates, and GCs the row when all-empty', async () => {
    const t = convexTest(schema, modules)
    // Create
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'team',
      icon: 'folder-heart',
      color: 'blue',
    })
    let row = await getMeta(t, 'team')
    expect(row?.icon).toBe('folder-heart')
    expect(row?.color).toBe('blue')
    // Update
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'team',
      starred: true,
    })
    row = await getMeta(t, 'team')
    expect(row?.starred).toBe(true)
    expect(row?.icon).toBe('folder-heart') // sticky
    // Empty out — GC
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'team',
      icon: null,
      color: null,
      starred: false,
    })
    expect(await getMeta(t, 'team')).toBeNull()
  })

  it('folders.list unions live folders + decorated-empty folder rows', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    // Decorate a folder that has no `folders` row (empty-shell case).
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'archive',
      icon: 'folder-archive',
    })
    const rows = await t.withIdentity({ subject: W }).query(api.folders.list, {})
    const paths = rows.map((r) => r.path).sort()
    expect(paths).toEqual(['archive', 'team'])
    const archive = rows.find((r) => r.path === 'archive')
    expect(archive?.icon).toBe('folder-archive')
  })

  it('setStar sugar over setMeta', async () => {
    const t = convexTest(schema, modules)
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setStar, { path: 'team', starred: true })
    expect((await getMeta(t, 'team'))?.starred).toBe(true)
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setStar, { path: 'team', starred: false })
    expect(await getMeta(t, 'team')).toBeNull() // GCd
  })

  // R5 fold (Codex full-app FAIL-3) — setStar's GC path (un-star
  // the last decoration) now SNAPSHOTS to trash before delete,
  // mirroring setMeta. Previously the row vanished without
  // recovery surface.
  it('R5 fold — setStar GC records trash with metaOnly marker', async () => {
    const t = convexTest(schema, modules)
    // Star a folder that has no other decoration.
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setStar, { path: 'team', starred: true })
    // Un-star → row GC'd → trash row recorded with metaOnly:true.
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setStar, { path: 'team', starred: false })
    expect(await getMeta(t, 'team')).toBeNull()
    // Trash row exists.
    const trash = await t.run(async (ctx) => {
      const rows = await ctx.db.query('trash').collect()
      return rows.find(
        (r: any) => r.workspaceId === W && r.kind === 'folder' && r.ref === 'team',
      )
    })
    expect(trash).toBeTruthy()
    expect((trash?.payload as any)?.metaOnly).toBe(true)
    // Restore brings it back as metadata-only (no folders row).
    await t.mutation(internal.trash._restore, {
      workspaceId: W,
      trashId: trash!._id,
    })
    expect((await getMeta(t, 'team'))?.starred).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────
// Trash payload preservation (atom + folder restore round-trip)
// ────────────────────────────────────────────────────────────────

describe('trash payload preservation (atom + folder)', () => {
  it('preserves systemLocked / userLocked / starred through atom delete+restore', async () => {
    // Note: a systemLocked atom CANNOT be deleted via the public
    // remove path (chokepoint #2 refuses). So we test the user-side
    // pair: starred + userLocked round-trip via the public remove.
    // userLocked is also refused by chokepoint #2, so we manually
    // delete via ctx.db.delete bypassing the guard to simulate a
    // restored-from-trash row in the future.
    const t = convexTest(schema, modules)
    await seedAtom(t, 'starred.md', { source: 'user', starred: true })
    await t.mutation(internal.atoms._removeInternal, {
      workspaceId: W,
      path: 'starred.md',
    })
    // Find + restore the trash row
    const trashId = await t.run(async (ctx) => {
      const rows = await ctx.db.query('trash').collect()
      const row = rows.find(
        (r: any) =>
          r.workspaceId === W && r.kind === 'atom' && r.ref === 'starred.md',
      )
      return row!._id
    })
    await t.mutation(internal.trash._restore, { workspaceId: W, trashId })
    expect((await getAtom(t, 'starred.md'))?.starred).toBe(true)
  })

  // R4 fold (Codex FAIL-4) — setMeta GC (clear-all on a
  // decorated-empty folder) now snapshots to trash with
  // metaOnly:true marker; restore recreates ONLY the
  // folderMetadata row, not a phantom folders row.
  it('R4 fold — setMeta GC snapshots to trash; restore is metadata-only', async () => {
    const t = convexTest(schema, modules)
    // Decorate an empty folder (no folders row exists).
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setMeta, {
        path: 'archive',
        icon: 'folder-archive',
        color: 'orange',
      })
    expect(await getMeta(t, 'archive')).not.toBeNull()
    // Clear all → GC → trash row recorded.
    await t.withIdentity({ subject: W }).mutation(api.folders.setMeta, {
      path: 'archive',
      icon: null,
      color: null,
      starred: false,
    })
    expect(await getMeta(t, 'archive')).toBeNull()
    // Restore from trash.
    const trashId = await t.run(async (ctx) => {
      const rows = await ctx.db.query('trash').collect()
      const row = rows.find(
        (r: any) =>
          r.workspaceId === W && r.kind === 'folder' && r.ref === 'archive',
      )
      return row!._id
    })
    await t.mutation(internal.trash._restore, { workspaceId: W, trashId })
    // folderMetadata recreated with the original cosmetics.
    const restored = await getMeta(t, 'archive')
    expect(restored?.icon).toBe('folder-archive')
    expect(restored?.color).toBe('orange')
    // NO phantom folders row created (the folder was metadata-only).
    const folderRowExists = await t.run(async (ctx) => {
      const rows = await ctx.db.query('folders').collect()
      return rows.some(
        (r: any) => r.workspaceId === W && r.path === 'archive',
      )
    })
    expect(folderRowExists).toBe(false)
  })

  it('preserves folderMetadata cosmetics through folder delete+restore', async () => {
    const t = convexTest(schema, modules)
    await seedFolder(t, 'team')
    await t
      .withIdentity({ subject: W })
      .mutation(api.folders.setMeta, {
        path: 'team',
        icon: 'folder-heart',
        color: 'blue',
        starred: true,
      })
    // Delete the folder. The chokepoint enforces no-locked-children,
    // which is satisfied (no atoms under it).
    await t.withIdentity({ subject: W }).mutation(api.folders.remove, { path: 'team' })
    expect(await getMeta(t, 'team')).toBeNull()
    // Restore: the folder + its decoration come back atomically.
    const trashId = await t.run(async (ctx) => {
      const rows = await ctx.db.query('trash').collect()
      const row = rows.find(
        (r: any) =>
          r.workspaceId === W && r.kind === 'folder' && r.ref === 'team',
      )
      return row!._id
    })
    await t.mutation(internal.trash._restore, { workspaceId: W, trashId })
    const restored = await getMeta(t, 'team')
    expect(restored?.icon).toBe('folder-heart')
    expect(restored?.color).toBe('blue')
    expect(restored?.starred).toBe(true)
  })
})
