import { createFileRoute } from '@tanstack/react-router'

// Files home with no specific atom selected. Opening a document still
// uses `/w/<wsId>/p/<atomId>` so file links stay stable across renames.
export const Route = createFileRoute('/_app/w/$wsId/files')({
  component: () => null,
})
