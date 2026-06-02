import { useId, useRef, useState, type ComponentType } from 'react'
import {
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import {
  SidebarAccountFooter,
  SidebarHeader,
  type SidebarUser,
} from './SidebarChrome'
import { useDialogFocus } from '../lib/dialog-focus'

type FolderLike = { path: string }
type FileLike = { path: string }

export type AgentThreadSummary = {
  threadId: string
  projectPath: string | null
  title: string
  createdAt: number
  updatedAt: number
  pinnedAt: number | null
  agentProviderId?: string | null
  agentModel?: string | null
  agentReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null
}

function isUserProjectPath(path: string | null | undefined) {
  const clean = (path ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!clean) return false
  return !clean.split('/').some((segment) => segment.startsWith('.'))
}

export function topLevelProjects(
  folders: ReadonlyArray<FolderLike>,
  files: ReadonlyArray<FileLike>,
  threads: ReadonlyArray<AgentThreadSummary>,
) {
  void folders
  void files
  const projects = new Set<string>()
  const add = (path: string | null | undefined) => {
    const clean = (path ?? '').trim().replace(/^\/+|\/+$/g, '')
    if (!isUserProjectPath(clean)) return
    projects.add(clean)
  }
  for (const thread of threads) add(thread.projectPath)
  return [...projects].sort((a, b) => a.localeCompare(b))
}

export function availableProjectFolders(
  folders: ReadonlyArray<FolderLike>,
  files: ReadonlyArray<FileLike>,
) {
  const options = new Set<string>()
  const addFolderPath = (path: string) => {
    const clean = path.trim().replace(/^\/+|\/+$/g, '')
    if (!clean) return
    const parts = clean.split('/').filter(Boolean)
    if (parts.some((part) => part.startsWith('.'))) return
    const last = parts[parts.length - 1] ?? ''
    const folderParts = /\.[a-z0-9]+$/i.test(last) ? parts.slice(0, -1) : parts
    for (let i = 1; i <= folderParts.length; i++) {
      options.add(folderParts.slice(0, i).join('/'))
    }
  }
  for (const folder of folders) addFolderPath(folder.path)
  for (const file of files) addFolderPath(file.path)
  return [...options].sort((a, b) => a.localeCompare(b))
}

function ageLabel(updatedAt: number) {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function latestThread(
  threads: ReadonlyArray<AgentThreadSummary>,
  projectPath: string | null,
) {
  return threads
    .filter((thread) => thread.projectPath === projectPath)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

type SidebarActionResult = void | Promise<void>

export function AgentChatSidebar({
  files,
  folders,
  threads,
  activeThreadId,
  activeProjectPath,
  onSelectThread,
  onNewThread,
  onCreateProject,
  onTogglePinned,
  onDeleteThread,
  onRenameThread,
  onRenameProject,
  onOpenSearch,
  user,
}: {
  files: ReadonlyArray<FileLike>
  folders: ReadonlyArray<FolderLike>
  threads: ReadonlyArray<AgentThreadSummary>
  activeThreadId: string | null
  activeProjectPath: string | null
  onSelectThread: (thread: AgentThreadSummary) => void
  onNewThread: (projectPath: string | null) => void
  onCreateProject: (mode: 'scratch' | 'existing') => void
  onTogglePinned: (thread: AgentThreadSummary) => SidebarActionResult
  onDeleteThread: (thread: AgentThreadSummary) => SidebarActionResult
  onRenameThread: (
    thread: AgentThreadSummary,
    title: string,
  ) => SidebarActionResult
  onRenameProject: (projectPath: string, nextPath: string) => SidebarActionResult
  onOpenSearch: () => void
  user: SidebarUser
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  )
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null)
  const [projectMenuPath, setProjectMenuPath] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<
    | { kind: 'chat'; thread: AgentThreadSummary }
    | { kind: 'project'; projectPath: string }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentThreadSummary | null>(
    null,
  )
  const projects = topLevelProjects(folders, files, threads)
  const workspaceThreads = threads.filter((thread) => thread.projectPath === null)
  const activeScopeLabel = activeProjectPath ?? 'workspace'

  function toggleProject(projectPath: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectPath)) next.delete(projectPath)
      else next.add(projectPath)
      return next
    })
  }

  return (
    <aside className="flex h-screen min-w-0 flex-col overflow-hidden border-r border-rule bg-panel">
      <SidebarHeader
        onOpenSearch={onOpenSearch}
        onCreate={() => onNewThread(activeProjectPath)}
        createLabel={`new chat in ${activeScopeLabel}`}
      />

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="group/projects relative mb-2 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Projects
          </h2>
          <button
            type="button"
            onClick={() => setProjectMenuOpen((open) => !open)}
            className="grid size-6 place-items-center rounded-md text-ink-faint opacity-0 transition-[opacity,color,background] hover:bg-hover hover:text-ink group-hover/projects:opacity-100 focus-visible:opacity-100"
            title="New project"
            aria-label="new project"
          >
            <FolderPlus className="size-4" strokeWidth={1.8} />
          </button>
          {projectMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setProjectMenuOpen(false)}
              />
              <div className="absolute right-0 top-8 z-30 w-56 overflow-hidden rounded-lg border border-rule bg-elevated p-1 shadow-modal">
                <button
                  type="button"
                  onClick={() => {
                    setProjectMenuOpen(false)
                    onCreateProject('scratch')
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] font-medium text-ink hover:bg-hover"
                >
                  <FolderPlus className="size-4 text-ink-dim" strokeWidth={1.8} />
                  <span className="truncate">Start from scratch</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProjectMenuOpen(false)
                    onCreateProject('existing')
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] font-medium text-ink hover:bg-hover"
                >
                  <Folder className="size-4 text-ink-dim" strokeWidth={1.8} />
                  <span className="truncate">Use existing folder</span>
                </button>
              </div>
            </>
          )}
        </div>
        <div className="space-y-1">
          {projects.length === 0 ? (
            <p className="px-1 py-2 text-[12px] leading-relaxed text-ink-faint">
              Create a project chat when a folder deserves its own context.
            </p>
          ) : (
            projects.map((projectPath) => {
              const projectThreads = threads.filter(
                (thread) => thread.projectPath === projectPath,
              )
              const collapsed = collapsedProjects.has(projectPath)
              const draftActive =
                activeProjectPath === projectPath && activeThreadId === null
              const latest = latestThread(threads, projectPath)
              return (
                <div key={projectPath}>
                  <div
                    className={`group/project relative flex h-8 w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-left outline-none transition-colors ${
                      draftActive
                        ? 'bg-hover text-ink-strong'
                        : 'text-ink-dim hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleProject(projectPath)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={collapsed ? 'expand project' : 'collapse project'}
                    >
                      {collapsed ? (
                        <Folder
                          className="size-4 shrink-0 opacity-75"
                          strokeWidth={1.8}
                        />
                      ) : (
                        <FolderOpen
                          className="size-4 shrink-0 opacity-75"
                          strokeWidth={1.8}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {projectPath}
                      </span>
                      {latest && !projectMenuPath && (
                        <span className="shrink-0 text-[10.5px] text-ink-faint group-hover/project:hidden">
                          {ageLabel(latest.updatedAt)}
                        </span>
                      )}
                    </button>
                    <span className="ml-auto hidden items-center gap-0.5 group-hover/project:flex group-focus-within/project:flex">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onNewThread(projectPath)
                        }}
                        className="grid size-5 place-items-center rounded text-ink-faint hover:bg-hover hover:text-ink"
                        title="New chat"
                        aria-label={`new chat in ${projectPath}`}
                      >
                        <SquarePen className="size-3" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setProjectMenuPath((current) =>
                            current === projectPath ? null : projectPath,
                          )
                          setThreadMenuId(null)
                        }}
                        className="grid size-5 place-items-center rounded text-ink-faint hover:bg-hover hover:text-ink"
                        title="More"
                        aria-label={`project actions for ${projectPath}`}
                      >
                        <MoreHorizontal className="size-3.5" strokeWidth={2} />
                      </button>
                    </span>
                    {projectMenuPath === projectPath && (
                      <ProjectMenu
                        onClose={() => setProjectMenuPath(null)}
                        onNewChat={() => {
                          setProjectMenuPath(null)
                          onNewThread(projectPath)
                        }}
                        onRename={() => {
                          setProjectMenuPath(null)
                          setRenameTarget({ kind: 'project', projectPath })
                        }}
                      />
                    )}
                  </div>
                  {!collapsed && (
                    <div className="ml-6 mt-0.5 space-y-0.5">
                      {projectThreads.slice(0, 6).map((thread) => (
                        <ThreadButton
                          key={thread.threadId}
                          thread={thread}
                          active={thread.threadId === activeThreadId}
                          menuOpen={threadMenuId === thread.threadId}
                          onClick={() => onSelectThread(thread)}
                          onTogglePinned={() => onTogglePinned(thread)}
                          onRequestDelete={() => setDeleteTarget(thread)}
                          onRequestRename={() =>
                            setRenameTarget({ kind: 'chat', thread })
                          }
                          onMenuToggle={() => {
                            setThreadMenuId((current) =>
                              current === thread.threadId
                                ? null
                                : thread.threadId,
                            )
                            setProjectMenuPath(null)
                          }}
                          onMenuClose={() => setThreadMenuId(null)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="group/chats mb-2 mt-6 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Chats
          </h2>
          <button
            type="button"
            onClick={() => onNewThread(null)}
            className="grid size-6 place-items-center rounded-md text-ink-faint opacity-0 transition-[opacity,color,background] hover:bg-hover hover:text-ink group-hover/chats:opacity-100 focus-visible:opacity-100"
            title="New chat"
            aria-label="new workspace chat"
          >
            <SquarePen className="size-3.5" strokeWidth={1.8} />
          </button>
        </div>
        <div className="space-y-0.5">
          {workspaceThreads.length === 0 ? (
            <button
              type="button"
              onClick={() => onNewThread(null)}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium transition-colors ${
                activeProjectPath === null && activeThreadId === null
                  ? 'bg-hover text-ink-strong'
                  : 'text-ink-dim hover:bg-hover hover:text-ink'
              }`}
            >
              <MessageSquare className="size-4" strokeWidth={1.8} />
              <span className="truncate">Workspace chat</span>
            </button>
          ) : (
            workspaceThreads.slice(0, 8).map((thread) => (
              <ThreadButton
                key={thread.threadId}
                thread={thread}
                active={thread.threadId === activeThreadId}
                menuOpen={threadMenuId === thread.threadId}
                onClick={() => onSelectThread(thread)}
                onTogglePinned={() => onTogglePinned(thread)}
                onRequestDelete={() => setDeleteTarget(thread)}
                onRequestRename={() => setRenameTarget({ kind: 'chat', thread })}
                onMenuToggle={() => {
                  setThreadMenuId((current) =>
                    current === thread.threadId ? null : thread.threadId,
                  )
                  setProjectMenuPath(null)
                }}
                onMenuClose={() => setThreadMenuId(null)}
              />
            ))
          )}
        </div>
      </div>

      <WorkspaceSwitcher />
      <SidebarAccountFooter user={user} />

      {renameTarget && (
        <RenameDialog
          title={
            renameTarget.kind === 'chat' ? 'Rename chat' : 'Rename project'
          }
          label={renameTarget.kind === 'chat' ? 'Chat name' : 'Project folder'}
          initialValue={
            renameTarget.kind === 'chat'
              ? renameTarget.thread.title
              : renameTarget.projectPath
          }
          onClose={() => setRenameTarget(null)}
          onSubmit={async (value) => {
            if (renameTarget.kind === 'chat') {
              await onRenameThread(renameTarget.thread, value)
            } else {
              await onRenameProject(renameTarget.projectPath, value)
            }
            setRenameTarget(null)
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete chat"
          body={`Delete "${deleteTarget.title}"? This removes the chat from your history.`}
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await onDeleteThread(deleteTarget)
            setDeleteTarget(null)
          }}
        />
      )}
    </aside>
  )
}

function ProjectMenu({
  onClose,
  onNewChat,
  onRename,
}: {
  onClose: () => void
  onNewChat: () => void
  onRename: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-1 top-7 z-30 w-48 overflow-hidden rounded-lg border border-rule bg-elevated p-1 shadow-modal">
        <MenuButton icon={SquarePen} label="New chat" onClick={onNewChat} />
        <MenuButton icon={Pencil} label="Rename project" onClick={onRename} />
      </div>
    </>
  )
}

function ThreadButton({
  thread,
  active,
  menuOpen,
  onClick,
  onTogglePinned,
  onRequestDelete,
  onRequestRename,
  onMenuToggle,
  onMenuClose,
}: {
  thread: AgentThreadSummary
  active: boolean
  menuOpen: boolean
  onClick: () => void
  onTogglePinned: () => SidebarActionResult
  onRequestDelete: () => void
  onRequestRename: () => void
  onMenuToggle: () => void
  onMenuClose: () => void
}) {
  return (
    <div
      className={`group/thread relative flex h-8 w-full cursor-pointer items-center gap-1 rounded-md px-2 text-left transition-colors ${
        active
          ? 'bg-hover text-ink-strong'
          : 'text-ink-dim hover:bg-hover hover:text-ink'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="absolute inset-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        aria-label={`Open chat ${thread.title}`}
        aria-current={active ? 'page' : undefined}
      />
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-ink-strong" />
      )}
      <span className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-2 text-left">
        <MessageSquare className="size-3.5 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {thread.title}
        </span>
      </span>
      {thread.pinnedAt !== null && (
        <Pin
          className="pointer-events-none relative z-[1] size-3 shrink-0 text-accent group-hover/thread:hidden group-focus-within/thread:hidden"
          strokeWidth={2}
        />
      )}
      <span className="pointer-events-none relative z-[1] shrink-0 text-[10.5px] text-ink-faint group-hover/thread:hidden group-focus-within/thread:hidden">
        {ageLabel(thread.updatedAt)}
      </span>
      <span className="relative z-10 ml-auto hidden items-center gap-0.5 group-hover/thread:flex group-focus-within/thread:flex">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void onTogglePinned()
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-elevated hover:text-ink"
          title={thread.pinnedAt === null ? 'Pin chat' : 'Unpin chat'}
          aria-label={thread.pinnedAt === null ? 'pin chat' : 'unpin chat'}
        >
          <Pin className="size-3" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRequestDelete()
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-elevated hover:text-danger"
          title="Delete chat"
          aria-label="delete chat"
        >
          <Trash2 className="size-3" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onMenuToggle()
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-elevated hover:text-ink"
          title="More"
          aria-label={`more actions for ${thread.title}`}
        >
          <MoreHorizontal className="size-3.5" strokeWidth={2} />
        </button>
      </span>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={onMenuClose} />
          <div className="absolute right-1 top-7 z-30 w-44 overflow-hidden rounded-lg border border-rule bg-elevated p-1 shadow-modal">
            <MenuButton
              icon={Pin}
              label={thread.pinnedAt === null ? 'Pin chat' : 'Unpin chat'}
              onClick={() => {
                onMenuClose()
                void onTogglePinned()
              }}
            />
            <MenuButton
              icon={Pencil}
              label="Rename chat"
              onClick={() => {
                onMenuClose()
                onRequestRename()
              }}
            />
            <MenuButton
              icon={Trash2}
              label="Delete chat"
              danger
              onClick={() => {
                onMenuClose()
                onRequestDelete()
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function MenuButton({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] font-medium hover:bg-hover ${
        danger ? 'text-danger' : 'text-ink'
      }`}
    >
      <Icon className="size-3.5 shrink-0 text-ink-dim" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function RenameDialog({
  title,
  label,
  initialValue,
  onClose,
  onSubmit,
}: {
  title: string
  label: string
  initialValue: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void>
}) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLElement>({
    initialFocusRef: inputRef,
    onEscape: onClose,
  })

  async function commit() {
    const clean = value.trim()
    if (!clean) {
      setError(`${label} is required.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSubmit(clean)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-backdrop px-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        tabIndex={-1}
        aria-hidden="true"
        aria-label="close dialog"
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="relative w-[360px] max-w-full rounded-lg border border-rule bg-elevated p-4 shadow-modal"
      >
        <h3 id={titleId} className="text-[14px] font-semibold text-ink-strong">
          {title}
        </h3>
        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          {label}
        </label>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
          className="mt-2 h-9 w-full rounded-md border border-rule bg-page px-2.5 text-[13px] text-ink outline-none focus:border-rule-strong"
        />
        {error && (
          <p className="mt-2 rounded-md border border-danger/30 bg-danger-soft px-2 py-1.5 text-[11.5px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-rule bg-elevated px-3 text-[12.5px] font-medium text-ink-dim hover:bg-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={saving}
            className="h-8 rounded-md bg-ink-strong px-3 text-[12.5px] font-medium text-surface hover:bg-accent-hover disabled:bg-ink-ghost"
          >
            Save
          </button>
        </div>
      </section>
    </div>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string
  body: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const titleId = useId()
  const bodyId = useId()
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLElement>({
    initialFocusRef: cancelRef,
    onEscape: onClose,
  })

  async function commit() {
    setSaving(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-backdrop px-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        tabIndex={-1}
        aria-hidden="true"
        aria-label="close dialog"
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="relative w-[360px] max-w-full rounded-lg border border-rule bg-elevated p-4 shadow-modal"
      >
        <h3 id={titleId} className="text-[14px] font-semibold text-ink-strong">
          {title}
        </h3>
        <p id={bodyId} className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
          {body}
        </p>
        {error && (
          <p className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-2 py-1.5 text-[11.5px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-rule bg-elevated px-3 text-[12.5px] font-medium text-ink-dim hover:bg-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={saving}
            className="h-8 rounded-md bg-danger px-3 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:bg-ink-ghost"
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
