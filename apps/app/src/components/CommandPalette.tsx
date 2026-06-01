import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  AppWindow,
  FilePenLine,
  PencilLine,
  Search,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { OPEN_SKETCH_EVENT } from './AtomEditor'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { SidebarRowsSkeleton } from './Skeleton'

type RunnableRow = {
  path: string
  label: string
}

type ViewRow = {
  packageRoot: string
  title: string
  entryPath: string
  scopePath: string
}

export type CommandPaletteEntry = {
  id: string
  title: string
  hint?: string
  kind: 'skill' | 'command' | 'system' | 'view'
  section: 'Open' | 'Run' | 'Create' | 'Editor'
  editPath?: string
  edit?: () => void
  keywords?: ReadonlyArray<string>
  run: () => void
}

const CREATE_SKILL_PROMPT =
  'Help me turn a recent successful workflow into a reusable dohc skill. Inspect the relevant context, ask for missing details only if needed, draft the skill plainly, and save it with save_skill only after I approve.'

const CREATE_COMMAND_PROMPT =
  'Help me create a reusable slash command for a task I repeat. Ask what command should do, draft the command body, and save it with save_command only after I approve.'

export function buildCommandPaletteEntries({
  savedCommands,
  skills,
  views,
  onClose,
  onFireSkill,
  onFireCommand,
  onOpenView,
  onPromptAgent,
  onOpenAtom,
  onOpenSketch,
}: {
  savedCommands: ReadonlyArray<RunnableRow>
  skills: ReadonlyArray<RunnableRow>
  views: ReadonlyArray<ViewRow>
  onClose: () => void
  onFireSkill: (path: string) => void
  onFireCommand: (path: string) => void
  onOpenView: (packageRoot: string) => void
  onPromptAgent: (prompt: string) => void
  onOpenAtom: (path: string) => void
  onOpenSketch: () => void
}): CommandPaletteEntry[] {
  const out: CommandPaletteEntry[] = []
  for (const view of views) {
    const scope = view.scopePath || 'Workspace'
    out.push({
      id: `view.${view.packageRoot}`,
      title: `Open view: ${view.title}`,
      hint: `view · ${scope}`,
      kind: 'view',
      section: 'Open',
      keywords: ['dashboard', 'view', view.packageRoot, view.entryPath],
      run: () => {
        onClose()
        onOpenView(view.packageRoot)
      },
    })
    out.push({
      id: `view-source.${view.packageRoot}`,
      title: `Edit view source: ${view.title}`,
      hint: `source · ${view.entryPath}`,
      kind: 'view',
      section: 'Open',
      editPath: view.entryPath,
      keywords: ['dashboard', 'view', 'source', view.packageRoot, view.entryPath],
      run: () => {
        onClose()
        onOpenAtom(view.entryPath)
      },
    })
  }
  // Commands first: they're explicit user-fired shortcuts. Skills
  // follow as reusable process instructions.
  for (const c of savedCommands) {
    out.push({
      id: `command.${c.path}`,
      title: c.label,
      hint: `command · ${c.path}`,
      kind: 'command',
      section: 'Run',
      editPath: c.path,
      edit: () => {
        onClose()
        onOpenAtom(c.path)
      },
      keywords: ['slash', 'shortcut', c.path],
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
      section: 'Run',
      editPath: s.path,
      edit: () => {
        onClose()
        onOpenAtom(s.path)
      },
      keywords: ['process', 'workflow', s.path],
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
    kind: 'system',
    section: 'Editor',
    keywords: ['drawing', 'diagram'],
    run: () => {
      onClose()
      onOpenSketch()
    },
  })
  out.push({
    id: 'sys.create-skill',
    title: 'Create reusable skill',
    hint: 'agent · save a process',
    kind: 'system',
    section: 'Create',
    keywords: ['workflow', 'process', 'repeat', 'save'],
    run: () => {
      onClose()
      onPromptAgent(CREATE_SKILL_PROMPT)
    },
  })
  out.push({
    id: 'sys.create-command',
    title: 'Create slash command',
    hint: 'agent · save a shortcut',
    kind: 'system',
    section: 'Create',
    keywords: ['shortcut', 'slash', 'repeat', 'save'],
    run: () => {
      onClose()
      onPromptAgent(CREATE_COMMAND_PROMPT)
    },
  })
  return out
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
  onOpenView: (packageRoot: string) => void
  onPromptAgent: (prompt: string) => void
  onOpenAtom: (path: string) => void
}

export function CommandPalette({
  open,
  onClose,
  onFireSkill,
  onFireCommand,
  onOpenView,
  onPromptAgent,
  onOpenAtom,
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
  const activeWorkspaceId = useActiveWorkspaceId()
  const skillsResult = useQuery(api.skills.list, { activeWorkspaceId })
  const savedCommandsResult = useQuery(api.skills.listCommands, {
    activeWorkspaceId,
  })
  const viewsResult = useQuery(api.views.list, { activeWorkspaceId })
  const skills = skillsResult ?? []
  const savedCommands = savedCommandsResult ?? []
  const views = viewsResult?.views ?? []
  const paletteLoading =
    open &&
    (skillsResult === undefined ||
      savedCommandsResult === undefined ||
      viewsResult === undefined)
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commands = useMemo(
    () =>
      buildCommandPaletteEntries({
        savedCommands,
        skills,
        views,
        onClose,
        onFireCommand,
        onFireSkill,
        onOpenView,
        onOpenAtom,
        onPromptAgent,
        onOpenSketch: () =>
          window.dispatchEvent(new CustomEvent(OPEN_SKETCH_EVENT)),
      }),
    [
      savedCommands,
      skills,
      views,
      onClose,
      onFireCommand,
      onFireSkill,
      onOpenView,
      onOpenAtom,
      onPromptAgent,
    ],
  )

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    if (!q) return commands
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q) ||
        c.editPath?.toLowerCase().includes(q) ||
        c.keywords?.some((keyword) => keyword.toLowerCase().includes(q)),
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
          {paletteLoading ? (
            <SidebarRowsSkeleton rows={6} className="px-2" />
          ) : filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">
              No actions match.
            </div>
          ) : (
            filtered.map((c, i) => {
              const showSection =
                i === 0 || filtered[i - 1]?.section !== c.section
              return (
                <div key={c.id}>
                  {showSection && (
                    <div className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                      {c.section}
                    </div>
                  )}
                  <div
                    onMouseEnter={() => setCursor(i)}
                    className={`group relative flex items-center gap-1 px-2 py-0.5 transition-colors ${
                      i === cursor
                        ? 'bg-hover text-ink-strong'
                        : 'text-ink hover:bg-hover'
                    }`}
                  >
                    {i === cursor && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-ink-strong" />
                    )}
                    <button
                      type="button"
                      onClick={c.run}
                      className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <PaletteEntryIcon entry={c} />
                          <span className="text-[13px] truncate font-medium">
                            {c.title}
                          </span>
                        </span>
                        {c.hint && (
                          <span className="text-[10.5px] text-ink-faint shrink-0 font-mono">
                            {c.hint}
                          </span>
                        )}
                      </span>
                    </button>
                    {c.edit && c.editPath && (
                      <button
                        type="button"
                        title={`Open ${c.editPath}`}
                        aria-label={`Open ${c.editPath}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          c.edit?.()
                        }}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 transition-opacity hover:bg-elevated hover:text-ink group-hover:opacity-100 focus:opacity-100"
                      >
                        <FilePenLine className="size-3.5" strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })
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

function PaletteEntryIcon({ entry }: { entry: CommandPaletteEntry }) {
  if (entry.kind === 'command') {
    return (
      <SquareTerminal
        className="size-3 text-accent shrink-0"
        strokeWidth={2.2}
        aria-hidden
      />
    )
  }
  if (entry.kind === 'skill') {
    return (
      <Sparkles
        className="size-3 text-violet-500 shrink-0"
        strokeWidth={2.2}
        aria-hidden
      />
    )
  }
  if (entry.kind === 'view') {
    return (
      <AppWindow
        className="size-3 text-accent shrink-0"
        strokeWidth={2.2}
        aria-hidden
      />
    )
  }
  if (entry.id === 'sys.insert-ascii-sketch') {
    return (
      <PencilLine
        className="size-3 text-ink-faint shrink-0"
        strokeWidth={2.2}
        aria-hidden
      />
    )
  }
  return (
    <Bot
      className="size-3 text-ink-faint shrink-0"
      strokeWidth={2.2}
      aria-hidden
    />
  )
}
