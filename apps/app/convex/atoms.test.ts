/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { splitFrontmatter } from './atomId'

// Verifies the STRUCTURAL Phase-2 guard (data layer, model-independent,
// no auth bypass): the agent write path cannot silently overwrite a
// USER-authored atom. This is what actually defends me.md / hand-
// edited dashboards against paste-driven prompt injection — not the
// system prompt.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'

async function seed(
  t: ReturnType<typeof convexTest>,
  path: string,
  source: 'user' | 'agent',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId: W,
      path,
      body: `original ${source}`,
      updatedAt: Date.now(),
      source,
    })
  })
}
const bodyOf = (t: ReturnType<typeof convexTest>, path: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('atoms').collect()
    const row = rows.find((r) => r.workspaceId === W && r.path === path)
    return row?.body ?? null
  })
// atom-address-v1 §1.1: every stored body now carries a seeded
// `id:` frontmatter. These guard tests care about the CONTENT, not
// the seeded id (the id behaviour is covered by atomId.test.ts), so
// assert on the frontmatter-stripped content.
const contentOf = async (t: ReturnType<typeof convexTest>, path: string) => {
  const b = await bodyOf(t, path)
  return b === null ? null : splitFrontmatter(b).rest
}

describe('atoms._upsertInternal — user-content overwrite guard', () => {
  it('THROWS when the agent overwrites a user-authored atom without confirm', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'me.md', 'user')
    await expect(
      t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: 'me.md',
        body: 'INJECTED',
        source: 'agent',
      }),
    ).rejects.toThrow(/user-authored/)
    expect(await bodyOf(t, 'me.md')).toBe('original user') // unchanged
  })

  it('ALLOWS the overwrite when explicitly confirmed', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'me.md', 'user')
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'me.md',
      body: 'user-approved edit',
      source: 'agent',
      allowUserOverwrite: true,
    })
    expect(await contentOf(t, 'me.md')).toBe('user-approved edit')
  })

  it('does NOT gate agent-authored atoms (no wedge regression)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'dashboard.md', 'agent')
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'dashboard.md',
      body: 'dohc update',
      source: 'agent',
    })
    expect(await contentOf(t, 'dashboard.md')).toBe('dohc update')
  })

  it('does NOT gate fresh creates', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'new.md',
      body: 'created',
      source: 'agent',
    })
    expect(await contentOf(t, 'new.md')).toBe('created')
  })
})

// D4.16/D4.17 + emoji-icons follow-up — an html file derives NO title
// from its markup (no h1/first-line parsing → null → the tree falls
// back to the filename). BUT a frontmatter `title:`/`name:` IS now
// honored for html (the filename is seeded there + editable, so html
// pages carry a real title in their metadata, like markdown).
describe('atoms.list — html-atom title (markup ignored; frontmatter honored)', () => {
  async function titleOf(
    t: ReturnType<typeof convexTest>,
    path: string,
  ): Promise<string | null | undefined> {
    const rows = await t.withIdentity({ subject: W }).query(api.atoms.list, {})
    return rows.find((r) => r.path === path)?.title
  }

  it('a `.html` file with <h1> → null (filename wins, NOT the h1)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'dashboard.html',
      body: '<div style="padding:2rem"><h1>My Dashboard</h1></div>',
      source: 'user',
    })
    expect(await titleOf(t, 'dashboard.html')).toBeNull()
  })

  it('a `.html` file with raw markup → null (NOT the `<div>` first line)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'bare.html',
      body: '<div style="padding:2rem">just a box</div>',
      source: 'user',
    })
    expect(await titleOf(t, 'bare.html')).toBeNull()
  })

  it('a `.html` file with a frontmatter title/name → uses it (real metadata title)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'named.html',
      body: '---\nname: Pretty Name\n---\n<h1>other</h1>',
      source: 'user',
    })
    expect(await titleOf(t, 'named.html')).toBe('Pretty Name')
  })

  it('a `.md` file STILL derives its title from the H1 (unchanged)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'note.md',
      body: '# Real Heading\n\nbody',
      source: 'user',
    })
    expect(await titleOf(t, 'note.md')).toBe('Real Heading')
  })
})
