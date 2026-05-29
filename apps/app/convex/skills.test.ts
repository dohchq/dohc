/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'
import { pathDeriveLabel } from './skills'

const modules = import.meta.glob('./**/*.ts')

// Track-3 P3 — `api.skills.list` query lockfile. Used by the
// chat UI's slash-command detection to render the skill list.

describe('Track-3 P3 — pathDeriveLabel (mirror of agent.ts; lockstep enforced)', () => {
  it('strips dirs + .md extension (case-insensitive)', () => {
    expect(pathDeriveLabel('.skills/foo.md')).toBe('foo')
    expect(pathDeriveLabel('.skills/team/standup.md')).toBe('standup')
    expect(pathDeriveLabel('.commands/draft-invoice.md')).toBe('draft-invoice')
    expect(pathDeriveLabel('me.md')).toBe('me')
    expect(pathDeriveLabel('.skills/foo.MD')).toBe('foo')
  })

  // P3+P4 indep fold F5: explicit cross-module parity lockstep.
  // Tests the EDGE CASES where the prior skills.ts version
  // diverged from agent.ts (empty / ext-only / slash-only paths).
  it('byte-identical with convex/agent.ts:pathDeriveLabel on edge inputs (P3+P4 indep fold F5)', async () => {
    const { pathDeriveLabel: agentLabel } = await import('./agent')
    const inputs = [
      '',
      '/',
      '.md',
      '/.md',
      '.skills/.md',
      '.skills/foo.md',
      '.skills/team/standup.md',
      '.commands/draft-invoice.md',
      '.skills/team/weekly-review.q3.md',
      'me.md',
      '.skills/MIXED.MD',
      'no-ext',
      '.skills/中文.md', // Unicode
    ]
    for (const input of inputs) {
      expect(pathDeriveLabel(input)).toBe(agentLabel(input))
    }
  })
})

describe('Track-3 P3 — api.skills.list returns the user`s saved skills', () => {
  it('returns empty array when there are no skills', async () => {
    const t = convexTest(schema, modules)
    const res = await t
      .withIdentity({
        subject: 'user|123',
        email: 'a@b.test',
      })
      .query(api.skills.list, {})
    expect(res).toEqual([])
  })

  it('includes type:skill atoms (canonical form)', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    // Seed a workspace via the standard route — write an atom that
    // declares type:skill in frontmatter.
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/weekly-review.md',
      body: '---\ntype: skill\n---\n\nRun the weekly review.',
    })
    const res = await ti.query(api.skills.list, {})
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({
      path: '.skills/weekly-review.md',
      label: 'weekly-review',
    })
  })

  it('includes dot-folder .skills atoms only when they declare type:skill', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/not-runnable.md',
      body: '# Plain note\n\nThis is just documentation.',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/real-skill.md',
      body: '---\ntype: skill\n---\nReusable instructions.',
    })
    const res = await ti.query(api.skills.list, {})
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({
      path: '.skills/real-skill.md',
      label: 'real-skill',
    })
  })

  it('EXCLUDES non-skill atoms (regular notes, html bodies)', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    await ti.mutation(api.atoms.upsert, {
      path: 'me.md',
      body: '# Me\n\nA regular note.',
    })
    await ti.mutation(api.atoms.upsert, {
      path: 'dashboard.md',
      body: '---\ntype: html\n---\n<h1>Dashboard</h1>',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/real-skill.md',
      body: '---\ntype: skill\n---\nDo a thing.',
    })
    const res = await ti.query(api.skills.list, {})
    expect(res).toHaveLength(1)
    expect(res[0].path).toBe('.skills/real-skill.md')
  })

  it('sorts results by label (deterministic UI order)', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/zebra.md',
      body: '---\ntype: skill\n---\nx',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/alpha.md',
      body: '---\ntype: skill\n---\nx',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/mike.md',
      body: '---\ntype: skill\n---\nx',
    })
    const res = await ti.query(api.skills.list, {})
    expect(res.map((r) => r.label)).toEqual(['alpha', 'mike', 'zebra'])
  })

  it('label collisions surface as duplicate label entries (UI disambiguates by path)', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/team/standup.md',
      body: '---\ntype: skill\n---\nx',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/client/standup.md',
      body: '---\ntype: skill\n---\nx',
    })
    const res = await ti.query(api.skills.list, {})
    expect(res).toHaveLength(2)
    expect(res.every((r) => r.label === 'standup')).toBe(true)
    // Both entries are present; the canonical `path` distinguishes
    // them. UI consumers (Chat.tsx detectSkillFire) handle the
    // collision via `ambiguous` branch.
    const paths = res.map((r) => r.path).sort()
    expect(paths).toEqual([
      '.skills/client/standup.md',
      '.skills/team/standup.md',
    ])
  })
})

describe('Track-3 P3 — api.skills.listCommands returns user-created commands', () => {
  it('returns type:command atoms from .commands only', async () => {
    const t = convexTest(schema, modules)
    const ti = t.withIdentity({ subject: 'user|123', email: 'a@b.test' })
    await ti.mutation(api.atoms.upsert, {
      path: '.commands/draft-invoice.md',
      body: '---\ntype: command\n---\nDraft an invoice using my invoice skill.',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.commands/readme.md',
      body: '# Just docs',
    })
    await ti.mutation(api.atoms.upsert, {
      path: '.skills/invoice.md',
      body: '---\ntype: skill\n---\nHow invoices work.',
    })

    const res = await ti.query(api.skills.listCommands, {})
    expect(res).toEqual([
      { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
    ])
  })
})
