import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/$workspaceSlug/a/$appRef')({
  component: () => null,
})
