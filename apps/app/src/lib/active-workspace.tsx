/**
 * Active workspace context.
 *
 * The provider stores which workspace the shell is operating in. It no
 * longer derives workspace identity from user-facing URLs: document
 * URLs use `/<workspaceSlug>/<pageSlug>-<atomId>`, and the backend
 * resolves the atom id to its owner workspace before authorizing it.
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
  /** undefined means the caller's personal workspace. */
  activeWorkspaceId: string | undefined
  /** Pass undefined / null / '' to switch back to personal. */
  setActiveWorkspaceId: (id: string | null | undefined) => void
}

const ActiveWorkspaceContext = createContext<Ctx | null>(null)

export function ActiveWorkspaceProvider({ children }: { children: ReactNode }) {
  const [storageValue, setStorageValue] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw && raw.length > 0 ? raw : undefined
    } catch {
      return undefined
    }
  })

  const setActiveWorkspaceId = useCallback(
    (next: string | null | undefined) => {
      const clean = next && next.length > 0 ? next : undefined
      setStorageValue(clean)
      try {
        if (clean === undefined) window.localStorage.removeItem(STORAGE_KEY)
        else window.localStorage.setItem(STORAGE_KEY, clean)
      } catch {
        // private mode etc.; the in-memory state is still updated.
      }
    },
    [],
  )

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

  const activeWorkspaceId = storageValue

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

export function useActiveWorkspaceId(): string | undefined {
  const ctx = useContext(ActiveWorkspaceContext)
  if (!ctx) {
    throw new Error(
      'useActiveWorkspaceId() requires <ActiveWorkspaceProvider> in the tree',
    )
  }
  return ctx.activeWorkspaceId
}

export function useActiveWorkspace(): Ctx {
  const ctx = useContext(ActiveWorkspaceContext)
  if (!ctx) {
    throw new Error(
      'useActiveWorkspace() requires <ActiveWorkspaceProvider> in the tree',
    )
  }
  return ctx
}
