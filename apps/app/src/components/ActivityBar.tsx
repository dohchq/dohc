import { Files, Workflow, Puzzle } from 'lucide-react'

// graph-v1 1c — VSCode-style activity bar (icon rail). Switches the
// primary view: Files (explorer + editor), Graph, Plugins.
export type ActivityView = 'atom' | 'graph' | 'plugins'

const ITEMS: Array<{
  view: ActivityView
  label: string
  Icon: typeof Files
}> = [
  { view: 'atom', label: 'Files', Icon: Files },
  { view: 'graph', label: 'Graph', Icon: Workflow },
  { view: 'plugins', label: 'Plugins', Icon: Puzzle },
]

export function ActivityBar({
  view,
  onSelect,
}: {
  view: ActivityView
  onSelect: (view: ActivityView) => void
}) {
  return (
    <nav className="flex h-screen w-12 flex-col items-center gap-1 border-r border-rule bg-panel py-3">
      {ITEMS.map(({ view: v, label, Icon }) => {
        const active = view === v
        return (
          <button
            key={v}
            type="button"
            onClick={() => onSelect(v)}
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={`relative grid size-9 place-items-center rounded-md transition-colors ${
              active
                ? 'text-ink-strong'
                : 'text-ink-faint hover:text-ink-dim hover:bg-hover'
            }`}
          >
            {active && (
              <span className="absolute left-[-12px] top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-ink-strong" />
            )}
            <Icon className="size-[18px]" strokeWidth={1.9} />
          </button>
        )
      })}
    </nav>
  )
}
