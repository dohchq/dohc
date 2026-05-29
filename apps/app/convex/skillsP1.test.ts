/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import {
  isSkillAtomBody,
  isCommandAtomBody,
  isHtmlAtomBody,
  isLegacySkillPath,
  isNonDataAtom,
  countTypeLines,
} from './atomId'
import { MAP_PATH } from './inlineAtom'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_t3p1'
const SKILL = '---\ntype: skill\nid: weekly.review\n---\nWalk the user through:\n1. read logs.md\n2. summarize'
const COMMAND = '---\ntype: command\nid: draft.invoice\n---\nRun the invoice workflow now.'
const HTML = '---\ntype: html\nid: report.q3\n---\n<h1>Report</h1>'
const MD = '---\nid: notes.q3\n---\n# Notes\nbillable: 999\nThis is plain markdown.'

// Track-3 P1 — the unified §6 predicate + the 11-site retrofit.
// These tests are the §6 audit lock; mirror the Track-2 P1a pattern.

describe('isSkillAtomBody — §1.2 EXACT grammar parity with isHtmlAtomBody', () => {
  it('accepts: bare, single-quoted, double-quoted, spaces', () => {
    expect(isSkillAtomBody('---\ntype: skill\nid: x\n---\nbody')).toBe(true)
    expect(isSkillAtomBody("---\ntype: 'skill'\nid: x\n---\nbody")).toBe(true)
    expect(isSkillAtomBody('---\ntype: "skill"\nid: x\n---\nbody')).toBe(true)
    expect(isSkillAtomBody('---\ntype:   skill   \nid: x\n---\nbody')).toBe(true)
  })
  it('rejects: uppercase, mixed-case, comments, arrays', () => {
    expect(isSkillAtomBody('---\ntype: SKILL\nid: x\n---\nb')).toBe(false)
    expect(isSkillAtomBody('---\ntype: Skill\nid: x\n---\nb')).toBe(false)
    expect(isSkillAtomBody('---\ntype: skill # note\nid: x\n---\nb')).toBe(false)
    expect(isSkillAtomBody('---\ntype: [skill]\nid: x\n---\nb')).toBe(false)
  })
  it('rejects: no frontmatter, near-miss tokens, inline-not-frontmatter', () => {
    expect(isSkillAtomBody('plain body')).toBe(false)
    expect(isSkillAtomBody('---\nid: x\n---\nb')).toBe(false)
    expect(isSkillAtomBody('---\nrole: skill\nid: x\n---\nb')).toBe(false)
    expect(isSkillAtomBody('not frontmatter but mentions type: skill')).toBe(
      false,
    )
  })
  it('ReDoS-safe under catastrophic input (>40k spaces, no closing fence)', () => {
    const evil = '---\n' + ' \n'.repeat(40000) + 'type: skill'
    const t0 = Date.now()
    expect(isSkillAtomBody(evil)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(50)
  })
})

describe('isCommandAtomBody — commands are explicit runnable chat entries', () => {
  it('accepts the same strict type grammar as skills/html', () => {
    expect(isCommandAtomBody('---\ntype: command\nid: x\n---\nbody')).toBe(true)
    expect(isCommandAtomBody("---\ntype: 'command'\nid: x\n---\nbody")).toBe(true)
    expect(isCommandAtomBody('---\ntype: "command"\nid: x\n---\nbody')).toBe(true)
  })

  it('rejects duplicate type declarations and near misses', () => {
    expect(isCommandAtomBody('---\ntype: command\ntype: skill\n---\nb')).toBe(false)
    expect(isCommandAtomBody('---\ntype: Command\n---\nb')).toBe(false)
    expect(isCommandAtomBody('plain type: command')).toBe(false)
  })
})

describe('countTypeLines — §1.2 strict-reject DUPLICATE `type:` lines', () => {
  it('counts the type: declarations in a frontmatter block', () => {
    expect(countTypeLines('')).toBe(0)
    expect(countTypeLines('id: x')).toBe(0)
    expect(countTypeLines('type: skill\nid: x')).toBe(1)
    expect(countTypeLines('type: skill\nid: x\ntype: html')).toBe(2)
  })
  it('isHtmlAtomBody REJECTS duplicate `type:` lines (Track-3 P1 tightening)', () => {
    // Pre-Track-3 the first-line-wins regex would match `type: html`
    // first; v6 fold introduces structural rejection of any
    // frontmatter with >1 type: declaration.
    expect(
      isHtmlAtomBody('---\ntype: html\nid: x\ntype: skill\n---\nb'),
    ).toBe(false)
    expect(
      isHtmlAtomBody('---\ntype: html\ntype: html\nid: x\n---\nb'),
    ).toBe(false)
  })
  it('isSkillAtomBody REJECTS duplicate `type:` lines (parity)', () => {
    expect(
      isSkillAtomBody('---\ntype: skill\nid: x\ntype: html\n---\nb'),
    ).toBe(false)
  })
})

describe('isLegacySkillPath — top-level `skills/` prefix only', () => {
  it('matches top-level skills/ paths incl. subfolders', () => {
    expect(isLegacySkillPath('skills/weekly-review.md')).toBe(true)
    expect(isLegacySkillPath('skills/team/weekly-review.md')).toBe(true)
  })
  it('does NOT match non-top-level skills/ paths', () => {
    expect(isLegacySkillPath('notes/skills/x.md')).toBe(false)
    expect(isLegacySkillPath('skills_archive/x.md')).toBe(false)
    expect(isLegacySkillPath('SKILLS/x.md')).toBe(false) // case-sensitive
  })
})

describe('isNonDataAtom — §6 unified predicate (the 11-site source of truth)', () => {
  it('matches MAP_PATH, html, skill, command, legacy-skill-path', () => {
    expect(isNonDataAtom(MAP_PATH, 'anything')).toBe(true)
    expect(isNonDataAtom('r.md', HTML)).toBe(true)
    expect(isNonDataAtom('s.md', SKILL)).toBe(true)
    expect(isNonDataAtom('.commands/draft-invoice.md', COMMAND)).toBe(true)
    expect(isNonDataAtom('skills/legacy.md', 'no frontmatter')).toBe(true)
  })
  it('does NOT match plain md / unrelated paths', () => {
    expect(isNonDataAtom('.context/_map.md', 'anything')).toBe(false)
    expect(isNonDataAtom('notes/x.md', MD)).toBe(false)
    expect(isNonDataAtom('logs/2025_07_14.md', 'billable: 4')).toBe(false)
  })
})

// ── §6 end-to-end (a `{billable: 999}` in a SKILL body never
// reaches the value-scanner downstream of any of the 11 sites) ──

describe('§6 end-to-end — skill body {k:v} never captures or resolves', () => {
  const SKILL_WITH_VALUE =
    '---\ntype: skill\nid: weekly.review\n---\n' +
    'Example: when you see {billable: 999} in the data, treat it...'
  const LEGACY_PATH_WITH_VALUE =
    'I track {logs: 4.5} hours here.\nNo frontmatter; legacy `skills/` path.'

  it('atomCapture skips a skill body (no inline captures recorded)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'skills/p1-skill.md',
      body: SKILL_WITH_VALUE,
      source: 'agent',
    })
    // The capture table must be empty for this workspace.
    const captures = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W,
      ),
    )
    expect(captures).toEqual([])
  })

  it('atomCapture skips a legacy `skills/*.md` body (compat OR)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'skills/legacy.md',
      body: LEGACY_PATH_WITH_VALUE,
      source: 'agent',
    })
    const captures = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W,
      ),
    )
    expect(captures).toEqual([])
  })

  it('formulaEval skips a skill body (no phantom resolution)', async () => {
    const t = convexTest(schema, modules)
    // A skill body that LOOKS like it has a billable address; the
    // path lives outside skills/ to ensure the FRONTMATTER predicate
    // is what skips it (not the path).
    const bodyWithKey =
      '---\ntype: skill\nid: trick\n---\nExample data {billable: 999}'
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'trick.md',
        body: bodyWithKey,
        updatedAt: 1,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'trick',
        path: 'trick.md',
        state: 'bound',
      })
    })
    const rows = await t
      .withIdentity({ subject: W })
      .query(api.formulaEval.evalFormulas, { srcs: ['sum(trick.billable)'] })
    // skill body → not a data source → no resolution.
    expect(rows.find((r) => r.src === 'sum(trick.billable)')?.value).toBeNull()
  })

  it('atoms.list `type` projection: html / skill / legacy-skill / null', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const insert = (path: string, body: string) =>
        ctx.db.insert('atoms', { workspaceId: W, path, body, updatedAt: 1 })
      await insert('report.md', HTML)
      await insert('weekly.md', SKILL)
      await insert('skills/legacy.md', 'no frontmatter')
      await insert('notes/plain.md', MD)
    })
    const rows = await t.withIdentity({ subject: W }).query(api.atoms.list, {})
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.type]))
    expect(byPath['report.md']).toBe('html')
    expect(byPath['weekly.md']).toBe('skill')
    expect(byPath['skills/legacy.md']).toBe('skill')
    expect(byPath['notes/plain.md']).toBeNull()
  })
})

// ── Track-2 RETROFIT honesty: the SAME predicate now also closes
// html-atom values from crossing windows / seed / onboarding sites
// that Track-2 P1a's §6 audit missed. Lock the parity. ──

describe('§6 retrofit — html bodies now ALSO skip at all unified sites', () => {
  it('isNonDataAtom is true for an html atom (Track-2 P1a parity)', () => {
    expect(isNonDataAtom('r.md', HTML)).toBe(true)
  })
  it('atomCapture skips an html body (Track-2 P1a behavior preserved)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'report.md',
      body: HTML + '\n{billable: 999}',
      source: 'agent',
    })
    const captures = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W,
      ),
    )
    expect(captures).toEqual([])
  })
})

// ── Track-3 P1 r1-fold (Codex FAIL-1): the data → non-data → data
// round trip must NOT leave a stale confirmed capture row. The
// non-data transition CLEARS prior captures at that path. ──

describe('§6 r1-fold FAIL-1 — data → non-data → data round trip clears stale captures', () => {
  it('flipping a captured data atom to type:skill clears its prior captures', async () => {
    const t = convexTest(schema, modules)
    // Step 1: data atom captured + confirmed (by writing it as
    // 'user' so it goes through atomCapture).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'log.md',
      body: '{billable: 1}',
      source: 'user',
    })
    const before = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W && c.ref === 'log.md',
      ),
    )
    expect(before.length).toBeGreaterThan(0) // capture exists
    // Step 2: flip to type:skill (non-data transition).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'log.md',
      body: '---\ntype: skill\nid: log\n---\nExample {billable: 999}',
      source: 'user',
      allowUserOverwrite: true,
    })
    const afterFlip = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W && c.ref === 'log.md',
      ),
    )
    // The non-data transition CLEARED the prior capture rows.
    expect(afterFlip).toEqual([])
    // Step 3: flip back to plain data with the SAME key but a
    // different value. The capture must be re-recorded fresh
    // (withhold-by-default), NOT inherited from the stale row.
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'log.md',
      body: '{billable: 999}',
      source: 'user',
      allowUserOverwrite: true,
    })
    const afterFlipBack = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W && c.ref === 'log.md',
      ),
    )
    // A fresh withhold row exists for `billable` (re-confirm required).
    expect(afterFlipBack.length).toBeGreaterThan(0)
  })
})
