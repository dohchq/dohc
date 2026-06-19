import { useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import type { CloudApi, CloudWorkspace } from './cloudApi'

// Cloud workspace access: lists the signed-in user's workspaces from
// GET /workspaces. Workspace home URLs route by workspace id.
export function WorkspaceList({ api }: { api: CloudApi }) {
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listWorkspaces()
      .then((rows) => {
        if (!cancelled) setWorkspaces(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your workspaces.')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  if (error) {
    return (
      <p role="alert" className="px-6 py-10 text-center text-[13px] text-danger">
        {error}
      </p>
    )
  }
  if (workspaces === null) {
    return (
      <p className="px-6 py-10 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        loading workspaces…
      </p>
    )
  }
  if (workspaces.length === 0) {
    return (
      <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-ink-dim">
        No cloud workspaces yet. Sync one from the desktop app to see it here.
      </p>
    )
  }
  return (
    <ul data-testid="workspace-list" className="flex flex-col gap-2">
      {workspaces.map((workspace) => (
        <li key={workspace.workspaceId}>
          <a
            href={`/${encodeURIComponent(workspace.workspaceId)}`}
            data-testid="workspace-link"
            className="flex items-center gap-3 rounded-lg border border-rule bg-surface px-4 py-3 transition-colors hover:bg-hover"
          >
            <Folder className="size-4 shrink-0 text-ink-dim" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
              {workspace.name || workspace.workspaceId}
            </span>
            <span aria-hidden className="text-ink-faint">
              →
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
