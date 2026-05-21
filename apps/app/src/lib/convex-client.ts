import { ConvexReactClient } from 'convex/react'

const convexUrl =
  (typeof process !== 'undefined' && process.env?.CONVEX_URL) ||
  import.meta.env?.VITE_CONVEX_URL

if (!convexUrl) {
  throw new Error(
    'CONVEX_URL / VITE_CONVEX_URL is not set. Run `npx convex dev` to provision.',
  )
}

// Singleton React client used by <ConvexProviderWithAuth> in __root.tsx.
// All useQuery/useMutation/useAction hooks read from this instance.
export const convexClient = new ConvexReactClient(convexUrl)
