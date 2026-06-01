import { createFileRoute } from '@tanstack/react-router'

// Primary Agent surface. Vestigial like the other `_app` children:
// the shell reads the URL and renders the app without remounting.
export const Route = createFileRoute('/_app/w/$wsId/agent')({
  component: () => null,
})
