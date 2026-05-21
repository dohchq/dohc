import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Sparkles } from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { usePlugins } from '../plugins/usePlugins'
import { OPEN_SKETCH_EVENT } from './AtomEditor'

type Command = {
  id: string
  title: string
  hint?: string
  // P3.2 — when set, an icon (Sparkles) renders alongside the
  // title. Currently used for SKILL entries to distinguish them
  // from plugin commands at a glance.
  kind?: 'skill' | undefined
  run: () => void
}

type Props = {
  open: boolean
  onClose: () => void
  onFirePrompt: (prompt: string) => void
  // P3+P4 fold (Codex F3) — dedicated channel for skill-fire.
  // STRUCTURALLY separates skill dispatch from generic prompt
  // dispatch so a plugin command whose text starts with `/<path>`
  // cannot accidentally become a skill-fire. The callsite in
  // index.tsx pipes onFireSkill ⇒ pendingSkillFire ⇒ Chat's
  // direct sendMessage({entry:'skill-fire', prompt: path}) —
  // never through detectSkillFire.
  onFireSkill: (path: string) => void
  onOpenAtom: (path: string) => void
  onOpenPlugins: () => void
}

export function CommandPalette({
  open,
  onClose,
  onFirePrompt,
  onFireSkill,
  onOpenAtom,
  onOpenPlugins,
}: Props) {
  const { plugins, enabled } = usePlugins()
  // Track-3 P3.2 — surface the user's saved skills here so the
  // ⌘K palette IS the design's "⌘K palette / slash-command"
  // entry surface (skills-commands-v1 §3.3). Each skill entry,
  // when picked, fires `onFirePrompt('/' + path)` — the LEADING
  // SLASH triggers Chat's `detectSkillFire` (P3.1), which sees
  // an EXACT path match and dispatches `sendMessage({entry:
  // 'skill-fire', prompt: path})`. The prepareStep BRACE
  // (P2b.4 + P2c fold) then forces step 0 into
  // {activeTools:['run_skill'], toolChoice: forced, providerOpts:
  // disableParallelToolUse} — the model can only call run_skill.
  // Zero new wiring at this layer; the palette is a discoverable
  // hotkey over the same structural-enforcement chain.
  const skills = useQuery(api.skills.list) ?? []
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commands: Command[] = useMemo(() => {
    const out: Command[] = []
    // Skills first (they're the user's OWN saved processes; most
    // relevant for daily use). Plugin commands and system items
    // follow.
    for (const s of skills) {
      out.push({
        id: `skill.${s.path}`,
        title: s.label,
        hint: `skill · ${s.path}`,
        kind: 'skill',
        run: () => {
          onClose()
          // P3+P4 Codex fold F3: dedicated channel — skill
          // dispatch routes through onFireSkill (NOT
          // onFirePrompt). A plugin command's text that
          // happens to start with `/<path>` can NEVER become
          // a skill-fire by accident: only this callsite
          // (and only with a real skill path) reaches the
          // skill-fire dispatch.
          onFireSkill(s.path)
        },
      })
    }
    for (const p of plugins) {
      if (!enabled.has(p.id)) continue
      for (const c of p.commands) {
        out.push({
          id: `${p.id}.${c.id}`,
          title: c.title,
          hint: `${p.name}${c.keybind ? ' · ' + c.keybind : ''}`,
          run: () => {
            onClose()
            onFirePrompt(c.prompt)
          },
        })
      }
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
    out.push({
      id: 'sys.open-marketplace',
      title: 'Open plugin marketplace',
      hint: 'system',
      run: () => {
        onClose()
        onOpenPlugins()
      },
    })
    return out
  }, [
    skills,
    plugins,
    enabled,
    onClose,
    onFirePrompt,
    onFireSkill,
    onOpenAtom,
    onOpenPlugins,
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
