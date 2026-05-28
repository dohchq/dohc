import { createFileRoute } from '@tanstack/react-router'

// R1 — `/w/<wsId>` (workspace home, no atom open). Vestigial: the
// `_app` shell renders the whole shell and shows its "pick a page"
// empty state when no atom is in the URL. Mirrors `_app.index.tsx`.
export const Route = createFileRoute('/_app/w/$wsId/')({
  component: () => null,
})
