import { createFileRoute } from '@tanstack/react-router'

// R1 — `/w/<wsId>/shared/<shareId>`. Vestigial: the `_app` shell
// reads the URL and renders SharedAtomView. Mirrors
// `_app.shared.$shareId.tsx`.
export const Route = createFileRoute('/_app/w/$wsId/shared/$shareId')({
  component: () => null,
})
