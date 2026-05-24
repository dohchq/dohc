/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
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

// M1 step 3.6.5 — fix pack pinning all 5 codex 5th-pass findings.
// Each describe block corresponds to one finding; the structural
// tests assert that the FIX shape stayed in place (prevents
// regressions on refactor), and where possible we exercise the
// runtime behavior end-to-end.

// ──────────────────────────────────────────────────────────────
// FIX #1 — snapshot version/content desync (collab-sync.ts)
// ──────────────────────────────────────────────────────────────
const COLLAB_SYNC_SRC = readFileSync(
  resolve(__dirname, '../src/lib/collab-sync.ts'),
  'utf8',
)

describe('M1 3.6.5 fix #1 — snapshot guards against version/content desync', () => {
  it('refuses to submit while sendableSteps exist (re-arms instead)', () => {
    // The bug: getVersion(view.state) excludes pending steps;
    // doc.toJSON() includes them. Submitting with both at the
    // same time gives {version: N, content: doc-at-N+k}.
    // Fix: skip + re-arm when sendableSteps is non-null.
    expect(COLLAB_SYNC_SRC).toMatch(/if \(sendableSteps\(view\.state\)\)/)
    // Re-arm pattern (caller's choice — armSnapshotDebounce()):
    expect(COLLAB_SYNC_SRC).toMatch(
      /if \(sendableSteps\(view\.state\)\)\s*\{[\s\S]*?armSnapshotDebounce\(\)/,
    )
  })

  it('refuses to submit while step-submit is in flight', () => {
    expect(COLLAB_SYNC_SRC).toMatch(
      /if \(inFlight\)\s*\{[\s\S]*?armSnapshotDebounce\(\)/,
    )
  })

  it('captures version + content in the same tick (atomic read)', () => {
    // The fix captures both INSIDE the try block, after the
    // guards, before any await. A double-check on sendableSteps
    // after capture catches a hypothetical re-entrant case.
    expect(COLLAB_SYNC_SRC).toMatch(
      /const docJson = view\.state\.doc\.toJSON\(\)[\s\S]*?const versionAtSnapshot = getVersion\(view\.state\)/,
    )
    // Double-check guard
    expect(COLLAB_SYNC_SRC).toMatch(
      /Double-check the guards held through the sync block/,
    )
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #2 — destroy flush + idle final projection
// ──────────────────────────────────────────────────────────────
describe('M1 3.6.5 fix #2 — destroy flushes pending snapshot; cleanup triggers final projection', () => {
  it('destroy() FIRES the pending snapshot (not just clears the timer)', () => {
    // Was: clearTimeout(snapshotTimer); set to null; return
    // Now: also fire-and-forget trySubmitSnapshot()
    expect(COLLAB_SYNC_SRC).toMatch(
      /destroy\(\)\s*\{[\s\S]*?clearTimeout\(snapshotTimer\)[\s\S]*?void trySubmitSnapshot\(\)/,
    )
    expect(COLLAB_SYNC_SRC).toMatch(/FLUSH the[\s\S]*?pending snapshot before tearing down/)
  })

  it('_cleanupIdleSessions tracks affected docIds + schedules final projection on zero', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await t
      .withIdentity({ subject: 'ws_alice_fp365' })
      .mutation(api.orgs.createOrg, { name: 'Acme' })
    await t.withIdentity({ subject: 'ws_alice_fp365' }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'lonely.md',
      body: 'lonely body',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string; workspaceId: string }) =>
        r.path === 'lonely.md' && r.workspaceId === orgId,
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex((row as { body: string }).body)

    // Create a collabDocs row + a single STALE session (90s+ old)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
      await ctx.db.insert('collabSessions', {
        docId,
        clientId: 'tab_only',
        userId: 'ws_alice_fp365',
        lastSeenAt: Date.now() - 120_000,
      })
    })

    // Cleanup reaps the session AND schedules a final projection
    // (because the session count for this doc dropped to zero).
    const result = await t.mutation(internal.collabPresence._cleanupIdleSessions, {})
    expect(result.reaped).toBe(1)
    expect(result.finalProjectionsScheduled).toBe(1)
  })

  it('_cleanupIdleSessions skips final projection when other sessions survive', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await t
      .withIdentity({ subject: 'ws_alice_fp365b' })
      .mutation(api.orgs.createOrg, { name: 'Acme' })
    await t.withIdentity({ subject: 'ws_alice_fp365b' }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'crowded.md',
      body: 'body',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string; workspaceId: string }) =>
        r.path === 'crowded.md' && r.workspaceId === orgId,
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex((row as { body: string }).body)

    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
      // One stale + one fresh
      await ctx.db.insert('collabSessions', {
        docId,
        clientId: 'tab_stale',
        userId: 'ws_alice_fp365b',
        lastSeenAt: Date.now() - 120_000,
      })
      await ctx.db.insert('collabSessions', {
        docId,
        clientId: 'tab_fresh',
        userId: 'ws_alice_fp365b',
        lastSeenAt: Date.now(),
      })
    })

    const result = await t.mutation(internal.collabPresence._cleanupIdleSessions, {})
    expect(result.reaped).toBe(1)
    expect(result.finalProjectionsScheduled).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #3 — pmToMdast Milkdown GFM node names
// ──────────────────────────────────────────────────────────────
describe('M1 3.6.5 fix #3 — pmToMdast accepts real Milkdown node names', () => {
  function paragraph(text: string) {
    return {
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }
  }
  const doc = (...children: any[]) => ({ type: 'doc', content: children })

  it("'hardbreak' (Milkdown name) accepted as break", () => {
    // Was: only 'hard_break' accepted. Real Crepe emits 'hardbreak'.
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line1' },
            { type: 'hardbreak' },
            { type: 'text', text: 'line2' },
          ],
        }) as any,
      ),
    )
    // hard break encoded as two trailing spaces or backslash-newline
    expect(md).toMatch(/line1[\\\s]+line2/)
  })

  it("'hr' (Milkdown name) accepted as thematic break", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(doc({ type: 'hr' }) as any),
    )
    expect(md.trim()).toContain('---')
  })

  it("'strike_through' (Milkdown mark name) → mdast delete → ~~text~~", () => {
    const md = serializeMdastToMarkdown(
      pmDocToMdast(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: 'gone', marks: [{ type: 'strike_through' }] },
          ],
        }) as any,
      ),
    )
    expect(md).toMatch(/~~gone~~|~gone~/)
  })

  it("list_item with attrs.checked=true → mdast listItem.checked=true → '- [x]'", () => {
    const pmDoc = doc({
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          attrs: { checked: true },
          content: [paragraph('do it')],
        },
      ],
    })
    const md = serializeMdastToMarkdown(pmDocToMdast(pmDoc as any))
    expect(md).toMatch(/-\s*\[x]\s*do it/i)
  })

  it("list_item with attrs.checked=false → '- [ ]'", () => {
    const pmDoc = doc({
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          attrs: { checked: false },
          content: [paragraph('pending')],
        },
      ],
    })
    const md = serializeMdastToMarkdown(pmDocToMdast(pmDoc as any))
    expect(md).toMatch(/-\s*\[\s]\s*pending/)
  })

  it('list_item without attrs.checked stays plain bullet (not a task list)', () => {
    const pmDoc = doc({
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          content: [paragraph('plain item')],
        },
      ],
    })
    const md = serializeMdastToMarkdown(pmDocToMdast(pmDoc as any))
    expect(md).toMatch(/-\s*plain item/)
    expect(md).not.toMatch(/\[\s?]/) // no task marker
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #4 — schema cache subscribe wiring in AtomEditor
// ──────────────────────────────────────────────────────────────
const ATOM_EDITOR_SRC = readFileSync(
  resolve(__dirname, '../src/components/AtomEditor.tsx'),
  'utf8',
)

describe('M1 3.6.5 fix #4 — AtomEditor subscribes to schema (no polling)', () => {
  it('imports subscribeSchema from the cache module', () => {
    expect(ATOM_EDITOR_SRC).toMatch(
      /import\s*\{[\s\S]*?subscribeSchema[\s\S]*?\}\s*from '@\/lib\/crepe-schema-cache'/,
    )
  })

  it('uses subscribeSchema inside useEffect; sets state on fire', () => {
    expect(ATOM_EDITOR_SRC).toMatch(/const unsub = subscribeSchema\(\(s\) => setCachedSchema\(s\)\)/)
    expect(ATOM_EDITOR_SRC).toMatch(/return unsub/)
  })

  it('NO longer polls via getCachedSchema() on every render', () => {
    // The old pattern: useEffect with no deps that re-runs every
    // render + calls getCachedSchema(). Codex's catch: nothing
    // forced a re-render after the schema arrived. The fix uses
    // subscribeSchema → setCachedSchema, which triggers the
    // re-render itself.
    expect(ATOM_EDITOR_SRC).not.toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*\/\/[^\n]*Re-check the cache on every render/,
    )
  })
})

// ──────────────────────────────────────────────────────────────
// FIX #5 — atomic scheduledJobId ownership in collabProjection
// ──────────────────────────────────────────────────────────────
const COLLAB_PROJECTION_SRC = readFileSync(
  resolve(__dirname, './collabProjection.ts'),
  'utf8',
)

describe('M1 3.6.5 fix #5 — scheduledJobId clear is ownership-conditional', () => {
  it('schedulePostSnapshotProjection captures previousJobId + re-reads before patching', () => {
    // The race: cancel-on-newer fails because the old job
    // already started; new schedule patches its id; old
    // handler runs + clears id → wipes new id.
    // Fix: schedule captures previousJobId, then patches the
    // new id ONLY if the row still carries previousJobId.
    expect(COLLAB_PROJECTION_SRC).toMatch(/const previousJobId = doc\.scheduledJobId/)
    expect(COLLAB_PROJECTION_SRC).toMatch(
      /fresh && fresh\.scheduledJobId === previousJobId/,
    )
  })

  it('_projectSnapshotToBody uses buildClearPatch helper for ownership-conditional clear', () => {
    // ownedJobId captured at handler entry; buildClearPatch
    // returns {scheduledJobId: undefined} ONLY if the row still
    // carries that id. Otherwise returns {} (no clear).
    expect(COLLAB_PROJECTION_SRC).toMatch(/const ownedJobId = doc\.scheduledJobId/)
    expect(COLLAB_PROJECTION_SRC).toMatch(/buildClearPatch/)
    expect(COLLAB_PROJECTION_SRC).toMatch(
      /fresh && fresh\.scheduledJobId === ownedJobId/,
    )
  })

  it('every scheduledJobId:undefined site routes through buildClearPatch (no direct clears)', () => {
    // After the fix, the only `scheduledJobId: undefined`
    // literal occurrences in the handler body should be:
    //   1. The buildClearPatch return type signature
    //   2. The buildClearPatch return value
    // Direct `scheduledJobId: undefined` ctx.db.patch calls
    // (without the await buildClearPatch()) would bypass the
    // ownership check.
    const handlerBody = COLLAB_PROJECTION_SRC.split(
      'export const _projectSnapshotToBody',
    )[1]
    // Within the handler, "scheduledJobId: undefined" appears
    // at most TWICE — once in the return type, once in the
    // return value. Both inside buildClearPatch.
    const allClears = handlerBody?.match(/scheduledJobId:\s*undefined/g) ?? []
    expect(allClears.length).toBeLessThanOrEqual(2)
    // And every ctx.db.patch site must include `await buildClearPatch()`
    // spread, NOT a literal scheduledJobId: undefined.
    const patchSites = handlerBody?.match(/ctx\.db\.patch\(doc\._id,\s*\{[\s\S]*?\}\)/g) ?? []
    expect(patchSites.length).toBeGreaterThan(0)
    for (const site of patchSites) {
      // Each patch site must NOT carry a direct scheduledJobId
      // literal — it goes through buildClearPatch's spread.
      expect(site).not.toMatch(/scheduledJobId:\s*undefined/)
      expect(site).toContain('buildClearPatch()')
    }
  })
})

// ──────────────────────────────────────────────────────────────
// Reference: end-to-end projection still works after the fixes
// ──────────────────────────────────────────────────────────────
describe('M1 3.6.5 — projection still works end-to-end (regression check)', () => {
  it('happy-path projection completes after all fixes land', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await t
      .withIdentity({ subject: 'ws_alice_fp365c' })
      .mutation(api.orgs.createOrg, { name: 'Acme' })
    await t.withIdentity({ subject: 'ws_alice_fp365c' }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 't.md',
      body: 'initial',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string; workspaceId: string }) =>
        r.path === 't.md' && r.workspaceId === orgId,
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex((row as { body: string }).body)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
    })
    const result = await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 5,
      snapshotContent: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'post-fix content' }] },
        ],
      }),
    })
    expect(result).toMatchObject({ ok: true, snapshotVersion: 5 })
    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(after?.body).toContain('post-fix content')
  })
})
