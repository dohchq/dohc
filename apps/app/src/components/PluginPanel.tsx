import { useEffect, useMemo, useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Hammer,
  Loader2,
  Package,
  PencilLine,
  Search,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { usePlugins } from '../plugins/usePlugins'
import { KERNELS } from '../plugins/kernels'
import { parseFrontmatter } from '../lib/frontmatter'
import type { PluginInstance } from '../plugins/types'

type CatalogCard = {
  id: string
  name: string
  description: string
  kernel: string
  category: 'Charts' | 'Dashboards' | 'Utilities' | 'Reference'
}

type Props = {
  onOpenAtom: (path: string) => void
  onCreatePlugin: () => void
}

type Tab = 'installed' | 'browse' | 'import'

export function PluginPanel({ onOpenAtom, onCreatePlugin }: Props) {
  const { plugins, enabled, loading } = usePlugins()
  const setEnabled = useMutation(api.plugins.setEnabled)
  const upsertAtom = useMutation(api.atoms.upsert)
  const installAction = useAction(api.catalog.install)
  const catalog = useQuery(api.catalog.list)
  const [tab, setTab] = useState<Tab>('installed')
  const [toast, setToast] = useState<string | null>(null)
  // When set, the right pane shows a single-plugin detail view instead
  // of the list. Resolved against the installed list first so we always
  // show the rich post-parse data when available.
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selectedPlugin = useMemo(
    () => (selectedId ? plugins.find((p) => p.id === selectedId) ?? null : null),
    [selectedId, plugins],
  )
  const selectedCatalog = useMemo(
    () =>
      selectedId && !selectedPlugin
        ? catalog?.entries.find((e) => e.id === selectedId) ?? null
        : null,
    [selectedId, selectedPlugin, catalog],
  )
  const hasDetail = Boolean(selectedPlugin || selectedCatalog)

  // ⎋ closes the detail view back to the list.
  useEffect(() => {
    if (!hasDetail) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasDetail])

  function flashToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  async function copyPlugin(path: string, fullAtom: string) {
    try {
      await navigator.clipboard.writeText(fullAtom)
      flashToast(`Copied ${path}`)
    } catch {
      flashToast('Clipboard blocked')
    }
  }

  async function installFromCatalog(card: CatalogCard) {
    const result = await installAction({ id: card.id })
    flashToast(`Installed ${result.name}`)
    setTab('installed')
  }

  return (
    <div className="pane bg-page">
      <header className="sticky top-0 z-20 flex h-11 items-center justify-between px-6 bg-page/85 backdrop-blur-md border-b border-rule">
        {hasDetail ? (
          <button
            onClick={() => setSelectedId(null)}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-dim hover:text-ink transition-colors"
          >
            <ArrowLeft className="size-3.5" strokeWidth={2} />
            <span>All plugins</span>
          </button>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-ink-strong font-semibold tracking-tight">
            <Package className="size-3.5 text-ink-dim" strokeWidth={2} />
            <span>Plugins</span>
          </div>
        )}
        <button
          onClick={onCreatePlugin}
          className="inline-flex items-center gap-1.5 h-7 rounded-md bg-ink-strong px-2.5 text-[11.5px] font-medium text-surface hover:bg-ink transition-colors"
        >
          <Hammer className="size-3" strokeWidth={2.2} />
          Build with agent
        </button>
      </header>

      <div className="max-w-[860px] mx-auto px-8 pt-8 pb-32">
        {selectedPlugin ? (
          <PluginDetail
            plugin={selectedPlugin}
            enabled={enabled.has(selectedPlugin.id)}
            onToggle={(v) =>
              setEnabled({ pluginId: selectedPlugin.id, enabled: v })
            }
            onOpenAtom={onOpenAtom}
            onCopy={() =>
              copyPlugin(selectedPlugin.path, reconstructFullAtom(selectedPlugin))
            }
          />
        ) : selectedCatalog ? (
          <CatalogDetail
            entry={selectedCatalog}
            installed={false}
            onInstall={async () => {
              await installFromCatalog(selectedCatalog)
              // After install, the entry shows up in `plugins` and the
              // selectedId resolves to the rich PluginDetail automatically.
            }}
          />
        ) : (
          <>
            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-rule -mt-2 mb-6">
              <TabButton
                active={tab === 'installed'}
                onClick={() => setTab('installed')}
                label="Installed"
                count={plugins.length}
              />
              <TabButton
                active={tab === 'browse'}
                onClick={() => setTab('browse')}
                label="Browse"
                count={catalog?.entries.length ?? null}
              />
              <TabButton
                active={tab === 'import'}
                onClick={() => setTab('import')}
                label="Import"
              />
            </div>

            {tab === 'installed' && (
              <InstalledTab
                plugins={plugins}
                enabled={enabled}
                loading={loading}
                onToggle={(id, e) =>
                  setEnabled({ pluginId: id, enabled: e })
                }
                onSelect={(id) => setSelectedId(id)}
                onCreatePlugin={onCreatePlugin}
              />
            )}
            {tab === 'browse' && (
              <BrowseTab
                installedIds={new Set(plugins.map((p) => p.id))}
                entries={catalog?.entries ?? null}
                categories={catalog?.categories ?? []}
                onInstall={installFromCatalog}
                onSelect={(id) => setSelectedId(id)}
              />
            )}
            {tab === 'import' && (
              <ImportTab
                onInstalled={(path) => {
                  flashToast(`Installed ${path}`)
                  setTab('installed')
                  onOpenAtom(path)
                }}
                installed={new Set(plugins.map((p) => p.id))}
                setEnabled={(id) =>
                  setEnabled({ pluginId: id, enabled: true })
                }
                upsertAtom={(args) => upsertAtom(args)}
              />
            )}
          </>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 inline-flex items-center gap-2 rounded-full border border-rule bg-elevated px-4 py-2 text-[12px] text-ink shadow-md">
          <Check className="size-3.5 text-success" strokeWidth={2.2} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number | null
}) {
  return (
    <button
      onClick={onClick}
      className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors ${
        active ? 'text-ink-strong' : 'text-ink-dim hover:text-ink'
      }`}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={`text-[10.5px] tabular-nums ${
            active ? 'text-ink-dim' : 'text-ink-faint'
          }`}
        >
          {count === null ? '…' : count}
        </span>
      )}
      {active && (
        <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-ink-strong rounded-t" />
      )}
    </button>
  )
}

// ---------- INSTALLED TAB ----------

function InstalledTab({
  plugins,
  enabled,
  loading,
  onToggle,
  onSelect,
  onCreatePlugin,
}: {
  plugins: ReturnType<typeof usePlugins>['plugins']
  enabled: Set<string>
  loading: boolean
  onToggle: (id: string, enabled: boolean) => void
  onSelect: (id: string) => void
  onCreatePlugin: () => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-faint py-8">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
        <span>Loading…</span>
      </div>
    )
  }
  if (plugins.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-rule bg-panel/40 px-6 py-10 text-center">
        <div className="size-10 rounded-xl bg-panel mx-auto flex items-center justify-center mb-3">
          <Package className="size-4 text-ink-dim" strokeWidth={2} />
        </div>
        <p className="text-[14px] text-ink-strong font-semibold">
          No plugins installed
        </p>
        <p className="mt-1 text-[12.5px] text-ink-dim max-w-sm mx-auto">
          Browse the marketplace, paste a plugin atom, or ask the agent to
          build one tailored to your workflow.
        </p>
        <button
          onClick={onCreatePlugin}
          className="mt-4 inline-flex items-center gap-1.5 h-8 rounded-md bg-ink-strong px-3 text-[12px] font-medium text-surface hover:bg-ink transition-colors"
        >
          <Hammer className="size-3" strokeWidth={2.2} />
          Build with agent
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {plugins.map((p) => {
        const isOn = enabled.has(p.id)
        const kernelExists = p.kernel ? Boolean(KERNELS[p.kernel]) : true
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(p.id)
              }
            }}
            className={`group rounded-lg border bg-surface p-4 transition-colors cursor-pointer hover:border-rule-strong hover:bg-hover focus:outline-none focus-visible:border-ink ${
              isOn ? 'border-rule-strong' : 'border-rule'
            }`}
          >
            <div className="flex items-start gap-4">
              <div
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <ToggleSwitch
                  checked={isOn}
                  disabled={!kernelExists}
                  onChange={(v) => onToggle(p.id, v)}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="text-[14px] font-semibold text-ink-strong tracking-tight">
                    {p.name}
                  </h3>
                  {!kernelExists && (
                    <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-danger">
                      Missing kernel
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12.5px] text-ink-dim leading-relaxed">
                  {p.description}
                </p>
                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  {p.kernel && p.handles && (
                    <Tag>
                      <span className="text-ink-faint">renders</span>{' '}
                      <code className="font-mono text-ink">{p.handles}</code>
                      <span className="text-ink-faint">·</span>
                      <code className="font-mono text-ink">{p.kernel}</code>
                    </Tag>
                  )}
                  {p.commands.length > 0 && (
                    <Tag>
                      {p.commands.length} command
                      {p.commands.length === 1 ? '' : 's'}
                    </Tag>
                  )}
                  {p.overlay && <Tag>overlay</Tag>}
                </div>
              </div>
              <ChevronRight
                className="size-4 text-ink-faint shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity"
                strokeWidth={2}
              />
            </div>
          </div>
        )
      })}
      <button
        onClick={onCreatePlugin}
        className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-dashed border-rule px-4 py-3 text-[12.5px] text-ink-dim hover:text-ink hover:border-rule-strong hover:bg-hover transition-colors"
      >
        <Hammer className="size-3.5" strokeWidth={2} />
        Build a custom plugin with the agent
      </button>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-rule bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-ink-dim">
      {children}
    </span>
  )
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={`relative inline-flex h-5 w-9 shrink-0 mt-0.5 items-center rounded-full transition-colors ${
        checked ? 'bg-ink-strong' : 'bg-rule-strong'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        className={`inline-block size-4 rounded-full bg-surface shadow-sm transform transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </label>
  )
}

// ---------- PLUGIN DETAIL ----------

function PluginDetail({
  plugin,
  enabled,
  onToggle,
  onOpenAtom,
  onCopy,
}: {
  plugin: PluginInstance
  enabled: boolean
  onToggle: (v: boolean) => void
  onOpenAtom: (path: string) => void
  onCopy: () => void
}) {
  const kernelExists = plugin.kernel ? Boolean(KERNELS[plugin.kernel]) : true
  const [bodyOpen, setBodyOpen] = useState(false)
  const configString =
    plugin.config && Object.keys(plugin.config).length > 0
      ? JSON.stringify(plugin.config, null, 2)
      : null

  return (
    <article className="flex flex-col gap-6">
      {/* Hero — name, description, primary actions, status pill. */}
      <header className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] font-semibold text-ink-faint">
              Plugin
            </span>
            <span
              className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] font-semibold rounded-full px-2 py-0.5 ${
                enabled
                  ? 'bg-success/10 text-success'
                  : 'bg-panel text-ink-faint border border-rule'
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  enabled ? 'bg-success' : 'bg-ink-faint'
                }`}
              />
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
            {!kernelExists && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] font-semibold rounded-full bg-danger-soft text-danger px-2 py-0.5">
                Missing kernel
              </span>
            )}
          </div>
          <h1 className="text-[26px] font-semibold text-ink-strong tracking-tight leading-tight">
            {plugin.name}
          </h1>
          <p className="mt-2 text-[14px] text-ink-dim leading-relaxed max-w-prose">
            {plugin.description}
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-3 mt-1">
          <ToggleSwitch
            checked={enabled}
            disabled={!kernelExists}
            onChange={onToggle}
          />
          <span className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">
            {kernelExists ? 'Tap to toggle' : 'Install kernel'}
          </span>
        </div>
      </header>

      {/* Metadata grid */}
      <section className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-lg border border-rule bg-panel px-5 py-4">
        <Field label="Identifier" value={plugin.id} mono />
        <Field
          label="Source"
          value={plugin.path}
          mono
          action={
            <button
              onClick={() => onOpenAtom(plugin.path)}
              className="inline-flex items-center gap-1 text-[11px] text-ink-dim hover:text-ink transition-colors"
              title="Open source atom"
            >
              <PencilLine className="size-3" strokeWidth={2.2} />
              Edit
            </button>
          }
        />
        <Field
          label="Kernel"
          value={plugin.kernel || '—'}
          mono
        />
        <Field
          label="Handles"
          value={plugin.handles || '—'}
          mono
        />
        <Field
          label="Overlay"
          value={plugin.overlay ? 'Yes' : 'No'}
        />
        <Field
          label="Commands"
          value={String(plugin.commands.length)}
        />
      </section>

      {/* Commands list */}
      {plugin.commands.length > 0 && (
        <section>
          <SectionTitle icon={<Terminal className="size-3.5" strokeWidth={2} />}>
            Commands ({plugin.commands.length})
          </SectionTitle>
          <div className="flex flex-col gap-1.5 mt-2">
            {plugin.commands.map((c) => (
              <div
                key={c.id}
                className="rounded-md border border-rule bg-surface px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h4 className="text-[13px] font-medium text-ink-strong">
                    {c.title}
                  </h4>
                  {c.keybind && (
                    <kbd className="rounded border border-rule bg-panel px-1.5 py-0.5 text-[10px] font-mono text-ink-dim">
                      {c.keybind}
                    </kbd>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-ink-dim leading-relaxed line-clamp-2">
                  {c.prompt}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Config — pretty JSON, if any */}
      {configString && (
        <section>
          <SectionTitle>Configuration</SectionTitle>
          <pre className="mt-2 rounded-md border border-rule bg-panel px-4 py-3 text-[11.5px] font-mono text-ink leading-relaxed overflow-x-auto">
            {configString}
          </pre>
        </section>
      )}

      {/* Body — collapsed by default; long plugin bodies stay out of the way. */}
      {plugin.body.trim().length > 0 && (
        <section>
          <button
            onClick={() => setBodyOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-faint hover:text-ink transition-colors"
          >
            {bodyOpen ? (
              <ChevronDown className="size-3" strokeWidth={2.4} />
            ) : (
              <ChevronRight className="size-3" strokeWidth={2.4} />
            )}
            Source body ({plugin.body.length.toLocaleString()} chars)
          </button>
          {bodyOpen && (
            <pre className="mt-2 max-h-[420px] rounded-md border border-rule bg-panel px-4 py-3 text-[11.5px] font-mono text-ink leading-relaxed overflow-auto">
              {plugin.body}
            </pre>
          )}
        </section>
      )}

      {/* Footer actions */}
      <footer className="flex items-center gap-2 pt-2 border-t border-rule">
        <button
          onClick={() => onOpenAtom(plugin.path)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[12px] font-medium text-surface hover:bg-ink transition-colors"
        >
          <PencilLine className="size-3" strokeWidth={2.2} />
          Edit atom
        </button>
        <button
          onClick={onCopy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule bg-elevated px-3 text-[12px] text-ink-dim hover:text-ink hover:border-rule-strong transition-colors"
        >
          <Copy className="size-3" strokeWidth={2.2} />
          Copy atom
        </button>
        <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          ⎋ to go back
        </span>
      </footer>
    </article>
  )
}

function SectionTitle({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <h2 className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-faint">
      {icon}
      {children}
    </h2>
  )
}

function Field({
  label,
  value,
  mono,
  action,
}: {
  label: string
  value: string
  mono?: boolean
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-faint">
          {label}
        </span>
        {action}
      </div>
      <span
        className={`text-[12.5px] truncate ${
          mono ? 'font-mono text-ink' : 'text-ink-strong'
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

// ---------- CATALOG DETAIL ----------
// Shown when the user clicks a browse-tab card for a plugin they have
// not yet installed. Lighter than PluginDetail (catalog cards carry
// less metadata) but follows the same hero / metadata / footer rhythm
// so the two feel like one surface. Post-install, the same id resolves
// to the rich PluginDetail automatically.

function CatalogDetail({
  entry,
  installed,
  onInstall,
}: {
  entry: CatalogCard
  installed: boolean
  onInstall: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function handleInstall() {
    if (busy || installed) return
    setBusy(true)
    try {
      await onInstall()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] font-semibold text-ink-faint">
              Marketplace
            </span>
            <span className="text-[10px] uppercase tracking-[0.1em] font-semibold rounded-full border border-rule bg-panel text-ink-dim px-2 py-0.5">
              {entry.category}
            </span>
          </div>
          <h1 className="text-[26px] font-semibold text-ink-strong tracking-tight leading-tight">
            {entry.name}
          </h1>
          <p className="mt-2 text-[14px] text-ink-dim leading-relaxed max-w-prose">
            {entry.description}
          </p>
        </div>
        <button
          onClick={handleInstall}
          disabled={busy || installed}
          className="shrink-0 mt-1 inline-flex h-9 items-center gap-2 rounded-md bg-ink-strong px-4 text-[13px] font-medium text-surface hover:bg-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.2} />
              Installing…
            </>
          ) : installed ? (
            <>
              <Check className="size-3.5" strokeWidth={2.4} />
              Installed
            </>
          ) : (
            <>
              <Download className="size-3.5" strokeWidth={2.2} />
              Install
            </>
          )}
        </button>
      </header>

      <section className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-lg border border-rule bg-panel px-5 py-4">
        <Field label="Identifier" value={entry.id} mono />
        <Field label="Category" value={entry.category} />
        <Field label="Kernel" value={entry.kernel || '—'} mono />
        <Field
          label="Source"
          value={`plugins/${entry.id}.md`}
          mono
        />
      </section>

      <section className="rounded-lg border border-dashed border-rule bg-panel/40 px-5 py-4">
        <p className="text-[12.5px] text-ink-dim leading-relaxed">
          Installing copies a templated plugin atom into your workspace at{' '}
          <code className="font-mono text-[11.5px] bg-panel px-1.5 py-0.5 rounded border border-rule text-ink">
            plugins/{entry.id}.md
          </code>
          . You can edit it like any other page, and the agent can refine
          it after you ask. Re-installing overwrites the current atom.
        </p>
      </section>

      <footer className="flex items-center pt-2 border-t border-rule">
        <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          ⎋ to go back
        </span>
      </footer>
    </article>
  )
}

// ---------- BROWSE TAB ----------

function BrowseTab({
  installedIds,
  entries,
  categories,
  onInstall,
  onSelect,
}: {
  installedIds: Set<string>
  entries: CatalogCard[] | null
  categories: Array<CatalogCard['category']>
  onInstall: (entry: CatalogCard) => Promise<void>
  onSelect: (id: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<'All' | CatalogCard['category']>('All')

  const visible = useMemo(() => {
    if (!entries) return []
    const q = filter.toLowerCase().trim()
    return entries.filter(
      (e) =>
        (category === 'All' || e.category === category) &&
        (!q ||
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q)),
    )
  }, [filter, category, entries])

  if (!entries) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-faint py-8">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
        <span>Loading catalog…</span>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-3 mb-5">
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-faint"
            strokeWidth={2}
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search plugins…"
            className="w-full h-9 pl-9 pr-3 rounded-md border border-rule bg-surface text-[13px] text-ink placeholder:text-ink-faint focus:border-rule-strong outline-none"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <CategoryChip
            active={category === 'All'}
            onClick={() => setCategory('All')}
          >
            All
          </CategoryChip>
          {categories.map((c) => (
            <CategoryChip
              key={c}
              active={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
            </CategoryChip>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-[13px] text-ink-faint py-6">No plugins match.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {visible.map((entry) => {
            const installed = installedIds.has(entry.id)
            return (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(entry.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(entry.id)
                  }
                }}
                className="group flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4 cursor-pointer hover:border-rule-strong hover:bg-hover focus:outline-none focus-visible:border-ink transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[13.5px] font-semibold text-ink-strong tracking-tight">
                    {entry.name}
                  </h3>
                  <span className="text-[9.5px] uppercase tracking-[0.1em] font-semibold text-ink-faint px-1.5 py-0.5 rounded-full border border-rule">
                    {entry.category}
                  </span>
                </div>
                <p className="text-[12px] text-ink-dim leading-relaxed flex-1">
                  {entry.description}
                </p>
                <div className="flex items-center justify-between gap-2 mt-1">
                  {entry.kernel && (
                    <code className="text-[10.5px] font-mono text-ink-faint">
                      {entry.kernel}
                    </code>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {installed ? (
                      <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.1em] font-semibold text-success">
                        <Check className="size-3" strokeWidth={2.4} />
                        Installed
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void onInstall(entry)
                        }}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-2.5 text-[11.5px] font-medium text-surface hover:bg-ink transition-colors"
                      >
                        <Download className="size-3" strokeWidth={2.2} />
                        Install
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`h-7 px-2.5 rounded-full text-[11.5px] font-medium transition-colors ${
        active
          ? 'bg-ink-strong text-surface'
          : 'text-ink-dim border border-rule hover:text-ink hover:border-rule-strong'
      }`}
    >
      {children}
    </button>
  )
}

// ---------- IMPORT TAB ----------

function ImportTab({
  onInstalled,
  installed,
  setEnabled,
  upsertAtom,
}: {
  onInstalled: (path: string) => void
  installed: Set<string>
  setEnabled: (id: string) => Promise<unknown>
  upsertAtom: (args: {
    path: string
    body: string
    source?: string
  }) => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function install() {
    setErr(null)
    const { meta } = parseFrontmatter(text)
    if (meta.type !== 'plugin') {
      setErr('Not a plugin atom — needs `type: plugin` in frontmatter.')
      return
    }
    const id = typeof meta.id === 'string' ? meta.id : ''
    if (!id) {
      setErr('Plugin atom needs an `id` field.')
      return
    }
    setBusy(true)
    try {
      const path = `plugins/${id}.md`
      await upsertAtom({ path, body: text, source: 'user' })
      await setEnabled(id)
      onInstalled(path)
      setText('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const existingId = idFromText(text)
  const reinstalling = existingId && installed.has(existingId)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-dim leading-relaxed">
        Paste a full plugin atom (frontmatter + body). It'll be saved to{' '}
        <code className="font-mono text-[12px] bg-panel px-1.5 py-0.5 rounded border border-rule text-ink">
          plugins/&lt;id&gt;.md
        </code>{' '}
        and enabled. If a plugin with the same id is already installed, it'll
        be overwritten.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`---\ntype: plugin\nid: my-plugin\nname: My plugin\n…\n---\n\n…body…`}
        spellCheck={false}
        className="min-h-[280px] rounded-lg border border-rule bg-surface px-4 py-3 text-[12.5px] font-mono text-ink placeholder:text-ink-faint leading-relaxed focus:border-rule-strong outline-none resize-y"
      />
      {err && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          <X className="size-3.5 mt-0.5 shrink-0" strokeWidth={2.2} />
          <span>{err}</span>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => setText('')}
          disabled={!text || busy}
          className="inline-flex h-8 items-center rounded-md border border-rule bg-elevated px-3 text-[12px] text-ink-dim hover:text-ink hover:border-rule-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Clear
        </button>
        <button
          onClick={install}
          disabled={!text.trim() || busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[12px] font-medium text-surface hover:bg-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? (
            <>
              <Loader2 className="size-3 animate-spin" strokeWidth={2.2} />
              Installing…
            </>
          ) : (
            <>
              <Download className="size-3" strokeWidth={2.2} />
              {reinstalling ? 'Reinstall' : 'Install'}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function idFromText(text: string): string {
  if (!text.trim()) return ''
  try {
    const { meta } = parseFrontmatter(text)
    return typeof meta.id === 'string' ? meta.id : ''
  } catch {
    return ''
  }
}

// ---------- helpers ----------

function reconstructFullAtom(
  p: ReturnType<typeof usePlugins>['plugins'][number],
): string {
  const fm: Record<string, unknown> = {
    type: 'plugin',
    id: p.id,
    name: p.name,
    description: p.description,
    ...(p.handles ? { handles: p.handles } : {}),
    ...(p.kernel ? { kernel: p.kernel } : {}),
    ...(p.commands.length ? { commands: p.commands } : {}),
    ...(p.overlay ? { overlay: true } : {}),
    ...p.config,
  }
  const lines: string[] = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') {
      lines.push(`${k}: ${v}`)
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n') + p.body
}
