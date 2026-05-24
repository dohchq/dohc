import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createFileRoute,
  useNavigate,
  useLocation,
  Outlet,
} from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import {
  MessageSquare,
  MessageSquareOff,
  Shield,
  RefreshCw,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { applyFrontmatter, parseFrontmatter } from '@/lib/frontmatter'
import { useDocumentMeta } from '@/lib/use-document-meta'
import { FileTree } from '@/components/FileTree'
import { AtomView } from '@/components/AtomView'
import { SharedAtomView } from '@/components/SharedAtomView'
import { ShareDialog } from '@/components/ShareDialog'
import { ActivityBar } from '@/components/ActivityBar'
import { GraphView } from '@/components/GraphView'
import type { Id } from '../../convex/_generated/dataModel'
import { Chat } from '@/components/Chat'
import { SharingPanel } from '@/components/SharingPanel'
import { ProposalsPanel } from '@/components/ProposalsPanel'
import { PluginPanel } from '@/components/PluginPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { SearchOverlay } from '@/components/SearchOverlay'
import { DohcLogo } from '@/components/DohcLogo'
import { Onboarding } from '@/components/Onboarding'
import {
  ActiveWorkspaceProvider,
  useActiveWorkspaceId,
} from '@/lib/active-workspace'

// D4.33 — pathless layout. The open atom now lives in the URL as a
// PATH segment `/p/<fileId>` (the rename-proof id, so a shared link
// survives renames). This layout holds the WHOLE app shell so that
// navigating `/` ↔ `/p/<id>` swaps only the (vestigial) child route
// and NEVER remounts the shell (file tree, chat, editor stay live).
// The child routes (_app.index, _app.p.$atomId) render nothing — the
// shell reads the open fileId straight from the path via useLocation.
export const Route = createFileRoute('/_app')({
  component: AppLayout,
})

function AppLayout() {
  return (
    <ActiveWorkspaceProvider>
      <Home />
      <Outlet />
    </ActiveWorkspaceProvider>
  )
}

const BUILD_PLUGIN_PROMPT = `I want to build a new plugin. Available kernels are heatmap, list (with layouts: cards/kanban/template), table, and custom. Custom kernels are full HTML/JS in a sandboxed iframe with read+write access via window.dohc. Ask me what view I want, what query it should claim (e.g. entities.list("booking")), which kernel to use, and which kernel-specific fields / commands / overlay flag to set. Then write the plugin atom to plugins/<id>.md with the right frontmatter.`

type View = 'atom' | 'graph' | 'plugins'

// Display name for a file path: the leaf, sans a single extension
// (`clients/Acme Corp.md` → `Acme Corp`). Used as the tab-title
// fallback when an atom has no frontmatter `title:` — mirrors how the
// tree labels untitled files.
function leafName(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
}

function Home() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="grid h-screen place-items-center bg-page text-ink-faint text-sm">
        loading…
      </div>
    )
  }
  if (!user) {
    return <SignInPrompt />
  }
  // Authed ⇒ a child component so the onboarding-state hook is called
  // UNCONDITIONALLY (no conditional-hook violation — P1 design v2,
  // Codex MED#5). The gate keys off the SERVER state machine + the
  // server "never end empty" invariant; the client cannot fake DONE.
  return <Gate />
}

function Gate() {
  // Gate only mounts post-auth, so this query always runs authed;
  // `undefined` ⇒ the state query is still resolving ⇒ keep showing
  // loading (never flash the wrong screen — P1 design v1 §gate).
  //
  // Jenny/ultrathink M3: `state` must be scoped to the ACTIVE workspace,
  // not personal-by-default. Otherwise an org user who finished personal
  // onboarding skips the wedge for their (still-NEW) org. The hook is
  // safe to use here because <Gate /> renders inside the provider via
  // <Home />.
  const activeWorkspaceId = useActiveWorkspaceId()
  const state = useQuery(api.onboarding.state, { activeWorkspaceId })
  if (state === undefined) {
    return (
      <div className="grid h-screen place-items-center bg-page text-ink-faint text-sm">
        loading…
      </div>
    )
  }
  if (state === 'NEW' || state === 'IN_PROGRESS') {
    return <Onboarding state={state} />
  }
  // DONE | DEFERRED → the workspace
  return <App />
}

function SignInPrompt() {
  // D4.31 — carry the CURRENT url (e.g. a shared `/?a=<fileId>` deep
  // link) through sign-in as `returnPathname`, so after auth the
  // recipient lands on the shared page, not home. The /api/auth/
  // sign-in handler already forwards returnPathname to WorkOS; this
  // is the missing client half. Sharing fix that's independent of
  // the URL shape (search param vs path).
  const { href } = useLocation()
  const signInHref =
    href && href !== '/'
      ? `/api/auth/sign-in?returnPathname=${encodeURIComponent(href)}`
      : '/api/auth/sign-in'
  return (
    <div
      className="grid h-screen place-items-center bg-page px-6"
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--dohc-grid) 1px, transparent 1px), linear-gradient(0deg, var(--dohc-grid) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      <div className="w-[420px] max-w-[92vw] rounded-[18px] border border-rule bg-surface px-10 py-12 shadow-md">
        <div className="flex flex-col items-center gap-4 text-accent">
          <DohcLogo size="lg" />
        </div>

        <h1 className="mt-8 text-center font-serif text-[30px] leading-[1.1] text-ink-strong">
          The quiet workspace for your work.
        </h1>

        <p className="mx-auto mt-3 max-w-[300px] text-center text-[13.5px] leading-relaxed text-ink-dim">
          dohc keeps your documents, sources, and drafts in one calm
          place — clear, traceable, and yours.
        </p>

        <a
          href={signInHref}
          className="group mt-9 flex h-11 items-center justify-center gap-2 rounded-lg bg-ink-strong text-surface text-[13.5px] font-medium tracking-wide shadow-sm transition-all hover:translate-y-[-1px] hover:shadow-md"
        >
          <span>Sign in</span>
          <span
            aria-hidden
            className="text-[16px] leading-none transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </a>

        <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
          secure sign-in · your work stays private
        </p>
      </div>
    </div>
  )
}

function App() {
  const { user } = useAuth()
  // org-plan §5 Phase B — every read/write is scoped to the active
  // workspace. undefined ⇒ caller's personal workspace (the v0 default;
  // back-compat preserved by requireWorkspace(ctx, undefined)).
  const activeWorkspaceId = useActiveWorkspaceId()
  const files = useQuery(api.atoms.list, { activeWorkspaceId })
  const folders = useQuery(api.folders.list, { activeWorkspaceId })
  // sharing-v1 1a — files shared WITH me (the "Shared with me" section).
  const sharedWithMe = useQuery(api.atomShares.listSharedWithMe, {
    activeWorkspaceId,
  })
  // The fileId currently being shared (drives the ShareDialog).
  const [sharePromptFor, setSharePromptFor] = useState<string | null>(null)
  const ensureThread = useMutation(api.agent.ensureThread)
  const upsertAtom = useMutation(api.atoms.upsert)
  const removeAtom = useMutation(api.atoms.remove)
  const moveAtom = useMutation(api.atoms.move)
  // D4.7c — pendingSaveRef gets populated by AtomView with its
  // flushSave function. Rename/move handlers await it before
  // dispatching the mutation so the wikilink-rewrite cascade sees
  // the latest typed body (fixes the save-flush race where typing
  // then immediately renaming lost the typed text).
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null)
  const setLockAtom = useMutation(api.atoms.setLock)
  const setStarAtom = useMutation(api.atoms.setStar)
  const setIconAtom = useMutation(api.atoms.setIcon)
  const setFolderStar = useMutation(api.folders.setStar)
  const setFolderMetaMut = useMutation(api.folders.setMeta)
  const createFolder = useMutation(api.folders.create)
  const removeFolder = useMutation(api.folders.remove)
  const moveFolder = useMutation(api.folders.move)
  const [threadId, setThreadId] = useState<string | null>(null)
  // Onboarding hand-off (P1 spec line 263): the wedge wrote the hero
  // path here right before the Gate flipped DONE → <App/>. Open it as
  // the FIRST frame so the wow moment lands on the populated workspace,
  // never an empty "Pick a page". One-shot: read AND clear on mount
  // (this App subtree mounts client-side post-gate, so the lazy
  // initializer runs on the client — same pattern as chatOpen).
  // D4.33 — the open atom is URL-driven via the PATH `/p/<fileId>`,
  // the SINGLE source of truth. `activePath` is DERIVED from that id
  // + the files list, so a rename/move (path changes, fileId stable)
  // re-derives the open path automatically — NO URL change needed.
  const location = useLocation()
  // R1 — recognize BOTH the legacy URL shape AND the new workspace-
  // scoped `/w/<wsId>/...` shape. Either form opens the right atom;
  // the activeWorkspaceId is derived separately by the hook (URL
  // wins → `useActiveWorkspaceId()`). Order in the regex alternation
  // matters: the workspace-scoped match must come FIRST so a literal
  // `/w/me/p/<id>` doesn't accidentally match `/p/<id>` on the suffix.
  const urlFileId = (() => {
    const m = /^(?:\/w\/[^/]+)?\/p\/(.+)$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()
  // sharing-v1 1a — `/shared/<shareId>` opens an atom shared WITH me.
  // Same R1 dual-shape: matches `/shared/<id>` and `/w/<wsId>/shared/<id>`.
  const urlShareId = (() => {
    const m = /^(?:\/w\/[^/]+)?\/shared\/(.+)$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()
  const navigate = useNavigate()
  // Optimistic override: the path we want shown RIGHT NOW, taking
  // precedence over the (possibly stale, just-refreshing) URL→files
  // derivation. Set when opening/creating/renaming/moving the open
  // atom, so the UI never flashes the old path or an empty state
  // during the brief window before `files` (a reactive query)
  // refreshes. Cleared once the URL derivation converges to it.
  const [optimisticPath, setOptimisticPath] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const handoff = window.localStorage.getItem('dohc:onboarding:open')
      if (handoff) {
        window.localStorage.removeItem('dohc:onboarding:open')
        return handoff
      }
    } catch {
      // localStorage unavailable — fall back to the normal default.
    }
    return null
  })
  // Derived open atom: resolve the URL's fileId → its CURRENT path
  // (rename-proof). The optimistic override wins while set.
  const derivedFromUrl =
    urlFileId && files
      ? (files.find((f) => f.fileId === urlFileId)?.path ?? null)
      : null
  const activePath = optimisticPath ?? derivedFromUrl ?? null
  const [view, setView] = useState<View>('atom')

  // Notion-style browser tab: reflect the open surface in the title +
  // favicon. This shell is the single owner — the open page lives in
  // live Convex queries here, not in route loader data. For a shared
  // page (`/shared/<id>`) we read its title/emoji from the SAME query
  // SharedAtomView uses; Convex multiplexes the identical subscription,
  // so it costs nothing extra.
  const sharedAtomForMeta = useQuery(
    api.atomShares.getSharedAtom,
    urlShareId ? { shareId: urlShareId as Id<'atomShares'> } : 'skip',
  )
  const { docTitle, docEmoji } = useMemo<{
    docTitle: string | null | undefined
    docEmoji: string | null | undefined
  }>(() => {
    if (view === 'graph') return { docTitle: 'Graph', docEmoji: null }
    if (view === 'plugins') return { docTitle: 'Plugins', docEmoji: null }
    if (urlShareId) {
      // undefined ⇒ still loading: hold the current tab (no brand flash).
      // null ⇒ gone/forbidden: fall back to the brand default.
      if (sharedAtomForMeta === undefined)
        return { docTitle: undefined, docEmoji: undefined }
      if (sharedAtomForMeta === null)
        return { docTitle: null, docEmoji: null }
      const { meta } = parseFrontmatter(sharedAtomForMeta.body)
      const title =
        (typeof meta.title === 'string' && meta.title.trim()) ||
        leafName(sharedAtomForMeta.path)
      const emoji =
        typeof meta.icon === 'string' && meta.icon.trim()
          ? meta.icon.trim()
          : null
      return { docTitle: title, docEmoji: emoji }
    }
    if (!activePath) return { docTitle: null, docEmoji: null }
    const f = (files ?? []).find((x) => x.path === activePath)
    return {
      docTitle: (f?.title && f.title.trim()) || leafName(activePath),
      docEmoji: f?.icon ?? null,
    }
  }, [view, urlShareId, sharedAtomForMeta, activePath, files])
  useDocumentMeta({ title: docTitle, emoji: docEmoji })

  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  // P3+P4 Codex fold F2+F3: a STRUCTURALLY-typed second channel
  // for programmatic skill-fire dispatches. Palette skill clicks
  // route here (NOT through pendingPrompt), so a plugin command
  // whose text happens to start with `/<path>` cannot accidentally
  // become a skill-fire via detectSkillFire. The two channels are
  // mutually exclusive at the type level.
  const [pendingSkillFire, setPendingSkillFire] = useState<string | null>(
    null,
  )
  const [enterEdit, setEnterEdit] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // Chat panel is hidden by default — when the user wants to talk to the
  // agent they pop it open via the floating toggle (or ⌘\). Persisted to
  // localStorage so the preference survives reloads.
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('dohc-chat-open') === '1'
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('dohc-chat-open', chatOpen ? '1' : '0')
    } catch {
      // localStorage unavailable / quota exceeded — non-fatal.
    }
  }, [chatOpen])
  // P2 — the consent ("Sharing") panel. A PULL surface (design D5):
  // ephemeral, default-closed, NOT persisted (a standing-open consent
  // panel would feel like nagging). Shares the single 3rd grid column
  // with Chat — exactly ONE is ever open (opening one closes the
  // other), so the grid never grows to 4 columns.
  const [sharingOpen, setSharingOpen] = useState(false)
  // P4 — the advisory loop ("Loop") panel. Ephemeral pull surface
  // like SharingPanel. The 3rd grid column holds EXACTLY ONE of
  // {chat, sharing, proposals}: every toggle force-closes the OTHER
  // TWO (the real build trap is 3 children in a 2-col grid — the
  // grid ternary below MUST include proposalsOpen in lockstep).
  const [proposalsOpen, setProposalsOpen] = useState(false)
  const toggleChat = useCallback(() => {
    setChatOpen((c) => !c)
    setSharingOpen(false)
    setProposalsOpen(false)
  }, [])
  const toggleSharing = useCallback(() => {
    setSharingOpen((s) => !s)
    setChatOpen(false)
    setProposalsOpen(false)
  }, [])
  const toggleProposals = useCallback(() => {
    setProposalsOpen((p) => !p)
    setChatOpen(false)
    setSharingOpen(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    ensureThread({ activeWorkspaceId }).then((id) => {
      if (!cancelled) setThreadId(id as string)
    })
    return () => {
      cancelled = true
    }
  }, [ensureThread, activeWorkspaceId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((p) => !p)
      }
      // ⌘⇧F opens full-content search across all pages.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'f'
      ) {
        e.preventDefault()
        setSearchOpen((s) => !s)
      }
      // ⌘\ toggles the chat panel.
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleChat()
      }
      // ⌘⇧S toggles the Sharing (consent) panel.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 's'
      ) {
        e.preventDefault()
        toggleSharing()
      }
      // ⌘⇧L toggles the Loop (advisory proposals) panel.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'l'
      ) {
        e.preventDefault()
        toggleProposals()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleChat, toggleSharing, toggleProposals])

  const onRunAction = useCallback((prompt: string) => {
    setPendingPrompt(prompt)
  }, [])

  // D4.33 — open an atom by PATH. Show it immediately (optimistic
  // override) AND, if its rename-proof fileId is known, push it into
  // the URL as `/p/<fileId>`. A just-created file has no fileId in
  // `files` yet → the bridge effect navigates once it appears. A
  // legacy atom with NO id stays optimistic-only (shown, no URL).
  const openAtom = useCallback(
    (rawPath: string, opts?: { replace?: boolean }) => {
      // Only append `.md` to an EXTENSIONLESS path (e.g. a wikilink
      // `[[playground/a]]`). A path that already has an extension —
      // crucially `.html` — is left as-is; appending `.md` to
      // `foo.html` made `foo.html.md`, which matched no file (broke
      // both the HTML render AND the URL update).
      const path = /\.[a-z0-9]+$/i.test(rawPath) ? rawPath : `${rawPath}.md`
      setView('atom')
      setOptimisticPath(path)
      const fid = (files ?? []).find((f) => f.path === path)?.fileId
      if (fid) {
        // R1 — navigate to the new workspace-scoped URL. `me` sentinel
        // for personal (activeWorkspaceId === undefined ⇒ /w/me/...);
        // the literal org id for org workspaces (/w/<orgId>/...).
        void navigate({
          to: '/w/$wsId/p/$atomId',
          params: { wsId: activeWorkspaceId ?? 'me', atomId: fid },
          replace: opts?.replace ?? false,
        })
      }
    },
    [files, navigate, activeWorkspaceId],
  )

  // Clear the open atom (→ home). Used on delete of the open atom.
  const clearOpenAtom = useCallback(
    (opts?: { replace?: boolean }) => {
      setOptimisticPath(null)
      // R1 — workspace home, not bare root. Stays in the active workspace.
      void navigate({
        to: '/w/$wsId',
        params: { wsId: activeWorkspaceId ?? 'me' },
        replace: opts?.replace ?? false,
      })
    },
    [navigate, activeWorkspaceId],
  )

  // sharing-v1 1a — open an atom shared WITH me (by share id).
  const openShared = useCallback(
    (sid: string) => {
      setOptimisticPath(null)
      setView('atom')
      // R1 — workspace-scoped share URL.
      void navigate({
        to: '/w/$wsId/shared/$shareId',
        params: { wsId: activeWorkspaceId ?? 'me', shareId: sid },
      })
    },
    [navigate, activeWorkspaceId],
  )

  // Bridge: once the optimistic path's file gains a real fileId in
  // `files` (a just-created file), reflect it in the URL — unless
  // the URL already points there.
  useEffect(() => {
    if (!optimisticPath || !files) return
    const fid = files.find((f) => f.path === optimisticPath)?.fileId
    if (fid && urlFileId !== fid) {
      // R1 — workspace-scoped URL.
      void navigate({
        to: '/w/$wsId/p/$atomId',
        params: { wsId: activeWorkspaceId ?? 'me', atomId: fid },
        replace: true,
      })
    }
  }, [optimisticPath, files, urlFileId, navigate, activeWorkspaceId])

  // Once the URL→files derivation converges to the optimistic path,
  // drop the override so the URL is the sole source of truth (a
  // rename keeps the same fileId, so this fires when `files` shows
  // the file at its new path).
  useEffect(() => {
    if (optimisticPath && derivedFromUrl === optimisticPath) {
      setOptimisticPath(null)
    }
  }, [optimisticPath, derivedFromUrl])

  // Back/forward landing on an atom should show the atom view (the
  // `view` panel state is independent of the URL).
  useEffect(() => {
    if (urlFileId) setView('atom')
  }, [urlFileId])

  async function createAtom(path: string, body = '') {
    await upsertAtom({ path, body, source: 'user', activeWorkspaceId })
    // openAtom shows it immediately (optimistic); the bridge effect
    // writes the URL once the new file lands in `files` with a fileId.
    openAtom(path)
    setEnterEdit(true)
  }

  async function createPageWithName(name: string) {
    let clean = name.trim().replace(/^\/+/, '')
    if (!clean) return
    if (!/\.[a-z0-9]+$/i.test(clean)) clean += '.md'
    const filesArr = files ?? []
    const exists = filesArr.some((f: { path: string }) => f.path === clean)
    if (exists) {
      window.alert(`Page already exists: ${clean}`)
      return
    }
    // D4.18/D4.22 — pre-seed the page TITLE (the typed name's leaf,
    // sans extension) into the frontmatter `title:` property so the
    // user doesn't retype it. HTML pages get the same treatment now —
    // the filename becomes their title, in metadata + above the page.
    const leaf =
      name.trim().replace(/\/+$/, '').split('/').pop() ?? clean
    const title = leaf.replace(/\.[a-z0-9]+$/i, '').trim()
    const body = title ? applyFrontmatter('', { title }) : ''
    await createAtom(clean, body)
  }

  async function createFolderWithName(name: string) {
    const clean = name.trim().replace(/^\/+|\/+$/g, '')
    if (!clean) return
    try {
      await createFolder({ path: clean, activeWorkspaceId })
    } catch (e) {
      window.alert(`Couldn't create folder: ${(e as Error).message}`)
    }
  }

  // file-org-v1 D4.4a — L/S keyboard shortcut handlers + click-
  // affordance handlers. R3 fold (Codex FAIL-5 / indep FAIL-3):
  // these handlers now RETHROW after alerting, so callers (the
  // FileTree's .then()/.catch() announcement pattern + the
  // FolderPicker's onCommit catch) see the failure and can react
  // (announce nothing on the keyboard path; render an error
  // message in the picker). The window.alert remains as the UX
  // for the keyboard path (the live region is polite + easy to
  // miss for sighted users; the alert is loud).
  async function toggleLockAtPath(path: string, currentlyLocked: boolean) {
    try {
      await setLockAtom({ path, locked: !currentlyLocked, activeWorkspaceId })
    } catch (e) {
      window.alert(`Couldn't ${currentlyLocked ? 'unlock' : 'lock'}: ${(e as Error).message}`)
      throw e
    }
  }
  async function toggleStarAtPath(path: string, currentlyStarred: boolean) {
    try {
      await setStarAtom({ path, starred: !currentlyStarred, activeWorkspaceId })
    } catch (e) {
      window.alert(`Couldn't ${currentlyStarred ? 'unstar' : 'star'}: ${(e as Error).message}`)
      throw e
    }
  }
  async function toggleFolderStarAtPath(path: string, currentlyStarred: boolean) {
    try {
      await setFolderStar({ path, starred: !currentlyStarred, activeWorkspaceId })
    } catch (e) {
      window.alert(`Couldn't ${currentlyStarred ? 'unstar' : 'star'} folder: ${(e as Error).message}`)
      throw e
    }
  }
  // file-org-v1 D4.5b — FolderPicker → setMeta. R3 fold (Codex
  // FAIL-5): the picker now catches + displays the error in its
  // role="alert" region; we DON'T alert here (the picker owns
  // the surface). Rethrow so the picker's catch fires.
  async function setFolderMetaAtPath(
    path: string,
    next: { icon: string | null; color: string | null; starred: boolean },
  ) {
    await setFolderMetaMut({
      path,
      icon: next.icon,
      color: next.color,
      starred: next.starred,
      activeWorkspaceId,
    })
  }

  // file-org-v1 D4.7 — drag-and-drop move handlers. The component
  // computed planDrop and now just needs the right mutation.
  // Alert + rethrow on failure (consistent with other DnD-adjacent
  // handlers — toggleLock/star/folderStar).
  async function moveFileByDrop(fromPath: string, toPath: string) {
    // D4.7c — flush any pending autosave for the open atom so the
    // wikilink cascade sees the latest body.
    await pendingSaveRef.current?.()
    try {
      const result = await moveAtom({ fromPath, toPath, activeWorkspaceId })
      // D4.30 — no URL change: the open atom's fileId is stable
      // across the move, so `activePath` re-derives to `toPath`
      // automatically when `files` refreshes.
      if (result.linkUpdates > 0) {
        window.setTimeout(
          () =>
            window.alert(
              `Moved ${fromPath} → ${toPath}\n` +
                `Updated ${result.linkUpdates} wikilink${result.linkUpdates === 1 ? '' : 's'} across your workspace.`,
            ),
          0,
        )
      }
    } catch (e) {
      window.alert(`Couldn't move file: ${(e as Error).message}`)
      throw e
    }
  }
  async function moveFolderByDrop(fromPath: string, toPath: string) {
    // D4.7c — flush autosave before the cascade runs.
    await pendingSaveRef.current?.()
    try {
      await moveFolder({ fromPath, toPath, activeWorkspaceId })
      // D4.8 — link-cascade alert removed per user feedback;
      // the rewrite is the kind of background polish that
      // doesn't need a popup confirmation.
    } catch (e) {
      window.alert(`Couldn't move folder: ${(e as Error).message}`)
      throw e
    }
  }

  async function deleteFileByPath(path: string) {
    const ok = window.confirm(`Delete ${path}?\n\nThis can't be undone.`)
    if (!ok) return
    try {
      await removeAtom({ path, activeWorkspaceId })
      // D4.30 — if we just deleted the open atom, clear the URL.
      if (activePath === path) clearOpenAtom({ replace: true })
    } catch (e) {
      window.alert(`Couldn't delete: ${(e as Error).message}`)
    }
  }

  async function renameFileByPath(path: string) {
    const next = window.prompt(
      `Rename to (full path, .md will be added if missing):`,
      path,
    )
    if (!next) return
    let target = next.trim().replace(/^\/+/, '')
    if (!target) return
    if (!/\.[a-z0-9]+$/i.test(target)) target += '.md'
    if (target === path) return
    // D4.7c — flush autosave so the cascade reads the latest body.
    await pendingSaveRef.current?.()
    try {
      await moveAtom({ fromPath: path, toPath: target, activeWorkspaceId })
      // D4.30 — no URL change; fileId is stable, activePath
      // re-derives to `target` automatically.
      // D4.8 — link-cascade alert removed; the rewrite is silent.
    } catch (e) {
      window.alert(`Rename failed: ${(e as Error).message}`)
    }
  }

  async function renameFolderByPath(path: string) {
    const next = window.prompt(`Rename folder to:`, path)
    if (!next) return
    const target = next.trim().replace(/^\/+|\/+$/g, '')
    if (!target || target === path) return
    // D4.7c — flush autosave before cascade.
    await pendingSaveRef.current?.()
    try {
      await moveFolder({ fromPath: path, toPath: target, activeWorkspaceId })
      // D4.30 — no URL change: every moved atom keeps its fileId
      // (folders.move reconciles the index), so the open atom's
      // `activePath` re-derives to its new path automatically.
      // D4.8 — link-cascade alert removed; the rewrite is silent.
    } catch (e) {
      window.alert(`Couldn't rename folder: ${(e as Error).message}`)
    }
  }

  async function deleteFolderByPath(path: string) {
    const ok = window.confirm(
      `Delete folder "${path}" and everything inside it?\n\nThis removes all nested folders and atoms. Can't be undone.`,
    )
    if (!ok) return
    try {
      const { atomCount, folderCount } = await removeFolder({
        path,
        activeWorkspaceId,
      })
      // D4.30 — if the open atom was inside the deleted folder, clear the URL.
      if (activePath && (activePath === path || activePath.startsWith(`${path}/`))) {
        clearOpenAtom({ replace: true })
      }
      window.setTimeout(() => {
        window.alert(
          `Deleted folder "${path}" — ${atomCount} atom(s), ${folderCount} folder row(s).`,
        )
      }, 0)
    } catch (e) {
      window.alert(`Couldn't delete folder: ${(e as Error).message}`)
    }
  }

  return (
    <div
      className={`grid h-screen overflow-hidden bg-page text-ink ${
        chatOpen || sharingOpen || proposalsOpen
          ? 'grid-cols-[48px_260px_1fr_400px]'
          : 'grid-cols-[48px_260px_1fr]'
      }`}
    >
      <ActivityBar
        view={view === 'plugins' ? 'plugins' : view === 'graph' ? 'graph' : 'atom'}
        onSelect={(v) => setView(v)}
      />
      <FileTree
        files={files ?? []}
        folders={folders ?? []}
        activePath={activePath}
        view={view === 'plugins' ? 'plugins' : 'atom'}
        onOpenSearch={() => setSearchOpen(true)}
        user={user}
        sharedWithMe={sharedWithMe ?? []}
        activeShareId={urlShareId}
        onOpenShared={openShared}
        onOpen={(p) => openAtom(p)}
        onCreatePage={createPageWithName}
        onCreateFolder={createFolderWithName}
        onDeleteFolder={deleteFolderByPath}
        onRenameFolder={renameFolderByPath}
        onDeleteFile={deleteFileByPath}
        onRenameFile={renameFileByPath}
        onToggleLock={toggleLockAtPath}
        onToggleStar={toggleStarAtPath}
        onToggleFolderStar={toggleFolderStarAtPath}
        onSetFolderMeta={setFolderMetaAtPath}
        onSetFileIcon={async (path, icon) => {
          await setIconAtom({ path, icon, activeWorkspaceId })
        }}
        onMoveFile={moveFileByDrop}
        onMoveFolder={moveFolderByDrop}
      />
      {view === 'graph' ? (
        <GraphView onOpenAtom={openAtom} onOpenShared={openShared} />
      ) : view === 'atom' ? (
        urlShareId ? (
          // key by shareId → fresh state per share (no stale draft
          // reuse when switching shared files; codex P1).
          <SharedAtomView
            key={urlShareId}
            shareId={urlShareId as Id<'atomShares'>}
          />
        ) : (
          <AtomView
            path={activePath}
            files={files ?? []}
            onRunAction={onRunAction}
            onOpenAtom={openAtom}
            onShare={(fid) => setSharePromptFor(fid)}
            enterEdit={enterEdit}
            onEnteredEdit={() => setEnterEdit(false)}
            pendingSaveRef={pendingSaveRef}
          />
        )
      ) : (
        <PluginPanel
          onOpenAtom={(path) => {
            openAtom(path)
            setEnterEdit(true)
          }}
          onCreatePlugin={() => {
            setPendingPrompt(BUILD_PLUGIN_PROMPT)
          }}
        />
      )}
      {/* The single 3rd column — EXACTLY ONE of Chat / Sharing /
       *  Proposals (each toggle force-closes the other two; the grid
       *  ternary above includes proposalsOpen in lockstep so this is
       *  never 3 children in a 2-col template). */}
      {chatOpen && (
        <Chat
          threadId={threadId}
          pendingPrompt={pendingPrompt}
          onPendingHandled={() => setPendingPrompt(null)}
          pendingSkillFire={pendingSkillFire}
          onPendingSkillFireHandled={() => setPendingSkillFire(null)}
        />
      )}
      {sharingOpen && (
        <SharingPanel
          onAskDohc={(p) => {
            setPendingPrompt(p)
            setChatOpen(true)
            setSharingOpen(false)
            setProposalsOpen(false)
          }}
        />
      )}
      {proposalsOpen && (
        <ProposalsPanel
          onAskDohc={(p) => {
            setPendingPrompt(p)
            setChatOpen(true)
            setSharingOpen(false)
            setProposalsOpen(false)
          }}
        />
      )}
      {/* Floating Loop-toggle — sits one row ABOVE the Sharing pill
       *  (bottom-[100px] vs [60px] vs 5; 40px step, h-9=36px ⇒ 4px
       *  clearance, no overlap at either right state). ⌘⇧L. */}
      <button
        type="button"
        onClick={toggleProposals}
        title={proposalsOpen ? 'hide loop (⌘⇧L)' : 'show loop (⌘⇧L)'}
        aria-label={proposalsOpen ? 'hide loop panel' : 'show loop panel'}
        className={`fixed bottom-[100px] z-50 inline-flex h-9 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3.5 text-[12px] font-medium tracking-wide text-ink-dim shadow-md hover:border-rule-strong hover:text-ink hover:bg-hover transition-[right,color,background,border,box-shadow] duration-150 ${
          chatOpen || sharingOpen || proposalsOpen
            ? 'right-[412px]'
            : 'right-5'
        }`}
      >
        <RefreshCw className="size-3.5" strokeWidth={2} />
        <span>{proposalsOpen ? 'Hide loop' : 'Loop'}</span>
      </button>
      {/* Floating Sharing-toggle — sits one row ABOVE the chat pill so
       *  the pills never overlap at either right state. ⌘⇧S also
       *  toggles. (P2 D4 ambient "who's at my windows" affordance.) */}
      <button
        type="button"
        onClick={toggleSharing}
        title={sharingOpen ? 'hide sharing (⌘⇧S)' : 'show sharing (⌘⇧S)'}
        aria-label={sharingOpen ? 'hide sharing panel' : 'show sharing panel'}
        className={`fixed bottom-[60px] z-50 inline-flex h-9 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3.5 text-[12px] font-medium tracking-wide text-ink-dim shadow-md hover:border-rule-strong hover:text-ink hover:bg-hover transition-[right,color,background,border,box-shadow] duration-150 ${
          chatOpen || sharingOpen || proposalsOpen
            ? 'right-[412px]'
            : 'right-5'
        }`}
      >
        <Shield className="size-3.5" strokeWidth={2} />
        <span>{sharingOpen ? 'Hide sharing' : 'Sharing'}</span>
      </button>
      {/* Floating chat-toggle, bottom-right. When a panel is open the
       *  pill slides to sit just outside its left edge so it never
       *  floats over the content. ⌘\ also toggles. */}
      <button
        type="button"
        onClick={toggleChat}
        title={chatOpen ? 'hide chat (⌘\\)' : 'show chat (⌘\\)'}
        aria-label={chatOpen ? 'hide chat panel' : 'show chat panel'}
        className={`fixed bottom-5 z-50 inline-flex h-9 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3.5 text-[12px] font-medium tracking-wide text-ink-dim shadow-md hover:border-rule-strong hover:text-ink hover:bg-hover transition-[right,color,background,border,box-shadow] duration-150 ${
          chatOpen || sharingOpen || proposalsOpen
            ? 'right-[412px]'
            : 'right-5'
        }`}
      >
        {chatOpen ? (
          <MessageSquareOff className="size-3.5" strokeWidth={2} />
        ) : (
          <MessageSquare className="size-3.5" strokeWidth={2} />
        )}
        <span>{chatOpen ? 'Hide chat' : 'Chat'}</span>
      </button>
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenAtom={openAtom}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onFirePrompt={(p) => {
          // P3+P4 Codex fold F2: opening chat is part of the
          // fire — without it, Chat is unmounted and the
          // pendingPrompt sits stale, replaying later when
          // the user opens chat manually (concrete repro
          // verified in review).
          setChatOpen(true)
          setSharingOpen(false)
          setProposalsOpen(false)
          setPendingPrompt(p)
        }}
        onFireSkill={(path) => {
          // P3+P4 Codex fold F2+F3: dedicated channel for
          // programmatic skill-fire. Does NOT pass through
          // detectSkillFire (Chat consumes pendingSkillFire
          // directly via sendMessage({entry:'skill-fire'})).
          // The structural enforcement is now route-checked
          // at the type system — a plugin command's prompt
          // text can never become a skill-fire by accident.
          setChatOpen(true)
          setSharingOpen(false)
          setProposalsOpen(false)
          setPendingSkillFire(path)
        }}
        onOpenAtom={openAtom}
        onOpenPlugins={() => setView('plugins')}
      />
      {sharePromptFor && (
        <ShareDialog
          fileId={sharePromptFor}
          fileLabel={
            (files ?? []).find((f) => f.fileId === sharePromptFor)?.title ??
            sharePromptFor
          }
          onClose={() => setSharePromptFor(null)}
        />
      )}
    </div>
  )
}
