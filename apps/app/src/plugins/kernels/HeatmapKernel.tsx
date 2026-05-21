import { Fragment, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import type { KernelProps } from '../types'

type Booking = {
  person?: string
  project?: string
  weekStart?: string
  percent?: number
  status?: string
}
type Person = { name?: string; role?: string; kind?: string; fte?: number }

export function HeatmapKernel({ plugin, query }: KernelProps) {
  const people = useQuery(api.entities.list, { type: 'person' }) as
    | Array<{ slug: string; data: Person }>
    | undefined
  const bookings = useQuery(api.entities.list, { type: 'booking' }) as
    | Array<{ slug: string; data: Booking }>
    | undefined

  const windowSpec =
    (plugin.config.window as string) ??
    (query.filters.window as string) ??
    'next-8w'
  const weeks = useMemo(() => computeWeeks(windowSpec), [windowSpec])

  if (!people || !bookings) {
    return <div className="heatmap-plugin heatmap-loading">loading…</div>
  }

  const grid = new Map<
    string,
    Map<string, { status: string; percent: number; project?: string }>
  >()
  for (const p of people) grid.set(p.slug, new Map())
  for (const b of bookings) {
    const personSlug = b.data?.person
    const weekStart = b.data?.weekStart
    if (typeof personSlug !== 'string' || typeof weekStart !== 'string') continue
    if (!weeks.includes(weekStart)) continue
    const cell = grid.get(personSlug)
    if (!cell) continue
    const existing = cell.get(weekStart)
    const status = String(b.data.status ?? 'potential')
    const percent = Number(b.data.percent ?? 0)
    if (!existing || priority(status) > priority(existing.status)) {
      cell.set(weekStart, { status, percent, project: b.data.project })
    }
  }

  const sortedPeople = [...people].sort((a, b) =>
    String(a.data?.name ?? a.slug).localeCompare(
      String(b.data?.name ?? b.slug),
    ),
  )

  return (
    <div className="heatmap-plugin">
      <div
        className="heatmap-grid"
        style={{
          gridTemplateColumns: `120px repeat(${weeks.length}, minmax(48px, 1fr))`,
        }}
      >
        <div />
        {weeks.map((w) => (
          <div key={w} className="heatmap-week-label" title={w}>
            {weekLabel(w)}
          </div>
        ))}
        {sortedPeople.map((p) => (
          <Fragment key={p.slug}>
            <div className="heatmap-person" title={p.slug}>
              <span className="heatmap-person-name">
                {p.data?.name ?? p.slug}
              </span>
              {p.data?.kind === 'contractor' && (
                <span className="heatmap-person-tag">c</span>
              )}
            </div>
            {weeks.map((w) => {
              const cell = grid.get(p.slug)?.get(w)
              const status = cell?.status ?? 'empty'
              return (
                <div
                  key={w}
                  className={`heatmap-cell heatmap-${status}`}
                  title={
                    cell
                      ? `${p.data?.name ?? p.slug} · ${cell.percent}% · ${cell.status}${cell.project ? ` · ${cell.project}` : ''}`
                      : `${p.data?.name ?? p.slug} · open · ${weekLabel(w)}`
                  }
                >
                  {cell?.percent ? (
                    <span className="heatmap-percent">{cell.percent}</span>
                  ) : null}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>

      <div className="heatmap-legend">
        <Legend status="hard-booked" label="hard" />
        <Legend status="pre-booked" label="pre" />
        <Legend status="potential" label="potential" />
        <Legend status="empty" label="open" />
      </div>
    </div>
  )
}

function Legend({ status, label }: { status: string; label: string }) {
  return (
    <span className="heatmap-legend-item">
      <span className={`heatmap-swatch heatmap-${status}`} />
      <span>{label}</span>
    </span>
  )
}

function priority(s: string): number {
  return s === 'hard-booked' ? 3 : s === 'pre-booked' ? 2 : s === 'potential' ? 1 : 0
}

function weekLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return `w${getISOWeek(d).toString().padStart(2, '0')}`
}

function getISOWeek(d: Date): number {
  const t = new Date(d.valueOf())
  const dayNr = (d.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - dayNr + 3)
  const firstThursday = t.valueOf()
  t.setUTCMonth(0, 1)
  if (t.getUTCDay() !== 4) {
    t.setUTCMonth(0, 1 + ((4 - t.getUTCDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - t.valueOf()) / 604800000)
}

function computeWeeks(spec: string): string[] {
  const m = /^next-(\d+)w$/.exec(spec)
  if (!m) return []
  const count = parseInt(m[1]!, 10)
  const out: string[] = []
  const now = new Date()
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const day = (monday.getUTCDay() + 6) % 7
  monday.setUTCDate(monday.getUTCDate() - day)
  for (let i = 0; i < count; i++) {
    const d = new Date(monday.valueOf())
    d.setUTCDate(d.getUTCDate() + i * 7)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
