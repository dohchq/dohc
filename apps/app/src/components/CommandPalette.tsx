import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Sparkles, SquareTerminal } from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { OPEN_SKETCH_EVENT } from './AtomEditor'

type Command = {
  id: string
  title: string
  hint?: string
  kind?: 'skill' | 'command' | undefined
  run: () => void
}

type Props = {
  open: boolean
  onClose: () => void
  // P3+P4 fold (Codex F3) — dedicated channel for skill-fire.
  // STRUCTURALLY separates skill dispatch from generic prompt dispatch.
  // The callsite pipes onFireSkill ⇒ pendingSkillFire ⇒ Chat's direct
  // sendMessage({entry:'skill-fire', prompt: path}) — never through
  // detectSkillFire.
  onFireSkill: (path: string) => void
  onFireCommand: (path: string) => void
}

export function CommandPalette({
  open,
  onClose,
  onFireSkill,
  onFireCommand,
}: Props) {
  // Track-3 P3.2 — surface the user's saved skills here so the
  // ⌘K palette IS the design's "⌘K palette / slash-command"
  // entry surface (skills-commands-v1 §3.3). Each skill entry
  // fires the dedicated onFireSkill channel directly. The prepareStep BRACE
  // (P2b.4 + P2c fold) then forces step 0 into
  // {activeTools:['run_skill'], toolChoice: forced, providerOpts:
  // disableParallelToolUse} — the model can only call run_skill.
  // Zero new wiring at this layer; the palette is a discoverable
  // hotkey over the same structural-enforcement chain.
  const skills = useQuery(api.skills.list, {}) ?? []
  const savedCommands = useQuery(api.skills.listCommands, {}) ?? []
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commands: Command[] = useMemo(() => {
    const out: Command[] = []
    // Commands first: they're explicit user-fired shortcuts. Skills
    // follow as reusable process instructions.
    for (const c of savedCommands) {
      out.push({
        id: `command.${c.path}`,
        title: c.label,
        hint: `command · ${c.path}`,
        kind: 'command',
        run: () => {
          onClose()
          onFireCommand(c.path)
        },
      })
    }
    for (const s of skills) {
      out.push({
        id: `skill.${s.path}`,
        title: s.label,
        hint: `skill · ${s.path}`,
        kind: 'skill',
        run: () => {
          onClose()
          // P3+P4 Codex fold F3: dedicated channel — skill
          // dispatch routes through onFireSkill. Only this
          // callsite (and only with a real skill path) reaches
          // the skill-fire dispatch.
          onFireSkill(s.path)
        },
      })
    }
    out.push({
      id: 'sys.insert-ascii-sketch',
      title: 'Insert ASCII sketch',
      hint: 'editor · ⌘⇧D',
      run: () => {
        onClose()
        window.dispatchEvent(new CustomEvent(OPEN_SKETCH_EVENT))
      },
    })
    return out
  }, [
    savedCommands,
    skills,
    onClose,
    onFireCommand,
    onFireSkill,
  ])

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    if (!q) return commands
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q),
    )
  }, [filter, commands])

  useEffect(() => {
    if (open) {
      setFilter('')
      setCursor(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[14vh] bg-backdrop backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[540px] max-w-[92vw] rounded-xl border border-rule-strong bg-elevated shadow-modal overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-rule">
          <Search
            className="size-4 text-ink-faint shrink-0"
            strokeWidth={2}
            aria-hidden
          />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Type a command or search…"
            className="flex-1 h-11 bg-transparent border-none outline-none text-[14px] text-ink placeholder:text-ink-faint"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(filtered.length - 1, c + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                filtered[cursor]?.run()
              }
            }}
          />
          <kbd className="text-[10.5px] text-ink-faint border border-rule rounded px-1.5 py-0.5 font-medium">
            esc
          </kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">
              No commands match.
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setCursor(i)}
                onClick={c.run}
                className={`relative w-full flex items-center justify-between gap-3 px-4 py-2 text-left transition-colors ${
                  i === cursor
                    ? 'bg-hover text-ink-strong'
                    : 'text-ink hover:bg-hover'
                }`}
              >
                {i === cursor && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-ink-strong" />
                )}
                <span className="flex items-center gap-2 min-w-0 flex-1">
                  {c.kind === 'command' && (
                    <SquareTerminal
                      className="size-3 text-accent shrink-0"
                      strokeWidth={2.2}
                      aria-hidden
                    />
                  )}
                  {c.kind === 'skill' && (
                    <Sparkles
                      className="size-3 text-violet-500 shrink-0"
                      strokeWidth={2.2}
                      aria-hidden
                    />
                  )}
                  <span className="text-[13px] truncate font-medium">
                    {c.title}
                  </span>
                </span>
                {c.hint && (
                  <span className="text-[10.5px] text-ink-faint shrink-0 font-mono">
                    {c.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-rule px-4 py-2 bg-panel">
          <span className="flex items-center gap-1 text-[10px] text-ink-faint">
            <kbd className="rounded border border-rule bg-elevated px-1.5 py-0.5 font-medium">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1 text-[10px] text-ink-faint">
            <kbd className="rounded border border-rule bg-elevated px-1.5 py-0.5 font-medium">
              ⏎
            </kbd>
            run
          </span>
          <span className="flex items-center gap-1 text-[10px] text-ink-faint">
            <kbd className="rounded border border-rule bg-elevated px-1.5 py-0.5 font-medium">
              esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </div>
  )
}
