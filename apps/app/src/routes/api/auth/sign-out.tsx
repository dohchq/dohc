import { createFileRoute } from '@tanstack/react-router'
import { signOut } from '@workos/authkit-tanstack-react-start'

export const Route = createFileRoute('/api/auth/sign-out')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        await signOut()
        const origin = new URL(request.url).origin
        return new Response(null, {
          status: 307,
          headers: { Location: `${origin}/signed-out` },
        })
      },
    },
  },
})
