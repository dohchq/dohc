import { useCallback, useMemo } from 'react'
import {
  useAuth as useAuthKit,
  useAccessToken,
} from '@workos/authkit-tanstack-react-start/client'

// Bridge AuthKit's React state into the shape Convex's
// <ConvexProviderWithAuth> expects: { isLoading, isAuthenticated,
// fetchAccessToken }.
//
// Critical: `useAccessToken()` returns { getAccessToken, loading } — an
// async function that resolves the current (possibly-refreshed) JWT.
// Reading a sync `accessToken` field would always be undefined.
//
// Also critical: `isLoading` must be true while either AuthKit is
// checking the session OR the access-token bootstrap hasn't finished —
// otherwise Convex fires queries with no token and gets UNAUTHENTICATED.
export function useAuthForConvex() {
  const { user, loading: authLoading } = useAuthKit()
  const { getAccessToken, loading: tokenLoading } = useAccessToken()

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken: _ }: { forceRefreshToken: boolean }) => {
      if (!user) return null
      try {
        const token = await getAccessToken()
        return token ?? null
      } catch {
        return null
      }
    },
    [user, getAccessToken],
  )

  return useMemo(
    () => ({
      isLoading: authLoading || tokenLoading,
      isAuthenticated: !!user,
      fetchAccessToken,
    }),
    [authLoading, tokenLoading, user, fetchAccessToken],
  )
}
