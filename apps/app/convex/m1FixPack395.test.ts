/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { register as registerProsemirrorComponent } from '@convex-dev/prosemirror-sync/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sha256Hex } from './atomWriter'
import { pmDocToMdast, UnknownPmNodeError } from './pmToMdast'
import { serializeMdastToMarkdown } from './markdownRoundtrip'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const __dirname = dirname(fileURLToPath(import.meta.url))

// M1 step 3.9.5 — fix pack pinning all 5 codex 6th-pass findings.

const ALICE = 'ws_alice_m1fp395'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  return orgId
}

async function makeAtomWithBody(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
  body: string,
): Promise<{ atomId: Id<'atoms'>; finalBody: string; docId: string }> {
  await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
    activeWorkspaceId: orgId,
    path,
    body,
  })
  const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
  const row = rows.find(
    (r: { workspaceId: string; path: string }) =>
      r.workspaceId === orgId && r.path === path,
  )
  return {
    atomId: (row as { _id: Id<'atoms'> })._id,
    finalBody: (row as { body: string }).body,
    docId: `atom:${orgId}:${(row as { _id: Id<'atoms'> })._id}`,
  }
}

const pmJsonForBody = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })

// ──────────────────────────────────────────────────────────────
// FIX #1 — bootstrap PM ↔ body binding (silent-rollback blocker)
// ──────────────────────────────────────────────────────────────
describe('M1 3.9.5 fix #1 — bootstrap PM↔body binding (silent-rollback blocker)', () => {
  // 3.9.25 — bootstrap pm-body-mismatch DEMOTED to warning.
  // The check was producing false-positives on benign parser
  // style drift (Crepe vs remark), blocking users from opening
  // atoms. The projection writer's case A/B/C three-state
  // resolver is the actual safety net for body drift; bootstrap
  // just needs to get the user into the editor. Tests updated
  // below to reflect the new permissive-proceed behavior.
  it('initial bootstrap PROCEEDS even when PM JSON does not roundtrip (3.9.25 warning-only)', async () => {
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'starting body',
    )
    const staleButHashMatches = pmJsonForBody('something else entirely')
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: staleButHashMatches,
        clientBodyHash: await sha256Hex(finalBody),
        activeWorkspaceId: orgId,
      })
    // 3.9.25 — bootstrap succeeds even with mismatched PM.
    expect(result.ok).toBe(true)
    // collabDocs row IS created (baseBodyHash = serverBodyHash
    // of atom.body, NOT the client's PM content — so drift is
    // captured at the source-of-truth level, not the client's
    // claim).
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs.length).toBe(1)
    expect(docs[0]?.baseBodyHash).toBe(await sha256Hex(finalBody))
  })

  it('aligned PM JSON passes the bind check (regression: happy path still works)', async () => {
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'aligned content',
    )
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('aligned content'),
        clientBodyHash: await sha256Hex(finalBody),
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(true)
  })

  it('rebootstrap path PROCEEDS with mismatched PM (3.9.25 warning-only)', async () => {
    // 3.9.25 — rebootstrap also no longer rejects on PM↔body
    // mismatch. The submitted PM JSON gets written as the new
    // snapshot; the projection writer's case A/B/C resolver
    // catches real drift on the next snapshot cycle. Atom.body
    // and baseBodyHash remain the source of truth.
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'agent-rewrote',
    )
    const correctHash = await sha256Hex(finalBody)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: correctHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: true,
        updatedAt: Date.now(),
      })
    })
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('stale PM content from before OOB'),
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(true)
    // Rebootstrap path cleared needsRebootstrap + advanced
    // projectedVersion to N+1.
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.needsRebootstrap).toBe(false)
  })

  it('body-changed remains distinct from pm-body-mismatch is no longer returned (3.9.25)', async () => {
    // 3.9.25 — pm-body-mismatch is no longer returned by bootstrap.
    // body-changed remains for stale-hash retries.
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { finalBody, docId } = await makeAtomWithBody(t, orgId, 't.md', 'x')

    // body-changed path: stale hash, anything PM
    const r1 = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('whatever'),
        clientBodyHash:
          'stale_0000000000000000000000000000000000000000000000000000000000',
        activeWorkspaceId: orgId,
      })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toBe('body-changed')

    // Previously pm-body-mismatch fired here; now bootstrap proceeds.
    const r2 = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('wrong content'),
        clientBodyHash: await sha256Hex(finalBody),
        activeWorkspaceId: orgId,
      })
    expect(r2.ok).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #2 — idle final projection uses component primitive
// ──────────────────────────────────────────────────────────────
describe('M1 3.9.5 fix #2 — _finalProjectIdleDoc uses component primitive (not syncApi)', () => {
  it('source: uses components.prosemirrorSync.lib.getSnapshot, NOT api.prosemirror.getSnapshot', () => {
    // Codex 6th-pass BLOCKER #2: api.prosemirror.getSnapshot
    // runs checkRead → requireWorkspace → cron-scheduled
    // mutations have no user identity → throws "Not
    // authenticated" → final flush broken in production.
    // Fix: use the COMPONENT primitive which bypasses checkRead.
    const src = readFileSync(
      resolve(__dirname, './collabPresence.ts'),
      'utf8',
    )
    expect(src).toMatch(/components\.prosemirrorSync\.lib\.getSnapshot/)
    // The syncApi path must NOT be CALLED via ctx.runQuery in
    // this fn. (Comments can mention the name; only the actual
    // invocation matters.)
    const finalProjectFn =
      src.split('export const _finalProjectIdleDoc')[1] ?? ''
    expect(finalProjectFn).not.toMatch(
      /ctx\.runQuery\(\s*api\.prosemirror\.getSnapshot/,
    )
  })

  it('runs without an authenticated user identity (real cron simulation)', async () => {
    // Component registered so getSnapshot actually fires. Call
    // the internal mutation WITHOUT withIdentity — exercising
    // the no-user-identity path the cron actually has in
    // production.
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      't.md',
      'aligned content',
    )
    const correctHash = await sha256Hex(finalBody)
    // Bootstrap (with user identity to set up state)
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('aligned content'),
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })
    // Submit a newer snapshot so there's something to project
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.prosemirror.submitSnapshot, {
        id: docId,
        version: 2,
        content: pmJsonForBody('updated content'),
      })

    // Now call _finalProjectIdleDoc WITHOUT withIdentity — the
    // cron path. Before fix #2 this throws "Not authenticated";
    // after fix #2 it runs the component primitive cleanly.
    const result = await t.mutation(
      internal.collabPresence._finalProjectIdleDoc,
      { docId },
    )
    expect(result).toMatchObject({ ok: true, scheduledFor: 2 })

    // atomId reference (silences unused warning)
    expect(atomId).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #3 — Crepe default-feature node names
// ──────────────────────────────────────────────────────────────
describe('M1 3.9.5 fix #3 — pmToMdast covers Crepe default-feature nodes', () => {
  const doc = (...children: any[]) => ({ type: 'doc', content: children })

  it("'image-block' (Crepe ImageBlock default feature) accepted as image", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'image-block',
          attrs: {
            src: 'https://example.com/photo.png',
            caption: 'a photo',
            ratio: 1,
          },
        }) as any,
      ),
    )
    expect(md).toContain('![a photo](https://example.com/photo.png)')
  })

  // M1 step 3.9.17 — proper math support via remark-math.
  // Replaces 3.8.1.6's fail-loud behavior. The pipeline now
  // includes remark-math; pmToMdast emits mdast inlineMath /
  // math nodes; serializer outputs `$...$` / `$$...$$` and
  // remark-math's parser round-trips them back symmetrically.
  // Multiplayer math atoms no longer freeze.
  it("'math_inline' serializes as $…$ (lossless via remark-math)", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: 'energy is ' },
            { type: 'math_inline', attrs: { value: 'E = mc^2' } },
            { type: 'text', text: '.' },
          ],
        }) as any,
      ),
    )
    // remark-math emits `$E = mc^2$` (no backticks — would be
    // inline code). Strict assertion: literal $ delimiters.
    expect(md).toMatch(/\$E = mc\^2\$/)
    expect(md).not.toMatch(/`\$/) // not inline-code-wrapped
  })

  it("'math_block' serializes as $$…$$ fenced math (lossless)", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'math_block',
          attrs: { value: '\\int_0^1 x^2 dx' },
        }) as any,
      ),
    )
    expect(md).toContain('$$')
    expect(md).toContain('\\int_0^1 x^2 dx')
  })

  it("'table_header_row' (Crepe TableBlock) accepted as table row", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'table',
          content: [
            {
              type: 'table_header_row',
              content: [
                {
                  type: 'table_header',
                  content: [{ type: 'text', text: 'Name' }],
                },
                {
                  type: 'table_header',
                  content: [{ type: 'text', text: 'Role' }],
                },
              ],
            },
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  content: [{ type: 'text', text: 'Alice' }],
                },
                {
                  type: 'table_cell',
                  content: [{ type: 'text', text: 'Engineer' }],
                },
              ],
            },
          ],
        }) as any,
      ),
    )
    expect(md).toMatch(/\|.*Name.*\|.*Role.*\|/)
    expect(md).toMatch(/\|.*Alice.*\|.*Engineer.*\|/)
  })

  it('unknown node still throws UnknownPmNodeError (3.6.5 fail-loud preserved)', () => {
    const doc = (...children: any[]) => ({ type: 'doc', content: children })
    expect(() =>
      pmDocToMdast(doc({ type: 'newly_added_crepe_feature' }) as any),
    ).toThrow(UnknownPmNodeError)
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #4 — frozen invariant (frozen dominates needsRebootstrap)
// ──────────────────────────────────────────────────────────────
describe('M1 3.9.5 fix #4 — frozen dominates needsRebootstrap', () => {
  it("bootstrap with frozen=true returns ok:false (reason:'frozen'), not rebootstrap", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      't.md',
      'frozen content',
    )
    const correctHash = await sha256Hex(finalBody)
    // Construct the pathological state: BOTH frozen AND needsRebootstrap
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: correctHash,
        projectedVersion: 1,
        frozen: true, // ← dominates
        needsRebootstrap: true, // ← would otherwise trigger rebootstrap
        updatedAt: Date.now(),
      })
    })

    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('frozen content'),
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('frozen')

    // Row state unchanged — frozen still true (client must
    // show reload banner; rebootstrap loop must NOT clear it)
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(true)
    expect(docs[0]?.needsRebootstrap).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #5 — FREEZE path with real component (test coverage gap)
// ──────────────────────────────────────────────────────────────
describe('M1 3.9.5 fix #5 — FREEZE case A reachable end-to-end with real component', () => {
  it('PM advanced AND atoms.body changed differently ⇒ FREEZE (real component)', async () => {
    const t = convexTest(schema, modules)
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomWithBody(
      t,
      orgId,
      't.md',
      'v0',
    )

    // Bootstrap + canonicalizing projection so baseBodyHash is
    // in canonical form.
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJsonForBody('v0'),
        clientBodyHash: await sha256Hex(
          (await t.run(async (c) => c.db.get(atomId)))!.body,
        ),
        activeWorkspaceId: orgId,
      })
    await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 2,
      snapshotContent: pmJsonForBody('v0'),
    })

    // Step 1: agent OOB-writes a NEW body
    const canonical = (await t.run(async (c) => c.db.get(atomId)))!.body
    const fmEnd = canonical.indexOf('---\n', 4) + 4
    const oobBody = canonical.slice(0, fmEnd) + 'agent-changed-it\n'
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { body: oobBody, updatedAt: Date.now() })
    })

    // Step 2: PM ALSO advanced (different content). This is
    // the case-A "both sides changed" scenario.
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmJsonForBody('alice-also-changed-it'),
      },
    )
    expect(result).toMatchObject({
      conflict: 'freeze',
      reason: 'both-sides-changed',
    })

    // atoms.body NOT overwritten by PM
    const after = await t.run(async (c) => c.db.get(atomId))
    expect(after?.body).toBe(oobBody)
    expect(after?.body).not.toContain('alice-also-changed-it')

    // collabDocs frozen
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(true)
    expect(docs[0]?.needsRebootstrap).toBe(false)
  })
})
