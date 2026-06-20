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

## Sites

- Sites are normal website folders in the user's local workspace. dohc can
  detect, serve, and preview them, but a site folder does not become a
  privileged dohc integration merely by existing.
- Static preview serves files from the selected site root through a loopback
  server with path-containment checks. Dev and build previews run explicit
  package scripts only when the user starts that mode.
- Site preview iframes may render loopback preview URLs. Top-level desktop
  navigation remains locked down; external sharing/publishing is a separate
  dohc Cloud decision.
- Source-like files (`.ts`, `.tsx`, `.js`, `.css`, `.json`, `.html`) collab
  as plain text by extension. They are not hidden state and are not scanned
  as inline atom prose.
- `@dohc/sdk` access is separate from merely rendering a site. The first
  preview bridge supports bounded local file reads through the desktop
  `readWorkspaceText` IPC path; browser code cannot choose an identity or
  widen the workspace. Collection reads such as
  `dohc.collections.get(...).list()` are intentionally deferred beyond Phase 1
  and must use server-side ACL checks as the actual authorization boundary
  before shipping. The preview bridge controls when browser code can call the
  feature, but it is not the trust boundary: callers cannot bypass server-side
  identity, workspace-scope, share, lock, or review-gate enforcement by
  manipulating browser state. Writes, cloud access, sharing, and publishing
  must continue through explicit workspace, share, lock, and review-gate
  checks.
