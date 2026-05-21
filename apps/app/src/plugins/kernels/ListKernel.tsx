import { useQuery } from 'convex/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../../../convex/_generated/api'
import type { KernelProps } from '../types'

// One kernel, three layouts. Iterates entities; the `layout` config
// switches how each one renders.
//
// Config:
//   layout: 'cards' (default) | 'kanban' | 'template'
//
//   cards/kanban:
//     cardTitle      — field for card title (default: 'name')
//     cardSubtitle   — field for subtitle
//     cardMeta       — field for meta line
//     fields         — extra fields rendered as key/value rows (cards only)
//
//   kanban only:
//     groupBy        — field whose values become columns (required)
//     columns        — column order; if omitted, auto-derived
//
//   template only:
//     itemTemplate   — markdown body with {{field}} placeholders (required)
//     separator      — string between items
//     empty          — markdown when there are no entities
//
//   all layouts:
//     sort           — field to sort by
//     sortDir        — 'asc' | 'desc'
//     limit          — max items to render
//
// Replaces the old kanban/cards/template kernels.

export function ListKernel({ plugin, query }: KernelProps) {
  const type = query.resource
  const entities = useQuery(api.entities.list, { type }) as
    | Array<{ slug: string; data: any }>
    | undefined

  if (!entities) return <div className="list-loading">loading…</div>

  const layout = String(plugin.config.layout ?? 'cards')
  const sortField = plugin.config.sort ? String(plugin.config.sort) : 'name'
  const sortDir = String(plugin.config.sortDir ?? 'asc')
  const limit =
    typeof plugin.config.limit === 'number' ? plugin.config.limit : undefined

  const sorted = [...entities].sort((a, b) => {
    const av = String(a.data?.[sortField] ?? a.slug)
    const bv = String(b.data?.[sortField] ?? b.slug)
    return sortDir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv)
  })
  const items = limit ? sorted.slice(0, limit) : sorted

  if (layout === 'template') return <TemplateLayout plugin={plugin} items={items} />
  if (layout === 'kanban') return <KanbanLayout plugin={plugin} items={items} />
  return <CardsLayout plugin={plugin} items={items} />
}

// ---- cards ----

function CardsLayout({
  plugin,
  items,
}: {
  plugin: KernelProps['plugin']
  items: Array<{ slug: string; data: any }>
}) {
  const titleField = String(plugin.config.cardTitle ?? 'name')
  const subtitleField = plugin.config.cardSubtitle
    ? String(plugin.config.cardSubtitle)
    : null
  const metaField = plugin.config.cardMeta ? String(plugin.config.cardMeta) : null
  const extraFields = (plugin.config.fields as string[] | undefined) ?? []

  if (items.length === 0)
    return <div className="cards-empty">nothing</div>

  return (
    <div className="cards-grid">
      {items.map((e) => (
        <div key={e.slug} className="card">
          <div className="card-title">
            {String(e.data?.[titleField] ?? e.slug)}
          </div>
          {subtitleField && (
            <div className="card-sub">{String(e.data?.[subtitleField] ?? '')}</div>
          )}
          {metaField && (
            <div className="card-meta">{String(e.data?.[metaField] ?? '')}</div>
          )}
          {extraFields.length > 0 && (
            <div className="card-fields">
              {extraFields.map((f) => (
                <div key={f} className="card-field">
                  <span className="card-field-key">{f}</span>
                  <span className="card-field-val">
                    {String(e.data?.[f] ?? '—')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- kanban ----

function KanbanLayout({
  plugin,
  items,
}: {
  plugin: KernelProps['plugin']
  items: Array<{ slug: string; data: any }>
}) {
  const groupBy = String(plugin.config.groupBy ?? 'status')
  const columns =
    (plugin.config.columns as string[] | undefined) ??
    Array.from(new Set(items.map((e) => String(e.data?.[groupBy] ?? '—'))))
  const titleField = String(plugin.config.cardTitle ?? 'name')
  const subtitleField = plugin.config.cardSubtitle
    ? String(plugin.config.cardSubtitle)
    : null
  const metaField = plugin.config.cardMeta ? String(plugin.config.cardMeta) : null

  const byCol = new Map<string, typeof items>()
  for (const c of columns) byCol.set(c, [])
  for (const e of items) {
    const colKey = String(e.data?.[groupBy] ?? '—')
    if (!byCol.has(colKey)) byCol.set(colKey, [])
    byCol.get(colKey)!.push(e)
  }

  return (
    <div className="kanban">
      {columns.map((col) => {
        const cards = byCol.get(col) ?? []
        return (
          <div key={col} className="kanban-col">
            <div className="kanban-col-header">
              <span className="kanban-col-name">{col}</span>
              <span className="kanban-col-count">{cards.length}</span>
            </div>
            <div className="kanban-cards">
              {cards.length === 0 ? (
                <div className="kanban-empty">·</div>
              ) : (
                cards.map((e) => {
                  const title = String(e.data?.[titleField] ?? e.slug)
                  const subtitle = subtitleField
                    ? String(e.data?.[subtitleField] ?? '')
                    : null
                  const meta = metaField
                    ? String(e.data?.[metaField] ?? '')
                    : null
                  return (
                    <div key={e.slug} className="kanban-card">
                      <div className="kanban-card-title">{title}</div>
                      {subtitle && (
                        <div className="kanban-card-sub">{subtitle}</div>
                      )}
                      {meta && <div className="kanban-card-meta">{meta}</div>}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---- template ----

function TemplateLayout({
  plugin,
  items,
}: {
  plugin: KernelProps['plugin']
  items: Array<{ slug: string; data: any }>
}) {
  const itemTemplate = String(plugin.config.itemTemplate ?? '- **{{name}}**')
  const separator = plugin.config.separator
    ? String(plugin.config.separator)
    : ''
  const emptyText = String(plugin.config.empty ?? '_(empty)_')

  if (items.length === 0) {
    return (
      <div className="template-kernel">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{emptyText}</ReactMarkdown>
      </div>
    )
  }

  const rendered = items
    .map((e) => substitute(itemTemplate, { ...e.data, slug: e.slug }))
    .join(separator ? `\n\n${separator}\n\n` : '\n\n')

  return (
    <div className="template-kernel">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{rendered}</ReactMarkdown>
    </div>
  )
}

const PLACEHOLDER_RE = /\{\{(\s*[\w.-]+\s*)\}\}/g

function substitute(template: string, data: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_, raw: string) => {
    const key = raw.trim()
    const v = data[key]
    if (v == null) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  })
}
