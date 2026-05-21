import { createFileRoute } from '@tanstack/react-router'

// D4.33 — `/p/<fileId>` (an atom is open). Vestigial: the `_app`
// layout renders the whole shell and reads the open fileId from the
// path (useLocation). This child only declares the route + param so
// the URL is valid and navigable.
export const Route = createFileRoute('/_app/p/$atomId')({
  component: () => null,
})
