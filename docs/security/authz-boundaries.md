# Authorization boundaries

dohc has three trust boundaries: the Electron main process, the workspace
engine daemon, and the opt-in sync services.

## Electron

- The renderer is untrusted input. IPC handlers call `assertTrustedSender` and
  parse payloads with the Zod contracts in
  `apps/desktop/src/ipc/bridgeContract.ts`.
- Main resolves workspace scope with `requireWorkspace`. Engine operations also
  require the workspace's live capture through `requireEngineCapture`.
- The renderer does not provide trusted user, workspace, or agent identity.
  Agent attribution comes from a main-process run slot.
- Asynchronous renderer state must carry a workspace or request guard.

## Workspace engine

- The desktop launches one authenticated daemon over inherited stdio.
- The daemon derives workspace scope from its handle table.
- Files, moments, versions, chats, search, secrets, and Y.Doc sessions remain
  inside that handle.
- Workspace-relative paths pass lexical validation and realpath containment.
- `resolveWorkspaceMetadataDir` refuses a symlinked `.dohc/` directory.
  Settings and policy files must be regular files no larger than 256 KiB.
  Invalid settings fall back to safe defaults, including an enabled workspace
  engine.

The effective policy parser lives in
`packages/security-contract/src/effectivePolicy.ts`. Search, export, capture,
and relay filtering share the path-classification contract.

## MCP and agents

- The MCP server receives one workspace root and cannot widen it.
- Mutating tools use the same path guards as the desktop.
- Agent attribution comes from a main-process run slot or daemon-owned actor
  context.
- A client-supplied author label does not grant agent authority.

## Sync services

- Better Auth provides the session through `services/workspace-api`.
- `services/sync-relay` validates that session against the same Postgres
  database and secret.
- The relay derives the user ID and workspace ownership server-side.
- Share filters use positive allowlists and return indistinguishable denials.
- Presence remains ephemeral and does not enter the replicated log.
- Secret-classified paths cannot enter grants, operations, or blobs.

The local desktop path does not depend on these services.
