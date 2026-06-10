import { createFileRoute } from '@tanstack/react-router'
import { SharedAtomPage } from '@/cloud/SharedAtomPage'

// Direct shared-atom URL (`/r/<atomId>`). Resolves through
// GET /shared/atoms/:atomId on the cloud API: a signed-in session is
// required and the share must still be live (revoked → 403, gone →
// 404) — SharedAtomPage renders the calm denied/missing states.
// Deliberately OUTSIDE the /_app session gate so the denied state can
// explain itself instead of bouncing straight to the splash.
export const Route = createFileRoute('/r/$atomId')({
  component: SharedPage,
})

function SharedPage() {
  const { atomId } = Route.useParams()
  return <SharedAtomPage atomId={atomId} />
}
