/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { internal, api } from './_generated/api'
import schema from './schema'
import {
  injectTypeSkillIntoBody,
} from './skillsMigration'
import {
  isSkillAtomBody,
  isHtmlAtomBody,
  extractFrontmatterId,
} from './atomId'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_t3p2a'

// Track-3 P2a — the §6.4 migration: uniform `type: skill` inject
// into legacy `skills/*.md` atoms (NO existing type) + the
// `migrationNotice: 'skills-v1'` per-file advisory + the
// clear-on-user-edit / clear-on-move dismissal lifecycle.

describe('injectTypeSkillIntoBody — pure function', () => {
  it('no frontmatter ⇒ prepends a fresh ---\\ntype: skill\\n---\\n block', () => {
    const out = injectTypeSkillIntoBody('Just plain markdown.')
    expect(out.changed).toBe(true)
    expect(out.body).toBe('---\ntype: skill\n---\nJust plain markdown.')
    expect(isSkillAtomBody(out.body)).toBe(true)
  })

  it('frontmatter WITHOUT a type: line ⇒ inserts type: skill as first field', () => {
    const before = '---\nid: weekly.review\nname: Weekly review\n---\nBody'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(true)
    expect(out.body).toBe(
      '---\ntype: skill\nid: weekly.review\nname: Weekly review\n---\nBody',
    )
    expect(isSkillAtomBody(out.body)).toBe(true)
    expect(extractFrontmatterId(out.body)).toBe('weekly.review')
  })

  it('frontmatter WITH type: skill already ⇒ unchanged (idempotent)', () => {
    const before = '---\ntype: skill\nid: x\n---\nBody'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(false)
    expect(out.body).toBe(before)
  })

  it('frontmatter WITH type: html ⇒ unchanged (user-intent preserved, NOT re-typed)', () => {
    const before = '---\ntype: html\nid: x\n---\n<h1>X</h1>'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(false)
    expect(out.body).toBe(before)
    expect(isHtmlAtomBody(out.body)).toBe(true) // still html
  })

  it('frontmatter WITH type: plugin ⇒ unchanged', () => {
    const before = '---\ntype: plugin\nid: gantt\nkernel: heatmap\n---\n'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(false)
  })

  // ── round-1 fold coverage gaps (Codex FAIL-1/-5 + indep FAIL-2/-6) ──
  it('CRLF body: preserves \\r\\n line endings (byte-exact frontmatter)', () => {
    const before = '---\r\nid: weekly.review\r\n---\r\nBody'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(true)
    expect(out.body).toBe(
      '---\r\ntype: skill\r\nid: weekly.review\r\n---\r\nBody',
    )
    expect(isSkillAtomBody(out.body)).toBe(true)
  })

  it('opener with trailing whitespace `---   \\n` still matches', () => {
    const before = '---   \nid: x\n---\nBody'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(true)
    expect(isSkillAtomBody(out.body)).toBe(true)
    // preserves the EOL convention; the opener line itself is rebuilt
    // with the same EOL (LF here).
    expect(out.body.startsWith('---\ntype: skill\n')).toBe(true)
  })

  it('quoted id round-trips through migration', () => {
    const before = "---\nid: 'weekly.review'\n---\nBody"
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(true)
    expect(isSkillAtomBody(out.body)).toBe(true)
    expect(extractFrontmatterId(out.body)).toBe('weekly.review')
  })

  it('frontmatter WITH unknown type (`type: foo`) ⇒ unchanged (user intent wins)', () => {
    const before = '---\ntype: foo\nid: x\n---\n{billable: 4}'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(false)
    expect(out.body).toBe(before)
  })

  it('frontmatter with duplicate `type:` ⇒ unchanged (countTypeLines > 0 wins)', () => {
    const before = '---\ntype: skill\ntype: html\nid: x\n---\nb'
    const out = injectTypeSkillIntoBody(before)
    expect(out.changed).toBe(false)
  })
})

describe('_migrateLegacyPaths — one-shot mutation', () => {
  it('injects type: skill into ALL `skills/*` atoms with no type declaration', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ins = (path: string, body: string) =>
        ctx.db.insert('atoms', { workspaceId: W, path, body, updatedAt: 1 })
      await ins('skills/weekly-review.md', 'Plain skill instructions.')
      await ins('skills/team/data-export.md', '---\nid: export\n---\nSteps:')
      await ins('skills/already-typed.md', '---\ntype: skill\nid: x\n---\nX')
      await ins('skills/not-a-skill.md', '---\ntype: html\n---\n<h1/>')
      await ins('notes/plain.md', '{billable: 4}') // NOT in skills/ — skip
    })
    const result = await t.mutation(
      internal.skillsMigration._migrateLegacyPaths,
      { workspaceId: W },
    )
    expect(result.scanned).toBe(4) // 4 in skills/ (the notes/ one is filtered)
    expect(result.migrated).toBe(2) // only the two untyped ones get injected
    // round-1 fold: typed-but-not-skill count (the operator's safety
    // signal before any future §6.4.5 cleanup of isLegacySkillPath).
    // already-typed.md (type: skill) + not-a-skill.md (type: html) = 2
    expect(result.skippedTyped).toBe(2)

    const all = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).filter(
        (a) => a.workspaceId === W,
      ),
    )
    const byPath = Object.fromEntries(all.map((a) => [a.path, a]))
    // Migrated atoms got `type: skill` + the advisory.
    expect(isSkillAtomBody(byPath['skills/weekly-review.md'].body)).toBe(true)
    expect(byPath['skills/weekly-review.md'].migrationNotice).toBe('skills-v1')
    expect(isSkillAtomBody(byPath['skills/team/data-export.md'].body)).toBe(true)
    expect(byPath['skills/team/data-export.md'].migrationNotice).toBe('skills-v1')
    // The fm-existing skill atom kept the original id.
    expect(extractFrontmatterId(byPath['skills/team/data-export.md'].body)).toBe('export')
    // Already-typed atoms: untouched + NO advisory.
    expect(byPath['skills/already-typed.md'].migrationNotice).toBeUndefined()
    expect(byPath['skills/not-a-skill.md'].migrationNotice).toBeUndefined()
    expect(isHtmlAtomBody(byPath['skills/not-a-skill.md'].body)).toBe(true)
    // The non-skills/ note is NOT migrated.
    expect(byPath['notes/plain.md'].migrationNotice).toBeUndefined()
  })

  it('is idempotent: re-running the migration is a no-op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/x.md',
        body: 'plain',
        updatedAt: 1,
      })
    })
    const first = await t.mutation(
      internal.skillsMigration._migrateLegacyPaths,
      { workspaceId: W },
    )
    expect(first.migrated).toBe(1)
    const second = await t.mutation(
      internal.skillsMigration._migrateLegacyPaths,
      { workspaceId: W },
    )
    // The second pass scans but migrates 0 (the body now has type:skill).
    expect(second.scanned).toBe(1)
    expect(second.migrated).toBe(0)
    // round-1 fold (indep FAIL-5): re-running the migration does
    // NOT clear the existing migrationNotice (the lifecycle clears
    // it only on user-edit / move, not on re-migration).
    const row = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).find(
        (a) => a.workspaceId === W && a.path === 'skills/x.md',
      ),
    )
    expect(row?.migrationNotice).toBe('skills-v1')
  })

  it('legacy `skills/x.md` WITHOUT `id:` gets seeded + reconciled (FAIL-1 fold)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/unseeded.md',
        body: 'Plain body, no frontmatter, no id.',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.skillsMigration._migrateLegacyPaths, {
      workspaceId: W,
    })
    // Post-migration: body has `type: skill` + a Track-1 `id:`.
    const row = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).find(
        (a) => a.workspaceId === W && a.path === 'skills/unseeded.md',
      ),
    )
    expect(row).toBeTruthy()
    expect(isSkillAtomBody(row!.body)).toBe(true)
    const id = extractFrontmatterId(row!.body)
    expect(id).not.toBeNull() // SEEDED
    // atomIds index has a BOUND row for this atom's id (reconciled).
    const idRow = await t.run(async (ctx) =>
      ctx.db
        .query('atomIds')
        .withIndex('by_workspace_fileId', (q) =>
          q.eq('workspaceId', W).eq('fileId', id!),
        )
        .unique(),
    )
    expect(idRow?.state).toBe('bound')
    expect(idRow?.path).toBe('skills/unseeded.md')
  })

  it('is workspace-scoped: does NOT touch other workspaces', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: 'ws_other',
        path: 'skills/foreign.md',
        body: 'plain',
        updatedAt: 1,
      })
    })
    const result = await t.mutation(
      internal.skillsMigration._migrateLegacyPaths,
      { workspaceId: W },
    )
    expect(result.scanned).toBe(0)
    const foreign = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', 'ws_other').eq('path', 'skills/foreign.md'),
        )
        .unique(),
    )
    expect(foreign?.migrationNotice).toBeUndefined()
  })
})

describe('migration advisory lifecycle — clear-on-edit / clear-on-move', () => {
  it("user edit clears migrationNotice (the user's edit IS acknowledgment)", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/wishlist.md',
        body: 'My skill wishlist.',
        updatedAt: 1,
      })
    })
    // Run the migration → notice set.
    await t.mutation(internal.skillsMigration._migrateLegacyPaths, {
      workspaceId: W,
    })
    let row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'skills/wishlist.md'),
        )
        .unique(),
    )
    expect(row?.migrationNotice).toBe('skills-v1')
    // User edits the file via the public `api.atoms.upsert` mutation,
    // which internally sets `isUserEdit: true` (the canonical user-
    // edit signal — `_upsertInternal` doesn't expose it).
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.upsert, {
        path: 'skills/wishlist.md',
        body: row!.body + '\nEdited by me.',
        source: 'user',
      })
    row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'skills/wishlist.md'),
        )
        .unique(),
    )
    expect(row?.migrationNotice).toBeUndefined()
  })

  it('agent (non-user) edit does NOT clear migrationNotice', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/foo.md',
        body: 'plain',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.skillsMigration._migrateLegacyPaths, {
      workspaceId: W,
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'skills/foo.md',
      body: 'agent-rewritten body without type frontmatter',
      source: 'agent',
      allowUserOverwrite: true,
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'skills/foo.md'),
        )
        .unique(),
    )
    // Agent edit ⇒ notice still present (the USER must confirm).
    expect(row?.migrationNotice).toBe('skills-v1')
  })

  it('_clearMigrationNotice clears the row (used by move / explicit dismiss)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/bar.md',
        body: 'plain',
        updatedAt: 1,
        migrationNotice: 'skills-v1',
      })
    })
    await t.mutation(internal.skillsMigration._clearMigrationNotice, {
      workspaceId: W,
      path: 'skills/bar.md',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'skills/bar.md'),
        )
        .unique(),
    )
    expect(row?.migrationNotice).toBeUndefined()
  })

  it('atoms.move clears migrationNotice (the new row never carries it forward)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'skills/notes.md',
        body: 'plain',
        updatedAt: 1,
        migrationNotice: 'skills-v1',
      })
    })
    await t
      .withIdentity({ subject: W })
      .mutation(api.atoms.move, {
        fromPath: 'skills/notes.md',
        toPath: 'notes/from-skills.md',
      })
    const newRow = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'notes/from-skills.md'),
        )
        .unique(),
    )
    expect(newRow?.migrationNotice).toBeUndefined()
  })
})
