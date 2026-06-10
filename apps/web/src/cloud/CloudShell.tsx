import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FileText, PanelLeft } from 'lucide-react'
import { DohcLogo } from '@dohc/brand'
import type { DohcBackendClient, WorkspaceFile } from '../backend/backendClient'
import { createDohcBackendClient } from '../backend/postgresBackendClient'
import { buildTree, nodeLabel, type TreeNode } from '../lib/path-tree'
import { UploadFileButton } from '../components/UploadFileButton'
import { useCloudSession } from './session'
import { FileViewer } from './FileViewer'

type FilesState =
  | { status: 'loading' }
  | { status: 'ready'; files: WorkspaceFile[] }
  | { status: 'error'; message: string }

// The compact dohc Cloud workspace shell: file tree + viewer/editor over
// the DohcBackendClient seam. Single-pane on narrow viewports — the tree
// overlays behind the panel toggle; viewing stays mobile-friendly.
export function CloudShell({
  workspaceId,
  backendClient,
}: {
  workspaceId: string
  backendClient?: DohcBackendClient
}) {
  const session = useCloudSession()
  const client = useMemo(
    () => backendClient ?? createDohcBackendClient({ workspaceId }),
    [backendClient, workspaceId],
  )
  const [filesState, setFilesState] = useState<FilesState>({ status: 'loading' })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const loadFiles = useCallback(async () => {
    try {
      const files = await client.listFiles()
      setFilesState({ status: 'ready', files })
    } catch (error) {
      setFilesState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not load files.',
      })
    }
  }, [client])

  useEffect(() => {
    setFilesState({ status: 'loading' })
    setSelectedPath(null)
    void loadFiles()
  }, [loadFiles])

  const files = filesState.status === 'ready' ? filesState.files : []
  const tree = useMemo(() => buildTree(files), [files])
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null

  async function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('newFileName') as HTMLInputElement
    const raw = input.value.trim().replace(/^\/+|\/+$/g, '')
    if (!raw) return
    const path = /\.[a-z0-9]+$/i.test(raw) ? raw : `${raw}.md`
    setCreateError(null)
    try {
      await client.createTextFile({ path, body: '', contentType: 'text/markdown' })
      setCreating(false)
      await loadFiles()
      setSelectedPath(path)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the file.')
    }
  }

  const sidebar = (
    <aside
      data-testid="cloud-file-tree"
      className="flex h-full w-[260px] min-w-0 flex-col border-r border-rule bg-panel"
    >
      <div className="flex items-center gap-1 border-b border-rule px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          files
        </span>
        <button
          type="button"
          data-testid="new-file-button"
          onClick={() => {
            setCreating((v) => !v)
            setCreateError(null)
          }}
          className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim hover:bg-hover hover:text-ink"
          title="New file"
          aria-label="New file"
        >
          <FilePlus2 className="size-4" strokeWidth={2} />
        </button>
        <UploadFileButton
          backendClient={client}
          onUploaded={(file) => {
            void loadFiles()
            setSelectedPath(file.path)
          }}
        />
      </div>
      {creating && (
        <form onSubmit={createFile} className="border-b border-rule px-3 py-2">
          <input
            name="newFileName"
            data-testid="new-file-name"
            autoFocus
            placeholder="notes/idea.md"
            className="h-8 w-full rounded-md border border-rule bg-page px-2 font-mono text-[12px] text-ink outline-none focus:border-rule-strong"
          />
          {createError && (
            <p role="alert" className="mt-1 text-[11px] leading-snug text-danger">
              {createError}
            </p>
          )}
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {filesState.status === 'loading' && (
          <p className="px-3 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            loading…
          </p>
        )}
        {filesState.status === 'error' && (
          <p role="alert" className="px-3 py-3 text-[12px] text-danger">
            {filesState.message}
          </p>
        )}
        {filesState.status === 'ready' && files.length === 0 && (
          <p className="px-3 py-3 text-[12px] leading-relaxed text-ink-dim">
            This workspace has no files yet.
          </p>
        )}
        {tree.children.map((node) => (
          <TreeRow
            key={node.fullPath}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={(path) => {
              setSelectedPath(path)
              setTreeOpen(false)
            }}
          />
        ))}
      </div>
    </aside>
  )

  return (
    <div className="flex h-screen min-h-0 flex-col bg-page text-ink">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule bg-surface px-3 sm:px-4">
        <button
          type="button"
          data-testid="tree-toggle"
          onClick={() => setTreeOpen((v) => !v)}
          className="inline-flex size-8 items-center justify-center rounded-md text-ink-dim hover:bg-hover hover:text-ink md:hidden"
          aria-label="Toggle file list"
        >
          <PanelLeft className="size-4" />
        </button>
        <a href="/" className="flex items-center gap-2 text-accent" aria-label="All workspaces">
          <DohcLogo size="sm" />
        </a>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-strong">
          {workspaceId}
        </span>
        <span className="hidden truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint sm:block">
          dohc Cloud
        </span>
        <button
          type="button"
          data-testid="sign-out-button"
          onClick={session.signOut}
          className="h-7 rounded-md px-2.5 text-[12px] text-ink-dim hover:bg-hover hover:text-ink"
        >
          Sign out
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className="hidden h-full md:block">{sidebar}</div>
        {treeOpen && (
          <div className="absolute inset-0 z-20 flex md:hidden">
            <div className="h-full bg-page shadow-md">{sidebar}</div>
            <button
              type="button"
              aria-label="Close file list"
              onClick={() => setTreeOpen(false)}
              className="h-full flex-1 bg-ink/20"
            />
          </div>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedFile ? (
            <FileViewer backendClient={client} file={selectedFile} />
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <p className="max-w-[340px] text-[13px] leading-relaxed text-ink-dim">
                Select a file to read or edit it here. This is your synced cloud
                workspace — open it anywhere.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const isFolder = node.page === null
  const padding = { paddingLeft: `${10 + depth * 14}px` }

  if (isFolder) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={padding}
          className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] text-ink-dim hover:bg-hover"
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{nodeLabel(node)}</span>
        </button>
        {!collapsed &&
          node.children.map((child) => (
            <TreeRow
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    )
  }
  const active = node.page!.path === selectedPath
  return (
    <button
      type="button"
      data-testid="tree-file"
      data-path={node.page!.path}
      onClick={() => onSelect(node.page!.path)}
      style={padding}
      className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] ${
        active ? 'bg-accent-soft text-ink-strong' : 'text-ink hover:bg-hover'
      }`}
    >
      <FileText className="size-3.5 shrink-0 text-ink-faint" />
      <span className="truncate">{nodeLabel(node)}</span>
    </button>
  )
}
