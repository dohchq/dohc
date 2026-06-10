# Authorization boundaries

dohc's safety properties are enforced server-side (`services/workspace-api`
with Better Auth, `services/hocuspocus`) and in the Electron main process —
never in renderer or browser code. They must not be weakened by rebrand or
UI work. (The pre-pivot edition of this document is in git history; this
edition describes the desktop-first/Postgres architecture.)

## Identity

- The authenticated identity comes ONLY from a validated Better Auth session
  (browser cookie, or the Bearer token issued by the desktop device-flow
  login). `createSessionActorResolver` in
  `services/workspace-api/src/auth/session.ts` is the production resolver;
  routes never accept a `userId` (or any user identifier) from the caller as
  authorization input.
- There is intentionally **no** unauthenticated request → data escape, and
  no env-gated dev bypass in shipping routes.

## Ownership and sharing

- Every atom, asset, database, and share is scoped to a `workspaceId`;
  membership is enforced server-side (`assertWorkspaceMember`) on the
  workspace routes. A user cannot read or mutate another workspace's data.
- Shared links are the only cross-user path. `GET /shared/atoms/:atomId`
  requires a session, resolves capability from the live share row at request
  time (revoked → 403, deleted → 404), and grants access to exactly that
  atom — nothing else in the workspace.
- A lock on a file refuses agent writes at the data layer; the user's own
  editing still works.

## Collaboration (Hocuspocus)

- Connections present signed collab tokens; the document name encodes the
  owner workspace, and `postgres-acl` makes the final access decision
  server-side. A caller can never choose identity or workspace.
- Proves: `services/hocuspocus/src/auth.test.ts`, `doc-name.test.ts`,
  `postgres-acl.test.ts` (which also asserts no legacy-backend code paths).

## Desktop IPC

- The sandboxed renderer reaches the system only through the typed preload
  bridge (`apps/desktop/src/preload.ts`); every channel is named in
  `CHANNELS` and validated in the main process against the zod
  `bridgeContract`. No raw `ipcRenderer`, no Node in the renderer
  (`scripts/check-architecture-debt.mjs` enforces both structurally).
- Workspace-relative paths from any client (IPC, MCP, sync) go through
  `validateUserWritePath` in `packages/workspace-core` (traversal, reserved
  `.dohc`, Windows alias tricks), and file serving additionally enforces
  realpath containment (`apps/desktop/src/workspaces/workspaceAssets.ts`).

## Apps and agents

- `.apps/` source folders are interface code, not data. Their files are
  visible and editable like any other source; nothing in them executes with
  workspace authority.
- An app must pass the `services/app-tester` checks — including the static
  trust check, which rejects legacy view-era code patterns among other
  gates — and an explicit user trust grant (`grantAppTrust`, main-process
  validated) before it can be a trusted, broadly-writing app.
- Local agents go through the stdio MCP server (`packages/mcp`): every path
  argument is validated, database queries are read-only and bounded, and
  agent writes are attributed in history. Boundary-crossing actions require
  user confirmation; nothing is auto-trusted.
