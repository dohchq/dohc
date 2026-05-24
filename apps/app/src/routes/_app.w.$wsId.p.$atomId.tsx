import { createFileRoute } from '@tanstack/react-router'

// R1 — `/w/<wsId>/p/<atomId>`. Vestigial: the `_app` shell reads the
// URL (`useLocation` + the new `/w/<wsId>/...` pattern) and renders
// AtomView in the main content. Mirrors `_app.p.$atomId.tsx`.
export const Route = createFileRoute('/_app/w/$wsId/p/$atomId')({
  component: () => null,
})
