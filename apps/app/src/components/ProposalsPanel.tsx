import { useCallback, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { RefreshCw, Check, X } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

// P4 — the loop UX (advisory proposals, in-product).
// Design: docs/strategy/loop-ux-design.md (gate CLEARED v2).
// A PULL surface: opened on demand, never a per-item nag. The
// advisory spine: dohc NEVER changes your work — accept is a pure
// status flip; Run-now writes only the proposals table, never user
// content. This panel renders DIRECTLY
// from the live `listPending` query — it intentionally keeps NO
// client snapshot of `items` (a frozen list could resurface a
// revoked cross-desk row); per-row action state is ephemeral and
// cleared by Convex reactivity.

type Item = {
  id: string
  kind: 'metric' | 'gardening'
  identifier: string
  message: string
  createdAt: number
  goal?: number
  actual?: number
}
type RunResult = {
  proposed: number
  gardening: 0 | 1
  reason?: 'no .context/intent.md' | 'ambiguous .context/intent.md'
}

export function ProposalsPanel({
  onAskDohc,
}: {
  // Frame Q: the truncated state defers to dohc (the existing
  // capable bulk path) — never a dead-end.
  onAskDohc: (prompt: string) => void
}) {
  const pending = useQuery(api.loop.listPending) as
    | { truncated: boolean; items: Item[] }
    | undefined
  const accept = useMutation(api.loop.accept)
  const dismiss = useMutation(api.loop.dismiss)
  const runNow = useMutation(api.loop.runNow)

  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const doRun = useCallback(async () => {
    setRunning(true)
    setNote(null)
    try {
      const r = (await runNow({})) as RunResult
      setRunResult(r)
    } catch {
      setNote('Could not run the check — try again.')
    } finally {
      setRunning(false)
    }
  }, [runNow])

  const resolve = useCallback(
    async (id: string, isAccept: boolean) => {
      setActing(id)
      setNote(null)
      try {
        const fn = isAccept ? accept : dismiss
        const r = await fn({ proposalId: id as Id<'proposals'> })
        // Clear any prior run-result so a stale post-run subline
        // can't linger over a now-changed list (e.g. resolving the
        // last item → Frame N must read neutral, not "see below").
        setRunResult(null)
        if (!r.ok) {
          // terminal race (already resolved elsewhere) — the live
          // query will drop it; just say so, never double-apply.
          setNote('Already resolved.')
        } else if (isAccept) {
          setNote('Noted — advice recorded. dohc didn’t change your work.')
        } else {
          setNote(
            'Dismissed. If you’re still behind this goal next week, dohc raises it again.',
          )
        }
      } catch {
        setNote('Something went wrong — nothing was applied. Try again.')
      } finally {
        setActing(null)
      }
    },
    [accept, dismiss],
  )

  const hasItems = !!pending && pending.items.length > 0

  // Post-run line — keyed off BOTH counts (never "nothing new" when
  // the gardening pass produced one) + the reason passthrough, AND
  // context-aware: a {0,0} rerun while a behind-goal digest is
  // visibly listed must NOT claim "nothing behind your goals" (that
  // would contradict the rows on screen — Codex secondary). In the
  // non-empty digest it reads as "already checked — nothing new".
  const runLine = (() => {
    if (!runResult) return null
    if (runResult.reason)
      return 'Set goals in .context/intent.md (e.g. {goal_billable: 40}) and dohc will track them.'
    if (runResult.proposed === 0 && runResult.gardening === 0)
      return hasItems
        ? 'Already checked this week — nothing new.'
        : 'Checked — nothing behind your goals right now.'
    if (runResult.gardening > 0)
      return 'Checked — a tidy-up suggestion is below.'
    return 'Checked — see what dohc flagged below.'
  })()

  return (
    <div className="flex h-screen flex-col border-l border-rule bg-panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-5">
        <RefreshCw className="size-3.5 text-ink-dim" strokeWidth={2} />
        <span className="text-[12.5px] font-semibold tracking-tight text-ink-strong">
          The weekly loop
        </span>
      </header>

      {/* Frame M — the advisory spine, stated up front */}
      <div className="shrink-0 border-b border-rule px-5 py-3">
        <p className="text-[11.5px] leading-relaxed text-ink-dim">
          dohc compares your stated goals to where things actually are
          and suggests where to look.{' '}
          <span className="text-ink">
            Advice only — dohc never changes your work.
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {pending === undefined ? (
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-lg border border-rule bg-surface"
              />
            ))}
          </div>
        ) : pending.items.length === 0 ? (
          // Frame N — empty (not a dead-end)
          <div className="mx-auto mt-8 max-w-[280px] text-center">
            <p className="text-[12.5px] font-medium text-ink-dim">
              Nothing flagged.
            </p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
              {runResult
                ? runLine
                : "Either you're on track, or dohc hasn't looked yet."}
            </p>
            <button
              onClick={doRun}
              disabled={running}
              className="mx-auto mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-rule bg-surface px-3 text-[11.5px] font-medium text-ink-dim hover:border-rule-strong hover:text-ink disabled:opacity-50 transition-colors"
            >
              <RefreshCw
                className={`size-3.5 ${running ? 'animate-spin' : ''}`}
                strokeWidth={2}
              />
              {running ? 'checking…' : 'Run the weekly check now'}
            </button>
          </div>
        ) : (
          // Frame O — the batched digest
          <div className="flex flex-col gap-3">
            {pending.truncated && (
              // Frame Q — fail-closed, honest, defers to dohc
              <div className="rounded-md bg-elevated px-3 py-2">
                <p className="text-[11px] leading-relaxed text-ink-dim">
                  Showing the first 100. Run a focused review with dohc
                  to work through the rest.
                </p>
                <button
                  onClick={() =>
                    onAskDohc(
                      'My weekly loop has more than 100 pending ' +
                        'proposals — walk me through them in batches ' +
                        'and help me clear them.',
                    )
                  }
                  className="mt-1.5 text-[11px] font-medium text-ink hover:underline"
                >
                  Ask dohc →
                </button>
              </div>
            )}
            {pending.items.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-rule bg-surface px-3.5 py-3"
              >
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-page px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.1em] text-ink-faint">
                    {p.kind}
                  </span>
                  <span className="font-mono text-[10.5px] text-ink-faint">
                    {p.identifier}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
                  {p.message}
                </p>
                {p.kind === 'metric' &&
                  typeof p.goal === 'number' &&
                  typeof p.actual === 'number' && (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-page">
                        <div
                          className="h-full rounded-full bg-ink-dim"
                          style={{
                            width: `${Math.max(
                              0,
                              Math.min(
                                100,
                                p.goal > 0
                                  ? (p.actual / p.goal) * 100
                                  : 0,
                              ),
                            )}%`,
                          }}
                        />
                      </div>
                      <p className="mt-1 text-[10px] text-ink-faint">
                        {p.actual} / {p.goal}
                      </p>
                    </div>
                  )}
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    onClick={() => resolve(p.id, true)}
                    disabled={acting === p.id}
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-ink-strong px-2.5 text-[11px] font-medium text-surface hover:bg-ink disabled:opacity-50 transition-colors"
                  >
                    <Check className="size-3" strokeWidth={2.4} />
                    Accept
                  </button>
                  <button
                    onClick={() => resolve(p.id, false)}
                    disabled={acting === p.id}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-rule px-2.5 text-[11px] font-medium text-ink-dim hover:border-rule-strong hover:text-ink disabled:opacity-50 transition-colors"
                  >
                    <X className="size-3" strokeWidth={2.4} />
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={doRun}
              disabled={running}
              className="mx-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-rule px-3 text-[11px] font-medium text-ink-faint hover:border-rule-strong hover:text-ink-dim disabled:opacity-50 transition-colors"
            >
              <RefreshCw
                className={`size-3 ${running ? 'animate-spin' : ''}`}
                strokeWidth={2}
              />
              {running ? 'checking…' : 'Run the weekly check now'}
            </button>
            {runResult && runLine && (
              <p className="text-center text-[11px] text-ink-faint">
                {runLine}
              </p>
            )}
          </div>
        )}

        {note && (
          <p className="mt-3 text-center text-[11px] font-medium text-ink-dim">
            {note}
          </p>
        )}
      </div>
    </div>
  )
}
