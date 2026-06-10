import { createFileRoute } from '@tanstack/react-router'
import { SharedAtomPage } from '@/cloud/SharedAtomPage'

// Legacy shared URL shape, kept only as an alias of /r/$atomId: the param
// is treated as an atom id and resolves through the same
// GET /shared/atoms/:atomId endpoint (session required; revoked → 403,
// gone → 404). Pre-pivot Convex links carried a share-ROW id, which is NOT
// migrated — the Convex store is deleted, so those old links 404 here.
// Living under /_app keeps it behind the signed-in gate: signed-out
// recipients see the splash, sign in, and land back here.
export const Route = createFileRoute('/_app/shared/$shareId')({
  component: SharedPage,
})

function SharedPage() {
  const { shareId } = Route.useParams()
  return <SharedAtomPage atomId={shareId} />
}
