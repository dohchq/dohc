import { createFileRoute, redirect } from '@tanstack/react-router'

// R1 — legacy `/p/<fileId>` URL redirects to `/w/me/p/<fileId>`.
//
// Preserves bookmarks + share-this-link flows that pre-date R1.
// The redirect is permanent in intent (the new URL is canonical), but
// we use a regular redirect so TanStack's internal routing handles it
// cleanly. `me` is the personal-workspace sentinel; the URL parser
// resolves it to `activeWorkspaceId === undefined` (the API back-compat
// path) — see `workspaceIdFromPathname` in `lib/active-workspace.tsx`.
export const Route = createFileRoute('/_app/p/$atomId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$wsId/p/$atomId',
      params: { wsId: 'me', atomId: params.atomId },
      replace: true,
    })
  },
  component: () => null,
})
