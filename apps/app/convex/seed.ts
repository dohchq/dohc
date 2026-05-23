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
    // path (agent/plugin via _upsertMany/_patch, restore) IS guarded.
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

      // --- Plugins, shipped as atoms in plugins/ ---

      {
        path: 'plugins/charts-heatmap.md',
        body: `---
type: plugin
id: charts-heatmap
name: Capacity heatmap (color)
description: Renders capacity.heatmap queries as a color grid instead of ASCII.
handles: capacity.heatmap
kernel: heatmap
window: next-8w
---

Built-in plugin for the capacity heatmap. Disable to fall back to ASCII.
`,
      },
      {
        path: 'plugins/booking-kanban.md',
        body: `---
type: plugin
id: booking-kanban
name: Bookings as kanban
description: Groups bookings by status into a kanban board.
handles: entities.list("booking")
kernel: list
layout: kanban
groupBy: status
columns: ["hard-booked", "pre-booked", "potential"]
cardTitle: person
cardSubtitle: project
cardMeta: percent
---

Renders any \`entities.list("booking")\` block as a kanban grouped by status.
`,
      },
      {
        path: 'plugins/project-cards.md',
        body: `---
type: plugin
id: project-cards
name: Projects as cards
description: Renders projects in a responsive card grid.
handles: entities.list("project")
kernel: list
layout: cards
cardTitle: name
cardSubtitle: client
cardMeta: status
fields: ["start", "end"]
---

Card view of projects. Useful for the pipeline + committed dashboards.
`,
      },

      {
        path: 'plugins/people-template.md',
        body: `---
type: plugin
id: people-template
name: People — custom layout
description: Template-layout example. Renders each person as a markdown block with the fields you want.
handles: entities.list("person")
kernel: list
layout: template
sort: name
itemTemplate: |
  ### {{name}} · {{role}}
  - **FTE** {{fte}}%
  - **kind** {{kind}}
empty: "_(no people yet)_"
---

Shows what the \`list\` kernel can do with \`layout: template\`. Edit
\`itemTemplate\` to reshape how each person renders — change the markdown,
add fields, anything.
`,
      },

      {
        path: 'plugins/projects-table.md',
        body: `---
type: plugin
id: projects-table
name: Projects as a sortable table
description: Dense table view of projects with date and status formatting. Click column headers to sort.
handles: entities.list("project")
kernel: table
sort: start
sortDir: asc
columns:
  - field: name
    label: Project
    width: 220px
  - field: client
    label: Client
  - field: status
    label: Status
    format: badge
  - field: start
    label: Starts
    format: date
  - field: end
    label: Ends
    format: date
---

Tabular view of projects. The table kernel is the right call when you
want to scan rows quickly and sort.
`,
      },

      {
        path: 'plugins/project-gantt.md',
        body: `---
type: plugin
id: project-gantt
name: Custom — project Gantt
description: A from-scratch Gantt chart for projects. Written entirely in this atom's body. Shows what the custom kernel can do.
handles: entities.list("project")
kernel: custom
---

<style>
  :root { --rule: #d8cfc1; --ink: #1b1b1b; --dim: #5a5a5a; --faint: #9c948a; --accent: #c75a1f; }
  body { padding: 12px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); margin: 0 0 12px; font-weight: 500; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--rule); }
  .row:first-child { border-top: none; }
  .name { width: 160px; font-weight: 600; flex-shrink: 0; }
  .client { color: var(--faint); font-size: 11px; }
  .lane { position: relative; flex: 1; height: 22px; background: #f3ecdd; border-radius: 2px; }
  .bar { position: absolute; top: 0; bottom: 0; border-radius: 2px; display: flex; align-items: center; padding: 0 8px; color: white; font-size: 11px; white-space: nowrap; }
  .bar.committed { background: var(--accent); }
  .bar.potential { background: repeating-linear-gradient(45deg, #e8c8a0, #e8c8a0 4px, #faf5ec 4px, #faf5ec 8px); color: #6a4a20; }
  .bar.shipped { background: #b8a89a; }
  .scale { display: flex; margin-left: 172px; margin-bottom: 6px; color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .tick { flex: 1; border-left: 1px dashed var(--rule); padding-left: 6px; }
  .empty { color: var(--faint); font-style: italic; padding: 24px 0; text-align: center; }
</style>

<h2>project gantt</h2>
<div id="root" class="empty">loading…</div>

<script>
  function fmt(d) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  window.dohc.onUpdate(function({ entities }) {
    var root = document.getElementById('root')
    var withDates = entities.filter(function(e) { return e.data && e.data.start && e.data.end })
    if (withDates.length === 0) {
      root.className = 'empty'
      root.textContent = '(no projects with start + end dates yet)'
      return
    }
    root.className = ''

    // Find the date range across all projects.
    var starts = withDates.map(function(e) { return new Date(e.data.start).getTime() })
    var ends   = withDates.map(function(e) { return new Date(e.data.end).getTime() })
    var minMs  = Math.min.apply(null, starts)
    var maxMs  = Math.max.apply(null, ends)
    var total  = Math.max(1, maxMs - minMs)

    // Build 4 tick labels.
    var ticks = []
    for (var i = 0; i < 4; i++) {
      var t = new Date(minMs + (total * i) / 4)
      ticks.push('<span class="tick">' + fmt(t) + '</span>')
    }

    // Render rows, sorted by start.
    withDates.sort(function(a, b) {
      return new Date(a.data.start) - new Date(b.data.start)
    })

    var rows = withDates.map(function(e) {
      var startMs = new Date(e.data.start).getTime()
      var endMs   = new Date(e.data.end).getTime()
      var leftPct = ((startMs - minMs) / total) * 100
      var widthPct = Math.max(2, ((endMs - startMs) / total) * 100)
      var status = e.data.status || 'committed'
      return (
        '<div class="row">' +
          '<div>' +
            '<div class="name">' + escapeHtml(e.data.name || e.slug) + '</div>' +
            '<div class="client">' + escapeHtml(e.data.client || '') + '</div>' +
          '</div>' +
          '<div class="lane">' +
            '<div class="bar ' + escapeHtml(status) + '" style="left:' + leftPct + '%; width:' + widthPct + '%">' +
              escapeHtml(status) +
            '</div>' +
          '</div>' +
        '</div>'
      )
    })

    root.innerHTML =
      '<div class="scale">' + ticks.join('') + '</div>' +
      rows.join('')
  })

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
</script>
`,
      },

      {
        path: 'plugins/booking-promoter.md',
        body: `---
type: plugin
id: booking-promoter
name: Custom — interactive booking promoter
description: An interactive Gantt-ish view. Click a "potential" bar to promote it to pre-booked, click again to make it hard-booked. Shows that custom plugins can WRITE, not just READ.
handles: entities.list("booking")
kernel: custom
commands:
  - id: refresh
    title: "Refresh bookings"
    prompt: "Re-render the booking-promoter view. Just tell me the current state of bookings in one line."
---

<style>
  body { padding: 8px; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: #5a5a5a; margin-bottom: 8px; }
  .swatch { display: inline-block; width: 12px; height: 12px; vertical-align: -2px; margin-right: 4px; border-radius: 2px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 5px 0; }
  .name { width: 90px; font-weight: 600; font-size: 12px; flex-shrink: 0; }
  .lane { flex: 1; display: flex; gap: 2px; }
  .cell {
    flex: 1; height: 22px; border-radius: 2px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; color: rgba(0,0,0,0.55);
    transition: transform 0.08s;
  }
  .cell:hover { transform: scale(1.08); z-index: 2; }
  .cell.empty { background: #f3ecdd; cursor: default; }
  .cell.empty:hover { transform: none; }
  .cell.potential { background: repeating-linear-gradient(45deg, #e8c8a0, #e8c8a0 3px, #faf5ec 3px, #faf5ec 6px); color: #6a4a20; }
  .cell.pre { background: #f3b97b; color: #5a2c08; }
  .cell.hard { background: #c75a1f; color: white; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #5a5a5a; margin: 0 0 6px; font-weight: 500; }
  .hint { font-size: 11px; color: #9c948a; margin-top: 8px; font-style: italic; }
</style>

<h2>click a cell to cycle: potential → pre-booked → hard-booked → potential</h2>
<div class="legend">
  <span><span class="swatch" style="background:repeating-linear-gradient(45deg,#e8c8a0,#e8c8a0 3px,#faf5ec 3px,#faf5ec 6px)"></span>potential</span>
  <span><span class="swatch" style="background:#f3b97b"></span>pre-booked</span>
  <span><span class="swatch" style="background:#c75a1f"></span>hard-booked</span>
</div>
<div id="root"></div>
<div class="hint">writes to the entities store via window.dohc.patch — heatmap above updates live</div>

<script>
  var NEXT = { potential: 'pre-booked', 'pre-booked': 'hard-booked', 'hard-booked': 'potential' }
  var CLASS = { potential: 'potential', 'pre-booked': 'pre', 'hard-booked': 'hard' }

  function pad(s, n) { return (s + '        ').slice(0, n) }

  window.dohc.onUpdate(function({ entities }) {
    var byPerson = {}
    var weeksSet = {}
    entities.forEach(function(b) {
      var d = b.data || {}
      if (!d.person || !d.weekStart) return
      if (!byPerson[d.person]) byPerson[d.person] = {}
      byPerson[d.person][d.weekStart] = { slug: b.slug, status: d.status }
      weeksSet[d.weekStart] = true
    })
    var weeks = Object.keys(weeksSet).sort()
    var people = Object.keys(byPerson).sort()

    document.getElementById('root').innerHTML = people.map(function(p) {
      var lane = weeks.map(function(w) {
        var b = byPerson[p][w]
        if (!b) return '<div class="cell empty"></div>'
        var cls = CLASS[b.status] || 'empty'
        return '<div class="cell ' + cls + '" data-slug="' + b.slug + '" data-status="' + b.status + '" title="' + w + ' · ' + b.status + '">' + cls.charAt(0).toUpperCase() + '</div>'
      }).join('')
      return '<div class="row"><div class="name">' + p + '</div><div class="lane">' + lane + '</div></div>'
    }).join('')

    document.querySelectorAll('.cell:not(.empty)').forEach(function(el) {
      el.addEventListener('click', function() {
        var slug = el.getAttribute('data-slug')
        var current = el.getAttribute('data-status')
        var next = NEXT[current] || 'potential'
        window.dohc.patch({ type: 'booking', slug: slug, data: { status: next } })
      })
    })
  })
</script>
`,
      },

      {
        path: 'plugins/sdk-docs.md',
        body: `---
type: plugin
id: sdk-docs
name: Plugin SDK docs
description: Reference for plugin authors. Shows what's available in window.dohc inside a custom kernel.
---

# dohc plugin SDK

If you're writing a \`kernel: custom\` plugin, your iframe's body is the
document. The parent injects \`window.dohc\` for you.

## reading data

\`\`\`js
window.dohc.onUpdate(({ entities, plugin, query }) => {
  // fires on load + on every Convex update
  // entities[] are of type \`query.resource\`
  // plugin.config has any extra frontmatter fields
})
\`\`\`

## writing entities

\`\`\`js
// upsert: create or replace
await window.dohc.upsert({
  type: 'booking',
  slug: 'anna-acme-2026-05-11',
  data: { person: 'anna', percent: 50, status: 'hard-booked' }
})

// patch: merge fields into an existing entity
await window.dohc.patch({
  type: 'booking',
  slug: 'anna-acme-2026-05-11',
  data: { status: 'hard-booked' }
})

// delete
await window.dohc.delete({ type: 'booking', slug: 'anna-acme-2026-05-11' })
\`\`\`

## fetching other entity types

\`\`\`js
const projects = await window.dohc.fetchEntities('project')
\`\`\`

## sandbox

The iframe runs with \`sandbox="allow-scripts"\`:

- ✓ JS executes
- ✓ External \`<script src="https://cdn...">\` works
- ✓ localStorage works (scoped to iframe, ephemeral)
- ✗ no cookies, no parent DOM, no top-nav, no popups

## auto-resize

The iframe self-reports its scroll height. You don't have to do anything.

## see also

- [[plugins/booking-promoter]] — interactive (uses patch)
- [[plugins/project-gantt]] — read-only Gantt
- [[plugins/booking-counts]] — simple stats cards
`,
      },

      {
        path: 'plugins/booking-counts.md',
        body: `---
type: plugin
id: booking-counts
name: Custom — bookings by status (counter cards)
description: Three big-number cards showing how many bookings are hard, pre, and potential. Demonstrates a tiny custom dashboard widget.
handles: entities.list("booking")
kernel: custom
---

<style>
  body { padding: 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .card { background: white; border: 1px solid #d8cfc1; padding: 14px 16px; }
  .num { font-size: 36px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #5a5a5a; margin-top: 6px; }
  .pct { font-size: 11px; color: #9c948a; margin-top: 4px; }
  .num.hard { color: #c75a1f; }
  .num.pre { color: #b87440; }
  .num.potential { color: #5a5a5a; }
</style>

<div class="grid">
  <div class="card"><div class="num hard" id="hard">0</div><div class="label">hard-booked</div><div class="pct" id="hard-pct"></div></div>
  <div class="card"><div class="num pre" id="pre">0</div><div class="label">pre-booked</div><div class="pct" id="pre-pct"></div></div>
  <div class="card"><div class="num potential" id="pot">0</div><div class="label">potential</div><div class="pct" id="pot-pct"></div></div>
</div>

<script>
  window.dohc.onUpdate(function({ entities }) {
    var counts = { 'hard-booked': 0, 'pre-booked': 0, 'potential': 0 }
    entities.forEach(function(e) {
      var s = e.data && e.data.status
      if (s in counts) counts[s]++
    })
    var total = counts['hard-booked'] + counts['pre-booked'] + counts['potential']
    function pct(n) { return total ? Math.round((n / total) * 100) + '%' : '—' }
    document.getElementById('hard').textContent = counts['hard-booked']
    document.getElementById('pre').textContent  = counts['pre-booked']
    document.getElementById('pot').textContent  = counts['potential']
    document.getElementById('hard-pct').textContent = pct(counts['hard-booked']) + ' of ' + total
    document.getElementById('pre-pct').textContent  = pct(counts['pre-booked'])  + ' of ' + total
    document.getElementById('pot-pct').textContent  = pct(counts['potential'])    + ' of ' + total
  })
</script>
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
