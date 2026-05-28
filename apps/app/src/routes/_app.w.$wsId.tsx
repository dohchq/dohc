import { createFileRoute, Outlet } from '@tanstack/react-router'

// R1 (org-plan multiplayer-and-h-followups §5) — workspace-scoped
// routes live under `/w/<wsId>/...`. This layout exists so child routes
// (`.index`, `.p.$atomId`, `.shared.$shareId`, `.r.$atomId`) inherit
// the `$wsId` param.
//
// Vestigial like the other `_app` children: the `_app` shell renders
// the whole UI and reads the URL via `useLocation` / `Route.useParams`.
// This file only declares the route + param so the URL is valid + the
// `$wsId` segment is captured.
export const Route = createFileRoute('/_app/w/$wsId')({
  component: () => <Outlet />,
})
