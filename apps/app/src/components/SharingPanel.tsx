import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import {
  Shield,
  ChevronDown,
  ChevronRight,
  Check,
  Lock,
  Plus,
  X,
  Copy,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

// P2 — reviewed-by-default, made visible (the consent surface).
// Design: docs/strategy/consent-surface-design.md (gate CLEARED v1).
// This is a PULL surface (D5): the owner opens it on their own
// schedule. No blocking modal, no per-atom interstitial. It only
// SHOWS the consequence (D4) and offers a batched, non-blocking
// share. Every read/write is the public wrapper over the locked
// engine — the surface cannot desync from the gate.

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

export function SharingPanel({
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
  const [tab, setTab] = useState<'mine' | 'onme'>('mine')
  const [builderOpen, setBuilderOpen] = useState(false)

  // D9 standing glanceable summary (always present, even at zero —
  // the surface is discoverable BEFORE the first share, so consent
  // never feels retrofitted / like surveillance).
  const summary = useMemo(() => {
    if (!overview) return null
    const windows = overview.length
    const waiting = overview.reduce(
      (n, w) => n + w.entities.length + w.atoms.length,
      0,
    )
    const viewers = new Set(overview.flatMap((w) => w.grantees)).size
    return { windows, waiting, viewers }
  }, [overview])

  return (
    <div className="flex h-screen flex-col border-l border-rule bg-panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-5">
        <Shield className="size-3.5 text-ink-dim" strokeWidth={2} />
        <span className="text-[12.5px] font-semibold tracking-tight text-ink-strong">
          Sharing
        </span>
      </header>

      {/* Frame A — the never-invisible header / standing summary */}
      <div className="shrink-0 border-b border-rule px-5 py-3">
        <p className="text-[11.5px] leading-relaxed text-ink-dim">
          dohc captures as you work.{' '}
          <span className="text-ink">Nothing is shared until you say so.</span>
        </p>
        {summary && (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {summary.waiting > 0 ? (
              <span className="font-medium text-ink-dim">
                {summary.waiting} value{summary.waiting === 1 ? '' : 's'}
              </span>
            ) : (
              'nothing'
            )}{' '}
            waiting across {summary.windows} window
            {summary.windows === 1 ? '' : 's'} · {summary.viewers} pe
            {summary.viewers === 1 ? 'rson' : 'ople'} with windows on your
            desk
          </p>
        )}
      </div>

      <div className="flex shrink-0 gap-1 border-b border-rule px-3 py-2">
        {(
          [
            ['mine', 'My windows'],
            ['onme', 'Windows on me'],
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
        {tab === 'mine' ? (
          <div className="flex flex-col gap-3">
            {/* P3 — create + the reciprocal "your id to share" */}
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setBuilderOpen((v) => !v)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 text-[11.5px] font-medium text-ink-dim hover:border-rule-strong hover:text-ink transition-colors"
              >
                <Plus className="size-3.5" strokeWidth={2.2} />
                {builderOpen ? 'Close' : 'New window'}
              </button>
              {myId && <CopyId id={myId} />}
            </div>

            {builderOpen && (
              <WindowBuilder onClose={() => setBuilderOpen(false)} />
            )}

            {overview === undefined ? (
              <Skeleton />
            ) : overview.length === 0 ? (
              // Frame B — no windows yet (discoverable, not a dead-end)
              !builderOpen && (
                <Empty
                  title="You haven't created a window yet."
                  body="A window shares specific values from your work with one person. Click ＋ New window to make one — nothing leaves your desk until you grant it and review what crosses."
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
          <Skeleton />
        ) : sharedWithMe.length === 0 ? (
          <Empty
            title="No one has shared a window with you."
            body="When someone grants you a window, exactly what you can see appears here — nothing more."
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
                    from {shortWs(s.ownerWorkspaceId)}
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] text-ink-faint">
                  exactly what you receive:
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
      setGrantMsg('already shared with them')
      return
    }
    setGrantBusy(true)
    setGrantMsg(null)
    try {
      await grant({ windowId: w.windowId, viewerWorkspaceId: id })
      setGrantId('')
      setGrantMsg(
        'Granted. What they actually see is the “Seen as” below — ' +
          'already-shared values cross now; the rest waits for your review.',
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
  // idempotent no-op, and "Share these" honestly reports it blocked).
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
            ? 'Too many to share at once — ask dohc to help clear this.'
            : "This isn't your window.",
        )
      } else {
        const shared = r.sharedRefs.length + r.sharedAtoms.length
        const blocked = r.blockedRefs.length + r.blockedAtoms.length
        setNote(
          blocked > 0
            ? `Shared ${shared} · kept back ${blocked} (you marked these private)`
            : `Shared ${shared} value${shared === 1 ? '' : 's'} →`,
        )
      }
    } catch {
      setNote('Something went wrong — nothing was shared. Try again.')
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
        <span className="text-[12px] font-semibold text-ink-strong">
          {w.name}
        </span>
        <span className="shrink-0 text-[10px] text-ink-faint">
          {w.grantees.length === 0
            ? 'not shared with anyone yet'
            : `shared with ${w.grantees.length}`}
        </span>
      </div>

      {/* P3 Frame J/L — grant / revoke, in-product */}
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
              title="revoke access (immediate, total)"
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
            placeholder="paste a person's workspace id…"
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
          They give you their id from the "your id" line at the top of
          their own Sharing panel. After granting, what they actually
          see is the digest / “Seen as” below — already-shared values
          cross at once; the rest waits for your review.
        </p>
      </div>

      {w.truncated ? (
        // Frame E — fail-closed, honest, and NEVER a dead-end: the
        // copy is explicit AND defers to dohc (the existing capable
        // bulk path) via the standard pending-prompt → Chat handoff.
        <div className="mt-2 rounded-md bg-danger-soft px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-danger">
            Too many unreviewed values to list safely — this window is
            paused for everyone until you review it.
          </p>
          <button
            onClick={() =>
              onAskDohc(
                `The "${w.name}" window has too many unreviewed ` +
                  `values to review here. Walk me through what's ` +
                  `waiting to share for it and help me clear it.`,
              )
            }
            className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-md bg-danger px-2.5 text-[11px] font-medium text-surface hover:opacity-90 transition-opacity"
          >
            Ask dohc to clear this →
          </button>
        </div>
      ) : nWithheld === 0 ? (
        // Frame C — nothing waiting
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-success">
          <Check className="size-3.5" strokeWidth={2.4} />
          everything you've chosen is shared; nothing waiting.
        </p>
      ) : (
        // Frame D — the batched, non-blocking digest
        <div className="mt-2">
          <p className="text-[11px] text-ink-dim">
            dohc captured{' '}
            <span className="font-medium text-ink">{nWithheld}</span> value
            {nWithheld === 1 ? '' : 's'} this window would show.
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
              {busy ? 'sharing…' : `Share these ${nPending}`}
            </button>
          ) : (
            <p className="mt-2.5 text-[11px] text-ink-faint">
              all kept private — nothing will cross this window.
            </p>
          )}
        </div>
      )}

      {note && (
        <p className="mt-2 text-[11px] font-medium text-ink-dim">{note}</p>
      )}

      {/* D4 "Seen as:" — the consequence, not the rule */}
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
            Seen as — what a viewer actually gets
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
    return <p className="mt-1.5 text-[10.5px] text-ink-faint">…</p>
  if (!preview.ok)
    return (
      <p className="mt-1.5 text-[10.5px] text-ink-faint">
        nothing crosses yet — share values above to see this fill in.
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

function Skeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-lg border border-rule bg-surface"
        />
      ))}
    </div>
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

// P3 — the reciprocal of granting: to be windowed in, you hand
// someone this id. whoami returns ONLY your own id (inert: only a
// window's own owner can grant it).
function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(id)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard unavailable — the id is still visible on hover */
        }
      }}
      title={`your id to share: ${id}`}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-rule bg-surface px-2 text-[10.5px] font-medium text-ink-faint hover:border-rule-strong hover:text-ink-dim transition-colors"
    >
      <Copy className="size-3" strokeWidth={2} />
      {done ? 'copied' : 'your id'}
    </button>
  )
}

// P3 Frame G/H — the inline window builder (no modal; pull surface).
// createWindow validates ≥1 key server-side; Create is ALSO disabled
// client-side so it never throws in the user's face. The new window
// then appears as a WindowCard whose existing digest / "Seen as:"
// shows the REAL consequence (never a hard-coded claim).
function WindowBuilder({ onClose }: { onClose: () => void }) {
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
        <Skeleton />
      </div>
    )

  // Frame G — nothing windowable yet (not a blank picker / dead-end)
  if (ak.keys.length === 0)
    return (
      <div className="rounded-lg border border-rule bg-surface px-3.5 py-4">
        <p className="text-[12px] font-medium text-ink-dim">
          Nothing to window yet
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Windows share specific values from your work. Do a little
          work with dohc first — the values you create show up here.
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
      onClose() // it now appears as a WindowCard (reactive)
    } catch {
      setErr('Could not create the window — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-rule bg-surface px-3.5 py-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="window name (e.g. “hours for my manager”)"
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
          {busy ? 'creating…' : 'Create window'}
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-ink-faint">
        Creating shares nothing by itself. You then grant a person and
        review what crosses — already-confirmed values cross at once;
        the rest waits for your review.
      </p>
    </div>
  )
}
