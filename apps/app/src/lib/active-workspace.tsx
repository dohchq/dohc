/**
 * Active workspace context (org-plan §5 Phase B + §9 switcher).
 *
 * Source of truth for "which workspace is the UI currently viewing".
 * The personal workspace is the implicit default — `activeWorkspaceId`
 * is `undefined` when viewing personal (the back-compat path: any
 * Convex query/mutation called without `activeWorkspaceId` resolves
 * to the caller's personal workspace via `requireWorkspace(ctx)`).
 *
 * Persistence: localStorage so the choice survives a page reload but
 * stays per-device (an open tab in personal + a tab in an org won't
 * fight each other within a single session). When URL-based routing
 * lands (Phase D follow-up) this hook becomes a thin pass-through
 * over the route param; the API stays the same.
 *
 * Switching workspaces does NOT do anything on the wire by itself —
 * it just changes what every `useActiveWorkspaceId()` consumer sees
 * on the next render, and reactive Convex queries re-subscribe with
 * the new arg. There is no global page reload.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'dohc.activeWorkspaceId'

type Ctx = {
  /** undefined ⇒ the caller's personal workspace (the v0 default). */
  activeWorkspaceId: string | undefined
  /** Pass undefined / null / '' to switch back to personal. */
  setActiveWorkspaceId: (id: string | null | undefined) => void
}

const ActiveWorkspaceContext = createContext<Ctx | null>(null)

export function ActiveWorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeWorkspaceId, setStateValue] = useState<string | undefined>(() => {
    // SSR-safe: only read localStorage in the browser.
    if (typeof window === 'undefined') return undefined
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw && raw.length > 0 ? raw : undefined
    } catch {
      return undefined
    }
  })

  const setActiveWorkspaceId = useCallback((next: string | null | undefined) => {
    const clean = next && next.length > 0 ? next : undefined
    setStateValue(clean)
    try {
      if (clean === undefined) window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, clean)
    } catch {
      /* private mode etc. — silently best-effort */
    }
  }, [])

  // Cross-tab sync: a switch in another tab updates this one too.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setStateValue(e.newValue && e.newValue.length > 0 ? e.newValue : undefined)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = useMemo(
    () => ({ activeWorkspaceId, setActiveWorkspaceId }),
    [activeWorkspaceId, setActiveWorkspaceId],
  )

  return (
    <ActiveWorkspaceContext.Provider value={value}>
      {children}
    </ActiveWorkspaceContext.Provider>
  )
}

/** Read the current active workspaceId (undefined ⇒ personal). */
export function useActiveWorkspaceId(): string | undefined {
  const ctx = useContext(ActiveWorkspaceContext)
  if (!ctx) {
    throw new Error(
      'useActiveWorkspaceId() requires <ActiveWorkspaceProvider> in the tree',
    )
  }
  return ctx.activeWorkspaceId
}

/** Read both the value and the setter (for the switcher UI). */
export function useActiveWorkspace(): Ctx {
  const ctx = useContext(ActiveWorkspaceContext)
  if (!ctx) {
    throw new Error(
      'useActiveWorkspace() requires <ActiveWorkspaceProvider> in the tree',
    )
  }
  return ctx
}
