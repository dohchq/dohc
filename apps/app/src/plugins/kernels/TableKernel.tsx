import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import type { KernelProps } from '../types'

// Generic table kernel. Renders entities as a sortable table with
// per-column formatting.
//
// Config:
//   columns       — array of { field, label?, format?, width? }
//                   format: text (default) | date | percent | badge | code
//   sort          — initial sort field
//   sortDir       — "asc" | "desc"
//   filter        — { field: value } map of static filters

type ColumnSpec = {
  field: string
  label?: string
  format?: 'text' | 'date' | 'percent' | 'badge' | 'code'
  width?: string
}

export function TableKernel({ plugin, query }: KernelProps) {
  const type = query.resource
  const entities = useQuery(api.entities.list, { type }) as
    | Array<{ slug: string; data: any }>
    | undefined

  const columns = (plugin.config.columns as ColumnSpec[] | undefined) ?? []
  const initialSort = plugin.config.sort
    ? String(plugin.config.sort)
    : columns[0]?.field
  const initialDir = (plugin.config.sortDir as string) ?? 'asc'
  const filter = (plugin.config.filter as Record<string, unknown>) ?? {}

  const [sortField, setSortField] = useState(initialSort)
  const [sortDir, setSortDir] = useState(initialDir)

  if (!entities) return <div className="table-loading">loading…</div>

  const visible = entities.filter((e) =>
    Object.entries(filter).every(
      ([k, v]) => String(e.data?.[k]) === String(v),
    ),
  )

  const sorted = sortField
    ? [...visible].sort((a, b) => {
        const av = String(a.data?.[sortField] ?? '')
        const bv = String(b.data?.[sortField] ?? '')
        const cmp = av.localeCompare(bv, undefined, { numeric: true })
        return sortDir === 'desc' ? -cmp : cmp
      })
    : visible

  if (columns.length === 0) {
    return (
      <div className="table-empty-config">
        no <code>columns</code> configured. add a <code>columns:</code> list
        in the plugin atom.
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = c.field === sortField
              return (
                <th
                  key={c.field}
                  style={c.width ? { width: c.width } : undefined}
                  onClick={() => {
                    if (sortField === c.field) {
                      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                    } else {
                      setSortField(c.field)
                      setSortDir('asc')
                    }
                  }}
                  className={`th-${active ? 'active' : ''}`}
                >
                  {c.label ?? c.field}
                  {active && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.slug}>
              {columns.map((c) => (
                <td key={c.field}>{formatCell(e.data?.[c.field], c.format)}</td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td
                className="table-empty"
                colSpan={columns.length}
              >
                no rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(v: unknown, format?: string) {
  if (v == null) return <span className="cell-empty">—</span>
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  switch (format) {
    case 'badge':
      return <span className={`cell-badge cell-badge-${slug(s)}`}>{s}</span>
    case 'date':
      return <span className="cell-date">{s}</span>
    case 'percent':
      return <span className="cell-percent">{s}%</span>
    case 'code':
      return <code>{s}</code>
    default:
      return s
  }
}

function slug(s: string): string {
  return s.replace(/[^\w-]+/g, '-').toLowerCase()
}
