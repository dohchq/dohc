// Curated plugin catalog. Single source of truth for both the React
// marketplace Browse tab AND the agent's install_plugin tool. Hardcoded
// for v0 — future: pull from a remote registry.

import { v } from 'convex/values'
import { query, action } from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'

type CatalogEntry = {
  id: string
  name: string
  description: string
  kernel: string
  category: 'Charts' | 'Dashboards' | 'Utilities' | 'Reference'
  /**
   * Full atom body — frontmatter + content. Pasted verbatim into the
   * user's vault on install. The first plugin atom field MUST be
   * `type: plugin`.
   */
  body: string
}

export const CATALOG: CatalogEntry[] = [
  // ---------- Charts ----------

  {
    id: 'charts-heatmap',
    name: 'Capacity heatmap (color)',
    description:
      'Renders capacity.heatmap queries as a color grid instead of ASCII. Color-coded cells show hard / pre / potential / open per person per week.',
    kernel: 'heatmap',
    category: 'Charts',
    body: `---
type: plugin
id: charts-heatmap
name: Capacity heatmap (color)
description: Renders capacity.heatmap queries as a color grid instead of ASCII.
handles: capacity.heatmap
kernel: heatmap
window: next-8w
---

Disable to fall back to ASCII.
`,
  },

  {
    id: 'project-gantt',
    name: 'Project Gantt',
    description:
      'A from-scratch Gantt chart for projects, written in a custom kernel. Scales dates across all projects, shows status as bar color.',
    kernel: 'custom',
    category: 'Charts',
    body: `---
type: plugin
id: project-gantt
name: Project Gantt
description: A from-scratch Gantt chart for projects.
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
  .scale { display: flex; margin-left: 172px; margin-bottom: 6px; color: var(--faint); font-size: 10px; }
  .tick { flex: 1; border-left: 1px dashed var(--rule); padding-left: 6px; }
  .empty { color: var(--faint); font-style: italic; padding: 24px 0; text-align: center; }
</style>

<h2>project gantt</h2>
<div id="root" class="empty">loading…</div>

<script>
  function fmt(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c])
  }
  window.vibeam.onUpdate(({ entities }) => {
    const root = document.getElementById('root')
    const withDates = entities.filter(e => e.data && e.data.start && e.data.end)
    if (withDates.length === 0) { root.className = 'empty'; root.textContent = '(no projects with start + end dates)'; return }
    root.className = ''
    const starts = withDates.map(e => new Date(e.data.start).getTime())
    const ends = withDates.map(e => new Date(e.data.end).getTime())
    const minMs = Math.min(...starts), maxMs = Math.max(...ends)
    const total = Math.max(1, maxMs - minMs)
    const ticks = []
    for (let i = 0; i < 4; i++) ticks.push('<span class="tick">' + fmt(new Date(minMs + total * i / 4)) + '</span>')
    withDates.sort((a, b) => new Date(a.data.start) - new Date(b.data.start))
    const rows = withDates.map(e => {
      const s = new Date(e.data.start).getTime(), n = new Date(e.data.end).getTime()
      const left = ((s - minMs) / total) * 100, width = Math.max(2, ((n - s) / total) * 100)
      const status = e.data.status || 'committed'
      return '<div class="row"><div><div class="name">' + escapeHtml(e.data.name || e.slug) +
        '</div><div class="client">' + escapeHtml(e.data.client || '') + '</div></div><div class="lane">' +
        '<div class="bar ' + escapeHtml(status) + '" style="left:' + left + '%; width:' + width + '%">' +
        escapeHtml(status) + '</div></div></div>'
    })
    root.innerHTML = '<div class="scale">' + ticks.join('') + '</div>' + rows.join('')
  })
</script>
`,
  },

  {
    id: 'booking-counts',
    name: 'Bookings by status (counter cards)',
    description:
      'Three big-number cards showing how many bookings are hard, pre, and potential.',
    kernel: 'custom',
    category: 'Charts',
    body: `---
type: plugin
id: booking-counts
name: Bookings by status (counter cards)
description: Three big-number cards by booking status.
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
  window.vibeam.onUpdate(({ entities }) => {
    const counts = { 'hard-booked': 0, 'pre-booked': 0, 'potential': 0 }
    entities.forEach(e => { const s = e.data && e.data.status; if (s in counts) counts[s]++ })
    const total = counts['hard-booked'] + counts['pre-booked'] + counts['potential']
    const pct = n => total ? Math.round((n / total) * 100) + '%' : '—'
    hard.textContent = counts['hard-booked']
    pre.textContent = counts['pre-booked']
    pot.textContent = counts['potential']
    document.getElementById('hard-pct').textContent = pct(counts['hard-booked']) + ' of ' + total
    document.getElementById('pre-pct').textContent = pct(counts['pre-booked']) + ' of ' + total
    document.getElementById('pot-pct').textContent = pct(counts['potential']) + ' of ' + total
  })
</script>
`,
  },

  // ---------- Dashboards ----------

  {
    id: 'booking-kanban',
    name: 'Bookings as kanban',
    description:
      'Groups bookings by status into a kanban board: potential / pre-booked / hard-booked.',
    kernel: 'list',
    category: 'Dashboards',
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

Renders \`entities.list("booking")\` as a kanban grouped by status.
`,
  },

  {
    id: 'project-cards',
    name: 'Projects as cards',
    description:
      'Renders projects in a responsive card grid with title, client, status, and date range.',
    kernel: 'list',
    category: 'Dashboards',
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

Card view of projects.
`,
  },

  {
    id: 'projects-table',
    name: 'Projects as a sortable table',
    description:
      'Dense table view of projects with formatted dates and status badges. Click column headers to sort.',
    kernel: 'table',
    category: 'Dashboards',
    body: `---
type: plugin
id: projects-table
name: Projects as a sortable table
description: Dense table view of projects with date and status formatting.
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

Tabular view of projects.
`,
  },

  {
    id: 'people-template',
    name: 'People — custom layout',
    description:
      'Template-layout example. Renders each person as a markdown block with role + FTE + kind. Edit the template to reshape.',
    kernel: 'list',
    category: 'Dashboards',
    body: `---
type: plugin
id: people-template
name: People — custom layout
description: Template-layout example — markdown per person.
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

Edit \`itemTemplate\` to reshape how each person renders.
`,
  },

  // ---------- Utilities ----------

  {
    id: 'booking-promoter',
    name: 'Interactive booking promoter',
    description:
      'Click a booking cell to cycle its status (potential → pre-booked → hard-booked). Demonstrates plugin writes via window.vibeam.patch.',
    kernel: 'custom',
    category: 'Utilities',
    body: `---
type: plugin
id: booking-promoter
name: Interactive booking promoter
description: Click a cell to cycle its booking status. Proves plugin write access.
handles: entities.list("booking")
kernel: custom
commands:
  - id: refresh
    title: "Refresh bookings"
    prompt: "Tell me the current state of bookings in one line."
---

<style>
  body { padding: 8px; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: #5a5a5a; margin-bottom: 8px; }
  .swatch { display: inline-block; width: 12px; height: 12px; vertical-align: -2px; margin-right: 4px; border-radius: 2px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 5px 0; }
  .name { width: 90px; font-weight: 600; font-size: 12px; flex-shrink: 0; }
  .lane { flex: 1; display: flex; gap: 2px; }
  .cell { flex: 1; height: 22px; border-radius: 2px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px; color: rgba(0,0,0,0.55); transition: transform 0.08s; }
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
<div class="hint">writes via window.vibeam.patch — other views update live</div>

<script>
  const NEXT = { potential: 'pre-booked', 'pre-booked': 'hard-booked', 'hard-booked': 'potential' }
  const CLASS = { potential: 'potential', 'pre-booked': 'pre', 'hard-booked': 'hard' }
  window.vibeam.onUpdate(({ entities }) => {
    const byPerson = {}, weeksSet = {}
    entities.forEach(b => {
      const d = b.data || {}
      if (!d.person || !d.weekStart) return
      if (!byPerson[d.person]) byPerson[d.person] = {}
      byPerson[d.person][d.weekStart] = { slug: b.slug, status: d.status }
      weeksSet[d.weekStart] = true
    })
    const weeks = Object.keys(weeksSet).sort(), people = Object.keys(byPerson).sort()
    document.getElementById('root').innerHTML = people.map(p => {
      const lane = weeks.map(w => {
        const b = byPerson[p][w]
        if (!b) return '<div class="cell empty"></div>'
        const cls = CLASS[b.status] || 'empty'
        return '<div class="cell ' + cls + '" data-slug="' + b.slug + '" data-status="' + b.status + '" title="' + w + ' · ' + b.status + '">' + cls.charAt(0).toUpperCase() + '</div>'
      }).join('')
      return '<div class="row"><div class="name">' + p + '</div><div class="lane">' + lane + '</div></div>'
    }).join('')
    document.querySelectorAll('.cell:not(.empty)').forEach(el => {
      el.addEventListener('click', () => {
        const slug = el.getAttribute('data-slug')
        const cur = el.getAttribute('data-status')
        window.vibeam.patch({ type: 'booking', slug, data: { status: NEXT[cur] || 'potential' } })
      })
    })
  })
</script>
`,
  },

  {
    id: 'pomodoro',
    name: 'Pomodoro timer',
    description:
      '25-minute focus timer with local pause/resume. Survives navigation via iframe localStorage. Overlay-ready.',
    kernel: 'custom',
    category: 'Utilities',
    body: `---
type: plugin
id: pomodoro
name: Pomodoro timer
description: 25-minute focus timer with local pause/resume.
overlay: true
kernel: custom
---

<style>
  body { padding: 8px 12px; background: #f7f3ec; }
  .bar { display: flex; align-items: center; gap: 14px; font-size: 12px; }
  .label { color: #5a5a5a; text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
  .time { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; color: #1b1b1b; min-width: 70px; }
  .time.done { color: #c75a1f; }
  button { background: white; border: 1px solid #d8cfc1; padding: 3px 10px; font-family: inherit; font-size: 11px; cursor: pointer; }
  button:hover { border-color: #c75a1f; }
</style>

<div class="bar">
  <span class="label">pomodoro</span>
  <span class="time" id="t">25:00</span>
  <button id="start">start</button>
  <button id="reset">reset</button>
</div>

<script>
  const LS = 'vibeam-pomodoro-end'
  let endAt = parseInt(localStorage.getItem(LS) || '0', 10) || 0
  function fmt(s) {
    const m = Math.floor(s / 60), r = s % 60
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0')
  }
  function tick() {
    const el = document.getElementById('t')
    if (!endAt) { el.textContent = '25:00'; el.classList.remove('done'); return }
    const left = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    el.textContent = fmt(left)
    if (left <= 0) el.classList.add('done')
  }
  document.getElementById('start').addEventListener('click', () => {
    endAt = Date.now() + 25 * 60 * 1000
    localStorage.setItem(LS, String(endAt))
    tick()
  })
  document.getElementById('reset').addEventListener('click', () => {
    endAt = 0
    localStorage.removeItem(LS)
    tick()
  })
  setInterval(tick, 1000)
  tick()
</script>
`,
  },

  // ---------- Reference ----------

  {
    id: 'sdk-docs',
    name: 'Plugin SDK reference',
    description:
      'In-vault reference for plugin authors. Shows what\'s available in window.vibeam inside a custom kernel.',
    kernel: '',
    category: 'Reference',
    body: `---
type: plugin
id: sdk-docs
name: Plugin SDK reference
description: Reference for plugin authors.
---

# vibeam plugin SDK

If you're writing a \`kernel: custom\` plugin, your iframe's body is the
document. The parent injects \`window.vibeam\` for you.

## reading data

\`\`\`js
window.vibeam.onUpdate(({ entities, plugin, query }) => {
  // fires on load + on every Convex update
})
\`\`\`

## writing entities

\`\`\`js
await window.vibeam.upsert({ type, slug, data })
await window.vibeam.patch({ type, slug, data })
await window.vibeam.delete({ type, slug })
\`\`\`

## fetching other entity types

\`\`\`js
const projects = await window.vibeam.fetchEntities('project')
\`\`\`

## sandbox

The iframe runs with \`sandbox="allow-scripts"\`:

- ✓ JS executes
- ✓ External \`<script src="https://cdn...">\` works
- ✓ localStorage (scoped to iframe, ephemeral)
- ✗ no cookies, no parent DOM, no top-nav

## auto-resize

The iframe self-reports its scroll height. You don't have to handle it.
`,
  },
]

const CATEGORIES: Array<CatalogEntry['category']> = [
  'Charts',
  'Dashboards',
  'Utilities',
  'Reference',
]

// ---------- public API ----------

// Lightweight listing for the marketplace Browse tab + agent surface.
// Skips the body for transfer size; install() looks it up by id.
export const list = query({
  args: {},
  handler: async () => {
    return {
      entries: CATALOG.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        kernel: e.kernel,
        category: e.category,
      })),
      categories: CATEGORIES,
    }
  },
})

// Install an entry by id: writes the plugin atom to plugins/<id>.md and
// enables it. Used by both the React Install button and the agent's
// install_plugin tool. Throws on unknown id.
export const install = action({
  args: { id: v.string() },
  handler: async (
    ctx,
    { id },
  ): Promise<{ ok: true; name: string; path: string }> => {
    const workspaceId = await requireWorkspace(ctx)
    const entry = CATALOG.find((e) => e.id === id)
    if (!entry) throw new Error(`unknown plugin: ${id}`)
    const path = `plugins/${entry.id}.md`
    await ctx.runMutation(internal.atoms._upsertInternal, {
      workspaceId,
      path,
      body: entry.body,
      source: 'user',
    })
    await ctx.runMutation(internal.plugins._setEnabledInternal, {
      workspaceId,
      pluginId: entry.id,
      enabled: true,
    })
    return { ok: true, name: entry.name, path }
  },
})
