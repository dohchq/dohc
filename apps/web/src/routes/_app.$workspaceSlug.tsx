import { createFileRoute } from '@tanstack/react-router'
import { CloudShell } from '@/cloud/CloudShell'

// Cloud workspace access. The path param is the WORKSPACE ID (the
// desktop's workspace UUID becomes the cloud workspace id verbatim);
// pretty slugs are future cloud-naming work. The file keeps its
// `$workspaceSlug` name so the route path stays stable for that work.
export const Route = createFileRoute('/_app/$workspaceSlug')({
  component: WorkspacePage,
})

function WorkspacePage() {
  const { workspaceSlug } = Route.useParams()
  return <CloudShell workspaceId={workspaceSlug} />
}
