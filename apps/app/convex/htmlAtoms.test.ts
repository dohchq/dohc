/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_owner'
const W2 = 'ws_attacker'
const HTML = '---\ntype: html\nid: report.q3\n---\n<h1>Hello</h1><p>x</p>'
const MD = '---\nid: notes.q3\n---\n# Just markdown'

async function seed(
  t: ReturnType<typeof convexTest>,
  ws: string,
  path: string,
  fileId: string,
  body: string,
  state: 'bound' | 'released' = 'bound',
  boundPath: string | null = path,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId: ws, path, body, updatedAt: 1 })
    await ctx.db.insert('atomIds', {
      workspaceId: ws,
      fileId,
      path: boundPath,
      state,
    })
  })
}

// html-atoms-v1 §2-B — the access-control boundary of the render
// route's data source. THE security-critical, here-verifiable part:
// workspace is derived from the SESSION, never the URL atomId.
describe('htmlAtoms.getRenderable — confused-deputy / access control', () => {
  it('unauthenticated → throws (requireWorkspace, no escape)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'r.html', 'report.q3', HTML)
    await expect(
      t.query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' }),
    ).rejects.toThrow(/not authenticated/i)
  })

  it('owner gets the POST-frontmatter html (frontmatter stripped)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'r.html', 'report.q3', HTML)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).not.toBeNull()
    expect(r!.html).toContain('<h1>Hello</h1>')
    expect(r!.html).not.toContain('type: html') // frontmatter gone
    expect(r!.updatedAt).toBe(1)
  })

  it('D4.13: a `.html` PATH renders even WITHOUT type:html frontmatter (extension-determined)', async () => {
    const t = convexTest(schema, modules)
    // No `type: html` — only an id. The `.html` extension alone
    // qualifies it as a renderable page.
    const body = '---\nid: page.x\n---\n<h1>By extension</h1>'
    await seed(t, W, 'page.html', 'page.x', body)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'page.x' })
    expect(r).not.toBeNull()
    expect(r!.html).toContain('<h1>By extension</h1>')
    expect(r!.html).not.toContain('id: page.x') // frontmatter stripped
  })

  it('D4.13: a `.md` PATH with no type:html → null (extension says markdown)', async () => {
    const t = convexTest(schema, modules)
    const body = '---\nid: plain.x\n---\n<h1>not a page</h1>'
    await seed(t, W, 'plain.md', 'plain.x', body)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'plain.x' })
    expect(r).toBeNull()
  })

  it('D4.13: case-insensitive — a `.HTML` PATH renders (codex P2)', async () => {
    const t = convexTest(schema, modules)
    const body = '---\nid: caps.x\n---\n<h1>caps</h1>'
    await seed(t, W, 'Report.HTML', 'caps.x', body)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'caps.x' })
    expect(r).not.toBeNull()
    expect(r!.html).toContain('<h1>caps</h1>')
  })

  it('D4.13: precedence — EXTENSION wins; a `.html` path renders even with a conflicting type: (codex P2)', async () => {
    const t = convexTest(schema, modules)
    // A `.html` path with `type: action` frontmatter still renders
    // as an HTML page. Extension is the single determinant — no
    // carve-outs, so every render-decision site agrees.
    const body = '---\nid: conf.x\ntype: action\n---\n<h1>still a page</h1>'
    await seed(t, W, 'conflict.html', 'conf.x', body)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'conf.x' })
    expect(r).not.toBeNull()
    expect(r!.html).toContain('<h1>still a page</h1>')
  })

  it('CROSS-WORKSPACE: another workspace cannot read it (→ null, no oracle)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'r.html', 'report.q3', HTML)
    const r = await t
      .withIdentity({ subject: W2 })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull() // indistinguishable from "does not exist"
  })

  it('non-html (md) atom → null (fail closed; /r/ renders only html)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'n.md', 'notes.q3', MD)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'notes.q3' })
    expect(r).toBeNull()
  })

  it('unknown atomId → null', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'r.html', 'report.q3', HTML)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'does.not.exist' })
    expect(r).toBeNull()
  })

  it('tombstoned (released) atomId → null', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'r.html', 'report.q3', HTML, 'released', null)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull()
  })

  it('bound id but the atom row is gone → null (no throw)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'report.q3',
        path: 'r.html',
        state: 'bound',
      })
    })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull()
  })

  it('empty atomId → null (not a throw)', async () => {
    const t = convexTest(schema, modules)
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: '' })
    expect(r).toBeNull()
  })

  // P2 dual-review folds ---------------------------------------------
  it('Codex FAIL-1: duplicate (ws,fileId) atomIds rows → null, not throw', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'a.html',
        body: HTML,
        updatedAt: 1,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'report.q3',
        path: 'a.html',
        state: 'bound',
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'report.q3',
        path: 'b.html',
        state: 'bound',
      })
    })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull() // fail-closed, no .unique() throw
  })

  it('Codex FAIL-1: duplicate (ws,path) atoms rows → null, not throw', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'r.html',
        body: HTML,
        updatedAt: 1,
      })
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'r.html',
        body: HTML,
        updatedAt: 2,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'report.q3',
        path: 'r.html',
        state: 'bound',
      })
    })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull()
  })

  it('M1: a bound path → atom whose frontmatter id mismatches → null', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      // idRow says report.q3 → r.html, but r.html's body declares a
      // DIFFERENT id (the corruption M1 defends against).
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'r.html',
        body: '---\ntype: html\nid: someone.else\n---\n<h1>Foreign</h1>',
        updatedAt: 1,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'report.q3',
        path: 'r.html',
        state: 'bound',
      })
    })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'report.q3' })
    expect(r).toBeNull()
  })

  it('M1 is not over-eager: a legacy html atom with NO id is still served', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'legacy.html',
        body: '---\ntype: html\n---\n<h1>Legacy</h1>',
        updatedAt: 7,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: W,
        fileId: 'legacy.page',
        path: 'legacy.html',
        state: 'bound',
      })
    })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.htmlAtoms.getRenderable, { atomId: 'legacy.page' })
    expect(r).not.toBeNull()
    expect(r!.html).toContain('<h1>Legacy</h1>')
  })
})

// html-atoms-v1 §5 P3b — the tree must perceive a `type: html` atom
// as a page (no `.html` extension). atoms.list derives `type` via
// the §6 one-predicate; advisory/additive, never affects routing.
describe('atoms.list — §5 html tree-perception projection', () => {
  it('an html atom row carries type:"html"; an md row type:null', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'dash.html',
        body: HTML,
        updatedAt: 1,
      })
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'notes.md',
        body: MD,
        updatedAt: 2,
      })
    })
    const rows = await t.withIdentity({ subject: W }).query(api.atoms.list)
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(byPath['dash.html'].type).toBe('html')
    expect(byPath['notes.md'].type).toBeNull()
  })

  it('workspace-scoped: another workspace never sees these rows', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'dash.html',
        body: HTML,
        updatedAt: 1,
      })
    })
    const rows = await t.withIdentity({ subject: W2 }).query(api.atoms.list)
    expect(rows.find((r) => r.path === 'dash.html')).toBeUndefined()
  })
})
