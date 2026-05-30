import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Sparkles,
  Folder,
  FolderOpen,
  Smile,
  FilePlus,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  AlertTriangle,
  Moon,
  Sun,
  Monitor,
  Lock,
  Star,
  Palette,
  Share2,
  Search,
  Brain,
  User,
  Target,
  Building2,
  SquareTerminal,
} from 'lucide-react'
import { FolderPicker } from './FolderPicker'
import { EmojiPicker } from './EmojiPicker'
import { DohcMark } from './DohcLogo'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { useTheme } from '@/lib/use-theme'
import {
  buildTree,
  nodeLabel,
  ancestors,
  type FileRow,
  type TreeNode,
  type FolderInput,
} from '@/lib/path-tree'
import { navigateTree, type FlatRow } from '@/lib/file-tree-nav'
import { colorVarFor } from '@/lib/folderTokens'
import { planDrop, type DragSource } from '@/lib/file-tree-dnd'

type Props = {
  files: FileRow[]
  // file-org-v1 v9 fold (Codex R8-6) — union: legacy string[] OR
  // the rich shape returned by api.folders.list.
  folders: FolderInput[]
  activePath: string | null
  view: 'atom'
  user: { email?: string | null; firstName?: string | null } | null
  onOpen: (path: string) => void
  onCreatePage: (name: string) => Promise<void>
  onCreateFolder: (name: string) => Promise<void>
  onDeleteFolder: (path: string) => Promise<void>
  onRenameFolder: (path: string, nextPath: string) => Promise<void>
  onDeleteFile: (path: string) => Promise<void>
  onRenameFile: (path: string, nextPath: string) => Promise<void>
  // file-org-v1 D4.4a — lock + star toggles wired from index.tsx to
  // the api.atoms.setLock + api.atoms.setStar mutations. Optional
  // so the existing index.tsx callsite compiles before it wires
  // them up (the L/S keyboard shortcuts no-op until wired).
  onToggleLock?: (path: string, currentlyLocked: boolean) => Promise<void>
  onToggleStar?: (path: string, currentlyStarred: boolean) => Promise<void>
  // file-org-v1 D4.5 — folder-level star (impressions.md line 39:
  // "favorite/star a file/folder"). S key on a folder row wires
  // here. Optional like the file-level handlers.
  onToggleFolderStar?: (
    path: string,
    currentlyStarred: boolean,
  ) => Promise<void>
  // file-org-v1 D4.5b — folder customization (icon + color + star
  // in one shot). Wired to api.folders.setMeta. Optional so the
  // existing index.tsx compiles before wiring.
  onSetFolderMeta?: (
    path: string,
    next: { icon: string | null; color: string | null; starred: boolean },
  ) => Promise<void>
  // file-org-v1 D4.7 — drag-and-drop move handlers. The component
  // computes the {fromPath, toPath} pair via planDrop; index.tsx
  // dispatches to api.atoms.move OR api.folders.move depending on
  // the source kind. Optional so the parent can opt out (DnD is
  // a progressive enhancement; tree still works without it).
  onMoveFile?: (fromPath: string, toPath: string) => Promise<void>
  onMoveFolder?: (fromPath: string, toPath: string) => Promise<void>
  // emoji-icons — set/clear a file's icon emoji (empty string clears).
  onSetFileIcon?: (path: string, icon: string) => Promise<void>
  // sharing-v1 1a — the "Shared with me" section (VSCode-style second
  // explorer group). Files shared TO this user; opening one routes to
  // /shared/<shareId>.
  sharedWithMe?: Array<{
    shareId: string
    fileId: string
    path: string
    title: string | null
    permission: 'view' | 'edit'
    available: boolean
  }>
  sharedByMeFileIds?: string[]
  activeShareId?: string | null
  onOpenShared?: (shareId: string) => void
  // Opens the full-content search overlay (⌘⇧F).
  onOpenSearch?: () => void
}

// Optional tree-level presence context. v2 live presence is owned by
// Hocuspocus/Y.Awareness inside the editor; FileTree currently passes an
// empty set after the v1 Convex presence table was removed. The context
// keeps the row rendering path stable if we later project awareness into
// the sidebar.
//
// Default value = empty set so the context works outside
// FileTree (e.g. tests that mount a single TreeRowNode in
// isolation; not a current use case but avoids hard-coded
// undefined checks at every consumer).
const PresenceContext = createContext<ReadonlySet<string>>(new Set())

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function readSectionOpen(key: string, dflt: boolean): boolean {
  if (typeof window === 'undefined') return dflt
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? dflt : v === '1'
  } catch {
    return dflt
  }
}

function writeSectionOpen(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? '1' : '0')
  } catch {
    // localStorage unavailable / quota — non-fatal.
  }
}

/** A section's open/closed state, persisted to localStorage by key. */
function usePersistedSectionToggle(key: string, dflt: boolean) {
  const [open, setOpen] = useState(() => readSectionOpen(key, dflt))
  useEffect(() => {
    writeSectionOpen(key, open)
  }, [key, open])
  return [open, setOpen] as const
}

/**
 * A collapsible sidebar section, VSCode-explorer style: a chevron +
 * uppercase label header that toggles a region below it. The header is
 * a real <button> with aria-expanded/aria-controls; the chevron is
 * visual-only. `trailing` holds optional header-right actions (e.g. the
 * "+ new" menu on Personal workspace).
 */
function TreeSection({
  id,
  label,
  open,
  onToggle,
  divider = false,
  trailing,
  children,
}: {
  id: string
  label: string
  open: boolean
  onToggle: () => void
  /** Draw a top rule — the explorer-style separator between sections. */
  divider?: boolean
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={divider ? 'border-t border-rule mt-1 pt-1' : ''}>
      <div className="group flex items-center pl-2.5 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          className="flex flex-1 items-center gap-1 py-1 text-left text-ink-faint hover:text-ink-dim transition-colors"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
          )}
          <span
            id={`${id}-label`}
            className="text-[10px] uppercase tracking-[0.12em] font-medium"
          >
            {label}
          </span>
        </button>
        {trailing}
      </div>
      <div id={id} role="group" aria-labelledby={`${id}-label`} hidden={!open}>
        {open && children}
      </div>
    </div>
  )
}

function contextFileIcon(path: string) {
  if (path === '.context/me.md') return User
  if (path === '.context/intent.md') return Target
  if (path === '.context/company.md') return Building2
  return null
}

export function FileTree({
  files,
  folders,
  activePath,
  view,
  user,
  onOpen,
  onCreatePage,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onDeleteFile,
  onRenameFile,
  onToggleLock,
  onToggleStar,
  onToggleFolderStar,
  onSetFolderMeta,
  onMoveFile,
  onMoveFolder,
  onSetFileIcon,
  sharedWithMe,
  sharedByMeFileIds,
  activeShareId,
  onOpenShared,
  onOpenSearch,
}: Props) {
  // v2: sidebar presence is intentionally quiet for now. Editor carets are the
  // primary live-collaboration UI, and removed v1 Convex presence rows should
  // not be recreated just to light up sidebar dots.
  const presentPathSet = useMemo<ReadonlySet<string>>(() => new Set(), [])
  const sharedByMeIds = useMemo(
    () => new Set(sharedByMeFileIds ?? []),
    [sharedByMeFileIds],
  )

  const tree = useMemo(() => buildTree(files, folders), [files, folders])
  const label = user?.firstName || user?.email?.split('@')[0] || 'signed in'

  // Collapsible-section open state, persisted per section (mirrors the
  // chat-open localStorage pattern in _app.tsx). Personal + Shared
  // both default open.
  const [openPersonal, setOpenPersonal] = usePersistedSectionToggle(
    'dohc-section-personal',
    true,
  )
  const [openShared, setOpenShared] = usePersistedSectionToggle(
    'dohc-section-shared',
    true,
  )

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!activePath) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const a of ancestors(activePath)) next.add(a)
      return next
    })
  }, [activePath])

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // file-org-v1 D4.3 — WAI-ARIA tree keyboard nav. `focusedPath` is
  // the roving-tabIndex anchor: exactly ONE row has tabIndex=0; all
  // others tabIndex=-1. Defaults to activePath so the keyboard user's
  // first Tab into the tree lands on their open file.
  const [focusedPath, setFocusedPath] = useState<string | null>(activePath)
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>())
  // Programmatic DOM focus must follow ONLY keyboard arrow-nav — never
  // the automatic bootstrap re-anchor (which would steal focus from the
  // editor when the open file lives in another section) and never mount
  // (clicks/onFocus already place DOM focus). Set true just before a
  // keyboard-driven setFocusedPath; the focus-DOM effect consumes it.
  const wantDomFocusRef = useRef(false)

  // Flatten the visible rows in render order. This is the lookup the
  // pure nav function uses. Re-derived each render because both
  // `tree` and `expanded` are inputs to visibility.
  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = []
    function walk(node: TreeNode, depth: number, parentPath: string | null) {
      // The synthetic root has fullPath==='' and no presence in
      // visible rows; skip it but recurse its children.
      if (node.fullPath === '') {
        for (const c of node.children) walk(c, depth, parentPath)
        return
      }
      const isFolder = node.page === null
      const isExpanded = isFolder && expanded.has(node.fullPath)
      out.push({
        fullPath: node.fullPath,
        isFolder,
        isExpanded,
        depth,
        parentPath,
      })
      if (isFolder && isExpanded) {
        for (const c of node.children) walk(c, depth + 1, node.fullPath)
      }
    }
    walk(tree, 0, null)
    return out
  }, [tree, expanded])

  // R3 fold (Codex FAIL-4) — re-anchor focusedPath whenever it's
  // stale: either null (no anchor yet) OR pointing at a row that's
  // not currently visible (e.g. activePath='deleted.md' loaded from
  // a previous session). Without this, every treeitem renders with
  // tabIndex=-1 and Tab cannot enter the tree.
  //
  // Priority: prefer activePath if it's visible (continuity with
  // the user's last interaction); else flatRows[0]. flatRows[0]
  // exists because the empty branch renders zero rows; we only
  // bootstrap when there's a row to anchor to.
  useEffect(() => {
    if (flatRows.length === 0) return
    const visible = new Set(flatRows.map((r) => r.fullPath))
    if (focusedPath === null || !visible.has(focusedPath)) {
      const next =
        activePath && visible.has(activePath)
          ? activePath
          : flatRows[0]!.fullPath
      setFocusedPath(next)
    }
  }, [focusedPath, flatRows, activePath])

  // Move DOM focus onto the focused row so the screen reader announces
  // it — but ONLY when a keyboard arrow-nav requested it (wantDomFocus).
  // The bootstrap re-anchor and mount must not grab focus, or opening a
  // file in another section would yank focus off the editor.
  useEffect(() => {
    if (!wantDomFocusRef.current) return
    wantDomFocusRef.current = false
    if (focusedPath === null) return
    const el = rowRefs.current.get(focusedPath)
    if (el && document.activeElement !== el) el.focus({ preventScroll: false })
  }, [focusedPath])

  // file-org-v1 D4.4b — ARIA-live announcer. When the user toggles
  // a lock or star, set this message; the polite live region in
  // the JSX below picks it up. Cleared on a short timer so a
  // screen reader doesn't read stale text on subsequent focus.
  const [announcement, setAnnouncement] = useState<string>('')
  useEffect(() => {
    if (!announcement) return
    const id = window.setTimeout(() => setAnnouncement(''), 2500)
    return () => window.clearTimeout(id)
  }, [announcement])

  // R3 fold (Codex FAIL-3) + R4 fold (Codex FAIL-3 second-pass) —
  // OPTIMISTIC toggle tracker. Keyed by path; value is the
  // intended NEW state of the flag. R3 fold tracked just presence;
  // R4 fold adds the intended value so reads use the optimistic
  // value (not the stale prop) for the racing window between
  // mutation resolve and Convex projection refresh. Removed when
  // the projection catches up (a useEffect on `files` matches the
  // intended flag).
  const pendingLocks = useRef(new Map<string, boolean>())
  const pendingStars = useRef(new Map<string, boolean>())
  const pendingFolderStars = useRef(new Map<string, boolean>())

  // Trigger a render when the optimistic maps mutate so row affordances
  // re-evaluate immediately. The ref is the source of truth; this
  // counter is just a tickle.
  const [, setPendingTick] = useState(0)
  const bumpPending = useCallback(() => setPendingTick((n) => n + 1), [])

  // Reconcile: when the projection finally matches the optimistic
  // intent, drop the entry. Defends against the race where a
  // mutation resolves before Convex re-pushes the new query result.
  useEffect(() => {
    let mutated = false
    for (const [path, intended] of pendingLocks.current) {
      const row = files.find((f) => f.path === path)
      if (row && (row.userLocked === true) === intended) {
        pendingLocks.current.delete(path)
        mutated = true
      }
    }
    for (const [path, intended] of pendingStars.current) {
      const row = files.find((f) => f.path === path)
      if (row && (row.starred === true) === intended) {
        pendingStars.current.delete(path)
        mutated = true
      }
    }
    for (const [path, intended] of pendingFolderStars.current) {
      const f = folders.find((x) =>
        typeof x === 'string' ? x === path : x.path === path,
      )
      const isStarred =
        typeof f === 'string' ? false : f?.starred === true
      if (f !== undefined && isStarred === intended) {
        pendingFolderStars.current.delete(path)
        mutated = true
      }
    }
    if (mutated) bumpPending()
  }, [files, folders, bumpPending])

  // file-org-v1 D4.4a — fast index from path → file row, so the
  // L/S shortcuts can read the current lock/star state and toggle
  // it. Folder rows look up `folderStarByPath` instead.
  const fileByPath = useMemo(() => {
    const m = new Map<string, FileRow>()
    for (const f of files) m.set(f.path, f)
    return m
  }, [files])

  // Optimistic-aware "is this file starred?" — reads the pending
  // override first so a just-clicked/just-pressed star reflects
  // instantly, before the Convex projection catches up.
  const starredOf = useCallback(
    (path: string) => {
      const o = pendingStars.current.get(path)
      return o !== undefined ? o : fileByPath.get(path)?.starred === true
    },
    [fileByPath],
  )

  // Toggle a file's favorite, optimistically. Shared by the row's star
  // button and the Shift+S shortcut so both behave identically.
  const toggleFileStar = useCallback(
    (path: string) => {
      if (!onToggleStar) return
      const current = starredOf(path)
      const willStar = !current
      setAnnouncement(willStar ? 'starring…' : 'unstarring…')
      pendingStars.current.set(path, willStar)
      bumpPending()
      void onToggleStar(path, current).then(
        () => setAnnouncement(willStar ? 'starred' : 'unstarred'),
        () => {
          setAnnouncement('')
          pendingStars.current.delete(path)
          bumpPending()
        },
      )
    },
    [onToggleStar, starredOf, bumpPending],
  )

  // file-org-v1 D4.6 — VSCode-style "create where you're standing".
  // The "+" button (header) creates at the level of the currently
  // FOCUSED row:
  //   • focused row is a FOLDER ⇒ create INSIDE it
  //   • focused row is a FILE ⇒ create AT THE SAME LEVEL (parent
  //     of the file)
  //   • nothing focused / focused row is at root ⇒ create at root
  // The PendingRow renders with this as the placeholder hint
  // ("new page in team/") so the user sees where it's going before
  // typing.
  const targetDir = useMemo(() => {
    if (focusedPath === null) return ''
    // Find the row in flatRows (cheaper than re-walking the tree).
    const row = flatRows.find((r) => r.fullPath === focusedPath)
    if (!row) return ''
    if (row.isFolder) return row.fullPath
    // Leaf row — parent is everything before the last segment.
    return row.parentPath ?? ''
  }, [focusedPath, flatRows])

  // file-org-v1 D4.7 — drag-and-drop state. `dragOverPath` is the
  // ROW the cursor is currently over (for the highlight); empty
  // string is the root drop zone. Source is read off dataTransfer,
  // not state — avoids stale-closure bugs when the user releases
  // over a different row.
  //
  // D4.7b (flicker fix): cleared ONLY by (a) the next row's
  // dragOver naturally overwriting it, (b) the tree-container
  // dragLeave when cursor exits the whole tree, OR (c) a window-
  // level `dragend` when the drag completes/cancels. We do NOT
  // clear in per-row dragLeave — that race between sibling rows
  // (A.leave → null → B.over → 'B') was the flicker source.
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  // D4.7b — global drag-end cleanup. HTML5 dragend fires on the
  // SOURCE element (not the target), but a window listener catches
  // every variant (drop, Escape-cancel, off-window release).
  useEffect(() => {
    function onEnd() {
      setDragOverPath(null)
    }
    window.addEventListener('dragend', onEnd)
    window.addEventListener('drop', onEnd)
    return () => {
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('drop', onEnd)
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetParentDir: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverPath(null)
      const raw = e.dataTransfer.getData('application/dohc-tree-row')
      if (!raw) return
      let source: DragSource
      try {
        source = JSON.parse(raw)
      } catch {
        return
      }
      const action = planDrop(source, { parentDir: targetParentDir })
      if (action.kind === 'noop') return
      if (action.kind === 'move-file') {
        if (!onMoveFile) return
        try {
          await onMoveFile(action.fromPath, action.toPath)
        } catch {
          // Error already surfaced via the app-level notice.
        }
        return
      }
      // move-folder
      if (!onMoveFolder) return
      try {
        await onMoveFolder(action.fromPath, action.toPath)
      } catch {
        // same: surfaced upstream
      }
    },
    [onMoveFile, onMoveFolder],
  )

  // file-org-v1 D4.5 — folder-star lookup. Built from the rich
  // FolderInput shape; legacy string entries map to starred=false.
  const folderStarByPath = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const f of folders) {
      if (typeof f === 'string') m.set(f, false)
      else m.set(f.path, f.starred === true)
    }
    return m
  }, [folders])

  // Folder favorite — the optimistic-aware read + toggle, mirroring the
  // file-star pair. Shared by the folder row's star button and Shift+S.
  const folderStarredOf = useCallback(
    (path: string) => {
      const o = pendingFolderStars.current.get(path)
      return o !== undefined ? o : folderStarByPath.get(path) === true
    },
    [folderStarByPath],
  )
  const toggleFolderStar = useCallback(
    (path: string) => {
      if (!onToggleFolderStar) return
      const current = folderStarredOf(path)
      const willStar = !current
      setAnnouncement(willStar ? 'starring folder…' : 'unstarring folder…')
      pendingFolderStars.current.set(path, willStar)
      bumpPending()
      void onToggleFolderStar(path, current).then(
        () =>
          setAnnouncement(willStar ? 'folder starred' : 'folder unstarred'),
        () => {
          setAnnouncement('')
          pendingFolderStars.current.delete(path)
          bumpPending()
        },
      )
    },
    [onToggleFolderStar, folderStarredOf, bumpPending],
  )

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // file-org-v1 D4.4a — Track-4 affordance shortcuts. L toggles
      // userLocked on a leaf row (refused on a folder for now —
      // D4.5 will wire folder-level locks if the design grows them).
      // S toggles starred on a leaf row.
      // R3 fold (Codex FAIL-2 / indep FAIL-2) — lock/star are
      // gated behind SHIFT so bare letters stay free for future
      // WAI-ARIA tree typeahead (APG §3.13). Shift+L = lock toggle;
      // Shift+S = star toggle.
      if ((e.key === 'l' || e.key === 'L') && e.shiftKey) {
        if (focusedPath === null) return
        const row = fileByPath.get(focusedPath)
        if (!row || !onToggleLock) return
        e.preventDefault()
        // R4 fold (Codex FAIL-3 second-pass) — read CURRENT state
        // from optimistic map first; falls back to prop. This
        // closes the race where the mutation resolved but Convex
        // hasn't re-pushed yet.
        const optimistic = pendingLocks.current.get(focusedPath)
        const currentlyLocked =
          optimistic !== undefined ? optimistic : row.userLocked === true
        const willLock = !currentlyLocked
        setAnnouncement(willLock ? 'locking…' : 'unlocking…')
        pendingLocks.current.set(focusedPath, willLock)
        bumpPending()
        const pathSnapshot = focusedPath
        void onToggleLock(pathSnapshot, currentlyLocked).then(
          () => setAnnouncement(willLock ? 'locked' : 'unlocked'),
          () => {
            setAnnouncement('')
            // Failed mutation — drop the optimistic entry so the
            // next press reads the real (unchanged) state.
            pendingLocks.current.delete(pathSnapshot)
            bumpPending()
          },
        )
        return
      }
      if ((e.key === 's' || e.key === 'S') && e.shiftKey) {
        if (focusedPath === null) return
        e.preventDefault()
        // file-org-v1 D4.5 — S on a leaf row stars/unstars the
        // atom; S on a folder row stars/unstars the folder
        // (folderMetadata row).
        const row = fileByPath.get(focusedPath)
        const pathSnapshot = focusedPath
        if (row) {
          toggleFileStar(pathSnapshot)
          return
        }
        // Folder row
        toggleFolderStar(pathSnapshot)
        return
      }

      // Only intercept keys we own — let typeahead / Tab pass through
      // (Tab leaves the tree to the next focusable element, per the
      // WAI-ARIA roving-tabIndex contract).
      const handled = new Set([
        'ArrowDown',
        'ArrowUp',
        'ArrowRight',
        'ArrowLeft',
        'Enter',
        ' ',
        'Home',
        'End',
      ])
      if (!handled.has(e.key)) return
      const action = navigateTree(flatRows, focusedPath, e.key)
      if (action === null) return
      e.preventDefault()
      switch (action.kind) {
        case 'focus':
          // Keyboard nav — DOM focus should follow to the new row.
          wantDomFocusRef.current = true
          setFocusedPath(action.path)
          break
        case 'expand':
        case 'toggle':
          toggle(action.path)
          break
        case 'collapse':
          // Collapsing the current row should keep focus on it (per
          // WAI-ARIA spec — focus follows the toggled folder).
          toggle(action.path)
          break
        case 'open':
          onOpen(action.path)
          break
      }
    },
    [
      flatRows,
      focusedPath,
      onOpen,
      fileByPath,
      folderStarByPath,
      onToggleLock,
      onToggleStar,
      onToggleFolderStar,
      toggleFileStar,
      toggleFolderStar,
      setAnnouncement,
      bumpPending,
    ],
  )

  // Register / unregister row DOM refs. Used by the focus-effect.
  const setRowRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) rowRefs.current.set(path, el)
      else rowRefs.current.delete(path)
    },
    [],
  )

  const [pending, setPending] = useState<'page' | 'folder' | null>(null)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<
    { kind: 'page' | 'folder'; path: string } | null
  >(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  // file-org-v1 D4.5b — FolderPicker state. Non-null ⇒ picker is
  // open against this folder, with optional `initial` (the current
  // {icon, color, starred} from folderMetadata).
  const [pickerFolder, setPickerFolder] = useState<{
    path: string
    initial: { icon: string | null; color: string | null; starred: boolean }
  } | null>(null)
  // emoji-icons — the file whose icon EmojiPicker is open.
  const [pickerFile, setPickerFile] = useState<{
    path: string
    current: string | null
  } | null>(null)

  async function commitPending(value: string) {
    if (pendingBusy) return
    const name = value.trim()
    if (!name) {
      setPending(null)
      setPendingError(null)
      return
    }
    // D4.6 — prefix with the target dir derived from focusedPath.
    // If the user typed an absolute-looking path with slashes, we
    // honor that as-written (escape hatch for power users); else
    // we prepend targetDir. This matches VSCode: type "alpha" in
    // "team" → "team/alpha"; type "other/beta" → "other/beta"
    // (the typed path wins because it already has structure).
    const path = name.includes('/') || targetDir === '' ? name : `${targetDir}/${name}`
    setPendingBusy(true)
    setPendingError(null)
    try {
      if (pending === 'page') await onCreatePage(path)
      else if (pending === 'folder') await onCreateFolder(path)
      setPending(null)
    } catch (error) {
      setPendingError(errorMessage(error, 'Could not create item.'))
    } finally {
      setPendingBusy(false)
    }
  }

  // D4.6 — when the user opens "New page" or "New folder" against
  // a focused folder, auto-expand it so the new row will be
  // visible right after commit. Cheap defensive UX.
  function beginPending(kind: 'page' | 'folder') {
    // The inline create row lives inside the Personal section; make
    // sure it's expanded or the input would mount hidden (and never
    // focus) when the user creates while the section is collapsed.
    setOpenPersonal(true)
    if (targetDir !== '' && !expanded.has(targetDir)) {
      setExpanded((prev) => new Set(prev).add(targetDir))
    }
    setPendingError(null)
    setPending(kind)
  }

  function beginRename(kind: 'page' | 'folder', path: string) {
    setRenameTarget({ kind, path })
    setRenameError(null)
  }

  async function commitRename(nextPath: string) {
    if (!renameTarget || renameBusy) return
    const clean = nextPath.trim()
    if (!clean || clean === renameTarget.path) {
      setRenameTarget(null)
      setRenameError(null)
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      if (renameTarget.kind === 'page') {
        await onRenameFile(renameTarget.path, clean)
      } else {
        await onRenameFolder(renameTarget.path, clean)
      }
      setRenameTarget(null)
    } catch (error) {
      setRenameError(errorMessage(error, 'Could not rename item.'))
    } finally {
      setRenameBusy(false)
    }
  }

  function cancelRename() {
    if (renameBusy) return
    setRenameTarget(null)
    setRenameError(null)
  }

  return (
    <PresenceContext.Provider value={presentPathSet}>
    <aside className="flex h-screen flex-col bg-panel border-r border-rule overflow-hidden">
      {/* file-org-v1 D4.4b — ARIA-live region for lock/star toggle
          announcements. Visually hidden (1px square, overflow-
          hidden); aria-live="polite" so the screen reader queues
          the announcement without interrupting. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </div>
      {/* file-org-v1 D4.5b — FolderPicker dialog (renders when
          pickerFolder is non-null). */}
      {pickerFolder && onSetFolderMeta && (
        <FolderPicker
          path={pickerFolder.path}
          initial={pickerFolder.initial}
          onClose={() => setPickerFolder(null)}
          onCommit={async (next) => {
            await onSetFolderMeta(pickerFolder.path, next)
            setAnnouncement(`folder customized: ${pickerFolder.path}`)
          }}
        />
      )}
      {/* emoji-icons — file icon EmojiPicker (renders when pickerFile
          is non-null). */}
      {pickerFile && onSetFileIcon && (
        <EmojiPicker
          title="Choose a file icon"
          current={pickerFile.current}
          onPick={async (emoji) => {
            await onSetFileIcon(pickerFile.path, emoji)
            setPickerFile(null)
          }}
          onClear={async () => {
            await onSetFileIcon(pickerFile.path, '')
            setPickerFile(null)
          }}
          onClose={() => setPickerFile(null)}
        />
      )}
      {/* Brand header — drop-lobe mark + lowercase wordmark. */}
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2 text-accent">
          <DohcMark size={20} />
          <span className="text-[16px] font-semibold tracking-tight leading-none text-ink-strong">
            dohc
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {onOpenSearch && (
            <button
              type="button"
              onClick={onOpenSearch}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim hover:text-ink hover:bg-hover transition-colors"
              title="search (⌘⇧F)"
              aria-label="search pages"
            >
              <Search className="size-4" strokeWidth={2} />
            </button>
          )}
          <div className="relative">
          <button
            onClick={() => setNewOpen((v) => !v)}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim hover:text-ink hover:bg-hover transition-colors"
            title="new page or folder"
            aria-label="new"
          >
            <Plus className="size-4" strokeWidth={2} />
          </button>
          {newOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setNewOpen(false)}
              />
              <div className="absolute right-0 top-9 z-40 w-44 rounded-lg border border-rule bg-elevated shadow-md py-1">
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink hover:bg-hover transition-colors"
                  onClick={() => {
                    beginPending('page')
                    setNewOpen(false)
                  }}
                >
                  <FilePlus className="size-3.5 text-ink-dim" strokeWidth={2} />
                  <span>New page</span>
                  {targetDir && (
                    <span className="ml-auto font-mono text-[10px] text-ink-faint truncate max-w-[80px]">
                      in {targetDir}
                    </span>
                  )}
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink hover:bg-hover transition-colors"
                  onClick={() => {
                    beginPending('folder')
                    setNewOpen(false)
                  }}
                >
                  <FolderPlus
                    className="size-3.5 text-ink-dim"
                    strokeWidth={2}
                  />
                  <span>New folder</span>
                  {targetDir && (
                    <span className="ml-auto font-mono text-[10px] text-ink-faint truncate max-w-[80px]">
                      in {targetDir}
                    </span>
                  )}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </header>

      {/* org-plan §9 Phase D — workspace switcher. Compact dropdown
          between the brand header and the file sections; "Personal"
          when no org is active, otherwise the active org's name. */}
      <WorkspaceSwitcher />

      {/* Sections — VSCode-explorer style. */}
      <div className="flex-1 overflow-y-auto pb-3">
        <TreeSection
          id="filetree-personal"
          label="Personal workspace"
          open={openPersonal}
          onToggle={() => setOpenPersonal((v) => !v)}
        >
          {/* pt-1 so the topmost row's focus ring isn't clipped. */}
          <div className="px-1.5 pt-1">
        {/* D4.6b — PendingRow renders INLINE at the target folder's
            depth (VSCode-style). The root case (targetDir === '')
            still renders at the top of the tree container; the
            nested case (targetDir !== '') renders INSIDE the
            matching folder's children — see TreeRowNode. */}
        {pending && targetDir === '' && (
          <PendingRow
            kind={pending}
            indent={8}
            onCommit={commitPending}
            busy={pendingBusy}
            error={pendingError}
            onInput={() => setPendingError(null)}
          />
        )}

        {tree.children.length === 0 && !pending ? (
          <div className="px-3 py-2 text-[12px] text-ink-faint leading-relaxed">
            No pages yet — hit{' '}
            <kbd className="rounded bg-hover px-1 py-0.5 text-[10px]">⌘K</kbd>{' '}
            or the <Plus className="inline size-3 -mt-0.5" /> button to start.
          </div>
        ) : (
          <div
            role="tree"
            aria-label="personal workspace"
            onKeyDown={onTreeKeyDown}
            // D4.7 — root drop zone. Dropping on empty space in the
            // tree container (not on any row) moves the source to
            // workspace root. The row-level onDrop calls
            // stopPropagation, so this only fires on truly empty
            // areas.
            onDragOver={(e) => {
              // D4.7b — the row-level onDragOver calls
              // stopPropagation, so this only fires when the cursor
              // is over EMPTY SPACE within the tree (not on any
              // row). That's the root drop zone.
              if (
                e.dataTransfer.types.includes('application/dohc-tree-row')
              ) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dragOverPath !== '') setDragOverPath('')
              }
            }}
            onDragLeave={(e) => {
              // Only clear when cursor truly leaves the tree
              // container. The contains-check on relatedTarget
              // handles bubbled leaves from descendant rows.
              if (
                !(e.currentTarget as HTMLElement).contains(
                  e.relatedTarget as Node | null,
                )
              ) {
                setDragOverPath(null)
              }
            }}
            onDrop={(e) => {
              void handleDrop(e, '')
            }}
            style={{
              outline:
                dragOverPath === ''
                  ? '1px dashed var(--color-accent-2)'
                  : 'none',
              outlineOffset: '-2px',
              borderRadius: 6,
            }}
          >
            {tree.children.map((child) => (
              <TreeRowNode
                key={child.fullPath}
                node={child}
                depth={0}
                activePath={activePath}
                expanded={expanded}
                viewIsAtom={view === 'atom'}
                focusedPath={focusedPath}
                setFocusedPath={setFocusedPath}
                setRowRef={setRowRef}
                onOpen={onOpen}
                onToggle={toggle}
                onDeleteFolder={onDeleteFolder}
                onRenameFolder={onRenameFolder}
                onDeleteFile={onDeleteFile}
                onRenameFile={onRenameFile}
                renameTarget={renameTarget}
                renameBusy={renameBusy}
                renameError={renameError}
                onBeginRename={beginRename}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
                onRenameInput={() => setRenameError(null)}
                onOpenPicker={
                  onSetFolderMeta
                    ? (n) =>
                        setPickerFolder({
                          path: n.fullPath,
                          initial: {
                            icon: n.icon ?? null,
                            color: n.color ?? null,
                            starred: n.starred === true,
                          },
                        })
                    : undefined
                }
                onOpenFileIcon={
                  onSetFileIcon
                    ? (path, current) => setPickerFile({ path, current })
                    : undefined
                }
                onToggleFileStar={onToggleStar ? toggleFileStar : undefined}
                starredOf={starredOf}
                onToggleFolderStar={
                  onToggleFolderStar ? toggleFolderStar : undefined
                }
                folderStarredOf={folderStarredOf}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                handleDrop={handleDrop}
                pendingKind={pending}
                pendingTargetDir={targetDir}
                onPendingCommit={commitPending}
                pendingBusy={pendingBusy}
                pendingError={pendingError}
                onPendingInput={() => setPendingError(null)}
                sharedByMeIds={sharedByMeIds}
              />
            ))}
          </div>
        )}
          </div>
        </TreeSection>

        {/* sharing-v1 1a — "Shared with me". Always shown so the surface
            is discoverable, with a calm empty state when nothing's shared. */}
        <TreeSection
          id="filetree-shared"
          label="Shared with me"
          open={openShared}
          onToggle={() => setOpenShared((v) => !v)}
          divider
        >
          <div className="px-1.5 pb-1">
            {(sharedWithMe?.length ?? 0) === 0 && (
              <p className="px-2 py-1 text-[11.5px] leading-relaxed text-ink-faint">
                Nothing shared with you yet.
              </p>
            )}
          {(sharedWithMe ?? []).map((s) => {
            const leaf =
              s.title ||
              s.path.replace(/\.[a-z0-9]+$/i, '').split('/').pop() ||
              s.fileId
            return (
              <button
                key={s.shareId}
                onClick={() => s.available && onOpenShared?.(s.shareId)}
                disabled={!s.available}
                title={s.available ? leaf : 'no longer available'}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors ${
                  activeShareId === s.shareId
                    ? 'bg-hover text-ink-strong font-medium'
                    : 'text-ink-dim hover:text-ink hover:bg-hover'
                } ${!s.available ? 'opacity-40 cursor-default' : ''}`}
              >
                <Share2 className="size-3.5 shrink-0" strokeWidth={2} />
                <span className="truncate">{leaf}</span>
                {s.permission === 'edit' && (
                  <span className="ml-auto text-[9px] text-ink-faint">edit</span>
                )}
              </button>
            )
          })}
          </div>
        </TreeSection>
      </div>

      {/* Footer */}
      <footer className="border-t border-rule px-3 py-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div
            className="flex flex-1 items-center gap-2 min-w-0"
            title={user?.email ?? ''}
          >
            <span className="size-2 rounded-full bg-success shrink-0" />
            <span className="truncate text-[11.5px] text-ink-dim">
              {label}
            </span>
          </div>
          <ThemeToggleButton />
          <a
            href="/api/auth/sign-out"
            className="text-[10.5px] text-ink-faint hover:text-ink-dim transition-colors"
            title="sign out"
          >
            sign out
          </a>
        </div>
      </footer>
    </aside>
    </PresenceContext.Provider>
  )
}

function PendingRow({
  kind,
  indent,
  onCommit,
  busy,
  error,
  onInput,
}: {
  kind: 'page' | 'folder'
  // D4.6b — left padding in pixels. Matches the depth-driven indent
  // used by TreeRowNode (8 + depth * 14) so the input visually
  // aligns with sibling rows at the same level.
  indent: number
  onCommit: (value: string) => void | Promise<void>
  busy?: boolean
  error?: string | null
  onInput?: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div
      className={`mr-1 mt-0.5 mb-0.5 rounded-md border bg-panel pr-2 ${
        error ? 'border-danger/50' : 'border-rule-strong'
      }`}
      style={{ paddingLeft: indent }}
    >
      <div className="flex items-center gap-1.5 py-1">
        <span className="size-3.5 shrink-0 text-ink-dim">
          {kind === 'page' ? (
            <FileText className="size-3.5" strokeWidth={2} />
          ) : (
            <Folder className="size-3.5" strokeWidth={2} />
          )}
        </span>
        <input
          ref={ref}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value)
            onInput?.()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void onCommit(value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              void onCommit('')
            }
          }}
          onBlur={() => {
            if (!error) void onCommit(value)
          }}
          placeholder={kind === 'page' ? 'page name' : 'folder name'}
          spellCheck={false}
          className="flex-1 bg-transparent border-none outline-none text-[12.5px] text-ink placeholder:text-ink-faint disabled:opacity-60"
        />
        {busy && (
          <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            saving
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="pb-1 pl-5 text-[11px] leading-snug text-danger">
          {error}
        </div>
      )}
    </div>
  )
}

function InlineRenameRow({
  kind,
  path,
  indent,
  busy,
  error,
  onCommit,
  onCancel,
  onInput,
}: {
  kind: 'page' | 'folder'
  path: string
  indent: number
  busy: boolean
  error: string | null
  onCommit: (value: string) => void | Promise<void>
  onCancel: () => void
  onInput: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(path)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <div
      role="treeitem"
      aria-label={`Rename ${path}`}
      className={`mr-1 mt-0.5 mb-0.5 rounded-md border bg-panel pr-2 ${
        error ? 'border-danger/50' : 'border-rule-strong'
      }`}
      style={{ paddingLeft: indent }}
    >
      <div className="flex items-center gap-1.5 py-1">
        <span className="size-3.5 shrink-0 text-ink-dim">
          {kind === 'page' ? (
            <FileText className="size-3.5" strokeWidth={2} />
          ) : (
            <Folder className="size-3.5" strokeWidth={2} />
          )}
        </span>
        <input
          ref={ref}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value)
            onInput()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void onCommit(value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          onBlur={() => {
            if (!error && !busy) onCancel()
          }}
          spellCheck={false}
          className="flex-1 bg-transparent border-none outline-none font-mono text-[12px] text-ink placeholder:text-ink-faint disabled:opacity-60"
        />
        {busy && (
          <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            renaming
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="pb-1 pl-5 text-[11px] leading-snug text-danger">
          {error}
        </div>
      )}
    </div>
  )
}

function TreeRowNode({
  node,
  depth,
  activePath,
  expanded,
  viewIsAtom,
  focusedPath,
  setFocusedPath,
  setRowRef,
  onOpen,
  onToggle,
  onDeleteFolder,
  onRenameFolder,
  onDeleteFile,
  onRenameFile,
  renameTarget,
  renameBusy,
  renameError,
  onBeginRename,
  onRenameCommit,
  onRenameCancel,
  onRenameInput,
  onOpenPicker,
  onOpenFileIcon,
  onToggleFileStar,
  starredOf,
  onToggleFolderStar,
  folderStarredOf,
  dragOverPath,
  setDragOverPath,
  handleDrop,
  pendingKind,
  pendingTargetDir,
  onPendingCommit,
  pendingBusy,
  pendingError,
  onPendingInput,
  sharedByMeIds,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  expanded: Set<string>
  viewIsAtom: boolean
  focusedPath: string | null
  setFocusedPath: (path: string) => void
  setRowRef: (path: string) => (el: HTMLDivElement | null) => void
  onOpen: (path: string) => void
  onToggle: (key: string) => void
  onDeleteFolder: (path: string) => Promise<void>
  onRenameFolder: (path: string, nextPath: string) => Promise<void>
  onDeleteFile: (path: string) => Promise<void>
  onRenameFile: (path: string, nextPath: string) => Promise<void>
  renameTarget: { kind: 'page' | 'folder'; path: string } | null
  renameBusy: boolean
  renameError: string | null
  onBeginRename: (kind: 'page' | 'folder', path: string) => void
  onRenameCommit: (nextPath: string) => Promise<void>
  onRenameCancel: () => void
  onRenameInput: () => void
  // file-org-v1 D4.5b — folder rows only; opens FolderPicker.
  onOpenPicker?: (node: TreeNode) => void
  // emoji-icons — file rows only; opens the EmojiPicker for the file.
  onOpenFileIcon?: (path: string, current: string | null) => void
  // Favorite toggle for file rows (optimistic-aware). Wired only when
  // the parent provided a star mutation; absent ⇒ read-only star.
  onToggleFileStar?: (path: string) => void
  starredOf?: (path: string) => boolean
  // Favorite toggle for folder rows (optimistic-aware), same contract.
  onToggleFolderStar?: (path: string) => void
  folderStarredOf?: (path: string) => boolean
  // file-org-v1 D4.7 — DnD state + handler from the parent.
  dragOverPath: string | null
  setDragOverPath: (path: string | null) => void
  handleDrop: (
    e: React.DragEvent,
    targetParentDir: string,
  ) => Promise<void>
  // file-org-v1 D4.6b — pending-create slot. When pendingKind is
  // non-null AND pendingTargetDir matches this folder's fullPath,
  // render the PendingRow inline at the top of this folder's
  // children (depth+1 indent). Root drops still render at the
  // top of the tree container (handled in FileTree, not here).
  pendingKind: 'page' | 'folder' | null
  pendingTargetDir: string
  onPendingCommit: (value: string) => void | Promise<void>
  pendingBusy: boolean
  pendingError: string | null
  onPendingInput: () => void
  sharedByMeIds: ReadonlySet<string>
}) {
  const isFolder = node.page === null
  const isExpanded = expanded.has(node.fullPath)
  const label = nodeLabel(node)
  const indent = 8 + depth * 14
  // Optional presence indicator. With v2 the set is empty unless a future
  // awareness projection feeds it, so the sidebar stays visually calm while
  // live collaboration is represented by editor carets.
  const presentPathSet = useContext(PresenceContext)
  const isPresent = !isFolder && presentPathSet.has(node.fullPath)
  // file-org-v1 D4.3 — roving tabIndex. The focused row carries
  // tabIndex=0; all others carry tabIndex=-1. The bootstrap-effect
  // at the top of FileTree guarantees focusedPath is non-null on
  // the second render, so the typical case is the strict equality.
  // The (focusedPath === null) branch is the first render only; we
  // default to tabIndex=0 nowhere here — the bootstrap effect will
  // re-render in a tick.
  const isTabStop = focusedPath === node.fullPath

  if (!isFolder) {
    const isActive = viewIsAtom && activePath === node.page!.path
    const filePath = node.page!.path
    const ContextIcon = contextFileIcon(filePath)
    const isSharedByMe = sharedByMeIds.has(node.page!.fileId ?? '')
    const showLock = node.page!.systemLocked || node.page!.userLocked
    const isRenaming =
      renameTarget?.kind === 'page' && renameTarget.path === filePath
    // D4.7 — DnD: leaf row is BOTH draggable (the file itself) AND
    // droppable (drop INTO file = drop into file's parent folder).
    const leafParent = filePath.includes('/')
      ? filePath.slice(0, filePath.lastIndexOf('/'))
      : ''
    const isDropTarget = dragOverPath === filePath
    if (isRenaming) {
      return (
        <InlineRenameRow
          kind="page"
          path={filePath}
          indent={indent}
          busy={renameBusy}
          error={renameError}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          onInput={onRenameInput}
        />
      )
    }
    return (
      <div
        ref={setRowRef(filePath)}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isActive}
        tabIndex={isTabStop ? 0 : -1}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(
            'application/dohc-tree-row',
            JSON.stringify({ path: filePath, kind: 'file' } satisfies DragSource),
          )
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/dohc-tree-row')) {
            e.preventDefault()
            // D4.7b — stopPropagation so the tree container's
            // onDragOver doesn't ALSO fire and (in React's batched
            // event) overwrite `dragOverPath` with the root-zone
            // value ''. Without this, the row highlight never
            // showed (container won the race every frame).
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (dragOverPath !== filePath) setDragOverPath(filePath)
          }
        }}
        // D4.7b: NO per-row dragLeave. The cursor moving from one
        // row to the next was firing leave → null → enter → next,
        // and the brief null frame was the flicker. The next row's
        // dragOver naturally overwrites dragOverPath; the container
        // dragLeave (below) handles "cursor exits the whole tree".
        onDrop={(e) => {
          void handleDrop(e, leafParent)
        }}
        onClick={() => {
          setFocusedPath(filePath)
          onOpen(filePath)
        }}
        onFocus={() => setFocusedPath(filePath)}
        title={filePath}
        className={`group relative flex items-center gap-1.5 rounded-md py-1 pr-1 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ink-faint ${
          // D4.7b — `transition-colors` is suppressed while the row
          // is a drop target; the highlight goes on/off instantly so
          // sub-frame hand-offs between sibling rows don't animate
          // into a perceptible flicker.
          isDropTarget
            ? 'bg-accent-2-soft ring-1 ring-accent-2'
            : `transition-colors ${
                isActive
                  ? 'bg-hover text-ink-strong'
                  : 'text-ink-dim hover:bg-hover hover:text-ink'
              }`
        }`}
        style={{ paddingLeft: indent }}
      >
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-ink-strong" />
        )}
        {/* a user-chosen emoji overrides the default lucide icon */}
        {node.page!.icon ? (
          <span
            className="shrink-0 inline-flex w-4 items-center justify-center text-[13px] leading-none"
            aria-hidden
          >
            {node.page!.icon}
          </span>
        ) : ContextIcon ? (
          <ContextIcon
            className="size-3.5 shrink-0 opacity-80 text-accent"
            strokeWidth={1.8}
          />
        ) : node.page!.type === 'html' ? (
          <Globe className="size-3.5 shrink-0 opacity-70" strokeWidth={1.8} />
        ) : node.page!.type === 'skill' ? (
          <Sparkles
            className="size-3.5 shrink-0 opacity-80 text-violet-500"
            strokeWidth={1.8}
          />
        ) : node.page!.type === 'command' ? (
          <SquareTerminal
            className="size-3.5 shrink-0 opacity-80 text-accent"
            strokeWidth={1.8}
          />
        ) : (
          <FileText className="size-3.5 shrink-0 opacity-70" strokeWidth={1.8} />
        )}
        <span className="truncate text-[12.5px] font-medium">{label}</span>
        {/* Optional sidebar presence dot. */}
        {isPresent && (
          <span
            className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-emerald-500"
            aria-label="Live editing session active"
            title="Live editing session active"
          />
        )}
        {/* file-org-v1 D4.4a — lock + star affordances. Lock icon
            color signals owner (violet=system, ink-dim=user); both
            present ⇒ system color wins (it's the stronger
            constraint). Star is accent-2-filled when set. */}
        {showLock && (
          <Lock
            className={`size-3 shrink-0 ${
              node.page!.systemLocked
                ? 'text-violet-500'
                : 'text-ink-faint'
            }`}
            strokeWidth={2}
            aria-label={
              node.page!.systemLocked ? 'system-locked' : 'user-locked'
            }
          />
        )}
        {isSharedByMe && (
          <Share2
            className="size-3 shrink-0 text-accent opacity-80"
            strokeWidth={2}
            aria-label="shared"
          />
        )}
        {onToggleFileStar ? (
          <StarToggle
            starred={
              starredOf ? starredOf(filePath) : node.page!.starred === true
            }
            onToggle={() => onToggleFileStar(filePath)}
          />
        ) : (
          node.page!.starred && (
            <Star
              className="size-3 shrink-0 fill-current text-accent-2"
              strokeWidth={1.5}
              aria-label="starred"
            />
          )
        )}
        <RowActions
          onRename={() => onBeginRename('page', filePath)}
          onDelete={() => onDeleteFile(filePath)}
          onCustomize={
            onOpenFileIcon
              ? () => onOpenFileIcon(filePath, node.page!.icon ?? null)
              : undefined
          }
          customizeLabel="set icon"
          customizeIcon={Smile}
          renameLabel={`rename ${filePath}`}
          deleteLabel={`delete ${filePath}`}
          deleteTitle={`Delete ${label}?`}
          deleteDescription="This file will be removed from the workspace."
        />
        {/* type suffix — distinguishes html from md independent of the
            (customizable) icon. Right-aligned (Obsidian-style); the
            RowActions ml-auto pushes this cluster to the right edge.
            md is the default → no suffix. */}
        {node.page!.type === 'html' && (
          <span className="shrink-0 text-[10px] font-medium lowercase tracking-wide text-ink-faint">
            html
          </span>
        )}
      </div>
    )
  }

  // D4.7 — folder row is draggable (the folder itself) AND a drop
  // target (drop INTO the folder).
  const folderIsDropTarget = dragOverPath === node.fullPath
  const isRenaming =
    renameTarget?.kind === 'folder' && renameTarget.path === node.fullPath
  if (isRenaming) {
    return (
      <Fragment>
        <InlineRenameRow
          kind="folder"
          path={node.fullPath}
          indent={indent}
          busy={renameBusy}
          error={renameError}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          onInput={onRenameInput}
        />
        {isExpanded &&
          pendingKind !== null &&
          pendingTargetDir === node.fullPath && (
            <PendingRow
              kind={pendingKind}
              indent={8 + (depth + 1) * 14}
              onCommit={onPendingCommit}
              busy={pendingBusy}
              error={pendingError}
              onInput={onPendingInput}
            />
          )}
        {isExpanded &&
          node.children.map((c) => (
            <TreeRowNode
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              viewIsAtom={viewIsAtom}
              focusedPath={focusedPath}
              setFocusedPath={setFocusedPath}
              setRowRef={setRowRef}
              onOpen={onOpen}
              onToggle={onToggle}
              onDeleteFolder={onDeleteFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFile={onDeleteFile}
              onRenameFile={onRenameFile}
              renameTarget={renameTarget}
              renameBusy={renameBusy}
              renameError={renameError}
              onBeginRename={onBeginRename}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              onRenameInput={onRenameInput}
              onOpenPicker={onOpenPicker}
              onOpenFileIcon={onOpenFileIcon}
              onToggleFileStar={onToggleFileStar}
              starredOf={starredOf}
              onToggleFolderStar={onToggleFolderStar}
              folderStarredOf={folderStarredOf}
              dragOverPath={dragOverPath}
              setDragOverPath={setDragOverPath}
              handleDrop={handleDrop}
              pendingKind={pendingKind}
              pendingTargetDir={pendingTargetDir}
              onPendingCommit={onPendingCommit}
              pendingBusy={pendingBusy}
              pendingError={pendingError}
              onPendingInput={onPendingInput}
              sharedByMeIds={sharedByMeIds}
            />
          ))}
      </Fragment>
    )
  }
  return (
    <Fragment>
      <div
        ref={setRowRef(node.fullPath)}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={isExpanded}
        tabIndex={isTabStop ? 0 : -1}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(
            'application/dohc-tree-row',
            JSON.stringify({
              path: node.fullPath,
              kind: 'folder',
            } satisfies DragSource),
          )
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/dohc-tree-row')) {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (dragOverPath !== node.fullPath) setDragOverPath(node.fullPath)
          }
        }}
        // D4.7b — NO per-row dragLeave (see leaf-branch comment).
        onDrop={(e) => {
          void handleDrop(e, node.fullPath)
        }}
        onClick={() => {
          setFocusedPath(node.fullPath)
          onToggle(node.fullPath)
        }}
        onFocus={() => setFocusedPath(node.fullPath)}
        className={`group flex items-center gap-1 rounded-md py-1 pr-1 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ink-faint ${
          folderIsDropTarget
            ? 'bg-accent-2-soft ring-1 ring-accent-2 text-ink'
            : 'text-ink-dim hover:bg-hover hover:text-ink transition-colors'
        }`}
        style={{ paddingLeft: indent }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle(node.fullPath)
          }}
          title={isExpanded ? 'collapse' : 'expand'}
          className="flex size-4 items-center justify-center text-ink-faint hover:text-ink shrink-0"
        >
          {isExpanded ? (
            <ChevronDown className="size-3" strokeWidth={2.2} />
          ) : (
            <ChevronRight className="size-3" strokeWidth={2.2} />
          )}
        </button>
        {(() => {
          // file-org-v1 D4.5 — folders use the lucide folder shape,
          // tinted by the chosen color. (Icons/emojis are files-only.)
          const isContextFolder = node.fullPath === '.context'
          const isSkillsFolder = node.fullPath === '.skills'
          const isCommandsFolder = node.fullPath === '.commands'
          const chosenColor = isContextFolder
            ? 'var(--color-accent)'
            : isSkillsFolder
              ? 'var(--color-violet-500, #8b5cf6)'
              : isCommandsFolder
                ? 'var(--color-accent)'
                : colorVarFor(node.color)
          const Base = isContextFolder
            ? Brain
            : isSkillsFolder
              ? Sparkles
              : isCommandsFolder
                ? SquareTerminal
                : isExpanded
                  ? FolderOpen
                  : Folder
          return (
            <Base
              className="size-3.5 shrink-0"
              strokeWidth={1.8}
              style={{
                color: chosenColor,
                opacity:
                  isContextFolder || isSkillsFolder || isCommandsFolder || node.color
                    ? 1
                    : 0.7,
              }}
            />
          )
        })()}
        <span className="truncate text-[12.5px] font-medium ml-0.5">{label}</span>
        {/* file-org-v1 D4.5 — folder star icon (next to label,
            before the row-actions menu). Mirrors the leaf-row
            star treatment for consistency. */}
        {onToggleFolderStar ? (
          <StarToggle
            starred={
              folderStarredOf
                ? folderStarredOf(node.fullPath)
                : node.starred === true
            }
            onToggle={() => onToggleFolderStar(node.fullPath)}
          />
        ) : (
          node.starred && (
            <Star
              className="size-3 shrink-0 fill-current text-accent-2"
              strokeWidth={1.5}
              aria-label="starred folder"
            />
          )
        )}
        <RowActions
          onRename={() => onBeginRename('folder', node.fullPath)}
          onDelete={() => onDeleteFolder(node.fullPath)}
          onCustomize={
            onOpenPicker ? () => onOpenPicker(node) : undefined
          }
          customizeLabel={`customize folder ${node.fullPath}`}
          renameLabel={`rename folder ${node.fullPath}`}
          deleteLabel={`delete folder ${node.fullPath}`}
          deleteTitle={`Delete ${label}?`}
          deleteDescription="This removes the folder, nested folders, and every page inside."
        />
      </div>
      {/* D4.6b — inline PendingRow at depth+1 when this folder is
          the create target. Renders BEFORE children (top of the
          folder's contents, matching VSCode). Suppresses the
          "empty" placeholder so the input isn't visually crowded
          by an "empty" string next to it. */}
      {isExpanded &&
        pendingKind !== null &&
        pendingTargetDir === node.fullPath && (
          <PendingRow
            kind={pendingKind}
            indent={8 + (depth + 1) * 14}
            onCommit={onPendingCommit}
            busy={pendingBusy}
            error={pendingError}
            onInput={onPendingInput}
          />
        )}
      {isExpanded &&
        node.children.length === 0 &&
        !(pendingKind !== null && pendingTargetDir === node.fullPath) && (
          <div
            className="text-[11px] text-ink-faint italic py-0.5"
            style={{ paddingLeft: indent + 22 }}
          >
            empty
          </div>
        )}
      {isExpanded &&
        node.children.map((c) => (
          <TreeRowNode
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            activePath={activePath}
            expanded={expanded}
            viewIsAtom={viewIsAtom}
            focusedPath={focusedPath}
            setFocusedPath={setFocusedPath}
            setRowRef={setRowRef}
            onOpen={onOpen}
            onToggle={onToggle}
            onDeleteFolder={onDeleteFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFile={onDeleteFile}
            onRenameFile={onRenameFile}
            renameTarget={renameTarget}
            renameBusy={renameBusy}
            renameError={renameError}
            onBeginRename={onBeginRename}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            onRenameInput={onRenameInput}
            onOpenPicker={onOpenPicker}
            onOpenFileIcon={onOpenFileIcon}
            onToggleFileStar={onToggleFileStar}
            starredOf={starredOf}
            onToggleFolderStar={onToggleFolderStar}
            folderStarredOf={folderStarredOf}
            dragOverPath={dragOverPath}
            setDragOverPath={setDragOverPath}
            handleDrop={handleDrop}
            pendingKind={pendingKind}
            pendingTargetDir={pendingTargetDir}
            onPendingCommit={onPendingCommit}
            pendingBusy={pendingBusy}
            pendingError={pendingError}
            onPendingInput={onPendingInput}
            sharedByMeIds={sharedByMeIds}
          />
        ))}
    </Fragment>
  )
}

// Favorite toggle on a file row. Persistent (filled, accent) when
// starred; revealed on hover when not — so it both indicates and
// toggles the favorite without a second always-on star.
function StarToggle({
  starred,
  onToggle,
}: {
  starred: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      title={starred ? 'unfavorite' : 'favorite'}
      aria-label={starred ? 'unfavorite' : 'favorite'}
      aria-pressed={starred}
      className={`flex size-5 shrink-0 items-center justify-center rounded hover:bg-hover transition-opacity ${
        starred
          ? 'opacity-100 text-accent-2'
          : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-ink-faint hover:text-ink'
      }`}
    >
      <Star
        className={`size-3 ${starred ? 'fill-current' : ''}`}
        strokeWidth={starred ? 1.5 : 2}
      />
    </button>
  )
}

function RowActions({
  onRename,
  onDelete,
  onCustomize,
  customizeLabel,
  customizeIcon: CustomizeIcon = Palette,
  renameLabel,
  deleteLabel,
  deleteTitle,
  deleteDescription,
}: {
  onRename: () => void
  onDelete: () => void | Promise<void>
  // When set, an extra button: folders → customize (Palette);
  // files → set icon (Smile).
  onCustomize?: () => void
  customizeLabel?: string
  customizeIcon?: React.ComponentType<{
    className?: string
    strokeWidth?: number
  }>
  renameLabel: string
  deleteLabel: string
  deleteTitle: string
  deleteDescription: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirmDelete() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
      setConfirmOpen(false)
    } catch (e) {
      setError(errorMessage(e, 'Could not delete item.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      {onCustomize && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCustomize()
          }}
          title={customizeLabel ?? 'customize'}
          aria-label={customizeLabel ?? 'customize'}
          className="flex size-5 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-hover transition-colors"
        >
          <CustomizeIcon className="size-3" strokeWidth={2} />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRename()
        }}
        title="rename"
        aria-label={renameLabel}
        className="flex size-5 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-hover transition-colors"
      >
        <Pencil className="size-3" strokeWidth={2} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setError(null)
          setConfirmOpen(true)
        }}
        title="delete"
        aria-label={deleteLabel}
        className="flex size-5 items-center justify-center rounded text-ink-faint hover:text-danger hover:bg-hover transition-colors"
      >
        <Trash2 className="size-3" strokeWidth={2} />
      </button>
      {confirmOpen && (
        <>
          <div
            className="fixed inset-0 z-30 cursor-default"
            onClick={(e) => {
              e.stopPropagation()
              if (!busy) setConfirmOpen(false)
            }}
          />
          <div
            className="absolute right-0 top-6 z-40 block w-64 rounded-lg border border-rule bg-elevated p-2.5 text-left shadow-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-danger"
                strokeWidth={2}
              />
              <div className="min-w-0">
                <div className="block truncate text-[12.5px] font-medium text-ink-strong">
                  {deleteTitle}
                </div>
                <div className="mt-0.5 block text-[11.5px] leading-snug text-ink-dim">
                  {deleteDescription}
                </div>
              </div>
            </div>
            {error && (
              <div
                role="alert"
                className="mt-2 block rounded-md bg-danger-soft px-2 py-1 text-[11px] leading-snug text-danger"
              >
                {error}
              </div>
            )}
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirmDelete()}
                className="rounded-md bg-danger px-2 py-1 text-[11.5px] font-medium text-surface transition-colors hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ThemeToggleButton() {
  const { theme, cycle } = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const next =
    theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
  return (
    <button
      onClick={cycle}
      title={`theme: ${theme} · click for ${next}`}
      aria-label="cycle theme"
      className="flex size-6 items-center justify-center rounded-md text-ink-faint hover:text-ink hover:bg-hover transition-colors"
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  )
}
