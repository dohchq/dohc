import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  createFileRoute,
  useNavigate,
  useLocation,
  Outlet,
} from '@tanstack/react-router'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import {
  Folder,
  FolderPlus,
  MessageSquare,
  MessageSquareOff,
  ArrowLeftRight,
  Search,
  X,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { applyFrontmatter, parseFrontmatter } from '@/lib/frontmatter'
import { useDocumentMeta } from '@/lib/use-document-meta'
import { FileTree } from '@/components/FileTree'
import { AtomView } from '@/components/AtomView'
import { SharedAtomView } from '@/components/SharedAtomView'
import { ShareDialog } from '@/components/ShareDialog'
import { ActivityBar } from '@/components/ActivityBar'
import { ViewFrame } from '@/components/ViewFrame'
import { ViewsSidebar } from '@/components/ViewsSidebar'
import {
  AgentChatSidebar,
  availableProjectFolders,
  type AgentThreadSummary,
} from '@/components/AgentChatSidebar'
import { AgentRunRail } from '@/components/AgentRunRail'
import type {
  AgentModelPickerSelection,
  AgentProviderSnapshot,
} from '@/components/AgentModelPicker'
import { GraphView } from '@/components/GraphView'
import type { Id } from '../../convex/_generated/dataModel'
import { Chat } from '@/components/Chat'
import { ImportsExportsPanel } from '@/components/SharingPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { SearchOverlay } from '@/components/SearchOverlay'
import { DohcLogo } from '@/components/DohcLogo'
import { Onboarding } from '@/components/Onboarding'
import { NoticeProvider, useNotice } from '@/components/NoticeCenter'
import {
  ActiveWorkspaceProvider,
  useActiveWorkspaceId,
} from '@/lib/active-workspace'
import { type AppView as View, viewFromPathname } from '@/lib/appViews'
import { ChatBusyProvider } from '@/lib/chat-busy'
import { firePaletteCommand, firePaletteSkill } from '@/lib/palette-fire'
import { decodeViewRef, encodeViewRef } from '@/lib/viewRefs'
import { useDialogFocus } from '../lib/dialog-focus'

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
    <NoticeProvider>
      <ActiveWorkspaceProvider>
        <ChatBusyProvider>
          <Home />
          <Outlet />
        </ChatBusyProvider>
      </ActiveWorkspaceProvider>
    </NoticeProvider>
  )
}

type FilesDestination =
  | { kind: 'atom'; id: string }
  | { kind: 'shared'; id: string }

// Display name for a file path: the leaf, sans a single extension
// (`clients/Acme Corp.md` → `Acme Corp`). Used as the tab-title
// fallback when an atom has no frontmatter `title:` — mirrors how the
// tree labels untitled files.
function leafName(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
}

function agentSelectionFromApi(
  selection:
    | {
        providerId?: string | null
        model?: string | null
        reasoningEffort?: AgentModelPickerSelection['reasoningEffort'] | null
      }
    | null
    | undefined,
): AgentModelPickerSelection | null {
  if (!selection?.providerId || !selection.model) return null
  return {
    providerId: selection.providerId,
    model: selection.model,
    ...(selection.reasoningEffort
      ? { reasoningEffort: selection.reasoningEffort }
      : {}),
  }
}

function agentSelectionFromThread(
  thread: AgentThreadSummary | null,
): AgentModelPickerSelection | null {
  if (!thread?.agentProviderId || !thread.agentModel) return null
  return {
    providerId: thread.agentProviderId,
    model: thread.agentModel,
    ...(thread.agentReasoningEffort
      ? { reasoningEffort: thread.agentReasoningEffort }
      : {}),
  }
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

  // W1 (H-7) — fire WorkOS membership reconcile on first sign-in for
  // each user.id + every 4h. Catches the "user removed in WorkOS but
  // session is still valid" case without waiting for the periodic cron.
  // Fire-and-forget: a WorkOS outage doesn't block the UI.
  const { user } = useAuth()
  const reconcileMembership = useAction(api.orgsBridge.reconcileMembership)
  const upsertMyProfile = useMutation(api.auth.upsertMyProfile)
  useEffect(() => {
    if (!user?.id) return
    const LAST_USER = 'dohc.lastReconcileFor'
    const STAMP_KEY = 'dohc.lastReconcileAt'
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
    try {
      const lastUser = window.localStorage.getItem(LAST_USER)
      const lastAtRaw = window.localStorage.getItem(STAMP_KEY)
      const lastAt = lastAtRaw ? Number(lastAtRaw) : 0
      const isNewUser = lastUser !== user.id
      const isStale = Date.now() - lastAt > FOUR_HOURS_MS
      if (isNewUser || isStale) {
        void reconcileMembership({}).catch(() => {})
        window.localStorage.setItem(LAST_USER, user.id)
        window.localStorage.setItem(STAMP_KEY, String(Date.now()))
      }
    } catch {
      // localStorage unavailable (private mode) — fire anyway, the
      // server side is idempotent.
      void reconcileMembership({}).catch(() => {})
    }
  }, [user?.id, reconcileMembership])
  useEffect(() => {
    if (!user?.id) return
    void upsertMyProfile({}).catch(() => {})
  }, [user?.id, user?.email, upsertMyProfile])
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
          dohc keeps your documents, sources, and drafts in one calm place —
          clear, traceable, and yours.
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
  const notice = useNotice()
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
  const sharedByMeFileIds = useQuery(api.atomShares.listSharedFileIds, {
    activeWorkspaceId,
  })
  // The fileId currently being shared (drives the ShareDialog).
  const [sharePromptFor, setSharePromptFor] = useState<string | null>(null)
  const createAgentThread = useMutation(api.agent.createThread)
  const setAgentThreadPinned = useMutation(api.agent.setThreadPinned)
  const deleteAgentThread = useMutation(api.agent.deleteThread)
  const renameAgentThreadMut = useMutation(api.agent.renameThread)
  const renameAgentProjectAndMoveFolderMut = useMutation(
    api.agent.renameProjectAndMoveFolder,
  )
  const agentThreads = useQuery(api.agent.listThreads, { activeWorkspaceId })
  const agentProviderInfo = useQuery(api.agent.listAgentProviders, {
    activeWorkspaceId,
  })
  const setAgentWorkspaceDefault = useMutation(
    api.agent.setAgentWorkspaceDefault,
  )
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
  const [agentProjectPath, setAgentProjectPath] = useState<string | null>(null)
  const [agentDraft, setAgentDraft] = useState(false)
  const [agentDraftSelection, setAgentDraftSelection] =
    useState<AgentModelPickerSelection | null>(null)
  const [agentSelectionOverride, setAgentSelectionOverride] =
    useState<AgentModelPickerSelection | null>(null)
  const [selectedAgentThreadSnapshot, setSelectedAgentThreadSnapshot] =
    useState<AgentThreadSummary | null>(null)
  const [projectDialogMode, setProjectDialogMode] = useState<
    'scratch' | 'existing' | null
  >(null)
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
  const urlViewRef = (() => {
    const m = /^(?:\/w\/[^/]+)?\/v\/([^/]+)\/?$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()
  const selectedViewPackageRoot = urlViewRef ? decodeViewRef(urlViewRef) : null
  const urlView = viewFromPathname(location.pathname)
  const navigate = useNavigate()
  const lastFilesDestinationRef = useRef<FilesDestination | null>(null)
  // Optimistic override: the path we want shown RIGHT NOW, taking
  // precedence over the (possibly stale, just-refreshing) URL→files
  // derivation. Set when opening/creating/renaming/moving the open
  // atom, so the UI never flashes the old path or an empty state
  // during the brief window before `files` (a reactive query)
  // refreshes. Cleared once the URL derivation converges to it.
  const initialOpenPathRef = useRef<string | null>(null)
  const initialViewPackageRootRef = useRef<string | null>(null)
  const [optimisticPath, setOptimisticPath] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const viewHandoff = window.localStorage.getItem('dohc:onboarding:view')
      if (viewHandoff) {
        window.localStorage.removeItem('dohc:onboarding:view')
        initialViewPackageRootRef.current = viewHandoff
        return null
      }
      const handoff = window.localStorage.getItem('dohc:onboarding:open')
      if (handoff) {
        window.localStorage.removeItem('dohc:onboarding:open')
        initialOpenPathRef.current = handoff
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
  const [view, setView] = useState<View>(
    () =>
      urlView ??
      (urlFileId || urlShareId || initialOpenPathRef.current
        ? 'atom'
        : 'views'),
  )

  const chatThreads = useMemo<AgentThreadSummary[]>(
    () =>
      (agentThreads ?? []).map((thread) => ({
        threadId: thread.threadId,
        projectPath: thread.projectPath,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        pinnedAt: thread.pinnedAt,
        agentProviderId: thread.agentProviderId,
        agentModel: thread.agentModel,
        agentReasoningEffort: thread.agentReasoningEffort,
      })),
    [agentThreads],
  )
  const queryActiveAgentThread = useMemo(
    () => chatThreads.find((thread) => thread.threadId === threadId) ?? null,
    [chatThreads, threadId],
  )
  const activeAgentThread = useMemo(
    () =>
      queryActiveAgentThread ??
      (selectedAgentThreadSnapshot?.threadId === threadId
        ? selectedAgentThreadSnapshot
        : null),
    [queryActiveAgentThread, selectedAgentThreadSnapshot, threadId],
  )
  const agentProviders = useMemo(
    () => (agentProviderInfo?.providers ?? []) as AgentProviderSnapshot[],
    [agentProviderInfo],
  )
  const agentEffectiveDefault = agentSelectionFromApi(
    agentProviderInfo?.effectiveDefault,
  )
  const activeThreadSelection = agentSelectionFromThread(activeAgentThread)
  const agentSelection =
    agentSelectionOverride ??
    activeThreadSelection ??
    (agentDraft ? agentDraftSelection : null) ??
    agentEffectiveDefault
  const agentDocTitle =
    activeAgentThread?.title?.trim() ||
    (threadId ? 'Workspace chat' : 'New chat')

  useEffect(() => {
    setAgentSelectionOverride(null)
  }, [activeWorkspaceId, threadId])

  useEffect(() => {
    setAgentDraftSelection(null)
    setSelectedAgentThreadSnapshot(null)
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!selectedAgentThreadSnapshot) return
    if (
      selectedAgentThreadSnapshot.threadId !== threadId ||
      queryActiveAgentThread
    ) {
      setSelectedAgentThreadSnapshot(null)
    }
  }, [queryActiveAgentThread, selectedAgentThreadSnapshot, threadId])

  const updateAgentSelection = useCallback(
    (selection: AgentModelPickerSelection) => {
      setAgentSelectionOverride(selection)
      if (agentDraft || !threadId) setAgentDraftSelection(selection)
    },
    [agentDraft, threadId],
  )

  const setAgentDefault = useCallback(
    async (selection: AgentModelPickerSelection) => {
      try {
        await setAgentWorkspaceDefault({
          activeWorkspaceId,
          agentProviderId: selection.providerId,
          agentModel: selection.model,
          agentReasoningEffort: selection.reasoningEffort,
        })
        setAgentDraftSelection(selection)
        notice.success('Default model updated', selection.model)
      } catch (e) {
        notice.error(`Couldn't update default model`, (e as Error).message)
      }
    },
    [activeWorkspaceId, notice, setAgentWorkspaceDefault],
  )

  // Notion-style browser tab: reflect the open surface in the title +
  // favicon. This shell is the single owner — the open page lives in
  // live Convex queries here, not in route loader data. For a shared
  // page (`/shared/<id>`) we read its title/emoji from the SAME query
  // SharedAtomView uses; Convex multiplexes the identical subscription,
  // so it costs nothing extra.
  const sharedAtomForMeta = useQuery(
    api.atomShares.getSharedAtom,
    urlShareId
      ? { shareId: urlShareId as Id<'atomShares'>, activeWorkspaceId }
      : 'skip',
  )
  const { docTitle, docEmoji } = useMemo<{
    docTitle: string | null | undefined
    docEmoji: string | null | undefined
  }>(() => {
    if (view === 'agent') return { docTitle: agentDocTitle, docEmoji: null }
    if (view === 'graph') return { docTitle: 'Graph', docEmoji: null }
    if (view === 'views') return { docTitle: 'Views', docEmoji: null }
    if (urlShareId) {
      // undefined ⇒ still loading: hold the current tab (no brand flash).
      // null ⇒ gone/forbidden: fall back to the brand default.
      if (sharedAtomForMeta === undefined)
        return { docTitle: undefined, docEmoji: undefined }
      if (sharedAtomForMeta === null) return { docTitle: null, docEmoji: null }
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
  }, [view, agentDocTitle, urlShareId, sharedAtomForMeta, activePath, files])
  useDocumentMeta({ title: docTitle, emoji: docEmoji })

  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  // P3+P4 Codex fold F2+F3: a STRUCTURALLY-typed second channel
  // for programmatic skill-fire dispatches. Palette skill clicks
  // route here (NOT through pendingPrompt), so only a real skill
  // palette row can become a skill-fire.
  const [pendingSkillFire, setPendingSkillFire] = useState<string | null>(null)
  const [pendingCommandFire, setPendingCommandFire] = useState<string | null>(
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
  // Imports / Exports panel. A pull surface for controlled data/text
  // crossing workspace boundaries. Per-document sharing stays in the
  // document Share button.
  const [sharingOpen, setSharingOpen] = useState(false)

  useEffect(() => {
    if (urlFileId) {
      lastFilesDestinationRef.current = { kind: 'atom', id: urlFileId }
    } else if (urlShareId) {
      lastFilesDestinationRef.current = { kind: 'shared', id: urlShareId }
    }
  }, [urlFileId, urlShareId])

  const navigateToView = useCallback(
    (next: View, opts?: { replace?: boolean }) => {
      if (next === view && (urlView || urlFileId || urlShareId)) return
      setView(next)
      if (next === 'agent') {
        setSharingOpen(false)
        void navigate({
          to: '/w/$wsId/agent',
          params: { wsId: activeWorkspaceId ?? 'me' },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (next === 'graph') {
        setSharingOpen(false)
        void navigate({
          to: '/w/$wsId/graph',
          params: { wsId: activeWorkspaceId ?? 'me' },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (next === 'views') {
        setSharingOpen(false)
        void navigate({
          to: '/w/$wsId/views',
          params: { wsId: activeWorkspaceId ?? 'me' },
          replace: opts?.replace ?? false,
        })
        return
      }

      const destination = urlFileId
        ? ({ kind: 'atom', id: urlFileId } as const)
        : urlShareId
          ? ({ kind: 'shared', id: urlShareId } as const)
          : lastFilesDestinationRef.current

      if (destination?.kind === 'atom') {
        void navigate({
          to: '/w/$wsId/p/$atomId',
          params: { wsId: activeWorkspaceId ?? 'me', atomId: destination.id },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (destination?.kind === 'shared') {
        void navigate({
          to: '/w/$wsId/shared/$shareId',
          params: { wsId: activeWorkspaceId ?? 'me', shareId: destination.id },
          replace: opts?.replace ?? false,
        })
        return
      }
      void navigate({
        to: '/w/$wsId/files',
        params: { wsId: activeWorkspaceId ?? 'me' },
        replace: opts?.replace ?? false,
      })
    },
    [activeWorkspaceId, navigate, urlFileId, urlShareId, urlView, view],
  )

  const toggleChat = useCallback(() => {
    if (view === 'agent') {
      navigateToView('atom')
      setChatOpen(true)
      setSharingOpen(false)
      return
    }
    setChatOpen((c) => !c)
    setSharingOpen(false)
  }, [navigateToView, view])
  const toggleSharing = useCallback(() => {
    setSharingOpen((s) => !s)
    setChatOpen(false)
  }, [])

  const projectFolderOptions = useMemo(
    () => availableProjectFolders(folders ?? [], files ?? []),
    [folders, files],
  )
  const agentProjectOptions = useMemo(() => {
    const paths = new Set<string>()
    for (const thread of chatThreads) {
      if (thread.projectPath) paths.add(thread.projectPath)
    }
    if (agentProjectPath) paths.add(agentProjectPath)
    return [...paths]
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ value: path, label: path }))
  }, [agentProjectPath, chatThreads])

  useEffect(() => {
    if (agentDraft || agentThreads === undefined) return
    if (threadId && selectedAgentThreadSnapshot?.threadId === threadId) return
    if (
      threadId &&
      chatThreads.some((thread) => thread.threadId === threadId)
    ) {
      return
    }
    const first = chatThreads[0] ?? null
    setThreadId(first?.threadId ?? null)
    setAgentProjectPath(first?.projectPath ?? null)
  }, [
    agentDraft,
    agentThreads,
    chatThreads,
    selectedAgentThreadSnapshot,
    threadId,
  ])

  const startAgentDraft = useCallback(
    (projectPath: string | null = null) => {
      setAgentDraft(true)
      setAgentProjectPath(projectPath)
      setThreadId(null)
      setAgentSelectionOverride(null)
      setSelectedAgentThreadSnapshot(null)
      navigateToView('agent')
    },
    [navigateToView],
  )

  const selectAgentThread = useCallback(
    (thread: AgentThreadSummary) => {
      setSelectedAgentThreadSnapshot(thread)
      setAgentProjectPath(thread.projectPath)
      setThreadId(thread.threadId)
      setAgentDraft(false)
      setAgentSelectionOverride(null)
      navigateToView('agent')
    },
    [navigateToView],
  )

  const ensureAgentThreadForSend = useCallback(
    async (
      projectPath: string | null,
      selection?: AgentModelPickerSelection | null,
    ) => {
      const chosenSelection = selection ?? agentSelection
      const id = await createAgentThread({
        activeWorkspaceId,
        projectPath,
        ...(chosenSelection
          ? {
              agentProviderId: chosenSelection.providerId,
              agentModel: chosenSelection.model,
              agentReasoningEffort: chosenSelection.reasoningEffort,
            }
          : {}),
      })
      if (chosenSelection) setAgentSelectionOverride(chosenSelection)
      setSelectedAgentThreadSnapshot(null)
      setAgentProjectPath(projectPath)
      setThreadId(id as string)
      setAgentDraft(false)
      navigateToView('agent')
      return id as string
    },
    [activeWorkspaceId, agentSelection, createAgentThread, navigateToView],
  )

  const createAgentProject = useCallback((mode: 'scratch' | 'existing') => {
    setProjectDialogMode(mode)
  }, [])

  const commitAgentProject = useCallback(
    async (mode: 'scratch' | 'existing', rawPath: string) => {
      const projectPath = rawPath.trim().replace(/^\/+|\/+$/g, '')
      if (!projectPath)
        return { ok: false, error: 'Project folder is required.' }
      if (projectPath.split('/').some((segment) => segment.startsWith('.'))) {
        return {
          ok: false,
          error: 'Internal dot-folders cannot be project chats.',
        }
      }
      try {
        if (mode === 'scratch') {
          await createFolder({ path: projectPath, activeWorkspaceId })
        } else if (!projectFolderOptions.includes(projectPath)) {
          return { ok: false, error: `Folder not found: ${projectPath}` }
        }
        startAgentDraft(projectPath)
        setProjectDialogMode(null)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    [activeWorkspaceId, createFolder, projectFolderOptions, startAgentDraft],
  )

  const toggleAgentThreadPinned = useCallback(
    async (thread: AgentThreadSummary) => {
      await setAgentThreadPinned({
        activeWorkspaceId,
        threadId: thread.threadId,
        pinned: thread.pinnedAt === null,
      })
    },
    [activeWorkspaceId, setAgentThreadPinned],
  )

  const deleteAgentChat = useCallback(
    async (thread: AgentThreadSummary) => {
      await deleteAgentThread({
        activeWorkspaceId,
        threadId: thread.threadId,
      })
      if (thread.threadId === threadId) {
        setSelectedAgentThreadSnapshot(null)
        setAgentProjectPath(null)
        setThreadId(null)
        setAgentDraft(true)
      }
    },
    [activeWorkspaceId, deleteAgentThread, threadId],
  )

  const renameAgentChat = useCallback(
    async (thread: AgentThreadSummary, title: string) => {
      await renameAgentThreadMut({
        activeWorkspaceId,
        threadId: thread.threadId,
        title,
      })
    },
    [activeWorkspaceId, renameAgentThreadMut],
  )

  const renameAgentProject = useCallback(
    async (projectPath: string, nextPath: string) => {
      const target = nextPath.trim().replace(/^\/+|\/+$/g, '')
      if (!target || target === projectPath) return
      if (target.split('/').some((segment) => segment.startsWith('.'))) {
        throw new Error('Internal dot-folders cannot be project chats.')
      }
      await pendingSaveRef.current?.()
      await renameAgentProjectAndMoveFolderMut({
        activeWorkspaceId,
        fromProjectPath: projectPath,
        toProjectPath: target,
      })
      if (agentProjectPath === projectPath) setAgentProjectPath(target)
    },
    [activeWorkspaceId, agentProjectPath, renameAgentProjectAndMoveFolderMut],
  )

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
      // ⌘⇧S toggles the Imports / Exports panel.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 's'
      ) {
        e.preventDefault()
        toggleSharing()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleChat, toggleSharing])

  const onRunAction = useCallback(
    (prompt: string) => {
      setPendingPrompt(prompt)
      navigateToView('agent')
    },
    [navigateToView],
  )

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
        lastFilesDestinationRef.current = { kind: 'atom', id: fid }
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
      lastFilesDestinationRef.current = null
      // Stay in the Files surface after deleting/clearing the open atom.
      void navigate({
        to: '/w/$wsId/files',
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
      lastFilesDestinationRef.current = { kind: 'shared', id: sid }
      // R1 — workspace-scoped share URL.
      void navigate({
        to: '/w/$wsId/shared/$shareId',
        params: { wsId: activeWorkspaceId ?? 'me', shareId: sid },
      })
    },
    [navigate, activeWorkspaceId],
  )

  const openView = useCallback(
    (packageRoot: string) => {
      setView('views')
      setSharingOpen(false)
      const viewRef = encodeViewRef(packageRoot)
      void navigate({
        to: '/w/$wsId/v/$viewRef',
        params: { wsId: activeWorkspaceId ?? 'me', viewRef },
      })
    },
    [activeWorkspaceId, navigate],
  )

  useEffect(() => {
    const packageRoot = initialViewPackageRootRef.current
    if (!packageRoot) return
    initialViewPackageRootRef.current = null
    openView(packageRoot)
  }, [openView])

  // Bridge: once the optimistic path's file gains a real fileId in
  // `files` (a just-created file), reflect it in the URL — unless
  // the URL already points there.
  useEffect(() => {
    if (!optimisticPath || !files) return
    const fid = files.find((f) => f.path === optimisticPath)?.fileId
    if (fid && urlFileId !== fid) {
      lastFilesDestinationRef.current = { kind: 'atom', id: fid }
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

  // Back/forward landing on a first-class route should update the shell
  // surface too. File/share routes are Files; the explicit view routes
  // cover Agent, Files-home, and Graph.
  useEffect(() => {
    const routedView = urlView ?? (urlFileId || urlShareId ? 'atom' : null)
    if (routedView) setView(routedView)
  }, [urlView, urlFileId, urlShareId])

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
      throw new Error(`Page already exists: ${clean}`)
    }
    // D4.18/D4.22 — pre-seed the page TITLE (the typed name's leaf,
    // sans extension) into the frontmatter `title:` property so the
    // user doesn't retype it. HTML pages get the same treatment now —
    // the filename becomes their title, in metadata + above the page.
    const leaf = name.trim().replace(/\/+$/, '').split('/').pop() ?? clean
    const title = leaf.replace(/\.[a-z0-9]+$/i, '').trim()
    const body = title ? applyFrontmatter('', { title }) : ''
    await createAtom(clean, body)
  }

  async function createFolderWithName(name: string) {
    const clean = name.trim().replace(/^\/+|\/+$/g, '')
    if (!clean) return
    await createFolder({ path: clean, activeWorkspaceId })
  }

  // file-org-v1 D4.4a — L/S keyboard shortcut handlers + click affordance
  // handlers. Failures rethrow so FileTree can roll back optimistic state;
  // the app-level notice is the sighted-user feedback for tiny toggles.
  async function toggleLockAtPath(path: string, currentlyLocked: boolean) {
    try {
      await setLockAtom({ path, locked: !currentlyLocked, activeWorkspaceId })
    } catch (e) {
      notice.error(
        `Couldn't ${currentlyLocked ? 'unlock' : 'lock'} file`,
        (e as Error).message,
      )
      throw e
    }
  }
  async function toggleStarAtPath(path: string, currentlyStarred: boolean) {
    try {
      await setStarAtom({
        path,
        starred: !currentlyStarred,
        activeWorkspaceId,
      })
    } catch (e) {
      notice.error(
        `Couldn't ${currentlyStarred ? 'unfavorite' : 'favorite'} file`,
        (e as Error).message,
      )
      throw e
    }
  }
  async function toggleFolderStarAtPath(
    path: string,
    currentlyStarred: boolean,
  ) {
    try {
      await setFolderStar({
        path,
        starred: !currentlyStarred,
        activeWorkspaceId,
      })
    } catch (e) {
      notice.error(
        `Couldn't ${currentlyStarred ? 'unfavorite' : 'favorite'} folder`,
        (e as Error).message,
      )
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
        notice.success(
          'Moved file',
          `Updated ${result.linkUpdates} wikilink${result.linkUpdates === 1 ? '' : 's'} across your workspace.`,
        )
      }
    } catch (e) {
      notice.error(`Couldn't move file`, (e as Error).message)
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
      notice.error(`Couldn't move folder`, (e as Error).message)
      throw e
    }
  }

  async function deleteFileByPath(path: string) {
    await removeAtom({ path, activeWorkspaceId })
    // D4.30 — if we just deleted the open atom, clear the URL.
    if (activePath === path) clearOpenAtom({ replace: true })
  }

  async function renameFileByPath(path: string, next: string) {
    let target = next.trim().replace(/^\/+/, '')
    if (!target) return
    if (!/\.[a-z0-9]+$/i.test(target)) target += '.md'
    if (target === path) return
    // D4.7c — flush autosave so the cascade reads the latest body.
    await pendingSaveRef.current?.()
    await moveAtom({ fromPath: path, toPath: target, activeWorkspaceId })
    // D4.30 — no URL change; fileId is stable, activePath
    // re-derives to `target` automatically.
    // D4.8 — link-cascade notice omitted; the rename row is the active surface.
  }

  async function renameFolderByPath(path: string, next: string) {
    const target = next.trim().replace(/^\/+|\/+$/g, '')
    if (!target || target === path) return
    // D4.7c — flush autosave before cascade.
    await pendingSaveRef.current?.()
    await moveFolder({ fromPath: path, toPath: target, activeWorkspaceId })
    // D4.30 — no URL change: every moved atom keeps its fileId
    // (folders.move reconciles the index), so the open atom's
    // `activePath` re-derives to its new path automatically.
    // D4.8 — link-cascade notice omitted; the rename row is the active surface.
  }

  async function deleteFolderByPath(path: string) {
    try {
      const { atomCount, folderCount } = await removeFolder({
        path,
        activeWorkspaceId,
      })
      // D4.30 — if the open atom was inside the deleted folder, clear the URL.
      if (
        activePath &&
        (activePath === path || activePath.startsWith(`${path}/`))
      ) {
        clearOpenAtom({ replace: true })
      }
      notice.success(
        'Deleted folder',
        `${atomCount} atom${atomCount === 1 ? '' : 's'}, ${folderCount} folder row${folderCount === 1 ? '' : 's'} removed.`,
      )
    } catch (e) {
      throw e
    }
  }

  const panelOpen = view !== 'agent' && (chatOpen || sharingOpen)

  return (
    <div
      className={`grid h-screen overflow-hidden bg-page text-ink ${
        view === 'agent'
          ? 'grid-cols-[48px_260px_minmax(0,1fr)_340px]'
          : panelOpen
            ? 'grid-cols-[48px_260px_1fr_400px]'
            : 'grid-cols-[48px_260px_1fr]'
      }`}
    >
      <ActivityBar view={view} onSelect={navigateToView} />
      {view === 'agent' ? (
        <>
          <AgentChatSidebar
            files={files ?? []}
            folders={folders ?? []}
            threads={chatThreads}
            activeThreadId={threadId}
            activeProjectPath={agentProjectPath}
            onSelectThread={selectAgentThread}
            onNewThread={startAgentDraft}
            onCreateProject={createAgentProject}
            onTogglePinned={toggleAgentThreadPinned}
            onDeleteThread={deleteAgentChat}
            onRenameThread={renameAgentChat}
            onRenameProject={renameAgentProject}
            onOpenSearch={() => setSearchOpen(true)}
            user={user}
          />
          <AgentWorkspace
            threadId={threadId}
            activeThread={activeAgentThread}
            projectPath={agentProjectPath}
            projectOptions={agentProjectOptions}
            folderOptions={projectFolderOptions}
            onProjectPathChange={setAgentProjectPath}
            onCreateProject={createAgentProject}
            onEnsureThread={ensureAgentThreadForSend}
            onToggleThreadPinned={toggleAgentThreadPinned}
            onRenameThread={renameAgentChat}
            onDeleteThread={deleteAgentChat}
            agentProviders={agentProviders}
            agentSelection={agentSelection}
            onAgentSelectionChange={updateAgentSelection}
            onSetAgentDefault={setAgentDefault}
            pendingPrompt={pendingPrompt}
            onPendingHandled={() => setPendingPrompt(null)}
            pendingSkillFire={pendingSkillFire}
            onPendingSkillFireHandled={() => setPendingSkillFire(null)}
            pendingCommandFire={pendingCommandFire}
            onPendingCommandFireHandled={() => setPendingCommandFire(null)}
          />
          <AgentRunRail
            files={files ?? []}
            activeThread={activeAgentThread}
            projectPath={agentProjectPath}
          />
        </>
      ) : view === 'views' ? (
        <>
          <ViewsSidebar
            selectedPackageRoot={selectedViewPackageRoot}
            onOpenView={openView}
            onOpenSource={(path) => openAtom(path)}
            onOpenSearch={() => setSearchOpen(true)}
            user={user}
          />
          <ViewFrame
            packageRoot={selectedViewPackageRoot}
            onOpenSource={(path) => openAtom(path)}
            onRunAgent={onRunAction}
          />
          {chatOpen && (
            <Chat
              mode="side"
              threadId={threadId}
              projectPath={agentProjectPath}
              projectOptions={agentProjectOptions}
              folderOptions={projectFolderOptions}
              onProjectPathChange={setAgentProjectPath}
              onCreateProject={createAgentProject}
              onEnsureThread={ensureAgentThreadForSend}
              agentProviders={agentProviders}
              agentSelection={agentSelection}
              onAgentSelectionChange={updateAgentSelection}
              onSetAgentDefault={setAgentDefault}
              pendingPrompt={pendingPrompt}
              onPendingHandled={() => setPendingPrompt(null)}
              pendingSkillFire={pendingSkillFire}
              onPendingSkillFireHandled={() => setPendingSkillFire(null)}
              pendingCommandFire={pendingCommandFire}
              onPendingCommandFireHandled={() => setPendingCommandFire(null)}
            />
          )}
          {sharingOpen && (
            <ImportsExportsPanel
              onAskDohc={(p) => {
                setPendingPrompt(p)
                setChatOpen(true)
                setSharingOpen(false)
              }}
            />
          )}
        </>
      ) : (
        <>
          <FileTree
            files={files ?? []}
            folders={folders ?? []}
            activePath={activePath}
            view="atom"
            onOpenSearch={() => setSearchOpen(true)}
            user={user}
            sharedWithMe={sharedWithMe ?? []}
            sharedByMeFileIds={sharedByMeFileIds ?? []}
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
          ) : urlShareId ? (
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
              onOpenView={openView}
              onShare={(fid) => setSharePromptFor(fid)}
              enterEdit={enterEdit}
              onEnteredEdit={() => setEnterEdit(false)}
              pendingSaveRef={pendingSaveRef}
            />
          )}
          {/* The single 3rd column — exactly one of Chat / Imports+Exports. */}
          {chatOpen && (
            <Chat
              mode="side"
              threadId={threadId}
              projectPath={agentProjectPath}
              projectOptions={agentProjectOptions}
              folderOptions={projectFolderOptions}
              onProjectPathChange={setAgentProjectPath}
              onCreateProject={createAgentProject}
              onEnsureThread={ensureAgentThreadForSend}
              agentProviders={agentProviders}
              agentSelection={agentSelection}
              onAgentSelectionChange={updateAgentSelection}
              onSetAgentDefault={setAgentDefault}
              pendingPrompt={pendingPrompt}
              onPendingHandled={() => setPendingPrompt(null)}
              pendingSkillFire={pendingSkillFire}
              onPendingSkillFireHandled={() => setPendingSkillFire(null)}
              pendingCommandFire={pendingCommandFire}
              onPendingCommandFireHandled={() => setPendingCommandFire(null)}
            />
          )}
          {sharingOpen && (
            <ImportsExportsPanel
              onAskDohc={(p) => {
                setPendingPrompt(p)
                setChatOpen(true)
                setSharingOpen(false)
              }}
            />
          )}
        </>
      )}
      {projectDialogMode && (
        <AgentProjectDialog
          mode={projectDialogMode}
          folderOptions={projectFolderOptions}
          onClose={() => setProjectDialogMode(null)}
          onSubmit={commitAgentProject}
        />
      )}
      {/* Floating Imports/Exports toggle — separate from per-doc Share. */}
      <button
        type="button"
        onClick={toggleSharing}
        title={
          sharingOpen
            ? 'hide imports / exports (⌘⇧S)'
            : 'show imports / exports (⌘⇧S)'
        }
        aria-label={
          sharingOpen
            ? 'hide imports / exports panel'
            : 'show imports / exports panel'
        }
        className={`fixed bottom-[60px] z-50 h-9 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3.5 text-[12px] font-medium tracking-wide text-ink-dim shadow-md hover:border-rule-strong hover:text-ink hover:bg-hover transition-[right,color,background,border,box-shadow] duration-150 ${
          view === 'agent' ? 'hidden' : 'inline-flex'
        } ${chatOpen || sharingOpen ? 'right-[412px]' : 'right-5'}`}
      >
        <ArrowLeftRight className="size-3.5" strokeWidth={2} />
        <span>{sharingOpen ? 'Hide panel' : 'Imports / Exports'}</span>
      </button>
      {/* Floating chat-toggle, bottom-right. When a panel is open the
       *  pill slides to sit just outside its left edge so it never
       *  floats over the content. ⌘\ also toggles. */}
      <button
        type="button"
        onClick={toggleChat}
        title={chatOpen ? 'hide chat (⌘\\)' : 'show chat (⌘\\)'}
        aria-label={chatOpen ? 'hide chat panel' : 'show chat panel'}
        className={`fixed bottom-5 z-50 h-9 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3.5 text-[12px] font-medium tracking-wide text-ink-dim shadow-md hover:border-rule-strong hover:text-ink hover:bg-hover transition-[right,color,background,border,box-shadow] duration-150 ${
          view === 'agent' ? 'hidden' : 'inline-flex'
        } ${chatOpen || sharingOpen ? 'right-[412px]' : 'right-5'}`}
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
        onOpenAtom={(path) => openAtom(path)}
        onOpenView={openView}
        onPromptAgent={(prompt) => {
          navigateToView('agent')
          setChatOpen(true)
          setSharingOpen(false)
          setPendingPrompt(prompt)
        }}
        onFireSkill={(path) => {
          // P3+P4 Codex fold F2+F3: dedicated channel for
          // programmatic skill-fire. Does NOT pass through
          // detectSkillFire (Chat consumes pendingSkillFire
          // directly via sendMessage({entry:'skill-fire'})).
          // The structural enforcement is now route-checked
          // at the type system.
          navigateToView('agent')
          firePaletteSkill(path, {
            setChatOpen,
            setSharingOpen,
            setPendingSkillFire,
          })
        }}
        onFireCommand={(path) => {
          navigateToView('agent')
          firePaletteCommand(path, {
            setChatOpen,
            setSharingOpen,
            setPendingCommandFire,
          })
        }}
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

function AgentWorkspace({
  threadId,
  activeThread,
  projectPath,
  projectOptions,
  folderOptions,
  onProjectPathChange,
  onCreateProject,
  onEnsureThread,
  onToggleThreadPinned,
  onRenameThread,
  onDeleteThread,
  agentProviders,
  agentSelection,
  onAgentSelectionChange,
  onSetAgentDefault,
  pendingPrompt,
  onPendingHandled,
  pendingSkillFire,
  onPendingSkillFireHandled,
  pendingCommandFire,
  onPendingCommandFireHandled,
}: {
  threadId: string | null
  activeThread: AgentThreadSummary | null
  projectPath: string | null
  projectOptions: Array<{ value: string | null; label: string }>
  folderOptions: string[]
  onProjectPathChange: (projectPath: string | null) => void
  onCreateProject: (mode: 'scratch' | 'existing') => void
  onEnsureThread: (projectPath: string | null) => Promise<string>
  onToggleThreadPinned: (thread: AgentThreadSummary) => void | Promise<void>
  onRenameThread: (
    thread: AgentThreadSummary,
    title: string,
  ) => void | Promise<void>
  onDeleteThread: (thread: AgentThreadSummary) => void | Promise<void>
  agentProviders: AgentProviderSnapshot[]
  agentSelection: AgentModelPickerSelection | null
  onAgentSelectionChange: (selection: AgentModelPickerSelection) => void
  onSetAgentDefault: (
    selection: AgentModelPickerSelection,
  ) => void | Promise<void>
  pendingPrompt: string | null
  onPendingHandled: () => void
  pendingSkillFire: string | null
  onPendingSkillFireHandled: () => void
  pendingCommandFire: string | null
  onPendingCommandFireHandled: () => void
}) {
  const onToggleThreadPinnedForHeader = useCallback(() => {
    if (!activeThread) return
    return onToggleThreadPinned(activeThread)
  }, [activeThread, onToggleThreadPinned])

  const onRenameThreadForHeader = useCallback(
    (title: string) => {
      if (!activeThread) return
      return onRenameThread(activeThread, title)
    },
    [activeThread, onRenameThread],
  )

  const onDeleteThreadForHeader = useCallback(() => {
    if (!activeThread) return
    return onDeleteThread(activeThread)
  }, [activeThread, onDeleteThread])

  return (
    <main className="min-w-0 bg-page">
      <Chat
        mode="primary"
        threadId={threadId}
        threadTitle={activeThread?.title ?? null}
        threadPinned={activeThread ? activeThread.pinnedAt !== null : false}
        projectPath={projectPath}
        projectOptions={projectOptions}
        folderOptions={folderOptions}
        onProjectPathChange={onProjectPathChange}
        onCreateProject={onCreateProject}
        onEnsureThread={onEnsureThread}
        onToggleThreadPinned={
          activeThread ? onToggleThreadPinnedForHeader : undefined
        }
        onRenameThread={activeThread ? onRenameThreadForHeader : undefined}
        onDeleteThread={activeThread ? onDeleteThreadForHeader : undefined}
        agentProviders={agentProviders}
        agentSelection={agentSelection}
        onAgentSelectionChange={onAgentSelectionChange}
        onSetAgentDefault={onSetAgentDefault}
        pendingPrompt={pendingPrompt}
        onPendingHandled={onPendingHandled}
        pendingSkillFire={pendingSkillFire}
        onPendingSkillFireHandled={onPendingSkillFireHandled}
        pendingCommandFire={pendingCommandFire}
        onPendingCommandFireHandled={onPendingCommandFireHandled}
      />
    </main>
  )
}

function AgentProjectDialog({
  mode,
  folderOptions,
  onClose,
  onSubmit,
}: {
  mode: 'scratch' | 'existing'
  folderOptions: string[]
  onClose: () => void
  onSubmit: (
    mode: 'scratch' | 'existing',
    projectPath: string,
  ) => Promise<{ ok: boolean; error?: string }>
}) {
  const [value, setValue] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLElement>({
    initialFocusRef: inputRef,
    onEscape: onClose,
  })
  const filteredFolders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return folderOptions
    return folderOptions.filter((path) => path.toLowerCase().includes(q))
  }, [folderOptions, query])
  const title =
    mode === 'scratch' ? 'Start from scratch' : 'Use an existing folder'

  async function commit(projectPath: string) {
    const clean = projectPath.trim()
    if (!clean) {
      setError('Choose a folder for this project.')
      return
    }
    setSaving(true)
    setError(null)
    const result = await onSubmit(mode, clean)
    if (!result.ok) {
      setError(result.error ?? 'Could not create project.')
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
        aria-label="close project dialog"
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="relative w-[420px] max-w-full rounded-lg border border-rule bg-elevated p-4 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {mode === 'scratch' ? (
              <FolderPlus
                className="size-4 shrink-0 text-accent"
                strokeWidth={1.8}
              />
            ) : (
              <Folder
                className="size-4 shrink-0 text-accent"
                strokeWidth={1.8}
              />
            )}
            <h3
              id={titleId}
              className="truncate text-[14px] font-semibold text-ink-strong"
            >
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
            aria-label="close"
          >
            <X className="size-4" strokeWidth={1.8} />
          </button>
        </div>

        {mode === 'scratch' ? (
          <div className="mt-4">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Project folder
            </label>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(value)
              }}
              placeholder="dohc"
              className="mt-2 h-9 w-full rounded-md border border-rule bg-page px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-rule-strong"
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              dohc will create the folder and start a draft project chat.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <label className="flex h-9 items-center gap-2 rounded-md border border-rule bg-page px-2.5 text-ink-dim focus-within:border-rule-strong">
              <Search className="size-3.5 shrink-0" strokeWidth={1.8} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search folders"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
              />
            </label>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-rule bg-page p-1">
              {filteredFolders.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-ink-faint">
                  No folders match that search.
                </p>
              ) : (
                filteredFolders.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => void commit(path)}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] font-medium text-ink-dim hover:bg-hover hover:text-ink"
                  >
                    <Folder className="size-3.5 shrink-0" strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-2 py-1.5 text-[11.5px] text-danger">
            {error}
          </p>
        )}

        {mode === 'scratch' && (
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
              onClick={() => void commit(value)}
              disabled={saving}
              className="h-8 rounded-md bg-ink-strong px-3 text-[12.5px] font-medium text-surface hover:bg-accent-hover disabled:bg-ink-ghost"
            >
              Create project
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
