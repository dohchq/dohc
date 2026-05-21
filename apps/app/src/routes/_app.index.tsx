import { createFileRoute } from '@tanstack/react-router'

// D4.33 — `/` (home, no atom open). The `_app` layout renders the
// whole shell; this child only defines the route. The shell shows
// its "pick a page" empty state when no atom is in the URL.
export const Route = createFileRoute('/_app/')({
  component: () => null,
})
