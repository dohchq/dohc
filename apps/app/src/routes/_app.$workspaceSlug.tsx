import { createFileRoute, Outlet } from '@tanstack/react-router'

// Workspace-slug routes live under `/<workspaceSlug>/...`, e.g.
// `/ice`, `/ice/files`, `/ice/features-<atomId>`. The shell reads the
// URL with useLocation; these files declare the route shape.
export const Route = createFileRoute('/_app/$workspaceSlug')({
  component: () => <Outlet />,
})
