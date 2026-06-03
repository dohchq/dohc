import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Check,
  Lock,
  Plus,
  X,
  Copy,
  Download,
  Upload,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { CardStackSkeleton, Skeleton } from './Skeleton'

// Imports / Exports — controlled workspace-to-workspace data exchange.
// The backend still calls these "windows": a window is a scoped,
// consent-gated export, and a granted window appears to another
// workspace as an import. Per-document sharing is intentionally kept
// separate in ShareDialog.

type EntityItem = { ref: string; type: string; slug: string; keys: string[] }
type AtomItem = { kind: 'atom'; ref: string; key: string }
type OverviewWindow = {
  windowId: Id<'windows'>
  name: string
  grantees: string[]
  truncated: boolean
  entities: EntityItem[]
  atoms: AtomItem[]
}
type SharedWindow = {
  windowId: Id<'windows'>
  name: string
  ownerWorkspaceId: string
  view: Record<string, string | number | boolean> | null
}

const shortWs = (w: string) => (w.length > 14 ? `${w.slice(0, 12)}…` : w)

export function ImportsExportsPanel({
  onAskDohc,
}: {
  // Frame E / §3 + §5: the truncated state must DEFER to the agent
  // (the existing capable bulk path) — never a dead-end. App wires
  // this to open Chat with a pending prompt.
  onAskDohc: (prompt: string) => void
}) {
  const overview = useQuery(api.windows.consentOverview) as
    | OverviewWindow[]
    | undefined
  const sharedWithMe = useQuery(api.windows.windowsSharedWithMe) as
    | SharedWindow[]
    | undefined
  const myId = useQuery(api.windows.whoami) as string | undefined
  const [tab, setTab] = useState<'exports' | 'imports'>('exports')
  const [builderOpen, setBuilderOpen] = useState(false)

  // Standing glanceable summary (always present, even at zero).
  const summary = useMemo(() => {
    if (!overview) return null
    const exports = overview.length
    const waiting = overview.reduce(
      (n, w) => n + w.entities.length + w.atoms.length,
      0,
    )
    const importers = new Set(overview.flatMap((w) => w.grantees)).size
    return { exports, waiting, importers }
  }, [overview])

  const importCount = Array.isArray(sharedWithMe) ? sharedWithMe.length : null

  return (
    <div className="flex h-screen flex-col border-l border-rule bg-panel">
      <header className="shrink-0 border-b border-rule px-4 py-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold tracking-tight text-ink-strong">
            Imports / Exports
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <WorkflowChoice
            active={tab === 'exports'}
            Icon={Upload}
            title="Send fields"
            detail={
              summary
                ? `${summary.exports} exports · ${summary.waiting} waiting`
                : 'loading exports'
            }
            onClick={() => setTab('exports')}
          />
          <WorkflowChoice
            active={tab === 'imports'}
            Icon={Download}
            title="Receive fields"
            detail={
              importCount === null
                ? 'loading imports'
                : `${importCount} available`
            }
            onClick={() => setTab('imports')}
          />
        </div>
      </header>

      <WorkspaceIdStrip id={myId ?? null} summary={summary} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'exports' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-[13px] font-semibold text-ink-strong">
                  Send fields
                </h2>
                <p className="mt-0.5 text-[10.5px] text-ink-faint">
                  Field set, importer, review.
                </p>
              </div>
              <button
                onClick={() => setBuilderOpen((v) => !v)}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink"
              >
                <Plus className="size-3.5" strokeWidth={2.2} />
                {builderOpen ? 'Close' : 'Create export'}
              </button>
            </div>

            {builderOpen && (
              <ExportBuilder onClose={() => setBuilderOpen(false)} />
            )}

            {overview === undefined ? (
              <CardStackSkeleton cards={2} />
            ) : overview.length === 0 ? (
              !builderOpen && (
                <ExportsEmpty onCreate={() => setBuilderOpen(true)} />
              )
            ) : (
              <div className="flex flex-col gap-3">
                {overview.map((w) => (
                  <WindowCard
                    key={w.windowId}
                    w={w}
                    myId={myId ?? null}
                    onAskDohc={onAskDohc}
                  />
                ))}
              </div>
            )}
          </div>
        ) : sharedWithMe === undefined ? (
          <CardStackSkeleton cards={2} />
        ) : sharedWithMe.length === 0 ? (
          <ImportsEmpty myId={myId ?? null} />
        ) : (
          <div className="flex flex-col gap-3">
            {sharedWithMe.map((s) => (
              <ImportCard key={s.windowId} source={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function WorkflowChoice({
  active,
  Icon,
  title,
  detail,
  onClick,
}: {
  active: boolean
  Icon: typeof Upload
  title: string
  detail: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-0 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-rule-strong bg-surface text-ink shadow-xs'
          : 'border-rule bg-page text-ink-dim hover:border-rule-strong hover:text-ink'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
        <Icon className="size-3.5 shrink-0 text-accent" strokeWidth={2} />
        <span className="truncate">{title}</span>
      </span>
      <span className="mt-1 block truncate text-[10px] text-ink-faint">
        {detail}
      </span>
    </button>
  )
}

function WorkspaceIdStrip({
  id,
  summary,
}: {
  id: string | null
  summary: { exports: number; waiting: number; importers: number } | null
}) {
  return (
    <div className="shrink-0 border-b border-rule px-4 py-3">
      <div className="rounded-lg border border-rule bg-surface px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-ink-strong">
              My workspace ID
            </p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
              {id ?? 'loading...'}
            </p>
          </div>
          {id ? (
            <CopyId id={id} />
          ) : (
            <Skeleton className="h-7 w-24 rounded-md" />
          )}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <PanelStat label="exports" value={summary?.exports} />
        <PanelStat label="waiting" value={summary?.waiting} />
        <PanelStat label="importers" value={summary?.importers} />
      </div>
    </div>
  )
}

function PanelStat({
  label,
  value,
}: {
  label: string
  value: number | undefined
}) {
  return (
    <div className="rounded-md bg-page px-2 py-1.5">
      <div className="text-[13px] font-semibold tabular-nums text-ink-strong">
        {value ?? '—'}
      </div>
      <div className="mt-0.5 truncate text-[9px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </div>
    </div>
  )
}

function WindowCard({
  w,
  myId,
  onAskDohc,
}: {
  w: OverviewWindow
  myId: string | null
  onAskDohc: (prompt: string) => void
}) {
  const confirmWithheld = useMutation(api.windows.confirmWithheldFor)
  const rejectKey = useMutation(api.captures.rejectKey)
  const grant = useMutation(api.windows.grant)
  const revoke = useMutation(api.windows.revoke)
  const [seenAsOpen, setSeenAsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // P3 grant/revoke (Frame J/L). Client pre-checks mirror the
  // engine-enforced invariants (self-grant / ≥1, etc.) so they read
  // as calm messages, never an uncaught throw — the engine is still
  // the real backstop.
  const [grantId, setGrantId] = useState('')
  const [grantBusy, setGrantBusy] = useState(false)
  const [grantMsg, setGrantMsg] = useState<string | null>(null)

  const doGrant = useCallback(async () => {
    const id = grantId.trim()
    if (!id) return
    if (myId && id === myId) {
      setGrantMsg("that's you — grant to someone else")
      return
    }
    if (w.grantees.includes(id)) {
      setGrantMsg('already granted to that workspace')
      return
    }
    setGrantBusy(true)
    setGrantMsg(null)
    try {
      await grant({ windowId: w.windowId, viewerWorkspaceId: id })
      setGrantId('')
      setGrantMsg(
        'Granted. The import preview below is the source of truth: approved fields cross now; everything else waits here.',
      )
    } catch {
      setGrantMsg('Could not grant — check the id and try again.')
    } finally {
      setGrantBusy(false)
    }
  }, [grant, grantId, myId, w.grantees, w.windowId])

  const doRevoke = useCallback(
    async (viewer: string) => {
      try {
        await revoke({ windowId: w.windowId, viewerWorkspaceId: viewer })
      } catch {
        setGrantMsg('Could not revoke — try again.')
      }
    },
    [revoke, w.windowId],
  )
  // Fold B (subagent LOW): a row the user kept private is still in
  // the withheld set (`rejected` is still withheld — honest), but it
  // must read as DONE, not still-actionable. Optimistic local mark;
  // the backend stays the source of truth (re-rejecting is an
  // idempotent no-op, and "Export these" honestly reports it blocked).
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set())

  // Every withheld (ref·key) as a stable row, split kept vs pending.
  const allRows = [
    ...w.entities.flatMap((e) =>
      e.keys.map((k) => ({
        id: `e:${e.ref}:${k}`,
        kind: 'entity' as const,
        ref: e.ref,
        key: k,
      })),
    ),
    ...w.atoms.map((a) => ({
      id: `a:${a.ref}:${a.key}`,
      kind: 'atom' as const,
      ref: a.ref,
      key: a.key,
    })),
  ]
  const pendingRows = allRows.filter((r) => !kept.has(r.id))
  const keptRows = allRows.filter((r) => kept.has(r.id))
  const nWithheld = allRows.length
  const nPending = pendingRows.length

  const shareAll = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await confirmWithheld({ windowId: w.windowId })
      if (!r.ok) {
        setNote(
          r.reason === 'too-many-to-enumerate'
            ? 'Too many to export at once — ask dohc to help clear this.'
            : "This isn't your export.",
        )
      } else {
        const exported = r.sharedRefs.length + r.sharedAtoms.length
        const blocked = r.blockedRefs.length + r.blockedAtoms.length
        setNote(
          blocked > 0
            ? `Exported ${exported} · kept back ${blocked} (you marked these private)`
            : `Exported ${exported} value${exported === 1 ? '' : 's'}`,
        )
      }
    } catch {
      setNote('Something went wrong — nothing crossed. Try again.')
    } finally {
      setBusy(false)
    }
  }, [confirmWithheld, w.windowId])

  const keepPrivate = useCallback(
    async (id: string, kind: 'entity' | 'atom', ref: string, key: string) => {
      try {
        await rejectKey({ kind, ref, key })
        setKept((s) => new Set(s).add(id))
      } catch {
        setNote('Could not keep that private — try again.')
      }
    },
    [rejectKey],
  )

  return (
    <div className="rounded-lg border border-rule bg-surface px-3.5 py-3 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-ink-strong">
          <Upload className="size-3.5 text-accent" strokeWidth={2} />
          <span className="truncate">{w.name}</span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            w.grantees.length === 0
              ? 'bg-page text-ink-faint'
              : 'bg-page text-success'
          }`}
        >
          {w.grantees.length === 0
            ? 'not shared'
            : `${w.grantees.length} importer${w.grantees.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <section className="mt-3 border-t border-rule pt-3">
        <SectionTitle title="Who can import" />
        <div className="mt-2 flex flex-col gap-1">
          {w.grantees.length === 0 ? (
            <p className="rounded-md bg-page px-2 py-1.5 text-[10.5px] text-ink-faint">
              No workspace has access yet.
            </p>
          ) : (
            w.grantees.map((g) => (
              <div
                key={g}
                className="flex items-center justify-between gap-2 rounded-md bg-page px-2 py-1"
              >
                <span className="truncate font-mono text-[10.5px] text-ink-dim">
                  {shortWs(g)}
                </span>
                <button
                  onClick={() => doRevoke(g)}
                  title="revoke this import"
                  className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-ink-faint transition-colors hover:text-danger"
                >
                  <X className="size-3" strokeWidth={2.4} />
                  revoke
                </button>
              </div>
            ))
          )}
          <div className="flex items-center gap-1.5">
            <input
              value={grantId}
              onChange={(e) => {
                setGrantId(e.target.value)
                setGrantMsg(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doGrant()
              }}
              placeholder="workspace ID to grant"
              className="min-w-0 flex-1 rounded-md border border-rule bg-page px-2 py-1 font-mono text-[10.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-rule-strong"
            />
            <button
              onClick={doGrant}
              disabled={grantBusy || !grantId.trim()}
              className="inline-flex h-7 shrink-0 items-center rounded-md bg-ink-strong px-2.5 text-[10.5px] font-medium text-surface transition-colors hover:bg-ink disabled:opacity-50"
            >
              {grantBusy ? '…' : 'Grant access'}
            </button>
          </div>
          {grantMsg && (
            <p className="text-[10.5px] text-ink-faint">{grantMsg}</p>
          )}
        </div>
      </section>

      <section className="mt-3 border-t border-rule pt-3">
        <SectionTitle title="Review waiting values" />
        {w.truncated ? (
          // Frame E — fail-closed, honest, and NEVER a dead-end: the
          // copy is explicit AND defers to dohc (the existing capable
          // bulk path) via the standard pending-prompt → Chat handoff.
          <div className="mt-2 rounded-md bg-danger-soft px-2.5 py-2">
            <p className="text-[11px] leading-relaxed text-danger">
              Too many waiting values to list safely.
            </p>
            <button
              onClick={() =>
                onAskDohc(
                  `The "${w.name}" export has too many unreviewed ` +
                    `values to review here. Walk me through what is ` +
                    `waiting to export and help me clear it.`,
                )
              }
              className="mt-1.5 inline-flex h-7 items-center gap-1 rounded-md bg-danger px-2.5 text-[11px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              Ask dohc to clear this
            </button>
          </div>
        ) : nWithheld === 0 ? (
          // Frame C — nothing waiting
          <p className="mt-2 flex items-center gap-1.5 rounded-md bg-page px-2 py-1.5 text-[11px] text-success">
            <Check className="size-3.5" strokeWidth={2.4} />
            all selected fields are approved
          </p>
        ) : (
          // Frame D — the batched, non-blocking digest
          <div className="mt-2">
            <p className="text-[11px] text-ink-dim">
              <span className="font-medium text-ink">{nWithheld}</span> value
              {nWithheld === 1 ? '' : 's'} waiting for this export.
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {pendingRows.map((r) => (
                <DigestRow
                  key={r.id}
                  label={`${r.ref} · ${r.key}`}
                  onKeepPrivate={() => keepPrivate(r.id, r.kind, r.ref, r.key)}
                />
              ))}
              {keptRows.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-1.5 rounded-md bg-page px-2 py-1 text-[10.5px] text-ink-faint"
                >
                  <Lock className="size-3 text-success" strokeWidth={2.2} />
                  <span className="truncate font-mono">
                    {r.ref} · {r.key}
                  </span>
                  <span className="ml-auto shrink-0 text-success">
                    kept private
                  </span>
                </li>
              ))}
            </ul>
            {nPending > 0 ? (
              <button
                onClick={shareAll}
                disabled={busy}
                className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink disabled:opacity-50"
              >
                {busy
                  ? 'exporting…'
                  : `Export ${nPending} value${nPending === 1 ? '' : 's'}`}
              </button>
            ) : (
              <p className="mt-2.5 text-[11px] text-ink-faint">
                all kept private
              </p>
            )}
          </div>
        )}
      </section>

      {note && (
        <p className="mt-2 text-[11px] font-medium text-ink-dim">{note}</p>
      )}

      {/* Preview the consequence, not the rule. */}
      {!w.truncated && (
        <section className="mt-3 border-t border-rule pt-3">
          <button
            onClick={() => setSeenAsOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left text-[11px] font-semibold text-ink-dim transition-colors hover:text-ink"
          >
            <span>Recipient preview</span>
            {seenAsOpen ? (
              <ChevronDown className="size-3.5" strokeWidth={2.2} />
            ) : (
              <ChevronRight className="size-3.5" strokeWidth={2.2} />
            )}
          </button>
          {seenAsOpen && <SeenAs windowId={w.windowId} />}
        </section>
      )}
    </div>
  )
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {title}
      </h3>
    </div>
  )
}

function DigestRow({
  label,
  onKeepPrivate,
}: {
  label: string
  onKeepPrivate: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-page px-2 py-1">
      <span className="truncate font-mono text-[10.5px] text-ink-dim">
        {label}
      </span>
      <button
        onClick={onKeepPrivate}
        title="keep this value private (permanent)"
        className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-faint hover:text-danger transition-colors"
      >
        <Lock className="size-3" strokeWidth={2} />
        keep private
      </button>
    </li>
  )
}

function SeenAs({ windowId }: { windowId: Id<'windows'> }) {
  // Lazy: only queries when the disclosure is open (this subtree
  // unmounts when collapsed). previewWindow == exactly what a granted
  // viewer gets — never more (server-enforced, design §4.3).
  const preview = useQuery(api.windows.previewWindow, { windowId })
  if (preview === undefined)
    return <Skeleton className="mt-2 h-2.5 w-24 rounded-full" />
  if (!preview.ok)
    return (
      <p className="mt-1.5 text-[10.5px] text-ink-faint">
        nothing crosses yet — approve fields above to see this fill in.
      </p>
    )
  return <ViewBlock view={preview.view} />
}

function ViewBlock({
  view,
}: {
  view: Record<string, string | number | boolean> | null
}) {
  if (!view || Object.keys(view).length === 0)
    return (
      <p className="mt-1 text-[10.5px] text-ink-faint">
        (nothing — every value is still private)
      </p>
    )
  return (
    <pre className="mt-1 overflow-x-auto rounded-md bg-page px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-dim">
      {Object.entries(view)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n')}
    </pre>
  )
}

function ImportCard({ source }: { source: SharedWindow }) {
  return (
    <div className="rounded-lg border border-rule bg-surface px-3.5 py-3 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-ink-strong">
          <Download className="size-3.5 text-accent" strokeWidth={2} />
          <span className="truncate">{source.name}</span>
        </span>
        <span className="shrink-0 rounded-full bg-page px-2 py-0.5 text-[10px] font-medium text-ink-faint">
          from {shortWs(source.ownerWorkspaceId)}
        </span>
      </div>
      <div className="mt-3 border-t border-rule pt-3">
        <SectionTitle title="Fields received" />
        <ViewBlock view={source.view} />
      </div>
    </div>
  )
}

function ExportsEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-rule bg-surface px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-page text-accent">
          <Upload className="size-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink-strong">
            Create a field set first
          </p>
          <div className="mt-2 grid gap-1.5 text-[11px] text-ink-dim">
            <StepLine index={1} text="choose fields" />
            <StepLine index={2} text="grant a workspace ID" />
            <StepLine index={3} text="approve waiting values" />
          </div>
          <button
            onClick={onCreate}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink"
          >
            <Plus className="size-3.5" strokeWidth={2.2} />
            Create export
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportsEmpty({ myId }: { myId: string | null }) {
  return (
    <div className="rounded-lg border border-rule bg-surface px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-page text-accent">
          <Download className="size-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink-strong">
            Give your ID to the sender
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Their grant will appear here as received fields.
          </p>
          <div className="mt-3">
            {myId ? (
              <CopyId id={myId} />
            ) : (
              <Skeleton className="h-8 w-32 rounded-md" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StepLine({ index, text }: { index: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-page text-[9px] font-semibold text-ink-faint">
        {index}
      </span>
      <span>{text}</span>
    </div>
  )
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        if (!navigator.clipboard?.writeText) return
        try {
          await navigator.clipboard.writeText(id)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard unavailable or permission denied */
        }
      }}
      title={`workspace id for imports/exports: ${id}`}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule bg-page px-2.5 text-[10.5px] font-medium text-ink-dim transition-colors hover:border-rule-strong hover:text-ink"
    >
      <Copy className="size-3" strokeWidth={2} />
      {done ? 'Copied' : 'My workspace ID'}
    </button>
  )
}

// Inline export builder. createWindow validates at least one key
// server-side; Create is also disabled client-side for a calmer UI.
function ExportBuilder({ onClose }: { onClose: () => void }) {
  const ak = useQuery(api.windows.availableKeys) as
    | { keys: string[]; truncated: boolean }
    | undefined
  const createWindow = useMutation(api.windows.createWindow)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [aggKey, setAggKey] = useState('')
  const [aggOp, setAggOp] = useState<'sum' | 'count'>('sum')
  const [aggAs, setAggAs] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggle = (k: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  if (ak === undefined)
    return (
      <div className="rounded-lg border border-rule bg-surface p-3">
        <CardStackSkeleton cards={2} />
      </div>
    )

  // Nothing exportable yet (not a blank picker / dead-end)
  if (ak.keys.length === 0)
    return (
      <div className="rounded-lg border border-rule bg-surface px-3.5 py-4 shadow-xs">
        <p className="text-[13px] font-semibold text-ink-strong">
          No captured fields yet
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Fields from documents and entities will appear here once dohc has
          captured them.
        </p>
        <button
          onClick={onClose}
          className="mt-2 text-[11px] font-medium text-ink hover:underline"
        >
          ok
        </button>
      </div>
    )

  const canCreate = !!name.trim() && picked.size > 0 && !busy

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setErr(null)
    try {
      const rename: Record<string, string> = {}
      for (const k of picked) {
        const r = renames[k]?.trim()
        if (r) rename[k] = r
      }
      const aggregate =
        aggKey && picked.has(aggKey) && aggAs.trim()
          ? { key: aggKey, op: aggOp, as: aggAs.trim() }
          : undefined
      await createWindow({
        name: name.trim(),
        selectorKeys: [...picked],
        rename: Object.keys(rename).length ? rename : undefined,
        aggregate,
      })
      onClose() // it now appears as an export card (reactive)
    } catch {
      setErr('Could not create the export — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-rule bg-surface px-3.5 py-3 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink-strong">
            Create export
          </p>
          <p className="mt-0.5 text-[10.5px] text-ink-faint">
            A named field set you can grant later.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
        >
          cancel
        </button>
      </div>

      <label className="block">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Export name
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client hours"
          className="mt-1 w-full rounded-md border border-rule bg-page px-2.5 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-rule-strong"
        />
      </label>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Choose fields
          </p>
          <span className="text-[10px] text-ink-faint">
            {picked.size} selected
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {ak.keys.map((k) => {
            const on = picked.has(k)
            return (
              <button
                key={k}
                onClick={() => toggle(k)}
                className={`rounded-md px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                  on
                    ? 'bg-ink-strong text-surface'
                    : 'border border-rule bg-page text-ink-dim hover:border-rule-strong'
                }`}
              >
                {k}
              </button>
            )
          })}
        </div>
        {ak.truncated && (
          <p className="mt-1 text-[10px] text-ink-faint">
            showing the first batch — refine on your desk if a value is missing.
          </p>
        )}
      </div>

      {picked.size > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-ink-faint hover:text-ink-dim">
            Optional field labels and totals
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {[...picked].map((k) => (
              <div key={k} className="flex items-center gap-1.5">
                <span className="w-20 shrink-0 truncate font-mono text-[10.5px] text-ink-dim">
                  {k}
                </span>
                <span className="text-ink-faint">→</span>
                <input
                  value={renames[k] ?? ''}
                  onChange={(e) =>
                    setRenames((r) => ({ ...r, [k]: e.target.value }))
                  }
                  placeholder={`${k} (unchanged)`}
                  className="min-w-0 flex-1 rounded-md border border-rule bg-page px-2 py-0.5 text-[10.5px] text-ink placeholder:text-ink-faint outline-none focus:border-rule-strong"
                />
              </div>
            ))}
            <div className="mt-1 flex items-center gap-1.5">
              <select
                value={aggKey}
                onChange={(e) => setAggKey(e.target.value)}
                className="rounded-md border border-rule bg-page px-1.5 py-0.5 text-[10.5px] text-ink-dim outline-none"
              >
                <option value="">no total</option>
                {[...picked].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              {aggKey && (
                <>
                  <select
                    value={aggOp}
                    onChange={(e) =>
                      setAggOp(e.target.value as 'sum' | 'count')
                    }
                    className="rounded-md border border-rule bg-page px-1.5 py-0.5 text-[10.5px] text-ink-dim outline-none"
                  >
                    <option value="sum">sum</option>
                    <option value="count">count</option>
                  </select>
                  <span className="text-ink-faint">as</span>
                  <input
                    value={aggAs}
                    onChange={(e) => setAggAs(e.target.value)}
                    placeholder="total"
                    className="min-w-0 flex-1 rounded-md border border-rule bg-page px-2 py-0.5 text-[10.5px] text-ink outline-none focus:border-rule-strong"
                  />
                </>
              )}
            </div>
          </div>
        </details>
      )}

      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-faint">
          Grant access after creating.
        </span>
        <button
          onClick={create}
          disabled={!canCreate}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface hover:bg-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'creating…' : 'Create export'}
        </button>
      </div>
    </div>
  )
}
