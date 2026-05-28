import { internalMutation } from './_generated/server'
import { v } from 'convex/values'
import {
  recordEntityWriteCapture,
  confirmEntityKey,
  clearEntityCaptures,
  recordAtomWriteCapture,
  clearAtomCaptures,
  confirmRefKey,
  recordAtomParseFailSentinel,
} from './captures'
import { parseInlineAtomsFromMarkdownWithStatus } from './inlineAtom'
import { isNonDataAtom } from './atomId'
import { deriveSearchFields } from './searchText'

// Test-only: skip the onboarding conversation and drop in a fully-
// populated capacity manager vault. Trigger via the convex CLI:
//   npx convex run seed:loadCapacityDemo
//
// SECURITY (Phase-3 Codex review): this was a PUBLIC mutation taking
// an arbitrary `workspaceId` and WIPING that workspace's atoms +
// entities — any caller could destroy any tenant's data. It is a
// dev/CLI tool never called by the app, so it is now an
// internalMutation: still runnable via `npx convex run` (admin CLI),
// no longer client-reachable. Cross-tenant data-wipe surface closed.
export const loadCapacityDemo = internalMutation({
  args: { workspaceId: v.optional(v.string()) },
  handler: async (ctx, { workspaceId }) => {
    const wid = workspaceId ?? 'demo'

    // Wipe.
    const ents = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) => q.eq('workspaceId', wid))
      .collect()
    for (const r of ents) {
      await ctx.db.delete(r._id)
      await clearEntityCaptures(ctx, wid, r.type, r.slug) // R2.1: no stale
    }
    const atoms = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', wid))
      .collect()
    for (const r of atoms) {
      await ctx.db.delete(r._id)
      await clearAtomCaptures(ctx, wid, r.path) // R3 §1: no stale/ghost
    }

    const now = Date.now()

    // People — 12-person services firm.
    const people = [
      { slug: 'anna', name: 'Anna', role: 'senior dev', fte: 100, kind: 'staff' },
      { slug: 'sam', name: 'Sam', role: 'senior dev', fte: 100, kind: 'staff' },
      { slug: 'jordan', name: 'Jordan', role: 'frontend dev', fte: 100, kind: 'staff' },
      { slug: 'mei', name: 'Mei', role: 'infra dev', fte: 100, kind: 'staff' },
      { slug: 'alex', name: 'Alex', role: 'designer', fte: 100, kind: 'staff' },
      { slug: 'riley', name: 'Riley', role: 'pm', fte: 100, kind: 'staff' },
      { slug: 'taylor', name: 'Taylor', role: 'head of growth', fte: 100, kind: 'staff' },
      { slug: 'kit', name: 'Kit', role: 'designer', fte: 60, kind: 'contractor' },
    ]
    // NOTE: seed is a dev-only CLI with hardcoded CANONICAL ids
    // (type/slug: no "/"). It is the one direct entities writer that
    // intentionally bypasses assertCanonicalEntityId — exempt because
    // it has no untrusted input, not by oversight. Every input-bearing
    // path (agent/internal via _upsertMany/_patch, restore) IS guarded.
    for (const p of people) {
      await ctx.db.insert('entities', {
        workspaceId: wid,
        type: 'person',
        slug: p.slug,
        data: p,
        updatedAt: now,
      })
    }

    // Clients.
    const clients = [
      { slug: 'acme', name: 'Acme', status: 'active' },
      { slug: 'beta', name: 'BetaCo', status: 'active' },
      { slug: 'charlie', name: 'Charlie Industries', status: 'prospect' },
    ]
    for (const c of clients) {
      await ctx.db.insert('entities', {
        workspaceId: wid,
        type: 'client',
        slug: c.slug,
        data: c,
        updatedAt: now,
      })
    }

    // Projects.
    const projects = [
      {
        slug: 'acme-rebrand',
        name: 'Acme rebrand',
        client: 'acme',
        start: '2026-04-13',
        end: '2026-05-31',
        status: 'committed',
      },
      {
        slug: 'beta-migration',
        name: 'BetaCo migration',
        client: 'beta',
        start: '2026-05-18',
        end: '2026-06-26',
        status: 'committed',
      },
      {
        slug: 'charlie-platform',
        name: 'Charlie platform',
        client: 'charlie',
        start: '2026-06-08',
        end: '2026-07-19',
        status: 'potential',
      },
    ]
    for (const p of projects) {
      await ctx.db.insert('entities', {
        workspaceId: wid,
        type: 'project',
        slug: p.slug,
        data: p,
        updatedAt: now,
      })
    }

    // Bookings. Today is 2026-05-14; this week's Monday is 2026-05-11
    // (w20). We span w20 through w27.
    const weeks = [
      '2026-05-11',
      '2026-05-18',
      '2026-05-25',
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ]

    type Booking = {
      person: string
      project: string
      weekStart: string
      percent: number
      status: 'potential' | 'pre-booked' | 'hard-booked'
    }
    const bookings: Booking[] = []
    const book = (b: Booking) => bookings.push(b)

    // Anna + Sam on Acme rebrand w20-w22 (active, winding down)
    for (const w of ['2026-05-11', '2026-05-18']) {
      book({ person: 'anna', project: 'acme-rebrand', weekStart: w, percent: 75, status: 'hard-booked' })
      book({ person: 'sam', project: 'acme-rebrand', weekStart: w, percent: 75, status: 'hard-booked' })
    }
    book({ person: 'anna', project: 'acme-rebrand', weekStart: '2026-05-25', percent: 50, status: 'pre-booked' })
    book({ person: 'sam', project: 'acme-rebrand', weekStart: '2026-05-25', percent: 50, status: 'pre-booked' })

    // Jordan + Mei on BetaCo starting w21 (hard)
    for (const w of ['2026-05-18', '2026-05-25', '2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']) {
      book({ person: 'jordan', project: 'beta-migration', weekStart: w, percent: 100, status: 'hard-booked' })
      book({ person: 'mei', project: 'beta-migration', weekStart: w, percent: 100, status: 'hard-booked' })
    }

    // Charlie platform — potential, starting w23. Tentatively need 2 people.
    for (const w of ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']) {
      book({ person: 'anna', project: 'charlie-platform', weekStart: w, percent: 50, status: 'potential' })
      book({ person: 'kit', project: 'charlie-platform', weekStart: w, percent: 60, status: 'potential' })
    }

    // Alex doing design across both Acme + BetaCo
    book({ person: 'alex', project: 'acme-rebrand', weekStart: '2026-05-11', percent: 50, status: 'pre-booked' })
    book({ person: 'alex', project: 'acme-rebrand', weekStart: '2026-05-18', percent: 50, status: 'pre-booked' })
    book({ person: 'alex', project: 'beta-migration', weekStart: '2026-05-25', percent: 60, status: 'pre-booked' })
    book({ person: 'alex', project: 'beta-migration', weekStart: '2026-06-01', percent: 60, status: 'pre-booked' })

    // Riley PM-ing both projects
    for (const w of weeks.slice(0, 7)) {
      book({ person: 'riley', project: 'beta-migration', weekStart: w, percent: 30, status: 'pre-booked' })
    }

    for (const b of bookings) {
      const slug = `${b.person}-${b.project}-${b.weekStart}`
      await ctx.db.insert('entities', {
        workspaceId: wid,
        type: 'booking',
        slug,
        data: b,
        updatedAt: now,
      })
    }

    // R2.1 (Codex HIGH): the demo is STRICT-by-construction, not an
    // unenforced exemption. Curated demo data is the demo-owner's
    // deliberate sharing decision, so every seeded scalar field gets
    // a structural capture that is then explicitly CONFIRMED — the
    // demo "lights up" AND no value is shareable without a real
    // confirm row (consistent with every other entity writer).
    const seeded = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) => q.eq('workspaceId', wid))
      .collect()
    for (const e of seeded) {
      for (const [k, val] of Object.entries(
        (e.data ?? {}) as Record<string, unknown>,
      )) {
        if (
          typeof val === 'string' ||
          typeof val === 'number' ||
          typeof val === 'boolean'
        ) {
          await recordEntityWriteCapture(ctx, wid, e.type, e.slug, k)
          await confirmEntityKey(ctx, wid, e.type, e.slug, k)
        }
      }
    }

    // Atoms — the synthesized views.
    const atomsToInsert: Array<{ path: string; body: string }> = [
      {
        path: 'index.md',
        body: `# capacity desk

> 2026-05-14 · 8 people · 3 projects (2 committed, 1 potential)

## this week (w20)
look across the team — see who's pinned, where the gaps are.

## next 8 weeks
\`\`\`query
capacity.heatmap({ window: "next-8w" })
\`\`\`

## overbook risks
\`\`\`query
capacity.risks()
\`\`\`

## active projects
\`\`\`query
entities.list("project", { status: "committed" })
\`\`\`

## pipeline (potential)
\`\`\`query
entities.list("project", { status: "potential" })
\`\`\`

## quick actions
- [[actions/new-booking]]
- [[actions/promote-potential]]
- [[actions/new-project]]
`,
      },
      {
        path: 'heatmap.md',
        body: `# full capacity heatmap

\`\`\`query
capacity.heatmap({ window: "next-8w" })
\`\`\`

ask the agent for different cuts — \`next-4w\`, \`next-12w\`, by project, by client.
`,
      },
      {
        path: 'pipeline.md',
        body: `# pipeline

potential projects — what's incoming?

\`\`\`query
entities.list("project", { status: "potential" })
\`\`\`

prospects:

\`\`\`query
entities.list("client", { status: "prospect" })
\`\`\`
`,
      },
      {
        path: 'people.md',
        body: `# everyone

\`\`\`query
entities.list("person")
\`\`\`
`,
      },
      {
        path: 'actions/new-booking.md',
        body: `---
type: action
title: Log a new booking
prompt: I want to log a new booking. Ask me who (person), what project, which weeks (comma-separated Mondays in ISO format), what percent allocation, and the status (potential / pre-booked / hard-booked). Then create the bookings.
---

Logs one or more weekly bookings for a person on a project.
`,
      },
      {
        path: 'actions/promote-potential.md',
        body: `---
type: action
title: Promote a potential booking
prompt: I want to promote a potential booking to pre-booked or hard-booked. Ask which person + project, then update all matching potential bookings for that pairing.
---

Walks a potential booking up the status ladder.
`,
      },
      {
        path: 'actions/new-project.md',
        body: `---
type: action
title: Log a new project
prompt: I want to log a new project. Ask the client, the project name, the rough start and end dates, and whether it's potential, committed, or shipped. Create the project entity. Then ask if I want to add any initial bookings.
---

Adds a project (and a client if new) to the vault.
`,
      },

    ]

    for (const a of atomsToInsert) {
      await ctx.db.insert('atoms', {
        workspaceId: wid,
        path: a.path,
        body: a.body,
        updatedAt: now,
        source: 'agent',
        ...deriveSearchFields(a.path, a.body),
      })
      // Track-3 P1 §6 retrofit: curated demo bodies that are
      // type:html/skill (or legacy `skills/*`) are VIEWS/INSTRUCTIONS,
      // NEVER value sources — skip the capture loop entirely.
      // Closes the Track-2 P1a latent gap (the seed.ts site was
      // missed by the original §6 audit).
      if (isNonDataAtom(a.path, a.body)) continue
      // R3 §1 — STRICT-by-construction: the curated demo is
      // explicitly pre-shared. Record + CONFIRM each inline value per
      // (path,key) (mirrors the entity reseed) so the demo lights up
      // through windows without an unenforced exemption.
      const parsed = parseInlineAtomsFromMarkdownWithStatus(a.body)
      if (parsed.ok) {
        const seen = new Set<string>()
        for (const atom of parsed.atoms) {
          if (atom.kind !== 'value' || seen.has(atom.key)) continue
          seen.add(atom.key)
          await recordAtomWriteCapture(ctx, wid, a.path, atom.key)
          await confirmRefKey(ctx, wid, 'atom', a.path, atom.key)
        }
      } else {
        // symmetry with applyAtomCapture (subagent R3-build LOW): an
        // over-cap/unparseable curated body fails CLOSED via the
        // sentinel, never silently no-withhold.
        await recordAtomParseFailSentinel(ctx, wid, a.path)
      }
    }

    return {
      people: people.length,
      clients: clients.length,
      projects: projects.length,
      bookings: bookings.length,
      atoms: atomsToInsert.length,
    }
  },
})
