import { createFileRoute, redirect } from '@tanstack/react-router'

// R1 — legacy `/shared/<shareId>` redirects to `/w/me/shared/<shareId>`.
// Preserves existing share links from before R1. See `_app.p.$atomId.tsx`
// for the parallel atom-URL redirect rationale.
export const Route = createFileRoute('/_app/shared/$shareId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$wsId/shared/$shareId',
      params: { wsId: 'me', shareId: params.shareId },
      replace: true,
    })
  },
  component: () => null,
})
