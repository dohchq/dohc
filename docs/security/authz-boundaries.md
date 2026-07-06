# Authorization boundaries

dohc is a local-first desktop product built on the workspace engine
(`packages/workspace-engine`, per-workspace SQLite under `.dohc/engine/`).
The Convex-era server enforcement this document used to describe is retired
(Think Bigger User Decision 6; see the
[legacy salvage audit](../superpowers/plans/2026-07-06-think-bigger-0n3-legacy-salvage-audit.md)).
This page states where authorization is enforced today.

## Trust boundary: the Electron main process

- Every IPC handler in `apps/desktop/src/main.ts` verifies the sender
  (`assertTrustedSender`) and parses its payload against the zod contracts in
  `apps/desktop/src/ipc/bridgeContract.ts`. The renderer is untrusted input.
- The renderer never supplies identity or authorization facts. Workspace
  membership of a request is resolved in main via the workspace registry
  (`requireWorkspace`); engine surfaces additionally gate on the workspace's
  live engine capture (`requireEngineCapture`).
- Agent attribution is server-side: a change is attributed to an agent only
  when main's own agent-run slot is active — never from client-declared
  authorship (actor-neutral capture principle).

## Workspace scoping and the filesystem

- All file paths are workspace-relative and pass two independent guards:
  lexical validation (traversal, encoding, reserved names) and realpath
  containment (a symlink inside the workspace cannot escape it). The desktop
  and MCP (`packages/mcp/src/tools.ts`) each enforce both.
- `.dohc/` metadata is defended in depth: a symlinked `.dohc/` or settings
  file is refused, settings files are size-capped, and unreadable settings
  resolve to safe defaults — including the workspace-engine default-on rule
  (a planted symlink cannot silently change a workspace's posture).
- Engine stores are per-workspace databases; there is no cross-workspace
  query surface. One workspace's moments, chats, versions, and search index
  are unreachable from another workspace's handles.

## Policy, search, export

- The effective-policy resolver (`packages/workspace-engine/src/effectivePolicy.ts`,
  `.dohc/files.toml` / `.dohc/visibility.toml`) is the single input for
  what search indexes and what export may leave the workspace. Secret-backed
  files (the `.env` driver) keep values out of moments, search, and export.

## MCP

- The MCP server is scoped to the `--workspace` root it was launched with and
  cannot widen it. Mutating tools resolve paths through the same dual guards
  and record through the engine (the desktop watcher captures physical
  writes); engine chat tools require the workspace's engine to be enabled and
  a workspace manifest identity.

## Cloud (opt-in, retiring per audit Phase D)

- The legacy cloud stack (`services/workspace-api`, Hocuspocus, Postgres) is
  reachable only through explicit opt-in cloud sync with bearer-token auth;
  nothing on the local default path depends on it. Collab tokens are minted
  only for shared cloud workspaces with a signed-in session and fail closed
  to local editing. Arc 0P rebuilds sync engine-native; the rebuilt server
  owns its own authorization design note when it lands.

Security rule unchanged from the beginning: client callers never provide
user identity or workspace authorization; the process that owns the data
derives the actor and scopes every operation to a workspace.
