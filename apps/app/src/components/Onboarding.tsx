import { useRef, useState } from 'react'
import { useAction, useMutation } from 'convex/react'
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { DohcLogo } from '@dohc/brand'
import {
  AttachmentTray,
  AttachmentDropOverlay,
  AttachmentUploadButton,
  useAttachmentUploads,
} from '@/components/AttachmentComposer'
import { AppLoadingScreen } from '@/components/Skeleton'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import type { Id } from '../../convex/_generated/dataModel'

// P1 — the onboarding wedge. The wedge only collects a high-signal setup
// brief, then hands off to the normal agent dashboard. Server state
// machine + "never end empty" invariant remain the source of truth; the
// client cannot fake completion.

type Props = { state: 'NEW' }
type WorkspaceKind = 'personal' | 'org'

// ── the questionnaire (drives dohc's first turn) ────────────────────
type Q = {
  id: string
  q: string
  help?: string
  kind: 'single' | 'multi' | 'free'
  options?: string[]
}

// ONE hardcoded opener — instant, zero latency. Its answer is the
// setup request, not a demographics survey. It SEEDS the model that
// tailors the rest around the system the user wants dohc to build.
function seedQuestion(kind: WorkspaceKind): Q {
  if (kind === 'org') {
    return {
      id: 'setup',
      q: 'What should this team workspace run first?',
      help: 'Pick the shared workflow people should land in.',
      kind: 'single',
      options: [
        'Project status hub',
        'Client delivery system',
        'Sales pipeline / CRM',
        'Hiring loop',
        'Weekly meeting workspace',
        'Company wiki',
      ],
    }
  }
  return {
    id: 'setup',
    q: 'What should dohc set up for you first?',
    help: 'Skip the template hunt. Pick the system you wish already existed.',
    kind: 'single',
    options: [
      'Project manager',
      'Personal finance tracker',
      'Client pipeline / CRM',
      'Notes and research vault',
      'Content calendar',
      'Life admin system',
    ],
  }
}

function realMaterialQuestion(kind: WorkspaceKind): Q {
  return {
    id: 'real_material',
    q: 'Add anything you already have',
    help:
      kind === 'org'
        ? 'Paste meeting notes, project lists, client details, team rituals, or the workflow mess this workspace should organize.'
        : 'Paste notes, lists, CSV rows, goals, client details, or the mess you were about to turn into a template.',
    kind: 'free',
  }
}

// Safety net: if the model is slow / errors / returns junk, the
// make-or-break wedge must NEVER dead-end — fall back to this solid
// static set. The dynamic path is a pure enhancement over this.
function fallbackQs(kind: WorkspaceKind): Q[] {
  const middle =
    kind === 'org'
      ? [
          {
            id: 'fb_focus',
            q: 'What should this shared system make easier?',
            help: 'Pick any that fit.',
            kind: 'multi' as const,
            options: [
              'Status updates',
              'Ownership and handoffs',
              'Client work',
              'Decisions and notes',
              'Deadlines',
              'Repeatable processes',
            ],
          },
          {
            id: 'fb_success',
            q: 'What should the first dashboard make obvious?',
            kind: 'single' as const,
            options: [
              'What needs attention',
              'Who owns what',
              'What changed recently',
              'What is blocked',
              'What is due next',
            ],
          },
        ]
      : [
          {
            id: 'fb_focus',
            q: 'What should this setup keep on top of?',
            help: 'Pick any that fit.',
            kind: 'multi' as const,
            options: [
              'Projects',
              'Money',
              'Notes and research',
              'People and follow-ups',
              'Deadlines',
              'Habits or routines',
            ],
          },
          {
            id: 'fb_success',
            q: 'What should the first dashboard make obvious?',
            kind: 'single' as const,
            options: [
              'What to do next',
              'Where things stand',
              'What changed recently',
              'What is slipping',
              'What is working',
            ],
          },
        ]
  return [...middle, realMaterialQuestion(kind)]
}

type Answers = Record<string, { picks: string[]; other: string }>

const answerText = (x?: { picks: string[]; other: string }) => {
  if (!x) return ''
  const all = [...x.picks]
  if (x.other.trim()) all.push(x.other.trim())
  return all.join(', ')
}

// Generic over WHATEVER questions were asked (AI-tailored OR fallback)
// — the brief is just the answered Q→A pairs + the build directive.
function composeIntro(
  ordered: Q[],
  a: Answers,
  kind: WorkspaceKind,
): string {
  const lines = ordered
    .map((q) => {
      const v = answerText(a[q.id])
      return v ? `• ${q.q.replace(/[?\s]+$/, '')}: ${v}` : null
    })
    .filter((x): x is string => x !== null)
  const identityPath =
    kind === 'org' ? '.context/company.md' : '.context/me.md'
  return [
    kind === 'org'
      ? 'Here’s the shared system this workspace should run:'
      : 'Here’s the Setup Run I want dohc to build:',
    ...lines,
    '',
    `Set it up now — build source markdown first, then a polished source-backed cockpit at home.html for a read-only report or .apps/<use-case> if the setup needs an interactive app-like cockpit; use .apps/home only if the user asked for a general home. If you create an app, run test_app and fix failures before finish_onboarding. Then write an inspectable .runs/setup.md and ${identityPath}. Use the real material I gave you first. Don’t re-ask what I just answered; if I skipped real material, avoid fake productivity theater and make the next capture action obvious.`,
  ].join('\n')
}

// STRICT client-side validation, mirroring the server zod EXACTLY
// (questions.length === 3; kind ∈ {single,multi}; 3–6 string options;
// q ≥ 3 chars). ANY deviation ⇒ null ⇒ the caller uses the curated
// fallbackQs(). A malformed-but-resolved model response must degrade
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

export function Onboarding(_props: Props) {
  const [phase, setPhase] = useState<'intro' | 'questions' | 'handoff'>(
    'intro',
  )
  const activeWorkspaceId = useActiveWorkspaceId()
  const workspaceKind: WorkspaceKind = activeWorkspaceId ? 'org' : 'personal'
  const startOnboarding = useAction(api.agent.startOnboarding)
  const defer = useMutation(api.onboarding.defer)
  const setupStartedRef = useRef(false)

  function beginSetup(
    intro: string,
    attachmentIds: Id<'workspaceAssets'>[],
  ) {
    if (setupStartedRef.current) return
    setupStartedRef.current = true
    setPhase('handoff')
    void startOnboarding({
      ...(intro ? { intro } : {}),
      attachmentIds,
      activeWorkspaceId,
    })
      .then((result) => {
        if (!result.started) {
          throw new Error('Setup run did not start. Please try again.')
        }
      })
      .catch((error) => {
        console.error(error)
        setupStartedRef.current = false
        setPhase('questions')
      })
  }

  if (phase === 'handoff') return <AppLoadingScreen />

  // ── Intro — exactly two choices ────────────────────────────────
  if (phase === 'intro') {
    return (
      <div className="grid h-screen place-items-center bg-page px-6">
        <div className="w-full max-w-[460px] text-center animate-[oFade_.5s_ease]">
          <div className="flex flex-col items-center gap-3 text-accent">
            <DohcLogo size="lg" />
          </div>
          <h1 className="mt-10 text-[27px] font-semibold tracking-tight leading-[1.2] text-ink-strong">
            {workspaceKind === 'org'
              ? 'Run the first shared setup.'
              : 'Start with a Setup Run.'}
          </h1>
          <p className="mx-auto mt-3 max-w-[360px] text-[13.5px] leading-relaxed text-ink-dim">
            {workspaceKind === 'org'
              ? 'Pick one workflow this team should run in dohc. It will build the sources, first cockpit, and operating rhythm.'
              : 'Tell dohc the Notion, Obsidian, or AI workflow you wanted. It builds the sources and first cockpit around you.'}
          </p>
          <button
            onClick={() => setPhase('questions')}
            className="group mt-10 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink-strong text-[14px] font-medium tracking-wide text-surface shadow-sm transition-all hover:-translate-y-px hover:shadow-md"
          >
            <Sparkles className="size-4" strokeWidth={2} />
            {workspaceKind === 'org' ? 'Set up this workflow' : 'Build my setup'}
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
        workspaceKind={workspaceKind}
        onCancel={() => setPhase('intro')}
        onDone={beginSetup}
      />
    )
  }

  return null
}

// ── Questionnaire ──────────────────────────────────────────────────
// One hardcoded opener → its answer seeds a model call that tailors
// the remaining 3 questions to this person. Hard timeout + a static
// fallback set ⇒ the make-or-break wedge can NEVER stall or dead-end;
// the dynamic path is a pure enhancement over a guaranteed baseline.
function Questionnaire({
  workspaceKind,
  onDone,
  onCancel,
}: {
  workspaceKind: WorkspaceKind
  onDone: (intro: string, attachmentIds: Id<'workspaceAssets'>[]) => void
  onCancel: () => void
}) {
  const generate = useAction(api.agent.generateQuestions)
  const activeWorkspaceId = useActiveWorkspaceId()
  const materialAttachments = useAttachmentUploads({
    activeWorkspaceId,
    purpose: 'chat',
  })
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

  const seed = seedQuestion(workspaceKind)
  const fallback = fallbackQs(workspaceKind)
  const ordered: Q[] = rest ? [seed, ...rest] : [seed]
  // Stable dot count (AI returns 3 by schema + our real-material
  // anchor; fallback mirrors that shape) so progress never jumps.
  const total = 1 + (rest?.length ?? fallback.length)
  const q = ordered[Math.min(Math.max(i, 0), ordered.length - 1)]
  const a = answers[q.id] ?? { picks: [], other: '' }
  const isLast = !!rest && i === ordered.length - 1
  const valid =
    (q.kind === 'free' || a.picks.length > 0 || a.other.trim().length > 0) &&
    !(q.kind === 'free' && materialAttachments.hasUploading)

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

  // setup request → tailored set: one model call, 14s hard timeout,
  // static fallback. Never throws into the UI; never blocks the wedge.
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
      setRest(qs ? [...qs, realMaterialQuestion(workspaceKind)] : fallback)
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
      return onDone(
        composeIntro(ordered, answers, workspaceKind),
        materialAttachments.readyAssetIds,
      )
    // leaving the seed question (forward): tailor (or, if already
    // tailored for this exact seed, just advance).
    if (dir === 1 && i === 0) {
      const seedAnswer = answerText(answers[seed.id])
      if (rest && seedAnswer === seededWithRef.current) return advance(1)
      return runTailor(seedAnswer)
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
            dohc is shaping a few questions around how you actually
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
              <div
                onDragEnter={materialAttachments.handleDragEnter}
                onDragOver={materialAttachments.handleDragOver}
                onDragLeave={materialAttachments.handleDragLeave}
                onDrop={materialAttachments.handleDrop}
                className={`relative rounded-xl border bg-surface transition-[border,background,box-shadow] focus-within:border-rule-strong ${
                  materialAttachments.isDragActive
                    ? 'border-accent bg-accent/5 shadow-modal'
                    : 'border-rule'
                }`}
              >
                {materialAttachments.isDragActive && (
                  <AttachmentDropOverlay />
                )}
                <textarea
                  autoFocus
                  value={a.other}
                  onPaste={materialAttachments.handlePaste}
                  onChange={(e) =>
                    set({ picks: [], other: e.target.value })
                  }
                  rows={4}
                  placeholder="Type anything — or skip with Continue."
                  className="w-full resize-none bg-transparent px-4 py-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
                />
                <div className="flex items-end justify-between gap-2 px-3 pb-3">
                  <AttachmentTray
                    attachments={materialAttachments.attachments}
                    onRemove={materialAttachments.removeAttachment}
                    compact
                  />
                  <AttachmentUploadButton
                    uploader={materialAttachments}
                    compact
                  />
                </div>
              </div>
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
              {isLast ? 'Build my workspace' : 'Continue'}
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
