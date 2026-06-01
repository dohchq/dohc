import { createFileRoute } from '@tanstack/react-router'

// Primary Graph surface. The shell owns rendering so switching between
// Agent, Files, and Graph does not remount shared app state.
export const Route = createFileRoute('/_app/w/$wsId/graph')({
  component: () => null,
})
