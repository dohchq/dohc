import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
import { AppFrame } from '@/components/AppFrame'
import { ViewsSidebar } from '@/components/ViewsSidebar'
import type { AppAgentRunRequest } from '@/apps/AppRuntimeHost'
import {
  AgentChatSidebar,
  availableProjectFolders,
  type AgentThreadSummary,
} from '@/components/AgentChatSidebar'
import { AgentRunRail } from '@/components/AgentRunRail'
import {
  agentSelectionToConvexArgs,
  type AgentModelPickerSelection,
  type AgentProviderSnapshot,
} from '@/components/AgentModelPicker'
import { GraphView } from '@/components/GraphView'
import type { Id } from '../../convex/_generated/dataModel'
import { Chat } from '@/components/Chat'
import { ImportsExportsPanel } from '@/components/SharingPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { SearchOverlay } from '@/components/SearchOverlay'
import { DohcLogo } from '@dohc/brand'
import { Onboarding } from '@/components/Onboarding'
import { AppLoadingScreen } from '@/components/Skeleton'
import { NoticeProvider, useNotice } from '@/components/NoticeCenter'
import { NotFoundPage } from '@/components/NotFoundPage'
import {
  ActiveWorkspaceProvider,
  useActiveWorkspace,
  useActiveWorkspaceId,
} from '@/lib/active-workspace'
import { type AppView as View, viewFromPathname } from '@/lib/appViews'
import type { AgentAccessMode } from '@/lib/agentAccess'
import { ChatBusyProvider } from '@/lib/chat-busy'
import { pathInsideFolder, projectTreePath } from '@/lib/file-tree-optimistic'
import { onboardingWorkspaceReady } from '@/lib/onboarding-ready'
import { firePaletteCommand, firePaletteSkill } from '@/lib/palette-fire'
import { decodeViewRef, encodeViewRef } from '@/lib/viewRefs'
import { pageIdFromRef, pagePath, pageRef } from '@/lib/page-urls'
import {
  agentThreadIdFromRef,
  agentThreadRef,
} from '@/lib/agent-thread-urls'
import { useDialogFocus } from '../lib/dialog-focus'

// Pathless layout. The open atom now lives in the URL as
// `/<workspaceSlug>/<pageSlug>-<atomId>`. This layout holds the whole
// app shell so route changes never remount the file tree, chat, or editor.
// Child routes render nothing; the shell resolves the current page from
// useLocation and the global atom id embedded in the page ref.
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

const ACTIVITY_BAR_WIDTH = 48
const LEFT_SIDEBAR_STORAGE_KEY = 'dohc-left-sidebar-width'
const LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = 'dohc-left-sidebar-collapsed'
const RIGHT_SIDEBAR_STORAGE_KEY = 'dohc-right-sidebar-width'
const LEFT_SIDEBAR_DEFAULT_WIDTH = 260
const LEFT_SIDEBAR_MIN_WIDTH = 220
const LEFT_SIDEBAR_MAX_WIDTH = 460
const RIGHT_SIDEBAR_LEGACY_DEFAULT_WIDTH = 400
const RIGHT_SIDEBAR_PREVIOUS_DEFAULT_WIDTH = 460
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 500
const RIGHT_SIDEBAR_MIN_WIDTH = 320
const RIGHT_SIDEBAR_MAX_WIDTH = 720
const SIDEBAR_RESIZE_NUDGE = 16

type ResizableSidebar = 'left' | 'right'

function clampSidebarWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)))
}

function readStoredSidebarWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed, min, max)
      : fallback
  } catch {
    return fallback
  }
}

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

function sameAgentSelection(
  a: AgentModelPickerSelection | null,
  b: AgentModelPickerSelection | null,
): boolean {
  return (
    a?.providerId === b?.providerId &&
    a?.model === b?.model &&
    (a?.reasoningEffort ?? null) === (b?.reasoningEffort ?? null)
  )
}

function Home() {
  const { user, loading } = useAuth()

  if (loading) {
    return <AppLoadingScreen />
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
  const progress = useQuery(api.onboarding.progress, { activeWorkspaceId })
  const completeIfReady = useMutation(api.onboarding.completeIfReady)
  const startOnboarding = useAction(api.agent.startOnboarding)
  const workspaceReady = onboardingWorkspaceReady(progress)
  const completingReadyRef = useRef(false)
  const resumeStartedRef = useRef<string | null>(null)

  // W1 (H-7) — fire WorkOS membership reconcile on first sign-in for
  // each user.id + every 4h. Catches the "user removed in WorkOS but
  // session is still valid" case without waiting for the periodic cron.
  // Fire-and-forget: a WorkOS outage doesn't block the UI.
  const { user } = useAuth()
  const reconcileMembership = useAction(api.orgsBridge.reconcileMembership)
  const upsertMyProfile = useMutation(api.auth.upsertMyProfile)
  const ensureWorkspaceSlugs = useMutation(api.workspaceSlugs.ensureMine)
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
    void upsertMyProfile({})
      .then(() => ensureWorkspaceSlugs({}))
      .catch(() => {})
  }, [user?.id, user?.email, upsertMyProfile, ensureWorkspaceSlugs])
  useEffect(() => {
    if (state !== 'IN_PROGRESS' || !workspaceReady) return
    if (completingReadyRef.current) return
    completingReadyRef.current = true
    completeIfReady({ activeWorkspaceId }).catch(() => {
      completingReadyRef.current = false
    })
  }, [activeWorkspaceId, completeIfReady, state, workspaceReady])
  useEffect(() => {
    if (state !== 'IN_PROGRESS' || workspaceReady) return
    const workspaceKey = activeWorkspaceId ?? 'personal'
    if (resumeStartedRef.current === workspaceKey) return
    resumeStartedRef.current = workspaceKey
    startOnboarding({ activeWorkspaceId }).catch(() => {
      resumeStartedRef.current = null
    })
  }, [activeWorkspaceId, startOnboarding, state, workspaceReady])
  if (state === undefined) {
    return <AppLoadingScreen />
  }
  if (state === 'NEW') {
    return <Onboarding state={state} />
  }
  if (state === 'IN_PROGRESS') {
    return <App initialView="agent" initialAgentHandoff />
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

type AppProps = {
  initialView?: View
  initialAgentHandoff?: boolean
}

function App({ initialView, initialAgentHandoff = false }: AppProps = {}) {
  const { user } = useAuth()
  const notice = useNotice()
  // org-plan §5 Phase B — every read/write is scoped to the active
  // workspace. undefined ⇒ caller's personal workspace (the v0 default;
  // back-compat preserved by requireWorkspace(ctx, undefined)).
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveWorkspace()
  const workspaces = useQuery(api.orgs.myWorkspaces, {})
  const activeWorkspace = useMemo(() => {
    if (!workspaces?.length) return null
    return (
      workspaces.find((w) =>
        activeWorkspaceId === undefined
          ? w.kind === 'personal'
          : w.workspaceId === activeWorkspaceId,
      ) ?? workspaces[0]
    )
  }, [activeWorkspaceId, workspaces])
  const activeWorkspaceSlug = activeWorkspace?.slug ?? 'workspace'
  const files = useQuery(api.atoms.list, { activeWorkspaceId })
  const folders = useQuery(api.folders.list, { activeWorkspaceId })
  const fileByPath = useMemo(() => {
    const rows = new Map<string, NonNullable<typeof files>[number]>()
    for (const file of files ?? []) rows.set(file.path, file)
    return rows
  }, [files])
  const fileByFileId = useMemo(() => {
    const rows = new Map<string, NonNullable<typeof files>[number]>()
    for (const file of files ?? []) {
      if (file.fileId) rows.set(file.fileId, file)
    }
    return rows
  }, [files])
  const fileByAtomId = useMemo(() => {
    const rows = new Map<string, NonNullable<typeof files>[number]>()
    for (const file of files ?? []) rows.set(file._id, file)
    return rows
  }, [files])
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
  const [agentHandoffPending, setAgentHandoffPending] =
    useState(initialAgentHandoff)
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
  // The open atom is URL-driven by `/<workspaceSlug>/<pageSlug>-<atomId>`.
  // The slug is cosmetic; the global atom id is the source of truth.
  // `activePath` is derived from either the current file list or the
  // backend page resolver, so renames keep the same durable URL id.
  const location = useLocation()
  const pathParts = location.pathname.split('/').filter(Boolean)
  const urlWorkspaceSlug =
    pathParts.length > 0 && pathParts[0] !== 'shared'
      ? decodeURIComponent(pathParts[0])
      : null
  const urlPageRef =
    pathParts.length === 2 &&
    !['agent', 'files', 'apps', 'views', 'graph', 'a', 'v'].includes(pathParts[1])
      ? decodeURIComponent(pathParts[1])
      : null
  const urlPageId = pageIdFromRef(urlPageRef)
  const urlAgentThreadRef =
    pathParts.length === 3 && pathParts[1] === 'agent'
      ? decodeURIComponent(pathParts[2])
      : null
  const urlAgentThreadId = agentThreadIdFromRef(urlAgentThreadRef)
  const urlWorkspaceKnown =
    !urlWorkspaceSlug || workspaces === undefined
      ? undefined
      : workspaces.some((workspace) => workspace.slug === urlWorkspaceSlug)
  // sharing-v1 1a — `/shared/<shareId>` opens an atom shared WITH me.
  const urlShareId = (() => {
    const m = /^\/shared\/([^/]+)\/?$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()
  const urlViewRef = (() => {
    const m = /^\/[^/]+\/(?:a|v)\/([^/]+)\/?$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()
  const selectedViewPackageRoot = urlViewRef ? decodeViewRef(urlViewRef) : null
  const urlView = viewFromPathname(location.pathname)
  const routedPage = useQuery(
    api.atoms.getPageById,
    urlPageId
      ? {
          atomId: urlPageId,
          workspaceSlug: urlWorkspaceSlug ?? undefined,
        }
      : 'skip',
  )
  const routedAgentThread = useQuery(
    api.agent.getThreadById,
    urlAgentThreadId && urlWorkspaceSlug
      ? {
          workspaceSlug: urlWorkspaceSlug,
          threadId: urlAgentThreadId,
        }
      : 'skip',
  )
  const routedShareId =
    routedPage?.kind === 'share' ? String(routedPage.shareId) : null
  const routedShareActiveWorkspaceId =
    routedPage?.kind === 'share'
      ? (routedPage.activeWorkspaceId ?? undefined)
      : undefined
  const activeShareId = urlShareId ?? routedShareId
  const activeShareWorkspaceId =
    routedShareActiveWorkspaceId ?? activeWorkspaceId
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
  const routedWorkspaceActiveId =
    routedPage?.kind === 'workspace'
      ? (routedPage.activeWorkspaceId ?? undefined)
      : undefined
  const derivedFromUrl =
    urlPageId
      ? (fileByAtomId.get(urlPageId)?.path ??
        (routedPage?.kind === 'workspace' ? routedPage.path : null))
      : null
  const activePath = optimisticPath ?? derivedFromUrl ?? null
  const [view, setView] = useState<View>(
    () =>
      urlView ??
      initialView ??
      (urlPageId || activeShareId || initialOpenPathRef.current
        ? 'atom'
        : 'views'),
  )

  useEffect(() => {
    if (routedPage?.kind !== 'workspace') return
    const next = routedPage.activeWorkspaceId ?? undefined
    if (next === activeWorkspaceId) return
    setActiveWorkspaceId(next)
  }, [activeWorkspaceId, routedPage, setActiveWorkspaceId])

  useEffect(() => {
    if (!routedAgentThread) return
    const next = routedAgentThread.activeWorkspaceId ?? undefined
    if (next === activeWorkspaceId) return
    setActiveWorkspaceId(next)
  }, [activeWorkspaceId, routedAgentThread, setActiveWorkspaceId])

  useEffect(() => {
    if (!urlPageRef || !routedPage) return
    const canonicalRef = pageRef({
      _id: String(routedPage.atomId),
      title: routedPage.title,
    })
    if (
      urlWorkspaceSlug === routedPage.workspaceSlug &&
      urlPageRef === canonicalRef
    ) {
      return
    }
    void navigate({
      to: '/$workspaceSlug/$pageRef',
      params: {
        workspaceSlug: routedPage.workspaceSlug,
        pageRef: canonicalRef,
      },
      replace: true,
    })
  }, [navigate, routedPage, urlPageRef, urlWorkspaceSlug])

  useEffect(() => {
    if (!urlAgentThreadRef || !routedAgentThread) return
    const canonicalRef = agentThreadRef(routedAgentThread)
    if (
      urlWorkspaceSlug === routedAgentThread.workspaceSlug &&
      urlAgentThreadRef === canonicalRef
    ) {
      return
    }
    void navigate({
      to: '/$workspaceSlug/agent/$threadRef',
      params: {
        workspaceSlug: routedAgentThread.workspaceSlug,
        threadRef: canonicalRef,
      },
      replace: true,
    })
  }, [navigate, routedAgentThread, urlAgentThreadRef, urlWorkspaceSlug])

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
        agentAccessMode: thread.agentAccessMode,
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
  useEffect(() => {
    if (!routedAgentThread) return
    setSelectedAgentThreadSnapshot({
      threadId: routedAgentThread.threadId,
      projectPath: routedAgentThread.projectPath,
      title: routedAgentThread.title,
      createdAt: routedAgentThread.createdAt,
      updatedAt: routedAgentThread.updatedAt,
      pinnedAt: routedAgentThread.pinnedAt,
      agentProviderId: routedAgentThread.agentProviderId,
      agentModel: routedAgentThread.agentModel,
      agentReasoningEffort: routedAgentThread.agentReasoningEffort,
      agentAccessMode: routedAgentThread.agentAccessMode,
    })
    setAgentProjectPath(routedAgentThread.projectPath)
    setThreadId(routedAgentThread.threadId)
    setAgentDraft(false)
    setView('agent')
  }, [routedAgentThread])
  const handoffAgentThread =
    !agentDraft && !threadId ? (chatThreads[0] ?? null) : null
  const visibleAgentThread = activeAgentThread ?? handoffAgentThread
  const visibleAgentThreadId =
    visibleAgentThread?.threadId ?? threadId ?? null
  const visibleAgentProjectPath =
    visibleAgentThreadId === threadId
      ? agentProjectPath
      : (visibleAgentThread?.projectPath ?? agentProjectPath)
  const agentWorkspaceLoading =
    view === 'agent' &&
    agentHandoffPending &&
    (agentThreads === undefined || !visibleAgentThreadId)
  const agentProviders = useMemo(
    () => (agentProviderInfo?.providers ?? []) as AgentProviderSnapshot[],
    [agentProviderInfo],
  )
  const agentEffectiveDefault = agentSelectionFromApi(
    agentProviderInfo?.effectiveDefault,
  )
  const activeThreadSelection = agentSelectionFromThread(visibleAgentThread)
  const agentSelection =
    agentSelectionOverride ??
    activeThreadSelection ??
    (agentDraft ? agentDraftSelection : null) ??
    agentEffectiveDefault
  const agentDocTitle =
    visibleAgentThread?.title?.trim() ||
    (visibleAgentThreadId ? 'Workspace chat' : 'New chat')

  useEffect(() => {
    setAgentSelectionOverride(null)
  }, [activeWorkspaceId, threadId])

  useEffect(() => {
    if (!agentSelectionOverride || !threadId) return
    if (!queryActiveAgentThread || !activeThreadSelection) return
    if (sameAgentSelection(agentSelectionOverride, activeThreadSelection)) {
      setAgentSelectionOverride(null)
    }
  }, [
    activeThreadSelection,
    agentSelectionOverride,
    queryActiveAgentThread,
    threadId,
  ])

  useEffect(() => {
    setAgentDraftSelection(null)
    setSelectedAgentThreadSnapshot(null)
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!agentHandoffPending) return
    if (visibleAgentThreadId || agentDraft) setAgentHandoffPending(false)
  }, [agentDraft, agentHandoffPending, visibleAgentThreadId])

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
          ...agentSelectionToConvexArgs(selection),
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
    activeShareId
      ? {
          shareId: activeShareId as Id<'atomShares'>,
          activeWorkspaceId: activeShareWorkspaceId,
        }
      : 'skip',
  )
  const { docTitle, docEmoji } = useMemo<{
    docTitle: string | null | undefined
    docEmoji: string | null | undefined
  }>(() => {
    if (view === 'agent') return { docTitle: agentDocTitle, docEmoji: null }
    if (view === 'graph') return { docTitle: 'Graph', docEmoji: null }
    if (view === 'views') return { docTitle: 'Apps', docEmoji: null }
    if (activeShareId) {
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
    const f = fileByPath.get(activePath)
    return {
      docTitle: (f?.title && f.title.trim()) || leafName(activePath),
      docEmoji: f?.icon ?? null,
    }
  }, [
    view,
    agentDocTitle,
    activeShareId,
    sharedAtomForMeta,
    activePath,
    fileByPath,
  ])
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
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return (
        window.localStorage.getItem(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
      )
    } catch {
      return false
    }
  })
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() =>
    readStoredSidebarWidth(
      LEFT_SIDEBAR_STORAGE_KEY,
      LEFT_SIDEBAR_DEFAULT_WIDTH,
      LEFT_SIDEBAR_MIN_WIDTH,
      LEFT_SIDEBAR_MAX_WIDTH,
    ),
  )
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    const storedWidth = readStoredSidebarWidth(
      RIGHT_SIDEBAR_STORAGE_KEY,
      RIGHT_SIDEBAR_DEFAULT_WIDTH,
      RIGHT_SIDEBAR_MIN_WIDTH,
      RIGHT_SIDEBAR_MAX_WIDTH,
    )
    return storedWidth === RIGHT_SIDEBAR_LEGACY_DEFAULT_WIDTH ||
      storedWidth === RIGHT_SIDEBAR_PREVIOUS_DEFAULT_WIDTH
      ? RIGHT_SIDEBAR_DEFAULT_WIDTH
      : storedWidth
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY,
        leftSidebarCollapsed ? '1' : '0',
      )
    } catch {
      // localStorage unavailable / quota exceeded — non-fatal.
    }
  }, [leftSidebarCollapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LEFT_SIDEBAR_STORAGE_KEY,
        String(leftSidebarWidth),
      )
    } catch {
      // localStorage unavailable / quota exceeded — non-fatal.
    }
  }, [leftSidebarWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RIGHT_SIDEBAR_STORAGE_KEY,
        String(rightSidebarWidth),
      )
    } catch {
      // localStorage unavailable / quota exceeded — non-fatal.
    }
  }, [rightSidebarWidth])

  const nudgeLeftSidebar = useCallback((delta: number) => {
    setLeftSidebarWidth((width) =>
      clampSidebarWidth(
        width + delta,
        LEFT_SIDEBAR_MIN_WIDTH,
        LEFT_SIDEBAR_MAX_WIDTH,
      ),
    )
  }, [])

  const nudgeRightSidebar = useCallback((delta: number) => {
    setRightSidebarWidth((width) =>
      clampSidebarWidth(
        width + delta,
        RIGHT_SIDEBAR_MIN_WIDTH,
        RIGHT_SIDEBAR_MAX_WIDTH,
      ),
    )
  }, [])

  const resetLeftSidebar = useCallback(() => {
    setLeftSidebarWidth(LEFT_SIDEBAR_DEFAULT_WIDTH)
  }, [])

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  const resetRightSidebar = useCallback(() => {
    setRightSidebarWidth(RIGHT_SIDEBAR_DEFAULT_WIDTH)
  }, [])

  const startSidebarResize = useCallback(
    (side: ResizableSidebar, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth =
        side === 'left' ? leftSidebarWidth : rightSidebarWidth
      const setWidth =
        side === 'left' ? setLeftSidebarWidth : setRightSidebarWidth
      const min =
        side === 'left' ? LEFT_SIDEBAR_MIN_WIDTH : RIGHT_SIDEBAR_MIN_WIDTH
      const max =
        side === 'left' ? LEFT_SIDEBAR_MAX_WIDTH : RIGHT_SIDEBAR_MAX_WIDTH
      const originalCursor = document.body.style.cursor
      const originalUserSelect = document.body.style.userSelect

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      function onPointerMove(moveEvent: PointerEvent) {
        const delta = moveEvent.clientX - startX
        const nextWidth =
          side === 'left' ? startWidth + delta : startWidth - delta
        setWidth(clampSidebarWidth(nextWidth, min, max))
      }

      function onPointerUp() {
        document.body.style.cursor = originalCursor
        document.body.style.userSelect = originalUserSelect
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
    },
    [leftSidebarWidth, rightSidebarWidth],
  )

  useEffect(() => {
    if (urlPageId) {
      lastFilesDestinationRef.current = { kind: 'atom', id: urlPageId }
    } else if (activeShareId) {
      lastFilesDestinationRef.current = { kind: 'shared', id: activeShareId }
    }
  }, [urlPageId, activeShareId])

  const navigateToAgentThread = useCallback(
    (thread: AgentThreadSummary, opts?: { replace?: boolean }) => {
      void navigate({
        to: '/$workspaceSlug/agent/$threadRef',
        params: {
          workspaceSlug: activeWorkspaceSlug,
          threadRef: agentThreadRef(thread),
        },
        replace: opts?.replace ?? false,
      })
    },
    [activeWorkspaceSlug, navigate],
  )

  const navigateToView = useCallback(
    (next: View, opts?: { replace?: boolean }) => {
      if (next === view && (urlView || urlPageId || activeShareId)) return
      setView(next)
      if (next === 'agent') {
        setSharingOpen(false)
        if (activeAgentThread && !agentDraft) {
          navigateToAgentThread(activeAgentThread, opts)
          return
        }
        void navigate({
          to: '/$workspaceSlug/agent',
          params: { workspaceSlug: activeWorkspaceSlug },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (next === 'graph') {
        setSharingOpen(false)
        void navigate({
          to: '/$workspaceSlug/graph',
          params: { workspaceSlug: activeWorkspaceSlug },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (next === 'views') {
        setSharingOpen(false)
        void navigate({
          to: '/$workspaceSlug/apps',
          params: { workspaceSlug: activeWorkspaceSlug },
          replace: opts?.replace ?? false,
        })
        return
      }

      const destination = urlPageId
        ? ({ kind: 'atom', id: urlPageId } as const)
        : activeShareId
          ? ({ kind: 'shared', id: activeShareId } as const)
          : lastFilesDestinationRef.current

      if (destination?.kind === 'atom') {
        const row = fileByAtomId.get(destination.id)
        if (!row) {
          void navigate({
            to: '/$workspaceSlug/files',
            params: { workspaceSlug: activeWorkspaceSlug },
            replace: opts?.replace ?? false,
          })
          return
        }
        void navigate({
          to: '/$workspaceSlug/$pageRef',
          params: {
            workspaceSlug: activeWorkspaceSlug,
            pageRef: pageRef(row),
          },
          replace: opts?.replace ?? false,
        })
        return
      }
      if (destination?.kind === 'shared') {
        void navigate({
          to: '/shared/$shareId',
          params: { shareId: destination.id },
          replace: opts?.replace ?? false,
        })
        return
      }
      void navigate({
        to: '/$workspaceSlug/files',
        params: { workspaceSlug: activeWorkspaceSlug },
        replace: opts?.replace ?? false,
      })
    },
    [
      activeShareId,
      activeAgentThread,
      agentDraft,
      activeWorkspaceSlug,
      fileByAtomId,
      navigate,
      navigateToAgentThread,
      urlPageId,
      urlView,
      view,
    ],
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
    if (urlAgentThreadId) return
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
    if (first && view === 'agent' && urlView === 'agent') {
      navigateToAgentThread(first, { replace: true })
    }
  }, [
    agentDraft,
    agentThreads,
    chatThreads,
    navigateToAgentThread,
    selectedAgentThreadSnapshot,
    threadId,
    urlAgentThreadId,
    urlView,
    view,
  ])

  const startAgentDraft = useCallback(
    (projectPath: string | null = null) => {
      setAgentDraft(true)
      setAgentProjectPath(projectPath)
      setThreadId(null)
      setAgentSelectionOverride(null)
      setSelectedAgentThreadSnapshot(null)
      setView('agent')
      setSharingOpen(false)
      void navigate({
        to: '/$workspaceSlug/agent',
        params: { workspaceSlug: activeWorkspaceSlug },
      })
    },
    [activeWorkspaceSlug, navigate],
  )

  const startAgentDraftInPanel = useCallback(
    (projectPath: string | null = agentProjectPath) => {
      setAgentDraft(true)
      setAgentProjectPath(projectPath)
      setThreadId(null)
      setAgentSelectionOverride(null)
      setSelectedAgentThreadSnapshot(null)
      setChatOpen(true)
      setSharingOpen(false)
    },
    [agentProjectPath],
  )

  const selectAgentThread = useCallback(
    (thread: AgentThreadSummary) => {
      setSelectedAgentThreadSnapshot(thread)
      setAgentProjectPath(thread.projectPath)
      setThreadId(thread.threadId)
      setAgentDraft(false)
      setAgentSelectionOverride(null)
      setView('agent')
      setSharingOpen(false)
      navigateToAgentThread(thread)
    },
    [navigateToAgentThread],
  )

  const selectAgentThreadInPanel = useCallback((thread: AgentThreadSummary) => {
    setSelectedAgentThreadSnapshot(thread)
    setAgentProjectPath(thread.projectPath)
    setThreadId(thread.threadId)
    setAgentDraft(false)
    setAgentSelectionOverride(null)
    setChatOpen(true)
    setSharingOpen(false)
  }, [])

  const createAgentChatThread = useCallback(
    async (
      projectPath: string | null,
      selection?: AgentModelPickerSelection | null,
      accessMode?: AgentAccessMode | null,
      navigateAfterCreate = true,
    ) => {
      const chosenSelection = selection ?? agentSelection
      const id = await createAgentThread({
        activeWorkspaceId,
        projectPath,
        ...(chosenSelection
          ? agentSelectionToConvexArgs(chosenSelection)
          : {}),
        ...(accessMode ? { agentAccessMode: accessMode } : {}),
      })
      if (chosenSelection) setAgentSelectionOverride(chosenSelection)
      const now = Date.now()
      setSelectedAgentThreadSnapshot({
        threadId: id as string,
        projectPath,
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        pinnedAt: null,
        agentProviderId: chosenSelection?.providerId ?? null,
        agentModel: chosenSelection?.model ?? null,
        agentReasoningEffort: chosenSelection?.reasoningEffort ?? null,
        agentAccessMode: accessMode ?? null,
      })
      setAgentProjectPath(projectPath)
      setThreadId(id as string)
      setAgentDraft(false)
      if (navigateAfterCreate) {
        navigateToAgentThread(
          {
            threadId: id as string,
            projectPath,
            title: 'New chat',
            createdAt: now,
            updatedAt: now,
            pinnedAt: null,
            agentProviderId: chosenSelection?.providerId ?? null,
            agentModel: chosenSelection?.model ?? null,
            agentReasoningEffort: chosenSelection?.reasoningEffort ?? null,
            agentAccessMode: accessMode ?? null,
          },
        )
      }
      return id as string
    },
    [
      activeWorkspaceId,
      agentSelection,
      createAgentThread,
      navigateToAgentThread,
    ],
  )

  const ensureAgentThreadForSend = useCallback(
    (
      projectPath: string | null,
      selection?: AgentModelPickerSelection | null,
      accessMode?: AgentAccessMode | null,
    ) => createAgentChatThread(projectPath, selection, accessMode, true),
    [createAgentChatThread],
  )

  const ensureAgentThreadForPanelSend = useCallback(
    (
      projectPath: string | null,
      selection?: AgentModelPickerSelection | null,
      accessMode?: AgentAccessMode | null,
    ) => createAgentChatThread(projectPath, selection, accessMode, false),
    [createAgentChatThread],
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
        void navigate({
          to: '/$workspaceSlug/agent',
          params: { workspaceSlug: activeWorkspaceSlug },
          replace: true,
        })
      }
    },
    [activeWorkspaceId, activeWorkspaceSlug, deleteAgentThread, navigate, threadId],
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
    (request: string | AppAgentRunRequest) => {
      const prompt =
        typeof request === 'string'
          ? request
          : [
              request.prompt,
              '',
              `Originating app: ${request.originatingApp}`,
              `App title: ${request.titleHint}`,
              request.sources && request.sources.length > 0
                ? `Sources: ${request.sources.join(', ')}`
                : null,
            ].filter(Boolean).join('\n')
      setPendingPrompt(prompt)
      navigateToView('agent')
    },
    [navigateToView],
  )

  // Open an atom by PATH. Show it immediately (optimistic override)
  // and, once its row is known, push the global atom id into the
  // canonical pretty URL.
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
      const row = fileByPath.get(path)
      if (row) {
        lastFilesDestinationRef.current = { kind: 'atom', id: row._id }
        void navigate({
          to: '/$workspaceSlug/$pageRef',
          params: {
            workspaceSlug: activeWorkspaceSlug,
            pageRef: pageRef(row),
          },
          replace: opts?.replace ?? false,
        })
      }
    },
    [activeWorkspaceSlug, fileByPath, navigate],
  )

  // Clear the open atom (→ home). Used on delete of the open atom.
  const clearOpenAtom = useCallback(
    (opts?: { replace?: boolean }) => {
      setOptimisticPath(null)
      lastFilesDestinationRef.current = null
      // Stay in the Files surface after deleting/clearing the open atom.
      void navigate({
        to: '/$workspaceSlug/files',
        params: { workspaceSlug: activeWorkspaceSlug },
        replace: opts?.replace ?? false,
      })
    },
    [activeWorkspaceSlug, navigate],
  )

  // sharing-v1 1a — open an atom shared WITH me (by share id).
  const openShared = useCallback(
    (sid: string) => {
      setOptimisticPath(null)
      setView('atom')
      lastFilesDestinationRef.current = { kind: 'shared', id: sid }
      void navigate({
        to: '/shared/$shareId',
        params: { shareId: sid },
      })
    },
    [navigate],
  )

  const openView = useCallback(
    (packageRoot: string) => {
      setView('views')
      setSharingOpen(false)
      const appRef = encodeViewRef(packageRoot)
      void navigate({
        to: '/$workspaceSlug/a/$appRef',
        params: { workspaceSlug: activeWorkspaceSlug, appRef },
      })
    },
    [activeWorkspaceSlug, navigate],
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
    if (!optimisticPath) return
    const row = fileByPath.get(optimisticPath)
    if (row && urlPageId !== row._id) {
      lastFilesDestinationRef.current = { kind: 'atom', id: row._id }
      void navigate({
        to: '/$workspaceSlug/$pageRef',
        params: {
          workspaceSlug: activeWorkspaceSlug,
          pageRef: pageRef(row),
        },
        replace: true,
      })
    }
  }, [activeWorkspaceSlug, optimisticPath, fileByPath, urlPageId, navigate])

  // Once the URL→files derivation converges to the optimistic path,
  // drop the override so the URL is the sole source of truth (a
  // rename keeps the same atom id, so this fires when `files` shows
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
    const routedView = urlView ?? (urlPageId || activeShareId ? 'atom' : null)
    if (routedView) setView(routedView)
  }, [urlView, urlPageId, activeShareId])

  async function createAtom(path: string, body = '') {
    // openAtom shows it immediately (optimistic); the bridge effect
    // writes the URL once the new file lands in `files` with an atom id.
    const previousPath = activePath
    openAtom(path)
    setEnterEdit(true)
    try {
      await upsertAtom({ path, body, source: 'user', activeWorkspaceId })
    } catch (e) {
      if (previousPath) openAtom(previousPath, { replace: true })
      else clearOpenAtom({ replace: true })
      notice.error(`Couldn't create page`, (e as Error).message)
      throw e
    }
  }

  async function createPageWithName(name: string) {
    let clean = name.trim().replace(/^\/+/, '')
    if (!clean) return
    if (!/\.[a-z0-9]+$/i.test(clean)) clean += '.md'
    const exists = fileByPath.has(clean)
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
    if (activePath === fromPath) setOptimisticPath(toPath)
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
      if (activePath === fromPath) setOptimisticPath(fromPath)
      notice.error(`Couldn't move file`, (e as Error).message)
      throw e
    }
  }
  async function moveFolderByDrop(fromPath: string, toPath: string) {
    // D4.7c — flush autosave before the cascade runs.
    await pendingSaveRef.current?.()
    const activeTarget = projectTreePath(activePath, [
      { id: 'active-folder-move', kind: 'folder', fromPath, toPath },
    ])
    const movedActivePath = activeTarget !== null && activeTarget !== activePath
    if (movedActivePath) setOptimisticPath(activeTarget)
    try {
      await moveFolder({ fromPath, toPath, activeWorkspaceId })
      // D4.8 — link-cascade alert removed per user feedback;
      // the rewrite is the kind of background polish that
      // doesn't need a popup confirmation.
    } catch (e) {
      if (movedActivePath) setOptimisticPath(activePath)
      notice.error(`Couldn't move folder`, (e as Error).message)
      throw e
    }
  }

  async function deleteFileByPath(path: string) {
    const restorePath = activePath
    // D4.30 — if we just deleted the open atom, clear the URL.
    if (activePath === path) clearOpenAtom({ replace: true })
    try {
      await removeAtom({ path, activeWorkspaceId })
    } catch (e) {
      if (restorePath === path) openAtom(restorePath, { replace: true })
      notice.error(`Couldn't delete file`, (e as Error).message)
      throw e
    }
  }

  async function renameFileByPath(path: string, next: string) {
    let target = next.trim().replace(/^\/+/, '')
    if (!target) return
    if (!/\.[a-z0-9]+$/i.test(target)) target += '.md'
    if (target === path) return
    // D4.7c — flush autosave so the cascade reads the latest body.
    await pendingSaveRef.current?.()
    if (activePath === path) setOptimisticPath(target)
    try {
      await moveAtom({ fromPath: path, toPath: target, activeWorkspaceId })
    } catch (e) {
      if (activePath === path) setOptimisticPath(path)
      notice.error(`Couldn't rename file`, (e as Error).message)
      throw e
    }
    // D4.30 — no URL change; fileId is stable, activePath
    // re-derives to `target` automatically.
    // D4.8 — link-cascade notice omitted; the rename row is the active surface.
  }

  async function renameFolderByPath(path: string, next: string) {
    const target = next.trim().replace(/^\/+|\/+$/g, '')
    if (!target || target === path) return
    // D4.7c — flush autosave before cascade.
    await pendingSaveRef.current?.()
    const activeTarget = projectTreePath(activePath, [
      {
        id: 'active-folder-rename',
        kind: 'folder',
        fromPath: path,
        toPath: target,
      },
    ])
    const renamedActivePath =
      activeTarget !== null && activeTarget !== activePath
    if (renamedActivePath) setOptimisticPath(activeTarget)
    try {
      await moveFolder({ fromPath: path, toPath: target, activeWorkspaceId })
    } catch (e) {
      if (renamedActivePath) setOptimisticPath(activePath)
      notice.error(`Couldn't rename folder`, (e as Error).message)
      throw e
    }
    // D4.30 — no URL change: every moved atom keeps its fileId
    // (folders.move reconciles the index), so the open atom's
    // `activePath` re-derives to its new path automatically.
    // D4.8 — link-cascade notice omitted; the rename row is the active surface.
  }

  async function deleteFolderByPath(path: string) {
    const restorePath = activePath
    if (activePath && pathInsideFolder(activePath, path)) {
      clearOpenAtom({ replace: true })
    }
    try {
      const { atomCount, folderCount } = await removeFolder({
        path,
        activeWorkspaceId,
      })
      // D4.30 — if the open atom was inside the deleted folder, clear the URL.
      notice.success(
        'Deleted folder',
        `${atomCount} atom${atomCount === 1 ? '' : 's'}, ${folderCount} folder row${folderCount === 1 ? '' : 's'} removed.`,
      )
    } catch (e) {
      if (restorePath && pathInsideFolder(restorePath, path)) {
        openAtom(restorePath, { replace: true })
      }
      throw e
    }
  }

  const panelOpen = view !== 'agent' && (chatOpen || sharingOpen)
  const rightColumnOpen = view === 'agent' || panelOpen
  const leftColumn = leftSidebarCollapsed ? null : `${leftSidebarWidth}px`
  const shellGridTemplateColumns = [
    `${ACTIVITY_BAR_WIDTH}px`,
    leftColumn,
    'minmax(0,1fr)',
    rightColumnOpen ? `${rightSidebarWidth}px` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const floatingPanelButtonRight = panelOpen ? rightSidebarWidth + 12 : 20
  const sharePromptFile = sharePromptFor
    ? fileByFileId.get(sharePromptFor)
    : undefined
  const sharePromptHref =
    sharePromptFile && typeof window !== 'undefined'
      ? `${window.location.origin}${pagePath({
          workspaceSlug: activeWorkspaceSlug,
          ...sharePromptFile,
        })}`
      : undefined
  const invalidPageRef = urlPageRef !== null && urlPageId === null
  const invalidAgentThreadRef =
    urlAgentThreadRef !== null && urlAgentThreadId === null
  const workspaceSlugMissing =
    urlWorkspaceKnown === false &&
    urlPageId === null &&
    urlAgentThreadId === null
  const showNotFound =
    invalidPageRef ||
    invalidAgentThreadRef ||
    workspaceSlugMissing ||
    routedPage === null ||
    routedAgentThread === null

  if (showNotFound) return <NotFoundPage />

  return agentWorkspaceLoading ? (
    <AppLoadingScreen />
  ) : (
    <div
      className="relative grid h-screen overflow-hidden bg-page text-ink"
      style={{ gridTemplateColumns: shellGridTemplateColumns }}
    >
      <ActivityBar
        view={view}
        onSelect={navigateToView}
        sidebarCollapsed={leftSidebarCollapsed}
        onToggleSidebar={toggleLeftSidebar}
      />
      {view === 'agent' ? (
        <>
          {!leftSidebarCollapsed && (
            <AgentChatSidebar
              files={files ?? []}
              folders={folders ?? []}
              threads={chatThreads}
              loading={
                files === undefined ||
                folders === undefined ||
                agentThreads === undefined
              }
              activeThreadId={visibleAgentThreadId}
              activeProjectPath={visibleAgentProjectPath}
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
          )}
          <AgentWorkspace
            threadId={visibleAgentThreadId}
            activeThread={visibleAgentThread}
            projectPath={visibleAgentProjectPath}
            projectOptions={agentProjectOptions}
            folderOptions={projectFolderOptions}
            onProjectPathChange={setAgentProjectPath}
            onCreateProject={createAgentProject}
            onEnsureThread={ensureAgentThreadForSend}
            threadAccessMode={visibleAgentThread?.agentAccessMode ?? null}
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
            activeThread={visibleAgentThread}
            projectPath={visibleAgentProjectPath}
          />
        </>
      ) : view === 'views' ? (
        <>
          {!leftSidebarCollapsed && (
            <ViewsSidebar
              selectedPackageRoot={selectedViewPackageRoot}
              onOpenView={openView}
              onOpenSource={(path) => openAtom(path)}
              onOpenSearch={() => setSearchOpen(true)}
              user={user}
            />
          )}
          <AppFrame
            packageRoot={selectedViewPackageRoot}
            onOpenSource={(path) => openAtom(path)}
            onRunAgent={onRunAction}
          />
          {chatOpen && (
            <Chat
              mode="side"
              threadId={threadId}
              threadTitle={activeAgentThread?.title ?? null}
              projectPath={agentProjectPath}
              projectOptions={agentProjectOptions}
              folderOptions={projectFolderOptions}
              threads={chatThreads}
              onSelectThread={selectAgentThreadInPanel}
              onNewThread={startAgentDraftInPanel}
              onProjectPathChange={setAgentProjectPath}
              onCreateProject={createAgentProject}
              onEnsureThread={ensureAgentThreadForPanelSend}
              threadAccessMode={activeAgentThread?.agentAccessMode ?? null}
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
          {!leftSidebarCollapsed && (
            <FileTree
              files={files ?? []}
              folders={folders ?? []}
              loading={files === undefined || folders === undefined}
              activePath={activePath}
              view="atom"
              onOpenSearch={() => setSearchOpen(true)}
              user={user}
              sharedWithMe={sharedWithMe ?? []}
              sharedByMeFileIds={sharedByMeFileIds ?? []}
              activeShareId={activeShareId}
              allowCreate={view !== 'graph'}
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
          )}
          {view === 'graph' ? (
            <GraphView onOpenAtom={openAtom} onOpenShared={openShared} />
          ) : activeShareId ? (
            // key by shareId → fresh state per share (no stale draft
            // reuse when switching shared files; codex P1).
            <SharedAtomView
              key={activeShareId}
              shareId={activeShareId as Id<'atomShares'>}
              activeWorkspaceIdOverride={routedShareActiveWorkspaceId}
            />
          ) : (
            <AtomView
              path={activePath}
              files={files ?? []}
              activeWorkspaceIdOverride={routedWorkspaceActiveId}
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
              threadTitle={activeAgentThread?.title ?? null}
              projectPath={agentProjectPath}
              projectOptions={agentProjectOptions}
              folderOptions={projectFolderOptions}
              threads={chatThreads}
              onSelectThread={selectAgentThreadInPanel}
              onNewThread={startAgentDraftInPanel}
              onProjectPathChange={setAgentProjectPath}
              onCreateProject={createAgentProject}
              onEnsureThread={ensureAgentThreadForPanelSend}
              threadAccessMode={activeAgentThread?.agentAccessMode ?? null}
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
      {!leftSidebarCollapsed && (
        <ShellResizeHandle
          side="left"
          label="Resize left sidebar"
          value={leftSidebarWidth}
          min={LEFT_SIDEBAR_MIN_WIDTH}
          max={LEFT_SIDEBAR_MAX_WIDTH}
          style={{ left: ACTIVITY_BAR_WIDTH + leftSidebarWidth }}
          onPointerDown={(event) => startSidebarResize('left', event)}
          onNudge={nudgeLeftSidebar}
          onReset={resetLeftSidebar}
        />
      )}
      {rightColumnOpen && (
        <ShellResizeHandle
          side="right"
          label="Resize right sidebar"
          value={rightSidebarWidth}
          min={RIGHT_SIDEBAR_MIN_WIDTH}
          max={RIGHT_SIDEBAR_MAX_WIDTH}
          style={{ right: rightSidebarWidth }}
          onPointerDown={(event) => startSidebarResize('right', event)}
          onNudge={nudgeRightSidebar}
          onReset={resetRightSidebar}
        />
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
        }`}
        style={{ right: floatingPanelButtonRight }}
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
        }`}
        style={{ right: floatingPanelButtonRight }}
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
            fileByFileId.get(sharePromptFor)?.title ??
            sharePromptFor
          }
          pageHref={sharePromptHref}
          onClose={() => setSharePromptFor(null)}
        />
      )}
    </div>
  )
}

function ShellResizeHandle({
  side,
  label,
  value,
  min,
  max,
  style,
  onPointerDown,
  onNudge,
  onReset,
}: {
  side: ResizableSidebar
  label: string
  value: number
  min: number
  max: number
  style: CSSProperties
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onNudge: (delta: number) => void
  onReset: () => void
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    const delta =
      side === 'left'
        ? direction * SIDEBAR_RESIZE_NUDGE
        : -direction * SIDEBAR_RESIZE_NUDGE
    onNudge(delta)
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        event.preventDefault()
        onReset()
      }}
      onKeyDown={onKeyDown}
      className={`group absolute inset-y-0 z-[55] w-2 cursor-col-resize touch-none outline-none ${
        side === 'left' ? '-translate-x-1/2' : 'translate-x-1/2'
      }`}
      style={style}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-rule-strong group-focus-visible:bg-accent" />
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
  threadAccessMode,
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
  onEnsureThread: (
    projectPath: string | null,
    selection?: AgentModelPickerSelection | null,
    accessMode?: AgentAccessMode | null,
  ) => Promise<string>
  threadAccessMode: AgentAccessMode | null
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
        threadAccessMode={threadAccessMode}
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
