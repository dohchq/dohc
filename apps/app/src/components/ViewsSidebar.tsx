import { FilePenLine, Loader2, PanelsTopLeft } from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import {
  SidebarAccountFooter,
  SidebarHeader,
  type SidebarUser,
} from './SidebarChrome'

type ViewRow = {
  packageRoot: string
  scopePath: string
  title: string
  entryPath: string
}

function groupViews(
  views: ViewRow[],
): Array<{ scopePath: string; views: ViewRow[] }> {
  const grouped = new Map<string, ViewRow[]>()
  for (const view of views) {
    const key = view.scopePath || ''
    const rows = grouped.get(key) ?? []
    rows.push(view)
    grouped.set(key, rows)
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scopePath, rows]) => ({
      scopePath,
      views: rows.sort((a, b) => a.title.localeCompare(b.title)),
    }))
}

export function ViewsSidebar({
  selectedPackageRoot,
  onOpenView,
  onOpenSource,
  onOpenSearch,
  user,
}: {
  selectedPackageRoot: string | null
  onOpenView: (packageRoot: string) => void
  onOpenSource: (path: string) => void
  onOpenSearch?: () => void
  user?: SidebarUser
}) {
  const activeWorkspaceId = useActiveWorkspaceId()
  const result = useQuery(api.views.list, { activeWorkspaceId })
  const views = result?.views ?? []
  const groups = groupViews(views)

  return (
    <aside className="flex h-screen min-w-0 flex-col border-r border-rule bg-panel">
      <SidebarHeader onOpenSearch={onOpenSearch} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <div className="flex min-w-0 items-center gap-2">
            <PanelsTopLeft
              className="size-4 shrink-0 text-ink-dim"
              strokeWidth={1.9}
            />
            <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Views
            </h2>
          </div>
          {result === undefined ? (
            <Loader2
              className="size-3.5 animate-spin text-ink-faint"
              aria-label="loading views"
            />
          ) : (
            <span className="font-mono text-[10.5px] text-ink-faint">
              {views.length}
            </span>
          )}
        </div>

        {result !== undefined && views.length === 0 ? (
          <div className="px-2 py-8 text-center text-[12px] leading-relaxed text-ink-faint">
            No views yet.
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={group.scopePath || 'workspace'} className="mb-3">
            <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {group.scopePath || 'Workspace'}
            </div>
            <div className="space-y-0.5">
              {group.views.map((view) => {
                const selected = selectedPackageRoot === view.packageRoot
                return (
                  <div
                    key={view.packageRoot}
                    className={`group flex items-center gap-1 rounded-md ${
                      selected ? 'bg-hover text-ink-strong' : 'text-ink'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenView(view.packageRoot)}
                      className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                      aria-current={selected ? 'page' : undefined}
                    >
                      {view.title}
                    </button>
                    <button
                      type="button"
                      title={`Open source ${view.entryPath}`}
                      aria-label={`Open source ${view.entryPath}`}
                      onClick={() => onOpenSource(view.entryPath)}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 transition-opacity hover:bg-elevated hover:text-ink group-hover:opacity-100 focus:opacity-100"
                    >
                      <FilePenLine className="size-3.5" strokeWidth={2} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        {result?.truncated ? (
          <div className="mt-4 border-t border-rule px-2 pt-3 text-[11px] leading-relaxed text-ink-faint">
            Showing the first scan window.
          </div>
        ) : null}
      </div>

      <WorkspaceSwitcher />
      <SidebarAccountFooter user={user ?? null} />
    </aside>
  )
}
