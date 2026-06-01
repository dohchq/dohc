import { createFileRoute } from '@tanstack/react-router'

// Primary Views surface. The shell owns rendering so switching between
// Agent, Files, Views, and Graph does not remount shared app state.
export const Route = createFileRoute('/_app/w/$wsId/views')({
  component: () => null,
})
