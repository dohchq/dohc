/**
 * Active workspace context (org-plan §5 Phase B + §9 switcher + R1).
 *
 * Source of truth for "which workspace is the UI currently viewing".
 * The personal workspace is the implicit default — `activeWorkspaceId`
 * is `undefined` when viewing personal (the back-compat path: any
 * Convex query/mutation called without `activeWorkspaceId` resolves
 * to the caller's personal workspace via `requireWorkspace(ctx)`).
 *
 * Resolution order (R1):
 *   1. URL path `/w/<wsId>/...` — the canonical source of truth.
 *      The literal `me` sentinel resolves to `undefined` (personal).
 *   2. localStorage fallback — for legacy URLs (`/p/<id>`, `/shared/<id>`,
 *      bare `/`) where the URL doesn't carry workspace context.
 *   3. `undefined` (personal default) if neither is set.
 *
 * setActiveWorkspaceId still writes localStorage. In a follow-up
 * commit it will ALSO navigate so URL stays authoritative; until then
 * the URL parser will pick up the next page navigation naturally.
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
import { useLocation } from '@tanstack/react-router'

const STORAGE_KEY = 'dohc.activeWorkspaceId'

/** Literal URL sentinel that means "the caller's personal workspace."
 *  Stable across browsers + devices (vs exposing the WorkOS subject id). */
const ME_SENTINEL = 'me'

/** Pull the `/w/<wsId>/...` prefix out of a pathname. Returns `undefined`
 *  if the pathname doesn't carry the prefix (legacy URLs). The literal
 *  `me` sentinel also returns `undefined` — the API layer never needs
 *  to know the subject id; that's the whole point of `requireWorkspace`
 *  defaulting to personal when no `activeWorkspaceId` is passed. */
export function workspaceIdFromPathname(
  pathname: string,
): string | undefined {
  const m = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname)
  if (!m) return undefined
  const raw = decodeURIComponent(m[1])
  if (raw === ME_SENTINEL || raw.length === 0) return undefined
  return raw
}

type Ctx = {
  /** undefined ⇒ the caller's personal workspace (the v0 default OR the
   *  `/w/me/...` sentinel — both resolve to "personal" at the API). */
  activeWorkspaceId: string | undefined
  /** Pass undefined / null / '' to switch back to personal. */
  setActiveWorkspaceId: (id: string | null | undefined) => void
}

const ActiveWorkspaceContext = createContext<Ctx | null>(null)

export function ActiveWorkspaceProvider({ children }: { children: ReactNode }) {
  // localStorage fallback — only used when the URL doesn't carry a
  // `/w/<wsId>/` prefix. SSR-safe (only reads in the browser).
  const [storageValue, setStorageValue] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw && raw.length > 0 ? raw : undefined
    } catch {
      return undefined
    }
  })

  // URL-derived value. Re-derives on every navigation. Independent of
  // localStorage; takes precedence when present.
  const { pathname } = useLocation()
  const urlValue = workspaceIdFromPathname(pathname)

  const setActiveWorkspaceId = useCallback((next: string | null | undefined) => {
    const clean = next && next.length > 0 ? next : undefined
    setStorageValue(clean)
    try {
      if (clean === undefined) window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, clean)
    } catch {
      /* private mode etc. — silently best-effort */
    }
    // (Follow-up commit: ALSO navigate so the URL becomes the authoritative
    // signal immediately. For this foundation commit, the URL picks up
    // the next page navigation naturally + localStorage carries until then.)
  }, [])

  // Cross-tab sync: a switch in another tab updates this one's storage
  // fallback. (URL is per-tab — cross-tab navigation is the user's job.)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setStorageValue(
        e.newValue && e.newValue.length > 0 ? e.newValue : undefined,
      )
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // URL wins over localStorage. URL absent ⇒ fall back. Either may resolve
  // to undefined (personal, the back-compat path).
  const activeWorkspaceId = urlValue ?? storageValue

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
