import {
  FileDiff,
  Folder,
  ListChecks,
} from 'lucide-react'
import { memo, useMemo, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export type AgentRailFileRow = {
  path: string
  type?: 'html' | 'skill' | 'command' | null
  updatedAt?: number
  source?: string
}

type ActiveThread = {
  threadId: string
  title: string
  projectPath: string | null
  createdAt: number
  updatedAt: number
  pinnedAt?: number | null
}

function normalizeProjectPath(projectPath: string | null): string | null {
  const normalized = projectPath?.trim().replace(/^\/+|\/+$/g, '') ?? ''
  return normalized.length > 0 ? normalized : null
}

export function isWithinProject(
  path: string,
  projectPath: string | null,
): boolean {
  const normalized = normalizeProjectPath(projectPath)
  if (!normalized) return true
  return path === normalized || path.startsWith(`${normalized}/`)
}

export function agentRailScopedFiles(
  files: AgentRailFileRow[],
  projectPath: string | null,
): AgentRailFileRow[] {
  const activeProjectPath = normalizeProjectPath(projectPath)
  return activeProjectPath
    ? files.filter((file) => isWithinProject(file.path, activeProjectPath))
    : files
}

export function agentRailChangeSummary(
  files: AgentRailFileRow[],
  projectPath: string | null,
  since: number | null,
): {
  changedCount: number
  agentCount: number
  userCount: number
  changedPaths: string[]
} {
  if (since === null) {
    return {
      changedCount: 0,
      agentCount: 0,
      userCount: 0,
      changedPaths: [],
    }
  }
  const changed = agentRailScopedFiles(files, projectPath).filter(
    (file) => (file.updatedAt ?? 0) >= since,
  )
  return {
    changedCount: changed.length,
    agentCount: changed.filter((file) => (file.source ?? 'agent') !== 'user')
      .length,
    userCount: changed.filter((file) => file.source === 'user').length,
    changedPaths: changed.map((file) => file.path),
  }
}

export const AgentRunRail = memo(function AgentRunRail({
  files,
  activeThread,
  projectPath,
}: {
  files: AgentRailFileRow[]
  activeThread: ActiveThread | null
  projectPath: string | null
}) {
  const activeProjectPath = normalizeProjectPath(projectPath)
  const changes = useMemo(
    () =>
      agentRailChangeSummary(
        files,
        activeProjectPath,
        activeThread?.createdAt ?? null,
      ),
    [activeProjectPath, activeThread?.createdAt, files],
  )
  const scopeLabel = activeProjectPath ?? 'Whole workspace'

  return (
    <aside className="flex h-screen min-w-0 flex-col border-l border-rule bg-panel px-4 py-5">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        <RailSection title="Progress" Icon={ListChecks}>
          {activeThread ? (
            <div className="rounded-md border border-rule bg-page px-2.5 py-2 text-[11.5px] leading-snug text-ink-dim">
              <span className="block truncate font-medium text-ink-strong">
                {activeThread.title}
              </span>
              <span className="mt-0.5 block text-ink-faint">Chat active</span>
            </div>
          ) : (
            <EmptyLine label="No active run" />
          )}
        </RailSection>

        <RailSection title="Environment" Icon={Folder}>
          <div className="flex flex-col gap-1.5">
            <MetricRow
              Icon={FileDiff}
              label="Changes"
              value={<ChangesValue changes={changes} />}
              title="Files touched since this chat started"
            />
            <MetricRow
              Icon={Folder}
              label="Scope"
              value={scopeLabel}
              title="Current chat scope"
            />
          </div>
        </RailSection>
      </div>
    </aside>
  )
})

function RailSection({
  title,
  Icon,
  children,
}: {
  title: string
  Icon: LucideIcon
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-ink-faint">
        <Icon className="size-3.5" strokeWidth={2} />
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em]">
          {title}
        </p>
      </div>
      {children}
    </section>
  )
}

function MetricRow({
  Icon,
  label,
  value,
  title,
}: {
  Icon: LucideIcon
  label: string
  value: ReactNode
  title: string
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-2.5 rounded-md px-0.5 py-1"
      title={title}
    >
      <Icon className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-strong">
        {label}
      </span>
      <span className="min-w-0 max-w-[150px] truncate text-right font-mono text-[11px] text-ink-faint">
        {value}
      </span>
    </div>
  )
}

function ChangesValue({
  changes,
}: {
  changes: ReturnType<typeof agentRailChangeSummary>
}) {
  if (changes.changedCount === 0) {
    return <span className="text-ink-faint">none</span>
  }
  return (
    <span className="inline-flex items-center justify-end gap-1">
      <span className="text-success">+{changes.changedCount}</span>
      <span className="text-ink-faint">
        file{changes.changedCount === 1 ? '' : 's'}
      </span>
    </span>
  )
}

function EmptyLine({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-rule px-2.5 py-2 text-[11.5px] leading-snug text-ink-faint">
      {label}
    </div>
  )
}
