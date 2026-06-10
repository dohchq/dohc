import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { AppWindow, Share2, Smile } from 'lucide-react'
import RSCE from 'react-simple-code-editor'
import { api } from '../../convex/_generated/api'
import {
  parseFrontmatter,
  setFrontmatterTitle,
  setFrontmatterIcon,
} from '../lib/frontmatter'
import { EmojiPicker } from './EmojiPicker'
import { highlightSource, type SourceLang } from '../lib/sourceHighlight'
import { parseViewPath } from '../lib/viewPaths'

// react-simple-code-editor is CJS (`exports.default = Editor`) with no
// `__esModule` flag, so under Vite's interop the ESM default import is
// the module object `{ default: Editor }`, not the component. Unwrap
// `.default` (fall back to the import itself if a build ever fixes it).
const SourceCodeEditor = (
  (RSCE as unknown as { default?: typeof RSCE }).default ?? RSCE
) as typeof RSCE
import {
  splitFrontmatter,
  joinFrontmatter,
  extractFrontmatterId,
  isHtmlPath,
  isSkillAtomBody,
} from '../lib/atomId'
import { buildShareText } from '../lib/shareText'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { PropertiesPanel } from './PropertiesPanel'
import { HtmlAtomFrame } from './HtmlAtomFrame'
import { AtomEditor, type AtomEditorHandle, OPEN_SKETCH_EVENT } from './AtomEditor'
import { DohcBrandBlock } from '@dohc/brand'
import { AsciiSketchModal } from './AsciiSketchModal'
import { DocumentSkeleton } from './Skeleton'
import {
  isSourceFirstPath,
  shouldRenderHtmlAtomFrame,
} from '../lib/viewSourceBehavior'
import {
  findSubpages,
  pathToBreadcrumbs,
  type FileRow,
} from '../lib/path-tree'
import type { DohcBackendClient } from '../backend/backendClient'

function hasPostFrontmatterContent(body: string): boolean {
  return splitFrontmatter(body).rest.trim().length > 0
}

export function wouldErasePostFrontmatterContent(
  previousBody: string | null | undefined,
  nextBody: string,
): boolean {
  if (!previousBody) return false
  return (
    hasPostFrontmatterContent(previousBody) &&
    !hasPostFrontmatterContent(nextBody)
  )
}

function sourceLangForPath(
  path: string | null | undefined,
  isHtml: boolean,
): SourceLang {
  if (isHtml) return 'html'
  const clean = path ?? ''
  if (/\.tsx$/i.test(clean)) return 'tsx'
  if (/\.ts$/i.test(clean)) return 'typescript'
  if (/\.jsx$/i.test(clean)) return 'jsx'
  if (/\.js$/i.test(clean)) return 'javascript'
  if (/\.css$/i.test(clean)) return 'css'
  if (/\.json$/i.test(clean)) return 'json'
  return 'markdown'
}

type Props = {
  path: string | null
  files: FileRow[]
  onRunAction: (prompt: string) => void
  onOpenAtom: (path: string) => void
  onOpenView?: (packageRoot: string) => void
  // sharing-v1 1a — share THIS file (by its rename-proof fileId).
  onShare?: (fileId: string) => void
  enterEdit?: boolean
  onEnteredEdit?: () => void
  activeWorkspaceIdOverride?: string
  backendClient?: Pick<DohcBackendClient, 'readText' | 'createTextFile'>
  // file-org-v1 D4.7c (save-flush race fix) — when rename/move
  // mutations are about to fire from elsewhere, the caller can
  // populate this ref with our flushSave function and `await` it
  // first to commit any pending debounced save BEFORE the
  // mutation reads the body. Without this, a fast type+rename
  // loses the typed text because the autosave debounce gets
  // cancelled when effectivePath changes post-rename.
  pendingSaveRef?: React.RefObject<(() => Promise<void>) | null>
}

export function AtomView({
  path,
  files,
  onRunAction,
  onOpenAtom,
  onOpenView,
  onShare,
  enterEdit,
  onEnteredEdit,
  activeWorkspaceIdOverride,
  backendClient,
  pendingSaveRef,
}: Props) {
  // No path → no atom is open. We skip the Convex query and render an
  // empty placeholder below. Don't fall back to a "default" atom path.
  const effectivePath = path
  const contextActiveWorkspaceId = useActiveWorkspaceId()
  const activeWorkspaceId =
    activeWorkspaceIdOverride ?? contextActiveWorkspaceId
  const convexRow = useQuery(
    api.atoms.getByPath,
    backendClient || !effectivePath
      ? 'skip'
      : { path: effectivePath, activeWorkspaceId },
  )
  const upsert = useMutation(api.atoms.upsert)
  // atom-address-v1 §1.4 — proactively learn if THIS file's address
  // was auto-suffixed or collided (so a hidden `id:` is never
  // unexplained). Rendered as a calm inline line by AtomShell.
  const idAdvisory = useQuery(
    api.atoms.idAdvisory,
    backendClient || !effectivePath
      ? 'skip'
      : { path: effectivePath, activeWorkspaceId },
  )
  const [backendRow, setBackendRow] = useState<
    { body: string; revision: string; migrationNotice?: string | null } | null | undefined
  >(undefined)
  const row:
    | { body: string; revision?: string; migrationNotice?: string | null }
    | null
    | undefined = backendClient ? backendRow : convexRow

  // Always-editor: the rendered doc IS the editor. There's no separate read
  // mode to swap to on blur, so the doc layout is identical whether the
  // editor has focus or not.
  //
  //   draft           — the in-flight editor body
  //   remoteBodyRef   — the last body we know the server has (initial load
  //                     or last successful save). Lets the server-sync
  //                     effect tell "remote update arrived" vs "echo of our
  //                     own save" vs "user has local edits — don't clobber".
  const [draft, setDraft] = useState('')
  const remoteBodyRef = useRef<string | null>(null)
  // syncedPath = the path whose initial content we've loaded into draft.
  // Until this matches the current path, we render a loader instead of
  // mounting the editor — Tiptap is uncontrolled and only reads its
  // initial value at mount time, so we must not mount it with stale or
  // empty content while the row is still in flight.
  const [syncedPath, setSyncedPath] = useState<string | null>(null)

  function writeText(path: string, body: string) {
    if (backendClient) {
      return backendClient.createTextFile({
        path,
        body,
        contentType: contentTypeForTextPath(path),
      })
    }
    return upsert({ path, body, source: 'user', activeWorkspaceId })
  }

  // Reset sync state when the path changes.
  useEffect(() => {
    remoteBodyRef.current = null
    setSyncedPath(null)
  }, [path])

  useEffect(() => {
    if (!backendClient) return
    if (!effectivePath) {
      setBackendRow(null)
      return
    }
    let cancelled = false
    setBackendRow(undefined)
    void backendClient.readText(effectivePath)
      .then((text) => {
        if (cancelled) return
        setBackendRow({ body: text.body, revision: text.revision })
      })
      .catch(() => {
        if (cancelled) return
        setBackendRow(null)
      })
    return () => {
      cancelled = true
    }
  }, [backendClient, effectivePath])

  // First-load sync: once the row arrives for the current path, seed draft
  // and mark synced. Subsequent remote updates while editing are NOT pulled
  // in — last-write-wins (the auto-save below will eventually overwrite the
  // server). This avoids fighting the uncontrolled editor.
  useEffect(() => {
    if (!row || !effectivePath) return
    if (syncedPath === effectivePath) return
    setDraft(row.body)
    remoteBodyRef.current = row.body
    setSyncedPath(effectivePath)
  }, [row, effectivePath, syncedPath])

  // Debounced auto-save. We mark remoteBodyRef optimistically on dispatch so
  // a second save in the debounce window doesn't double-fire for the same
  // content.
  useEffect(() => {
    if (!row || !effectivePath) return
    if (remoteBodyRef.current === null) return
    if (draft === remoteBodyRef.current) return
    const t = setTimeout(() => {
      const toSave = draft
      if (wouldErasePostFrontmatterContent(remoteBodyRef.current, toSave)) {
        setDraft(remoteBodyRef.current ?? '')
        return
      }
      remoteBodyRef.current = toSave
      void writeText(effectivePath, toSave)
    }, 500)
    return () => clearTimeout(t)
  }, [backendClient, draft, row, upsert, effectivePath, activeWorkspaceId])

  // D4.28 — immediate commit (no debounce) for the raw-source
  // textarea. Editing the frontmatter `id:` per-keystroke on the
  // 500ms autosave makes each intermediate id reconcile + scan
  // (wasteful + the mechanism behind earlier index churn). The
  // source view now buffers locally and calls this ONCE on
  // blur/done, so the id is reconciled a single time with the final
  // value. Sets remoteBodyRef so the debounce won't double-fire.
  async function commitDraft(next: string) {
    if (!effectivePath) return
    if (wouldErasePostFrontmatterContent(remoteBodyRef.current, next)) {
      setDraft(remoteBodyRef.current ?? draft)
      return
    }
    setDraft(next)
    if (next === remoteBodyRef.current) return
    remoteBodyRef.current = next
    await writeText(effectivePath, next)
  }

  function changeDraft(next: string) {
    if (wouldErasePostFrontmatterContent(remoteBodyRef.current, next)) return
    setDraft(next)
  }

  function previewDraft(next: string) {
    if (wouldErasePostFrontmatterContent(remoteBodyRef.current, next)) return
    setDraft(next)
    remoteBodyRef.current = next
  }

  // D4.7c — flushPendingSave: synchronously dispatch any pending
  // debounced save before a sibling mutation runs (rename / move /
  // delete). Keeps body-in-DB up to date with the typed content so
  // the move's wikilink cascade sees the latest text.
  //
  // draftRef is updated AFTER every render via the effect below, so
  // flushPendingSave always reads the latest committed-to-React
  // draft (avoids closure staleness from useCallback's dep array).
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  useEffect(() => {
    if (!pendingSaveRef) return
    pendingSaveRef.current = async () => {
      if (!effectivePath) return
      if (remoteBodyRef.current === null) return
      if (draftRef.current === remoteBodyRef.current) return
      const toSave = draftRef.current
      if (wouldErasePostFrontmatterContent(remoteBodyRef.current, toSave)) {
        setDraft(remoteBodyRef.current)
        return
      }
      remoteBodyRef.current = toSave
      await writeText(effectivePath, toSave)
    }
    return () => {
      if (pendingSaveRef.current) pendingSaveRef.current = null
    }
  }, [backendClient, effectivePath, upsert, pendingSaveRef, activeWorkspaceId])

  // enterEdit signals "focus the editor on arrival" for new-page flows.
  // Clear the flag upstream
  // after a tick so the autoFocus rAF inside AtomEditor has time to fire.
  useEffect(() => {
    if (!enterEdit) return
    const t = setTimeout(() => onEnteredEdit?.(), 80)
    return () => clearTimeout(t)
  }, [enterEdit, onEnteredEdit])

  const breadcrumbs = useMemo(
    () => (effectivePath ? pathToBreadcrumbs(effectivePath) : []),
    [effectivePath],
  )
  const subpages = useMemo(
    () => (effectivePath ? findSubpages(files, effectivePath) : []),
    [files, effectivePath],
  )

  // Middle-mouse drag-to-pan on the pane. Lets the user navigate wide ascii
  // sketches (which overflow the page column horizontally) and tall pages
  // by holding the scroll wheel down and dragging — the standard "hand"
  // gesture from browsers / PDF readers. Works on the same .pane that has
  // overflow:auto, so we just translate its scrollLeft/scrollTop on move.
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    let panning = false
    let startX = 0
    let startY = 0
    let startScrollLeft = 0
    let startScrollTop = 0
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 1) return // middle button only
      e.preventDefault()
      panning = true
      startX = e.clientX
      startY = e.clientY
      startScrollLeft = pane!.scrollLeft
      startScrollTop = pane!.scrollTop
      pane!.classList.add('pane-panning')
    }
    function onMouseMove(e: MouseEvent) {
      if (!panning) return
      pane!.scrollLeft = startScrollLeft - (e.clientX - startX)
      pane!.scrollTop = startScrollTop - (e.clientY - startY)
    }
    function endPan() {
      if (!panning) return
      panning = false
      pane!.classList.remove('pane-panning')
    }
    // Block the browser's autoscroll cursor on middle-down inside the pane.
    function onAuxClick(e: MouseEvent) {
      if (e.button === 1) e.preventDefault()
    }
    pane.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', endPan)
    window.addEventListener('blur', endPan)
    pane.addEventListener('auxclick', onAuxClick)
    return () => {
      pane.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', endPan)
      window.removeEventListener('blur', endPan)
      pane.removeEventListener('auxclick', onAuxClick)
    }
  }, [])

  return (
    <div ref={paneRef} className="pane bg-page">
      <header className="sticky top-0 z-20 flex h-11 items-center px-6 bg-page/85 backdrop-blur-md border-b border-rule">
        <Breadcrumbs crumbs={breadcrumbs} onOpenAtom={onOpenAtom} />
      </header>
      {!effectivePath ? (
        <NoFile />
      ) : row === undefined || syncedPath !== effectivePath ? (
        <DocumentSkeleton />
      ) : row === null ? (
        <EmptyAtom path={effectivePath} />
      ) : (
        <AtomShell
          /* 3.9.21 — multiplayer is default-on; the key
             suffix that previously tracked the flag's on/off
             state is no longer needed. Reverting to the
             original effectivePath-only key. */
          key={effectivePath}
          draft={draft}
          onChange={changeDraft}
          onPreviewChange={previewDraft}
          onRunAction={onRunAction}
          subpages={subpages}
          allFiles={files}
          onOpenAtom={onOpenAtom}
          onOpenView={onOpenView}
          autoFocus={!!enterEdit}
          advisory={idAdvisory ?? null}
          migrationNotice={row?.migrationNotice ?? null}
          // D4.11b — the SERVER-saved id (from the row body, where
          // seedAtomIdIntoBody injected it on first write). The local
          // draft doesn't re-sync the injected id during editing, so
          // a freshly-authored html atom has no `id:` in `draft` yet;
          // the iframe (which renders the SAVED content by id) falls
          // back to this so it resolves immediately after the first
          // autosave round-trips.
          savedAtomId={row ? extractFrontmatterId(row.body) : null}
          // D4.13 — extension determines rendering: a `.html` path
          // renders as a sandboxed HTML page, anything else as the
          // markdown editor. (type: html frontmatter is still a
          // backward-compat fallback inside AtomShell.)
          pathIsHtml={effectivePath ? isHtmlPath(effectivePath) : false}
          path={effectivePath}
          activeWorkspaceId={activeWorkspaceId}
          // D4.28 — immediate-commit for the raw-source textarea
          // (avoids per-keystroke id reconcile).
          onCommitSource={commitDraft}
          onShare={onShare}
        />
      )}
    </div>
  )
}

function contentTypeForTextPath(path: string): string {
  const clean = path.toLowerCase()
  if (clean.endsWith('.html')) return 'text/html'
  if (clean.endsWith('.json')) return 'application/json'
  if (clean.endsWith('.txt')) return 'text/plain'
  if (clean.endsWith('.csv')) return 'text/csv'
  return 'text/markdown'
}

function NoFile() {
  return (
    <div className="flex h-[calc(100vh-44px)] flex-col items-center justify-center gap-8 px-8">
      {/* dohc brand block — mark on the left, calm metadata on the right. */}
      <DohcBrandBlock
        lines={['dohc · workspace', 'your documents, sources, and drafts', '~/workspace']}
      />
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-[22px] tracking-tight text-ink-strong font-semibold">
          Open a document
        </h2>
        <p className="text-[13.5px] text-ink-dim max-w-sm text-center leading-relaxed">
          Pick a page from the sidebar to start reading or editing — or press{' '}
          <kbd className="rounded bg-panel border border-rule px-1.5 py-0.5 text-[11px] font-medium text-ink-dim">
            ⌘K
          </kbd>{' '}
          to search and run a command.
        </p>
      </div>
    </div>
  )
}

function AtomShell({
  draft,
  onChange,
  onPreviewChange,
  onRunAction,
  subpages,
  allFiles,
  onOpenAtom,
  onOpenView,
  autoFocus,
  advisory,
  migrationNotice,
  savedAtomId,
  pathIsHtml,
  path,
  activeWorkspaceId,
  onCommitSource,
  onShare,
}: {
  draft: string
  onChange: (next: string) => void
  onPreviewChange?: (next: string) => void
  onRunAction: (prompt: string) => void
  subpages: FileRow[]
  // D4.8 — full vault file list (not just subpages) so the
  // wikilink decoration plugin can resolve targets across the
  // entire vault and mark unknown targets as broken.
  allFiles: FileRow[]
  onOpenAtom: (path: string) => void
  onOpenView?: (packageRoot: string) => void
  autoFocus: boolean
  advisory: {
    kind: 'collision' | 'suffixed' | null
    fileId: string | null
    wanted: string | null
  } | null
  migrationNotice?: string | null
  // D4.11b — server-saved id fallback for the html-atom iframe.
  savedAtomId?: string | null
  // D4.13 — true when the atom's PATH ends in `.html`. Extension is
  // the primary render determinant.
  pathIsHtml?: boolean
  // the atom's current path (for the html title default = filename)
  path?: string | null
  activeWorkspaceId?: string
  // D4.28 — immediately persist the raw-source buffer (one save +
  // one id-reconcile) on blur/done.
  onCommitSource?: (next: string) => void
  // sharing-v1 1a — share this file (by its fileId).
  onShare?: (fileId: string) => void
}) {
  const { user } = useAuth()
  const editorRef = useRef<AtomEditorHandle | null>(null)
  const identity = useQuery(api.auth.whoami)
  const collabUserName =
    user?.firstName || user?.email?.split('@')[0] || 'You'
  // D4.8 — known-files list for the wikilink plugin's resolver +
  // autocomplete picker. Memoized so the editor's plugin reads a
  // stable identity until the file list actually changes. The
  // shape is just {path, title} — derived from the api.atoms.list
  // projection (which derives title from frontmatter or H1).
  const knownFiles = useMemo(
    () =>
      allFiles.map((f) => ({
        path: f.path,
        title: f.title ?? null,
        // D4.8e — pass the rename-proof fileId through so the
        // formula plugin can resolve `{= id.key }` references to
        // the file's current title.
        fileId: f.fileId ?? null,
      })),
    [allFiles],
  )
  const knownPaths = useMemo(
    () => new Set(knownFiles.map((f) => f.path)),
    [knownFiles],
  )
  const [sketcherOpen, setSketcherOpen] = useState(false)
  // When set, the sketcher is editing an existing ascii block at this doc
  // position. On insert we `replaceCodeBlockAt(pos, ...)` instead of
  // inserting a fresh fence at the cursor.
  const [editingBlock, setEditingBlock] = useState<{ pos: number; text: string; language: string } | null>(null)
  // atom-address-v1 §1.4 — (b1) the leading YAML frontmatter (incl.
  // the rename-proof `id:`) is split off so Tiptap never renders it as
  // prose (zero frontmatter glyphs); the exact captured bytes are
  // reattached on every change, so it round-trips byte-identical.
  // (b2) `sourceMode` swaps the editor for a raw textarea over the
  // FULL body so the user can still SEE and hand-edit the
  // frontmatter/id (manifesto locked-#1: inspectable & hand-editable).
  const viewInfo = useMemo(() => (path ? parseViewPath(path) : null), [path])
  const sourceLocked = isSourceFirstPath(path)
  const [sourceMode, setSourceMode] = useState(() => sourceLocked)
  useEffect(() => {
    if (sourceLocked) setSourceMode(true)
  }, [sourceLocked])
  // D4.28 — raw-source buffer. While in source mode the textarea
  // edits THIS (local), not `draft`, so per-keystroke autosave +
  // id-reconcile don't fire. Synced from `draft` while source mode is
  // active; committed (one immediate save) on blur / formatted-return.
  const [sourceDraft, setSourceDraft] = useState(draft)
  useEffect(() => {
    if (sourceMode) setSourceDraft(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, draft])
  function leaveSource() {
    onCommitSource?.(sourceDraft)
    setSourceMode(false)
  }

  // D4.15 — the "Address auto-named …" suffixed advisory is purely
  // informational ("fine to keep"). Make it dismissible + persist
  // the dismissal per-atom in localStorage so it never nags again.
  const suffixedKey =
    advisory && advisory.kind === 'suffixed' && advisory.fileId
      ? `dohc:dismiss-suffixed:${advisory.fileId}`
      : null
  const [suffixedDismissed, setSuffixedDismissed] = useState(false)
  useEffect(() => {
    if (!suffixedKey) {
      setSuffixedDismissed(false)
      return
    }
    try {
      setSuffixedDismissed(localStorage.getItem(suffixedKey) === '1')
    } catch {
      setSuffixedDismissed(false)
    }
  }, [suffixedKey])
  function dismissSuffixed() {
    if (suffixedKey) {
      try {
        localStorage.setItem(suffixedKey, '1')
      } catch {
        /* ignore quota / disabled storage */
      }
    }
    setSuffixedDismissed(true)
  }

  // ⌘/Ctrl + Shift + D opens the ASCII sketch modal. Scoped to window so
  // the user can trigger it while typing inside the editor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setSketcherOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The slash menu's "ASCII sketch" item and the command palette's
  // "Insert ASCII sketch" command both dispatch a custom event we listen
  // for here, so the sketcher modal opens regardless of where the user
  // triggered it from.
  useEffect(() => {
    function onOpen() {
      setSketcherOpen(true)
    }
    window.addEventListener(OPEN_SKETCH_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SKETCH_EVENT, onOpen)
  }, [])
  // Parse from the live draft so headers/overlays update as the user types.
  // Memoize the derived parts so unrelated shell state changes do not reparse
  // YAML or resplit the frontmatter.
  const { meta, fm, rest } = useMemo(() => {
    const parsed = parseFrontmatter(draft)
    const split = splitFrontmatter(draft)
    return { meta: parsed.meta, fm: split.fm, rest: split.rest }
  }, [draft])
  const isAction = meta.type === 'action'
  const isSkill = useMemo(() => isSkillAtomBody(draft), [draft])
  // D4.13 — EXTENSION determines rendering: a `.html` path renders
  // as a sandboxed HTML page (the §2-B route iframe), NEVER Tiptap.
  // `type: html` frontmatter is kept as a backward-compat fallback
  // so existing agent-authored html atoms (.md + type: html) keep
  // working. The §2-B route + tree badge mirror this same OR.
  const isHtml = useMemo(
    () => shouldRenderHtmlAtomFrame({ path, pathIsHtml: !!pathIsHtml, draft }),
    [path, pathIsHtml, draft],
  )
  // D4.11b — prefer the draft's id (honors a live hand-edit in
  // source mode); fall back to the SERVER-saved id when the draft
  // has none yet (a freshly-authored html atom whose id was just
  // injected on autosave but hasn't re-synced into the local
  // draft). Without the fallback the iframe sees null → "no
  // address yet" instead of rendering the just-saved page.
  const atomId = useMemo(
    () => extractFrontmatterId(draft) ?? savedAtomId ?? null,
    [draft, savedAtomId],
  )

  // D4.22 — Notion-style title field, backed by the frontmatter
  // `title:` property (NOT the body). The editor shows the full
  // content; the title lives in metadata next to `id`. Not shown
  // for html (filename is the title) / action / skill.
  // html files DO support a title now — the filename, shown above the
  // page + stored in frontmatter (like markdown pages).
  const supportsTitle = !isAction && !isSkill
  // the file name (leaf, sans extension) — the default title for html.
  const leafName = useMemo(
    () =>
      path
        ? (path.replace(/\.[a-z0-9]+$/i, '').split('/').pop() ?? '')
        : '',
    [path],
  )
  // seed an html page's frontmatter `title:` with its filename when
  // missing, so the title is real metadata (one-time per file; this
  // shell is keyed by path, so it re-evaluates on open).
  useEffect(() => {
    if (!isHtml || !leafName) return
    const t = meta.title
    if (typeof t === 'string' && t.trim()) return
    onChange(setFrontmatterTitle(draft, leafName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHtml, leafName])
  const pageTitle = typeof meta.title === 'string' ? meta.title : ''
  // emoji-icons — the page's icon lives in frontmatter `icon:`, shown
  // above the title (Notion-style) + editable via the emoji picker.
  const pageIcon = typeof meta.icon === 'string' ? meta.icon : ''
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const shellClassName = isHtml && !sourceMode
    ? 'dohc-html-shell'
    : 'doc doc-editing'
  const htmlViewMode = isHtml && !sourceMode
  const fileActionsClassName = htmlViewMode
    ? 'absolute right-3 top-3 z-30 flex items-center gap-1 rounded-md border border-rule bg-page/85 px-1.5 py-1 shadow-xs backdrop-blur'
    : 'flex justify-end items-center gap-2 -mt-2 mb-1'

  return (
    <div className={shellClassName}>
      {isAction && typeof meta.prompt === 'string' && (
        <ActionHeader
          title={typeof meta.title === 'string' ? meta.title : '(untitled)'}
          prompt={meta.prompt}
          onRunAction={onRunAction}
        />
      )}
      {advisory && advisory.kind === 'collision' && (
        // §1.4 REQUIRED surfacing — proactive, inline, never a modal.
        // The user learns their address is broken without having to
        // suspect anything; the `source` button is the fix.
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-ink-dim">
          <span className="font-medium text-ink-strong">
            Address <code className="text-[11px]">{advisory.fileId}</code> is
            already used by another file.
          </span>{' '}
          Live values referencing it won’t resolve until this file’s id is
          unique — open{' '}
          <button
            type="button"
            onClick={() => setSourceMode(true)}
            className="underline underline-offset-2 hover:text-ink-strong"
          >
            ⟨⟩ source
          </button>{' '}
          and change <code className="text-[11px]">id:</code>.
        </div>
      )}
      {advisory && advisory.kind === 'suffixed' && !suffixedDismissed && (
        <div className="mb-2 flex items-start gap-2 text-[11.5px] text-ink-faint">
          <span className="flex-1">
            Address auto-named{' '}
            <code className="text-[11px]">{advisory.fileId}</code> (another file
            wanted <code className="text-[11px]">{advisory.wanted}</code>). Fine
            to keep — or rename via{' '}
            <span className="text-ink-dim">source</span>.
          </span>
          <button
            type="button"
            onClick={dismissSuffixed}
            className="shrink-0 px-1 leading-none text-ink-faint hover:text-ink-strong transition-colors"
            title="Dismiss"
            aria-label="Dismiss this notice"
          >
            ✕
          </button>
        </div>
      )}
      {migrationNotice === 'skills-v1' && (
        // skills-commands-v1 §6.4 — calm per-file advisory shown
        // until the user edits the file (any save clears it) or
        // moves it out of `skills/`. Reserved-folder migration
        // signal; never a modal.
        <div className="mb-2 rounded-md border border-violet-500/30 bg-violet-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-ink-dim">
          <span className="font-medium text-ink-strong">
            Marked as a skill by migration.
          </span>{' '}
          The <code className="text-[11px]">.skills/</code> folder is reserved
          for agent skills — edit this file to keep it (clears this
          notice), or move it elsewhere to restore inline
          <code className="text-[11px]"> {'{key: value}'}</code> captures.
        </div>
      )}
      {/* (b2) Raw-source toggle. D4.11: ALWAYS shown (was gated on
          `fm !== ''`). The gate created a chicken-and-egg: a new
          atom has no frontmatter, so the toggle was hidden, so you
          could never drop into raw mode to ADD frontmatter — making
          it impossible to hand-author an html / skill atom
          (Tiptap hides frontmatter, so typing `---\ntype: html\n---`
          in the formatted editor doesn't stick). Always-on unblocks
          manual creation of typed atoms + raw `id:` edits on a fresh
          file. Plain notes just gain a faint, ignorable "source"
          button — standard "view source" affordance.
          Track-3 P4: skills also surface the "copy share text"
          button (strips the canonical id + injects an advisory
          source-share line so the recipient owns a clean atom). */}
      <div className={fileActionsClassName}>
        {viewInfo && onOpenView && (
          <button
            type="button"
            onClick={() => onOpenView(viewInfo.packageRoot)}
            className="flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-dim px-1.5 py-0.5 rounded transition-colors"
            title="Open rendered view"
          >
            <AppWindow className="size-3" strokeWidth={2} />
            Open view
          </button>
        )}
        {isSkill && <ShareSkillButton body={draft} />}
        {onShare && atomId && (
          <button
            type="button"
            onClick={() => onShare(atomId)}
            className="flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-dim px-1.5 py-0.5 rounded transition-colors"
            title="Share this file with someone"
          >
            <Share2 className="size-3" strokeWidth={2} />
            share
          </button>
        )}
        {!sourceLocked && (
          <button
            type="button"
            onClick={() => (sourceMode ? leaveSource() : setSourceMode(true))}
            className="text-[11px] text-ink-faint hover:text-ink-dim px-1.5 py-0.5 rounded transition-colors"
            title={
              sourceMode
                ? 'Back to the formatted editor'
                : 'Show & edit the raw source (frontmatter / id)'
            }
          >
            {sourceMode ? 'formatted' : 'source'}
          </button>
        )}
      </div>
      {/* emoji-icons — Notion-style page icon ABOVE the title. Lives
          in the frontmatter `icon:` property (shows in the tree +
          metadata). Click to open the emoji picker. */}
      {!sourceMode && supportsTitle && !htmlViewMode && (
        <div className="group/icon mb-1">
          {pageIcon ? (
            <button
              type="button"
              onClick={() => setIconPickerOpen(true)}
              title="Change icon"
              className="rounded-md p-0.5 text-[44px] leading-none hover:bg-hover"
            >
              {pageIcon}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIconPickerOpen(true)}
              title="Add icon"
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-ink-faint opacity-0 transition-opacity hover:text-ink-dim group-hover/icon:opacity-100"
            >
              <Smile className="size-4" strokeWidth={1.8} />
              Add icon
            </button>
          )}
        </div>
      )}
      {/* D4.22 — Notion-style page title field, ABOVE the
          properties. Backed by the frontmatter `title:` property. */}
      {!sourceMode && supportsTitle && !htmlViewMode && (
        <input
          className="dohc-title-field"
          value={pageTitle || (isHtml ? leafName : '')}
          placeholder="Untitled"
          spellCheck={false}
          onChange={(e) => onChange(setFrontmatterTitle(draft, e.target.value))}
        />
      )}
      {iconPickerOpen && (
        <EmojiPicker
          onPick={(emoji) => {
            onChange(setFrontmatterIcon(draft, emoji))
            setIconPickerOpen(false)
          }}
          onClear={() => {
            onChange(setFrontmatterIcon(draft, null))
            setIconPickerOpen(false)
          }}
          onClose={() => setIconPickerOpen(false)}
        />
      )}
      {/* D4.19 — Notion-style page properties (frontmatter editor),
          BELOW the title. Hidden for action / skill atoms
          (their frontmatter is functional config) and in raw-source
          mode. */}
      {!sourceMode &&
        !htmlViewMode &&
        !isAction &&
        !isSkill && (
          <PropertiesPanel body={draft} onChange={onChange} />
        )}
      {sourceMode ? (
        // (b2) raw source over the FULL body (frontmatter included).
        // Edits flow straight to `draft`/save — an `id:` hand-edit is
        // honored by the next write (seedAtomIdIntoBody never rewrites
        // a non-empty id).
        // D4.34 — syntax-highlighted (Prism): YAML frontmatter +
        // HTML or Markdown body. react-simple-code-editor overlays a
        // highlighted <pre> on the editable <textarea>.
        // D4.28 — edits buffer locally; committed on blur/done so the
        // frontmatter id reconciles ONCE, not per keystroke.
        <SourceCodeEditor
          value={sourceDraft}
          onValueChange={setSourceDraft}
          highlight={(code) => highlightSource(code, sourceLangForPath(path, isHtml))}
          onBlur={() => onCommitSource?.(sourceDraft)}
          autoFocus
          padding={0}
          className="dohc-source min-h-[60vh] font-mono text-[13px] leading-relaxed"
        />
      ) : isHtml ? (
        // html-atoms-v1 §5 — rendered VIEW via the §2-B sandboxed
        // route iframe (Tiptap is never used for an html body). The
        // The source toggle above still flips to the raw textarea.
        <HtmlAtomFrame
          atomId={atomId}
          body={rest}
          activeWorkspaceId={activeWorkspaceId}
        />
      ) : identity === undefined ? (
        <DocumentSkeleton compact />
      ) : (
        <AtomEditor
          ref={editorRef}
          // (b1) Tiptap only ever sees the body WITHOUT frontmatter →
          // zero frontmatter glyphs. On change we reattach the exact
          // captured `fm` bytes, so the frontmatter round-trips
          // byte-identical regardless of Tiptap's content normalization.
          // D4.22 — title lives in frontmatter now, so the editor
          // gets the full content body again (no title extraction).
          value={rest}
          onChange={(next) => onChange(joinFrontmatter(fm, next))}
          onPreviewChange={(next) => onPreviewChange?.(joinFrontmatter(fm, next))}
          frontmatter={meta}
          activeWorkspaceId={activeWorkspaceId}
          autoFocus={autoFocus}
          onAsciiBlockClick={(pos, content, language) => {
            setEditingBlock({ pos, text: content, language })
            setSketcherOpen(true)
          }}
          knownFiles={knownFiles}
          collab={
            identity?.workspaceId && atomId
              ? {
                  workspaceId: activeWorkspaceId ?? identity.workspaceId,
                  atomId,
                  userId: user?.id,
                  userName: collabUserName,
                }
              : undefined
          }
          onOpenWikilink={(target) => {
            // Resolution rule (matches the cascade): if the target
            // matches an existing file (with or without .md),
            // navigate. The broken-link case stays in the editor —
            // the dashed/muted style already tells the user.
            const withMd = target.endsWith('.md') ? target : `${target}.md`
            if (knownPaths.has(target)) onOpenAtom(target)
            else if (knownPaths.has(withMd)) onOpenAtom(withMd)
          }}
        />
      )}
      {!htmlViewMode && subpages.length > 0 && (
        <Subpages subpages={subpages} onOpenAtom={onOpenAtom} />
      )}
      {sketcherOpen && (
        <AsciiSketchModal
          initialText={editingBlock?.text}
          initialLanguage={editingBlock?.language}
          onClose={() => {
            setSketcherOpen(false)
            setEditingBlock(null)
          }}
          onInsert={(text, language) => {
            if (editingBlock) {
              editorRef.current?.replaceCodeBlockAt(editingBlock.pos, text, language)
            } else {
              editorRef.current?.insertCodeBlock(language ?? 'ascii', text)
            }
            setSketcherOpen(false)
            setEditingBlock(null)
          }}
        />
      )}
    </div>
  )
}

function Breadcrumbs({
  crumbs,
  onOpenAtom,
}: {
  crumbs: ReturnType<typeof pathToBreadcrumbs>
  onOpenAtom: (path: string) => void
}) {
  return (
    <nav className="flex items-center gap-0.5 text-[12.5px] min-w-0">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center min-w-0">
          {i > 0 && (
            <span className="px-1.5 text-ink-faint select-none" aria-hidden>
              /
            </span>
          )}
          {c.isCurrent ? (
            <span className="text-ink-strong font-medium truncate">
              {c.label}
            </span>
          ) : c.target ? (
            <button
              onClick={() => onOpenAtom(c.target)}
              title={c.target}
              className="text-ink-dim hover:text-ink truncate transition-colors"
            >
              {c.label}
            </button>
          ) : (
            <span className="text-ink-dim truncate">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

function EmptyAtom({ path }: { path: string }) {
  return (
    <div className="doc">
      <div className="flex flex-col items-start gap-3 px-2 py-12 max-w-[640px]">
        <h1 className="text-[32px] tracking-tight leading-none text-ink-strong font-semibold">
          Start something
        </h1>
        <p className="text-[14px] text-ink-dim leading-relaxed">
          <code className="font-mono text-[12.5px] bg-panel px-1.5 py-0.5 rounded border border-rule text-ink">
            {path}
          </code>{' '}
          doesn't exist yet.
        </p>
        <p className="text-[14px] text-ink-dim leading-relaxed">
          Tell the agent what you do — it'll build your workspace.
        </p>
      </div>
    </div>
  )
}

function Subpages({
  subpages,
  onOpenAtom,
}: {
  subpages: FileRow[]
  onOpenAtom: (path: string) => void
}) {
  return (
    <div className="dohc-subpages mt-12 mb-16 border-t border-rule pt-6">
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium mb-3">
        in this folder · {subpages.length}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
        {subpages.map((s) => (
          <li key={s._id}>
            <button
              onClick={() => onOpenAtom(s.path)}
              title={s.path}
              className="w-full text-left flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-dim hover:text-ink hover:bg-hover transition-colors"
            >
              <span className="size-1 rounded-full bg-ink-ghost shrink-0" />
              <span className="truncate">
                {s.title?.trim() ||
                  s.path.split('/').pop()?.replace(/\.md$/i, '') ||
                  s.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ActionHeader({
  title,
  prompt,
  onRunAction,
}: {
  title: string
  prompt: string
  onRunAction: (p: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 mb-6 px-4 py-3 rounded-lg border border-rule bg-panel">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint font-semibold">
          action
        </span>
        <span className="text-[13.5px] text-ink-strong truncate font-medium">
          {title}
        </span>
      </div>
      <button
        onClick={() => onRunAction(prompt)}
        className="shrink-0 inline-flex h-7 items-center rounded-md bg-ink-strong px-3 text-[12px] font-medium text-surface hover:bg-ink transition-colors"
      >
        Run
      </button>
    </div>
  )
}

// Track-3 P4 — "Copy share text" button for type:skill atoms.
// Pure UI shell over the `buildShareText` pure helper + the
// `api.auth.whoami` query for the sender handle. Click writes the share text
// to the clipboard; failures show an inline copy panel so the user can select
// the text without leaving the page.
function ShareSkillButton({ body }: { body: string }) {
  const me = useQuery(api.auth.whoami)
  const [copied, setCopied] = useState(false)
  const [fallbackText, setFallbackText] = useState<string | null>(null)
  const fallbackRef = useRef<HTMLTextAreaElement>(null)
  const handle = me?.workspaceId ?? ''
  const disabled = !handle

  useEffect(() => {
    if (!fallbackText) return
    fallbackRef.current?.focus()
    fallbackRef.current?.select()
  }, [fallbackText])

  async function onClick() {
    const text = buildShareText(body, handle)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
        return
      }
      setFallbackText(text)
    } catch {
      setFallbackText(text)
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="text-[11px] text-ink-faint hover:text-ink-dim px-1.5 py-0.5 rounded transition-colors disabled:cursor-not-allowed disabled:hover:text-ink-faint"
        title="Copy share text (strips id, adds source-share for provenance — the recipient pastes into a new atom they own)"
      >
        {copied ? '✓ copied' : '⤴ share'}
      </button>
      {fallbackText && (
        <>
          <span
            className="fixed inset-0 z-30"
            onClick={() => setFallbackText(null)}
          />
          <span className="absolute right-0 top-7 z-40 block w-80 rounded-lg border border-rule bg-elevated p-3 text-left shadow-md">
            <span className="block text-[12.5px] font-medium text-ink-strong">
              Copy share text
            </span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-dim">
              Clipboard access is unavailable here. The text is selected for
              manual copy.
            </span>
            <textarea
              ref={fallbackRef}
              value={fallbackText}
              readOnly
              className="mt-2 h-28 w-full resize-none rounded-md border border-rule bg-panel p-2 font-mono text-[11px] leading-snug text-ink outline-none focus:border-accent"
            />
            <span className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setFallbackText(null)}
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              >
                Close
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const writeText = navigator.clipboard?.writeText
                    if (!writeText) throw new Error('Clipboard unavailable')
                    await writeText.call(navigator.clipboard, fallbackText)
                    setFallbackText(null)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1800)
                  } catch {
                    fallbackRef.current?.focus()
                    fallbackRef.current?.select()
                  }
                }}
                className="rounded-md bg-ink-strong px-2 py-1 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink"
              >
                Copy again
              </button>
            </span>
          </span>
        </>
      )}
    </span>
  )
}
