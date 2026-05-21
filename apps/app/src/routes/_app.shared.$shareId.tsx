import { createFileRoute } from '@tanstack/react-router'

// sharing-v1 1a — `/shared/<shareId>` opens an atom shared WITH the
// current user (read-only in 1a). Vestigial like the other `_app`
// children: the layout shell reads the shareId from the path
// (useLocation) and renders SharedAtomView in the main content.
export const Route = createFileRoute('/_app/shared/$shareId')({
  component: () => null,
})
