import { createFileRoute } from '@tanstack/react-router'

// Bare `/` is the signed-in workspace shell using the user's current
// active workspace. Canonical workspace home URLs are `/<workspaceSlug>`.
export const Route = createFileRoute('/_app/')({
  component: () => null,
})
