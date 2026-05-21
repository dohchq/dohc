import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useUIMessages, type UIMessage } from '@convex-dev/agent/react'
import {
  Sparkles,
  Send,
  ArrowRight,
  ArrowLeft,
  RotateCw,
  Check,
  Loader2,
  Pencil,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { DohcLogo } from '@/components/DohcLogo'
import { Markdown } from '@/components/Markdown'

// P1 — the onboarding wedge. Design:
// docs/strategy/onboarding-wedge-design.md. UX-polish pass: a 2-choice
// intro → a short guided questionnaire (its answers ARE beam's first
// turn) → a working surface that always says what's happening, renders
// beam's markdown properly, and shows the build assembling without
// clipping. Server state machine + "never end empty" invariant remain
// the source of truth; the client cannot fake completion.

type Props = { state: 'NEW' | 'IN_PROGRESS' }

// ── the questionnaire (drives beam's first turn) ────────────────────
type Q = {
  id: string
  q: string
  help?: string
  kind: 'single' | 'multi' | 'free'
  options?: string[]
}

// ONE hardcoded opener — instant, zero latency. Its answer SEEDS the
// model that tailors the rest to this specific person.
const SEED_Q: Q = {
  id: 'work',
  q: 'What kind of work do you do?',
  help: 'This tailors everything that follows.',
  kind: 'single',
  options: [
    'Freelancer / consultant',
    'Founder / running a business',
    'Lead / manager',
    'Maker / creative',
    'Researcher / analyst',
    'Student / academic',
  ],
}

// Safety net: if the model is slow / errors / returns junk, the
// make-or-break wedge must NEVER dead-end — fall back to this solid
// static set. The dynamic path is a pure enhancement over this.
const FALLBACK_QS: Q[] = [
  {
    id: 'fb_focus',
    q: 'What should beam keep on top of for you?',
    help: 'Pick any that fit.',
    kind: 'multi',
    options: [
      'Clients & projects',
      'Time & billable hours',
      'Goals & deadlines',
      'Money & invoices',
      'Notes & knowledge',
      'People & contacts',
      'Tasks & follow-ups',
    ],
  },
  {
    id: 'fb_pain',
    q: 'What bites you most often?',
    kind: 'single',
    options: [
      'Things slip through the cracks',
      'Status is scattered across tools',
      "I don't know where I stand vs my goals",
      'Too much manual filing & admin',
      'Hard to share the right slice with others',
    ],
  },
  {
    id: 'fb_now',
    q: 'Anything you’re working on right now beam should know about?',
    help: 'Optional — a sentence is plenty.',
    kind: 'free',
  },
]

type Answers = Record<string, { picks: string[]; other: string }>

const answerText = (x?: { picks: string[]; other: string }) => {
  if (!x) return ''
  const all = [...x.picks]
  if (x.other.trim()) all.push(x.other.trim())
  return all.join(', ')
}

// Generic over WHATEVER questions were asked (AI-tailored OR fallback)
// — the brief is just the answered Q→A pairs + the build directive.
function composeIntro(ordered: Q[], a: Answers): string {
  const lines = ordered
    .map((q) => {
      const v = answerText(a[q.id])
      return v ? `• ${q.q.replace(/[?\s]+$/, '')}: ${v}` : null
    })
    .filter((x): x is string => x !== null)
  return [
    'Here’s me, so you can set up my cockpit:',
    ...lines,
    '',
    'Set it up now — build me a populated dashboard and my profile (me.md). Don’t re-ask what I just answered; if a realistic example helps make it concrete, use one that fits my work.',
  ].join('\n')
}

// STRICT client-side validation, mirroring the server zod EXACTLY
// (questions.length === 3; kind ∈ {single,multi}; 3–6 string options;
// q ≥ 3 chars). ANY deviation ⇒ null ⇒ the caller uses the curated
// FALLBACK_QS. A malformed-but-resolved model response must degrade
// to the clean baseline — never a coerced/half-baked AI set (Codex).
function sanitizeQs(raw: unknown): Q[] | null {
  if (!raw || typeof raw !== 'object') return null
  const arr = (raw as { questions?: unknown }).questions
  if (!Array.isArray(arr) || arr.length !== 3) return null
  const out: Q[] = []
  for (let n = 0; n < arr.length; n++) {
    const it = arr[n] as Record<string, unknown> | null
    if (!it || typeof it !== 'object') return null
    if (it.kind !== 'single' && it.kind !== 'multi') return null // no coercion
    if (typeof it.q !== 'string' || it.q.trim().length < 3) return null
    if (it.help !== undefined && typeof it.help !== 'string') return null
    const optsRaw = it.options
    if (
      !Array.isArray(optsRaw) ||
      optsRaw.length < 3 ||
      optsRaw.length > 6
    )
      return null
    // Validate EVERY element — do NOT filter junk into a partial set
    // (that is silent repair; the server zod rejects the whole array
    // on any bad element, so mirror it: any deviation ⇒ fallback).
    const opts: string[] = []
    for (const o of optsRaw) {
      if (typeof o !== 'string' || o.trim().length === 0) return null
      opts.push(o.trim())
    }
    out.push({
      id: `ai_${n}`,
      q: it.q.trim(),
      help: typeof it.help === 'string' ? it.help.trim() : undefined,
      kind: it.kind,
      options: opts,
    })
  }
  return out // exactly 3, every field strictly validated
}

export function Onboarding({ state }: Props) {
  const [phase, setPhase] = useState<'intro' | 'questions' | 'working'>(
    state === 'IN_PROGRESS' ? 'working' : 'intro',
  )
  const introRef = useRef<string | null>(null)

  const ensureThread = useMutation(api.agent.ensureThread)
  const startOnboarding = useAction(api.agent.startOnboarding)
  const defer = useMutation(api.onboarding.defer)
  const sendMessage = useAction(api.agent.sendMessage)
  const progress = useQuery(api.onboarding.progress)

  const [threadId, setThreadId] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ensureThread({})
      .then((id) => alive && setThreadId(id))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [ensureThread])

  // Kick beam's first turn. With the questionnaire brief ⇒ that's the
  // prompt (one clear turn). Idempotent + race-proof + crash-
  // recoverable server-side (single-doc CAS lease) — safe to re-call.
  const kicked = useRef(false)
  const [kicking, setKicking] = useState(false)
  const [kickFailed, setKickFailed] = useState(false)
  const kick = useCallback(
    (intro?: string | null) => {
      if (!threadId) return
      setKicking(true)
      setKickFailed(false)
      startOnboarding(intro ? { intro } : {})
        .catch(() => setKickFailed(true))
        .finally(() => setKicking(false))
    },
    [threadId, startOnboarding],
  )
  useEffect(() => {
    if (phase === 'working' && threadId && !kicked.current) {
      kicked.current = true
      kick(introRef.current)
    }
  }, [phase, threadId, kick])

  // ── live conversation (same pipeline as Chat — not a fork) ──────
  const mq = useUIMessages(
    api.agent.listMessages,
    threadId ? { threadId } : 'skip',
    { initialNumItems: 50, stream: true },
  )
  const messages: UIMessage[] = useMemo(() => {
    if (!mq || mq.status === 'LoadingFirstPage') return []
    return mq.results ?? []
  }, [mq])

  const busy = useMemo(
    () =>
      messages.some(
        (m) =>
          m.role === 'assistant' &&
          ['pending', 'streaming'].includes(
            (m as { status?: string }).status ?? '',
          ),
      ),
    [messages],
  )
  const hasCompletedAssistant = useMemo(
    () =>
      messages.some(
        (m) =>
          m.role === 'assistant' &&
          (m as { status?: string }).status === 'success' &&
          m.parts.some((p) => p.type === 'text' && p.text?.trim()),
      ),
    [messages],
  )
  const composerReady = hasCompletedAssistant && !busy
  const cockpitReady = !!progress?.hasMe && !!progress?.hasDashboardWithQuery

  // ── composer ───────────────────────────────────────────────────
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const send = useCallback(
    async (override?: string) => {
      const prompt = (override ?? input).trim()
      if (!prompt || !threadId || sending) return
      setSending(true)
      if (!override) setInput('')
      try {
        await sendMessage({ threadId, prompt })
      } catch (e) {
        console.error(e)
      } finally {
        setSending(false)
      }
    },
    [input, threadId, sending, sendMessage],
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  // "What am I waiting for?" — one derived status, never ambiguous.
  // `stalled`: kicked but nothing came back for a while (or the kick
  // threw) ⇒ offer a calm retry instead of an infinite spinner.
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (phase !== 'working') return
    if (busy || hasCompletedAssistant || messages.length > 0) {
      setStalled(false)
      return
    }
    if (kickFailed) {
      setStalled(true)
      return
    }
    const t = setTimeout(() => setStalled(true), 24_000)
    return () => clearTimeout(t)
  }, [phase, busy, hasCompletedAssistant, messages.length, kickFailed])

  type Status = 'connecting' | 'building' | 'waiting' | 'ready' | 'stalled'
  const status: Status = cockpitReady
    ? 'ready'
    : stalled
      ? 'stalled'
      : busy
        ? 'building'
        : composerReady
          ? 'waiting'
          : messages.length > 0
            ? 'building'
            : 'connecting'

  // Frame-6 handoff: hand <App/> the hero path so the first post-
  // onboarding frame is the populated cockpit. One-shot, SSR-guarded.
  const upsertAtom = useMutation(api.atoms.upsert)
  const meAtom = useQuery(
    api.atoms.getByPath,
    progress?.mePath ? { path: progress.mePath } : 'skip',
  )
  const heroAtom = useQuery(
    api.atoms.getByPath,
    progress?.dashboardPath ? { path: progress.dashboardPath } : 'skip',
  )
  useEffect(() => {
    if (
      cockpitReady &&
      progress?.dashboardPath &&
      typeof window !== 'undefined'
    ) {
      try {
        window.localStorage.setItem(
          'vibeam:onboarding:open',
          progress.dashboardPath,
        )
      } catch {
        /* private-mode / quota — App shows its normal default */
      }
    }
  }, [cockpitReady, progress?.dashboardPath])

  // ── Intro — exactly two choices ────────────────────────────────
  if (phase === 'intro') {
    return (
      <div className="grid h-screen place-items-center bg-page px-6">
        <div className="w-full max-w-[460px] text-center animate-[oFade_.5s_ease]">
          <div className="flex flex-col items-center gap-3 text-accent">
            <DohcLogo size="lg" />
          </div>
          <h1 className="mt-10 text-[27px] font-semibold tracking-tight leading-[1.2] text-ink-strong">
            Let’s set up your cockpit.
          </h1>
          <p className="mx-auto mt-3 max-w-[360px] text-[13.5px] leading-relaxed text-ink-dim">
            A handful of quick questions so beam builds around how you
            actually work. About a minute — then it does the rest.
          </p>
          <button
            onClick={() => setPhase('questions')}
            className="group mt-10 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink-strong text-[14px] font-medium tracking-wide text-surface shadow-sm transition-all hover:-translate-y-px hover:shadow-md"
          >
            <Sparkles className="size-4" strokeWidth={2} />
            Set up my cockpit
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5"
              strokeWidth={2}
            />
          </button>
          <button
            onClick={() => defer({}).catch(() => {})}
            className="mx-auto mt-6 block text-[12px] text-ink-faint transition-colors hover:text-ink-dim"
          >
            I’ll explore on my own
          </button>
        </div>
      </div>
    )
  }

  // ── Questionnaire — guided, one question at a time ─────────────
  if (phase === 'questions') {
    return (
      <Questionnaire
        onCancel={() => setPhase('intro')}
        onDone={(intro) => {
          introRef.current = intro
          setPhase('working')
        }}
      />
    )
  }

  // ── Working surface ────────────────────────────────────────────
  return (
    <div className="grid h-screen grid-cols-[1fr_360px] bg-page">
      <div className="flex h-screen min-w-0 flex-col">
        <StatusBar
          status={status}
          onRetry={() => kick()}
          retrying={kicking}
        />
        <div
          ref={scrollRef}
          className="mx-auto flex w-full max-w-[700px] flex-1 flex-col gap-5 overflow-y-auto px-6 py-6"
        >
          {messages.length === 0 ? (
            <ThinkingBubble
              label={
                status === 'stalled'
                  ? 'beam didn’t get going.'
                  : 'beam is reading what you told me…'
              }
            />
          ) : (
            messages.map((m) => <Msg key={m.key} m={m} />)
          )}
          {busy && messages.length > 0 && <ThinkingBubble />}
        </div>

        <div className="mx-auto w-full max-w-[700px] px-6 pb-5 pt-1">
          {composerReady ? (
            <div className="relative rounded-xl border border-rule bg-elevated shadow-xs transition-colors focus-within:border-rule-strong">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder="Reply to beam, or tell it what to fix…"
                rows={3}
                className="w-full resize-none bg-transparent px-3.5 pb-9 pt-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
              />
              <div className="absolute bottom-2 left-3.5 right-2 flex items-center justify-between">
                <span className="text-[10px] text-ink-faint">
                  ⏎ send · ⇧⏎ newline
                </span>
                <button
                  onClick={() => send()}
                  disabled={sending || !input.trim()}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-2.5 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink disabled:cursor-not-allowed disabled:bg-ink-ghost"
                >
                  <Send className="size-3" strokeWidth={2.2} />
                  send
                </button>
              </div>
            </div>
          ) : status === 'stalled' ? (
            <button
              onClick={() => kick()}
              disabled={kicking}
              className="mx-auto flex h-10 items-center gap-2 rounded-lg border border-rule px-4 text-[12.5px] font-medium text-ink-dim transition-colors hover:border-rule-strong hover:text-ink disabled:opacity-50"
            >
              <RotateCw className="size-4" strokeWidth={2} />
              {kicking ? 'starting…' : 'Give it another go'}
            </button>
          ) : (
            <p className="py-3 text-center text-[12px] text-ink-faint">
              beam is working — your cockpit is taking shape on the
              right →
            </p>
          )}
        </div>
      </div>

      {/* right — the live build, made legible */}
      <aside className="flex h-screen flex-col border-l border-rule bg-panel">
        <div className="flex items-center gap-2 border-b border-rule px-5 py-4">
          <Sparkles className="size-3.5 text-ink-dim" strokeWidth={2} />
          <span className="text-[12px] font-semibold tracking-tight text-ink-strong">
            Your cockpit, live
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-5">
          <BuildChecklist progress={progress} status={status} />

          {heroAtom && (
            <Card title="Your dashboard, taking shape">
              <div className="max-h-[300px] overflow-y-auto pr-1">
                <Markdown variant="compact">{heroAtom.body}</Markdown>
              </div>
            </Card>
          )}

          {meAtom && (
            <MeCard
              path={meAtom.path}
              body={meAtom.body}
              onSave={(next) =>
                upsertAtom({ path: meAtom.path, body: next }).then(
                  () => undefined,
                )
              }
            />
          )}

          {hasCompletedAssistant && !cockpitReady && (
            <Card title="Not quite right?">
              <p className="text-[11.5px] leading-relaxed text-ink-dim">
                Tell beam what to fix — it learns you as it goes.
              </p>
              <button
                onClick={() => {
                  setInput((v) => v || 'Not quite — ')
                  scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                  })
                }}
                disabled={!composerReady}
                className="mt-2 text-[11.5px] font-medium text-accent transition-colors hover:text-accent-hover disabled:text-ink-faint"
              >
                correct beam →
              </button>
            </Card>
          )}
        </div>

        <div className="border-t border-rule px-5 py-4">
          {cockpitReady ? (
            <p className="flex items-center gap-1.5 text-[12px] font-medium leading-relaxed text-success">
              <Check className="size-4" strokeWidth={2.4} />
              Your cockpit is ready — opening…
            </p>
          ) : (
            <button
              onClick={() => defer({}).catch(() => {})}
              className="text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
            >
              I’ll explore on my own
            </button>
          )}
        </div>
      </aside>
      <style>{`@keyframes oFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>
    </div>
  )
}

// ── Questionnaire ──────────────────────────────────────────────────
// One hardcoded opener → its answer seeds a model call that tailors
// the remaining 3 questions to this person. Hard timeout + a static
// fallback set ⇒ the make-or-break wedge can NEVER stall or dead-end;
// the dynamic path is a pure enhancement over a guaranteed baseline.
function Questionnaire({
  onDone,
  onCancel,
}: {
  onDone: (intro: string) => void
  onCancel: () => void
}) {
  const generate = useAction(api.agent.generateQuestions)
  const [answers, setAnswers] = useState<Answers>({})
  const [rest, setRest] = useState<Q[] | null>(null)
  const [tailoring, setTailoring] = useState(false)
  const seededWithRef = useRef<string | null>(null)
  const [i, setI] = useState(0)
  const [shown, setShown] = useState(true)
  // Single-flight guard: the 160ms transition + still-enabled buttons
  // let a double-click queue multiple ±1 jumps. Locked until the
  // transition settles; terminal branches lock-then-unmount.
  const busyRef = useRef(false)

  const ordered: Q[] = rest ? [SEED_Q, ...rest] : [SEED_Q]
  // Stable dot count (AI returns exactly 3 by schema; fallback is 3)
  // so the progress bar never jumps when the tailored set arrives.
  const total = 1 + (rest?.length ?? FALLBACK_QS.length)
  const q = ordered[Math.min(Math.max(i, 0), ordered.length - 1)]
  const a = answers[q.id] ?? { picks: [], other: '' }
  const isLast = !!rest && i === ordered.length - 1
  const valid =
    q.kind === 'free' || a.picks.length > 0 || a.other.trim().length > 0

  const set = (next: { picks: string[]; other: string }) =>
    setAnswers((s) => ({ ...s, [q.id]: next }))

  const advance = (dir: 1 | -1) => {
    setShown(false)
    setTimeout(() => {
      setI((n) => Math.min(Math.max(n + dir, 0), ordered.length - 1))
      setShown(true)
      busyRef.current = false
    }, 160)
  }

  // seed → tailored set: one model call, 14s hard timeout, static
  // fallback. Never throws into the UI; never blocks the wedge.
  const runTailor = (seed: string) => {
    setTailoring(true)
    seededWithRef.current = seed
    void (async () => {
      let qs: Q[] | null = null
      try {
        const res = await Promise.race([
          generate({ seed }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), 14_000),
          ),
        ])
        qs = sanitizeQs(res)
      } catch {
        qs = null
      }
      setRest(qs ?? FALLBACK_QS)
      setTailoring(false)
      setI(1)
      setShown(true)
      busyRef.current = false
    })()
  }

  const go = (dir: 1 | -1) => {
    if (busyRef.current || tailoring) return
    busyRef.current = true
    // terminal branches change the parent phase ⇒ this unmounts;
    // the lock is never released (correct — no second fire).
    if (dir === -1 && i === 0) return onCancel()
    if (dir === 1 && isLast)
      return onDone(composeIntro(ordered, answers))
    // leaving the seed question (forward): tailor (or, if already
    // tailored for this exact seed, just advance).
    if (dir === 1 && i === 0) {
      const seed = answerText(answers[SEED_Q.id])
      if (rest && seed === seededWithRef.current) return advance(1)
      return runTailor(seed)
    }
    advance(dir)
  }

  const toggle = (opt: string) => {
    if (q.kind === 'single') set({ picks: [opt], other: '' })
    else
      set({
        picks: a.picks.includes(opt)
          ? a.picks.filter((p) => p !== opt)
          : [...a.picks, opt],
        other: a.other,
      })
  }

  // Tailoring — a calm, on-brand wait (never a blank/ambiguous gap).
  if (tailoring) {
    return (
      <div className="grid h-screen place-items-center bg-page px-6">
        <div className="w-full max-w-[540px] text-center">
          <div className="mb-9 flex items-center justify-center gap-1.5">
            {Array.from({ length: total }).map((_, n) => (
              <span
                key={n}
                className={`h-1 rounded-full ${
                  n === 0
                    ? 'w-6 animate-pulse bg-ink-dim'
                    : 'w-1.5 bg-ink-ghost'
                }`}
              />
            ))}
          </div>
          <Loader2
            className="mx-auto size-5 animate-spin text-ink-dim"
            strokeWidth={2.2}
          />
          <h2 className="mt-5 text-[19px] font-semibold tracking-tight text-ink-strong">
            Tailoring your setup…
          </h2>
          <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-relaxed text-ink-dim">
            beam is shaping a few questions around how you actually
            work. Just a moment.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-screen place-items-center bg-page px-6">
      <div className="w-full max-w-[540px]">
        {/* progress */}
        <div className="mb-9 flex items-center justify-center gap-1.5">
          {Array.from({ length: total }).map((_, n) => (
            <span
              key={n}
              className={`h-1 rounded-full transition-all duration-300 ${
                n === i
                  ? 'w-6 bg-ink-strong'
                  : n < i
                    ? 'w-1.5 bg-ink-dim'
                    : 'w-1.5 bg-ink-ghost'
              }`}
            />
          ))}
        </div>

        <div
          className={`transition-all duration-200 ${
            shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
          }`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Question {i + 1} of {total}
          </p>
          <h2 className="mt-2 text-[22px] font-semibold leading-snug tracking-tight text-ink-strong">
            {q.q}
          </h2>
          {q.help && (
            <p className="mt-1.5 text-[12.5px] text-ink-dim">{q.help}</p>
          )}

          <div className="mt-6 flex flex-col gap-2">
            {q.options?.map((opt) => {
              const on = a.picks.includes(opt)
              return (
                <button
                  key={opt}
                  onClick={() => toggle(opt)}
                  className={`group flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-[13.5px] transition-all ${
                    on
                      ? 'border-ink-strong bg-ink-strong text-surface shadow-sm'
                      : 'border-rule bg-surface text-ink-dim hover:border-rule-strong hover:text-ink'
                  }`}
                >
                  <span
                    className={`grid size-4 shrink-0 place-items-center border ${
                      q.kind === 'multi' ? 'rounded-md' : 'rounded-full'
                    } ${
                      on
                        ? 'border-surface bg-surface text-ink-strong'
                        : 'border-ink-ghost'
                    }`}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  {opt}
                </button>
              )
            })}

            {q.kind === 'free' ? (
              <textarea
                autoFocus
                value={a.other}
                onChange={(e) =>
                  set({ picks: [], other: e.target.value })
                }
                rows={4}
                placeholder="Type anything — or skip with Continue."
                className="w-full resize-none rounded-xl border border-rule bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-rule-strong"
              />
            ) : (
              <div className="relative">
                {a.other.trim().length > 0 && (
                  <span className="pointer-events-none absolute left-3.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-full bg-ink-strong text-surface">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                )}
                <input
                  value={a.other}
                  onChange={(e) =>
                    set({
                      picks: q.kind === 'single' ? [] : a.picks,
                      other: e.target.value,
                    })
                  }
                  placeholder="Something else…"
                  className={`w-full rounded-xl border px-4 py-3 text-[13.5px] text-ink outline-none transition-all placeholder:text-ink-faint ${
                    a.other.trim().length > 0
                      ? 'border-solid border-ink-strong bg-surface pl-10'
                      : 'border-dashed border-rule bg-transparent focus:border-rule-strong focus:bg-surface'
                  }`}
                />
              </div>
            )}
          </div>

          <div className="mt-8 flex items-center justify-between">
            <button
              onClick={() => go(-1)}
              disabled={!shown}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-faint transition-colors hover:text-ink-dim disabled:opacity-50"
            >
              <ArrowLeft className="size-3.5" strokeWidth={2} />
              {i === 0 ? 'Back' : 'Previous'}
            </button>
            <button
              onClick={() => go(1)}
              disabled={!valid || !shown}
              className="group inline-flex h-10 items-center gap-2 rounded-xl bg-ink-strong px-5 text-[13px] font-medium text-surface shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-ink-ghost disabled:shadow-none"
            >
              {isLast ? 'Build my cockpit' : 'Continue'}
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5"
                strokeWidth={2}
              />
            </button>
          </div>
          {q.kind === 'free' && (
            <p className="mt-3 text-center text-[11px] text-ink-faint">
              Optional — Continue to skip.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── working-surface pieces ─────────────────────────────────────────
function StatusBar({
  status,
  onRetry,
  retrying,
}: {
  status: 'connecting' | 'building' | 'waiting' | 'ready' | 'stalled'
  onRetry: () => void
  retrying: boolean
}) {
  const map = {
    connecting: {
      t: 'Getting things ready',
      s: 'beam is spinning up — just a few seconds.',
      spin: true,
    },
    building: {
      t: 'beam is building your cockpit',
      s: 'Reading what you told me and setting things up — about a minute.',
      spin: true,
    },
    waiting: {
      t: 'beam needs a word from you',
      s: 'Reply below to keep going.',
      spin: false,
    },
    ready: {
      t: 'Your cockpit is ready',
      s: 'Opening it now…',
      spin: false,
    },
    stalled: {
      t: 'beam didn’t get going',
      s: 'It happens — give it another go.',
      spin: false,
    },
  }[status]
  return (
    <header className="flex items-center justify-between gap-4 border-b border-rule px-6 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface">
          {status === 'ready' ? (
            <Check className="size-3.5 text-success" strokeWidth={2.6} />
          ) : map.spin ? (
            <Loader2
              className="size-3.5 animate-spin text-ink-dim"
              strokeWidth={2.4}
            />
          ) : (
            <span className="size-1.5 rounded-full bg-accent" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight text-ink-strong">
            {map.t}
          </p>
          <p className="truncate text-[11.5px] text-ink-faint">{map.s}</p>
        </div>
      </div>
      {status === 'stalled' && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-rule px-3 text-[12px] font-medium text-ink-dim transition-colors hover:border-rule-strong hover:text-ink disabled:opacity-50"
        >
          <RotateCw className="size-3.5" strokeWidth={2} />
          {retrying ? 'starting…' : 'Retry'}
        </button>
      )}
    </header>
  )
}

function ThinkingBubble({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
      <span className="flex gap-1">
        {[0, 1, 2].map((n) => (
          <span
            key={n}
            className="size-1.5 animate-bounce rounded-full bg-ink-ghost"
            style={{ animationDelay: `${n * 140}ms` }}
          />
        ))}
      </span>
      {label && <span>{label}</span>}
    </div>
  )
}

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-3.5 py-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
        {title}
      </p>
      {children}
    </div>
  )
}

function BuildChecklist({
  progress,
  status,
}: {
  progress:
    | {
        entityCount: number
        hasMe: boolean
        hasDashboardWithQuery: boolean
      }
    | undefined
    | null
  status: string
}) {
  const live = status === 'building' || status === 'connecting'
  const n = progress?.entityCount ?? 0
  const items = [
    {
      done: n > 0,
      label:
        n > 0
          ? `Organized ${n >= 200 ? '200+' : n} thing${n === 1 ? '' : 's'} from your work`
          : 'Pulling structure out of your work',
    },
    {
      done: !!progress?.hasDashboardWithQuery,
      label: progress?.hasDashboardWithQuery
        ? 'Built your live dashboard'
        : 'Building your live dashboard',
    },
    {
      done: !!progress?.hasMe,
      label: progress?.hasMe
        ? 'Saved your profile'
        : 'Learning how you work',
    },
  ]
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it, idx) => (
        <div key={idx} className="flex items-start gap-2.5">
          <span className="mt-px grid size-4 shrink-0 place-items-center">
            {it.done ? (
              <Check className="size-3.5 text-success" strokeWidth={2.6} />
            ) : live ? (
              <Loader2
                className="size-3.5 animate-spin text-ink-faint"
                strokeWidth={2.2}
              />
            ) : (
              <span className="size-2 rounded-full border border-ink-ghost" />
            )}
          </span>
          <span
            className={`text-[12px] leading-snug ${
              it.done ? 'text-ink-strong' : 'text-ink-dim'
            }`}
          >
            {it.label}
          </span>
        </div>
      ))}
    </div>
  )
}

// D6 — the profile beam wrote, shown back and editable. Markdown
// preview by default (not a raw mono wall); Edit reveals the textarea.
// beam may keep refining it — we keep showing its latest UNTIL the
// user edits, then stop clobbering them. Save = real atoms.upsert.
function MeCard({
  path,
  body,
  onSave,
}: {
  path: string
  body: string
  onSave: (next: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!dirty) setDraft(body)
  }, [body, dirty])
  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setDirty(false)
      setSaved(true)
      setEditing(false)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="rounded-xl border border-rule bg-surface px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
          What beam learned about you
        </p>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent transition-colors hover:text-accent-hover"
          >
            <Pencil className="size-3" strokeWidth={2.2} />
            edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value)
              setDirty(true)
              setSaved(false)
            }}
            rows={8}
            className="w-full resize-none rounded-md border border-rule bg-page px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none transition-colors focus:border-rule-strong"
          />
          <div className="mt-1.5 flex items-center justify-end gap-3">
            <button
              onClick={() => {
                setEditing(false)
                setDirty(false)
                setDraft(body)
              }}
              className="text-[11px] text-ink-faint hover:text-ink-dim"
            >
              cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="text-[11px] font-medium text-accent hover:text-accent-hover disabled:text-ink-faint"
            >
              {saving ? 'saving…' : 'save'}
            </button>
          </div>
        </>
      ) : (
        <div className="max-h-[220px] overflow-y-auto pr-1">
          <Markdown variant="compact">{body}</Markdown>
          {saved && (
            <p className="mt-1.5 text-[10.5px] font-medium text-success">
              saved ✓
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// Same part-handling as Chat (text + tool chips; reasoning hidden) —
// but beam's text is rendered as proper markdown, not a wall.
function Msg({ m }: { m: UIMessage }) {
  if (m.role === 'system') return null
  const isUser = m.role === 'user'
  const text = m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('')
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {isUser ? 'you' : 'beam'}
      </span>
      <div
        className={
          isUser
            ? 'self-start rounded-xl rounded-tl-sm border border-rule bg-surface px-3.5 py-2.5'
            : ''
        }
      >
        {text.trim() &&
          (isUser ? (
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
              {text}
            </div>
          ) : (
            <Markdown>{text}</Markdown>
          ))}
        <div className="mt-1 flex flex-wrap gap-1">
          {m.parts.map((part, i) => {
            if (!part.type?.startsWith('tool-')) return null
            const p = part as unknown as {
              type: string
              toolName?: string
              state?: string
            }
            const name = p.toolName ?? p.type.replace(/^tool-/, '')
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-panel px-2 py-1 font-mono text-[10.5px] text-ink-dim"
              >
                <span className="size-1 rounded-full bg-success" />
                <span className="text-ink">{name}</span>
                {p.state && p.state !== 'output-available' && (
                  <em className="not-italic text-ink-faint">
                    ({p.state})
                  </em>
                )}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
