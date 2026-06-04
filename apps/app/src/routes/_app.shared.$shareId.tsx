import { createFileRoute } from '@tanstack/react-router'

// Legacy/shared grant URL. New copy-link behavior prefers
// `/<workspaceSlug>/<pageSlug>-<atomId>`, but existing share links keep
// rendering through the app shell.
export const Route = createFileRoute('/_app/shared/$shareId')({
  component: () => null,
})
