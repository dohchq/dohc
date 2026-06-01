# Authorization boundaries

dohc's safety properties are enforced server-side in Convex and must not
be weakened by rebrand or UI work.

## Identity

- The authenticated identity is derived server-side via
  `ctx.auth.getUserIdentity()`. Functions NEVER accept a `userId` (or any
  user identifier) as an argument for authorization from browser/client
  callers.
- There is intentionally **no** unauthenticated request → data escape.
  An earlier env-gated dev bypass was removed because Convex public
  functions are raw internet endpoints on a shared deployment.
- Server-to-server bridges may use explicit identity/workspace arguments only
  behind a shared server secret. The current reviewed exception is
  `hocuspocusAuth.checkAtomAccess`, which requires
  `HOCUSPOCUS_CONVEX_SERVER_TOKEN` and is called by the Hocuspocus service,
  not by the browser. Its `userId` comes from the signed collab token `sub`,
  while `workspaceId` is the owner workspace encoded in the Hocuspocus
  document name; Convex performs the final share/org ACL decision.

## Ownership

- Every atom, folder, entity, and share is scoped to a `workspaceId`
  derived from the authenticated identity (`requireWorkspace`).
  `workspace` is a domain concept, not legacy brand — it stays.
- A user cannot read or mutate another workspace's data. Sharing is the
  only cross-user path and is consent-gated.

## Locks and gates

- A user lock on an atom refuses all agent writes at the data layer; the
  user's own editor still works. Hocuspocus forwards signed `actorKind` into
  the Convex ACL bridge so collaborative writes follow the same rule.
- The skill-turn gate and inline-window caps are structural, fail-closed
  invariants. The supporting tests (`skillTurnGate`, `strictKeystone`,
  `r3InlineWindow`, `windows`, `atomShares`) must keep passing.

## HTML atoms

- Author HTML is sanitized before interpolation into a trusted,
  server-built shell. The shell is fixed and never resolves inline
  `{= }` formulas (the walk skips STYLE/script ancestors). CSP:
  `style-src 'unsafe-inline'; font-src data:` with no network fetches.

## Views

- `.views/` source atoms are interface code, not data sources. Inline
  `{key: value}` examples inside view source are skipped by capture,
  live values, and imports/exports scans.
- View code runs in a sandboxed iframe with `sandbox="allow-scripts"` and
  without `allow-same-origin`, forms, popups, or top-navigation powers.
- The iframe receives no Convex URL, cookies, access token, workspace id
  authority, or raw cross-workspace handles. It talks to dohc through a
  small `postMessage` SDK.
- The parent bridge validates message shape before dispatch and attaches
  `packageRoot` plus the active workspace itself. Browser code cannot
  choose an identity or widen its workspace.
- Convex still derives identity server-side with `requireWorkspace`; atom
  reads still go through atom/folder access checks.
- Imports/exports windows remain the only cross-workspace field-sharing
  path exposed to views.
- View discovery, source reads, SDK rows, and bundles are capped. Oversized
  views fail with diagnostics instead of rendering.
- Agent handoffs and proposed patches from view code are reviewed actions,
  not direct document writes; the parent emits a lightweight local
  `dohc:view-action` event for those operations.
