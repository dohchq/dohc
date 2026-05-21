import { createFileRoute } from '@tanstack/react-router'
import { getSignInUrl } from '@workos/authkit-tanstack-react-start'

// Derives the redirect URI from the request's host so dev + prod work
// without env-var changes. WorkOS's allowed-redirect-URI list needs the
// callback URL configured per environment.
export const Route = createFileRoute('/api/auth/sign-in')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url)
        const returnPathname = url.searchParams.get('returnPathname') ?? undefined
        const redirectUri = `${url.protocol}//${url.host}/api/auth/callback`
        const signInUrl = await getSignInUrl({
          data: { returnPathname, redirectUri },
        })
        return new Response(null, {
          status: 307,
          headers: { Location: signInUrl },
        })
      },
    },
  },
})
