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
  const sharedWithMe = useQuery(api.windows.windowsSharedWithMe)
  const myId = useQuery(api.windows.whoami)
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

  return (
    <div className="flex h-screen flex-col border-l border-rule bg-panel">
      <header className="shrink-0 border-b border-rule px-5 py-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold tracking-tight text-ink-strong">
            Imports / Exports
          </span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-dim">
          Exports publish only the fields you choose from this workspace.
          Imports are fields another workspace exposes to you. Document
          sharing is still handled from a document's Share button.
        </p>
      </header>

      <div className="shrink-0 border-b border-rule px-5 py-3">
        {summary && (
          <div className="grid grid-cols-3 gap-2">
            <Metric label="exports" value={summary.exports} />
            <Metric label="waiting" value={summary.waiting} />
            <Metric label="importers" value={summary.importers} />
          </div>
        )}
        <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
          Nothing crosses until an export exists, a workspace is granted,
          and you approve any newly captured values for that export.
        </p>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-rule px-3 py-2">
        {(
          [
            ['exports', 'Exports'],
            ['imports', 'Imports'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              tab === k
                ? 'bg-surface text-ink shadow-xs'
                : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'exports' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setBuilderOpen((v) => !v)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 text-[11.5px] font-medium text-ink-dim hover:border-rule-strong hover:text-ink transition-colors"
              >
                <Plus className="size-3.5" strokeWidth={2.2} />
                {builderOpen ? 'Close' : 'New export'}
              </button>
              {myId && <CopyId id={myId} />}
            </div>

            {builderOpen && (
              <ExportBuilder onClose={() => setBuilderOpen(false)} />
            )}

            {overview === undefined ? (
              <CardStackSkeleton cards={2} />
            ) : overview.length === 0 ? (
              // Frame B — no windows yet (discoverable, not a dead-end)
              !builderOpen && (
                <Empty
                  title="No exports yet."
                  body="Create an export when another workspace should receive specific fields from yours. It is closer to a tiny API than document sharing."
                />
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
          <Empty
            title="No imports yet."
            body="When another workspace grants you an export, the imported fields appear here exactly as exposed — nothing else."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {sharedWithMe.map((s) => (
              <div
                key={s.windowId}
                className="rounded-lg border border-rule bg-surface px-3.5 py-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-ink-strong">
                    {s.name}
                  </span>
                  <span className="text-[10px] text-ink-faint">
                    imported from {shortWs(s.ownerWorkspaceId)}
                  </span>
                </div>
                <p className="mt-1 flex items-center gap-1 text-[10.5px] text-ink-faint">
                  <Download className="size-3" strokeWidth={2} />
                  fields available to this workspace
                </p>
                <ViewBlock view={s.view} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-rule bg-surface px-2.5 py-2">
      <div className="text-[15px] font-semibold tabular-nums text-ink-strong">
        {value}
      </div>
      <div className="mt-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">
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
    async (
      id: string,
      kind: 'entity' | 'atom',
      ref: string,
      key: string,
    ) => {
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
    <div className="rounded-lg border border-rule bg-surface px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-ink-strong">
          <Upload className="size-3 text-accent" strokeWidth={2} />
          <span className="truncate">{w.name}</span>
        </span>
        <span className="shrink-0 text-[10px] text-ink-faint">
          {w.grantees.length === 0
            ? 'not granted yet'
            : `granted to ${w.grantees.length}`}
        </span>
      </div>

      {/* Grant / revoke, in-product */}
      <div className="mt-1.5 flex flex-col gap-1">
        {w.grantees.map((g) => (
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
              className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-ink-faint hover:text-danger transition-colors"
            >
              <X className="size-3" strokeWidth={2.4} />
              revoke
            </button>
          </div>
        ))}
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
            placeholder="paste importer workspace id…"
            className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-2 py-1 font-mono text-[10.5px] text-ink placeholder:text-ink-faint outline-none focus:border-rule-strong transition-colors"
          />
          <button
            onClick={doGrant}
            disabled={grantBusy || !grantId.trim()}
            className="inline-flex h-6 shrink-0 items-center rounded-md bg-ink-strong px-2.5 text-[10.5px] font-medium text-surface hover:bg-ink disabled:opacity-50 transition-colors"
          >
            {grantBusy ? '…' : 'Grant'}
          </button>
        </div>
        {grantMsg && (
          <p className="text-[10.5px] text-ink-faint">{grantMsg}</p>
        )}
        <p className="text-[10px] leading-relaxed text-ink-faint">
          They copy their workspace id from this panel. Granting creates
          their import. Already approved fields cross immediately; new
          captured fields wait here until you approve them for this export.
        </p>
      </div>

      {w.truncated ? (
        // Frame E — fail-closed, honest, and NEVER a dead-end: the
        // copy is explicit AND defers to dohc (the existing capable
        // bulk path) via the standard pending-prompt → Chat handoff.
        <div className="mt-2 rounded-md bg-danger-soft px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-danger">
            Too many waiting values to list safely — this export is paused
            until you review it.
          </p>
          <button
            onClick={() =>
              onAskDohc(
                `The "${w.name}" export has too many unreviewed ` +
                  `values to review here. Walk me through what is ` +
                  `waiting to export and help me clear it.`,
              )
            }
            className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-md bg-danger px-2.5 text-[11px] font-medium text-surface hover:opacity-90 transition-opacity"
          >
            Ask dohc to clear this
          </button>
        </div>
      ) : nWithheld === 0 ? (
        // Frame C — nothing waiting
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-success">
          <Check className="size-3.5" strokeWidth={2.4} />
          all selected fields are approved; nothing waiting.
        </p>
      ) : (
        // Frame D — the batched, non-blocking digest
        <div className="mt-2">
          <p className="text-[11px] text-ink-dim">
            dohc captured{' '}
            <span className="font-medium text-ink">{nWithheld}</span> value
            {nWithheld === 1 ? '' : 's'} this export would expose.
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {pendingRows.map((r) => (
              <DigestRow
                key={r.id}
                label={`${r.ref} · ${r.key}`}
                onKeepPrivate={() =>
                  keepPrivate(r.id, r.kind, r.ref, r.key)
                }
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
              className="mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface hover:bg-ink disabled:opacity-50 transition-colors"
            >
              {busy ? 'exporting…' : `Export these ${nPending}`}
            </button>
          ) : (
            <p className="mt-2.5 text-[11px] text-ink-faint">
              all kept private — nothing will cross this export.
            </p>
          )}
        </div>
      )}

      {note && (
        <p className="mt-2 text-[11px] font-medium text-ink-dim">{note}</p>
      )}

      {/* Preview the consequence, not the rule. */}
      {!w.truncated && (
        <div className="mt-2.5 border-t border-rule pt-2">
          <button
            onClick={() => setSeenAsOpen((v) => !v)}
            className="flex items-center gap-1 text-[10.5px] font-medium text-ink-faint hover:text-ink-dim transition-colors"
          >
            {seenAsOpen ? (
              <ChevronDown className="size-3" strokeWidth={2.2} />
            ) : (
              <ChevronRight className="size-3" strokeWidth={2.2} />
            )}
            Preview import — what the other workspace gets
          </button>
          {seenAsOpen && <SeenAs windowId={w.windowId} />}
        </div>
      )}
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

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-10 max-w-[260px] text-center">
      <p className="text-[12.5px] font-medium text-ink-dim">{title}</p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
        {body}
      </p>
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
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-rule bg-surface px-2 text-[10.5px] font-medium text-ink-faint hover:border-rule-strong hover:text-ink-dim transition-colors"
    >
      <Copy className="size-3" strokeWidth={2} />
      {done ? 'copied' : 'workspace id'}
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
      <div className="rounded-lg border border-rule bg-surface px-3.5 py-4">
        <p className="text-[12px] font-medium text-ink-dim">
          Nothing exportable yet
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Exports use captured fields from your workspace. Do a little
          work with dohc first — the fields you create show up here.
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
    <div className="flex flex-col gap-2.5 rounded-lg border border-rule bg-surface px-3.5 py-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="export name (e.g. “hours for my manager”)"
        className="rounded-md border border-rule bg-page px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint outline-none focus:border-rule-strong transition-colors"
      />
      <div>
        <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          values it exposes {picked.size > 0 && `· ${picked.size}`}
        </p>
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
            showing the first batch — refine on your desk if a value is
            missing.
          </p>
        )}
      </div>

      {picked.size > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-ink-faint hover:text-ink-dim">
            rename or summarise (optional)
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
        <button
          onClick={onClose}
          className="text-[11px] text-ink-faint hover:text-ink-dim transition-colors"
        >
          cancel
        </button>
        <button
          onClick={create}
          disabled={!canCreate}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[11.5px] font-medium text-surface hover:bg-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'creating…' : 'Create export'}
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-ink-faint">
        Creating exports nothing by itself. You then grant a workspace and
        approve exactly which fields cross.
      </p>
    </div>
  )
}
