# dohc Desktop: The Local-First Model

dohc Desktop (`apps/desktop`, Electron) is the primary dohc client. A
workspace is a real folder of real files on the user's disk. Everything else —
history, sync, collaboration, agents — is built on top of that folder and
works with no account. Cloud is additive, never required.

dohc brings git-grade building-collaboration — change sets, history,
attribution, AI-assisted merge — to everyday people. That is why the history,
attribution, and catch-up surfaces described here are core product, not
plumbing: they are what make a folder of files safe to build in together.

## The workspace folder

A workspace is any folder the user creates or attaches
(`apps/desktop/src/workspaces/createWorkspaceFolder.ts`). Files are plain
files; deleting `.dohc/` leaves a perfectly usable directory. First run seeds
`.context/me.md`, a plain-text note the user's agents read.

The desktop tracks known workspaces in a registry JSON under Electron
`userData` (`apps/desktop/src/workspaces/WorkspaceRegistry.ts`,
`registryStore.ts`). A registry entry gains a `remote` binding
(`{ serverUrl, remoteWorkspaceId }`) only after the user explicitly enables
cloud sync. The registry store refuses to overwrite a corrupt or
newer-version registry file rather than collapsing it to empty.

## The `.dohc` sidecar

All dohc metadata lives in one inspectable sidecar directory inside the
workspace. Every file in it is JSON a person can open and read:

| Path | Owner | Contents |
| --- | --- | --- |
| `.dohc/manifest.json` | `packages/workspace-core/src/metadata.ts` | Workspace identity: `workspaceId`, `kind` (`personal` \| `shared` \| `cloud-only`), `mode` (`local-first` \| `cloud-first-local-copy` \| `cloud-only`). Mode is per workspace, never per file. |
| `.dohc/sync-manifest.json` | `packages/workspace-fs/src/metadata.ts` | The cloud-sync baseline (per-file id/revision/sha256 plus the server binding). Deliberately split from the identity manifest — see `docs/architecture/workspace-sync.md`. |
| `.dohc/history/<recordedAtMs>-<id>.json` | `packages/workspace-history/src/changeSetStore.ts` | One change set per file, pretty-printed, plus `index.json`. History is meant to be opened and read. |
| `.dohc/apps-state.json` | `apps/desktop/src/workspaces/appPackage.ts` | Per-app trust and last-test state, fingerprint-bound to the exact tested bytes. |
| `.dohc/agent-runs.json` | `apps/desktop/src/agents/AgentIntegration.ts` | Agent run records (id, agent, start/end, status). |
| `.dohc/databases/<slug>/operations.jsonl` | `packages/workspace-core/src/databases.ts` | Append-only op log for SQLite edits made through dohc. |
| `.dohc/cache/apps/<name>` | `packages/workspace-core/src/apps.ts` | App build output. Cache, never source. |

A present-but-broken manifest is never silently overwritten — it may be the
user's data — and a manifest written by a newer dohc blocks the folder with a
clear reason instead of being downgraded
(`createWorkspaceFolder.ts`, `checkManifest` in `workspace-core`).

## Watcher, settle batching, and history

The desktop watches the workspace folder (chokidar via
`packages/workspace-fs/src/watchEvents.ts`) and debounces raw events into a
quiet-window settle: a batch flushes after 500 ms of quiet, with a hard flush
every `settleMs * 8` so a chatty writer (a database WAL, a long agent run)
cannot starve the window forever. One settled batch becomes one change set —
an agent run touching 18 files is a single unit of history, not 18 entries.

`apps/desktop/src/workspaces/workspaceWatcher.ts` turns each settled batch
into `WatcherEvent`s and records a change set with a human summary. Care is
taken at the edges:

- only a confirmed-absent file (ENOENT/ENOTDIR) records as a delete; a
  transiently unreadable file is still present.
- changes to `.dohc/**` are never recorded (no history of the history).
- SQLite sidecar files (`-wal`, `-shm`) collapse into the database they
  belong to, so history reads "wallet.sqlite changed".

### Attribution

Filesystem edits default to the local user. While an agent run is active
(`ActiveAgentRun` in `workspaceWatcher.ts`, set by
`apps/desktop/src/agents/AgentIntegration.ts`), the batch is attributed to
the agent and linked to its run record in `.dohc/agent-runs.json`. History
answers "who changed this, and as part of what" for human and agent edits
alike.

## File-type UX

Files open in views native to what they are
(`classifyPath` in `packages/workspace-core/src/paths.ts`,
`apps/desktop/src/workspaces/workspaceFiles.ts`): markdown gets an editor,
data and media get viewers, SQLite gets the Database Studio, app sources get
the app view. The e2e proof is `apps/desktop/e2e/fileTypes.spec.ts`.

## Apps as source folders, behind a trust gate

A local app is a visible source folder at `<scope>/.apps/<name>/` with an
`app.json` manifest (`packages/workspace-core/src/apps.ts`). The manifest's
`read`/`write` globs are a ceiling, not a grant: apps are offline
(`network: false`), and writing requires per-user trust. Trust and test
results are persisted in `.dohc/apps-state.json` fingerprint-bound to the
exact manifest + source bytes that were tested
(`apps/desktop/src/workspaces/appPackage.ts`) — editing a trusted app's
source invalidates the decision.

## Database Studio

SQLite files are first-class workspace files. The desktop opens them with
`node:sqlite` — a Node built-in, no native addon, loaded lazily via
`createRequire` so it stays off the launch path
(`apps/desktop/src/workspaces/workspaceDatabase.ts`). Row edits made through
dohc are validated (`validateUserWritePath`) and appended to the op log under
`.dohc/databases/`, so database changes carry history like everything else.

## Local agents over MCP

The agent integration is local-only and stdio-scoped. The dohc MCP server
(`packages/mcp/src/server.ts`) is launched by the user's AI tool (Claude
Code, Codex, …) as a stdio child; desktop Settings shows the copyable
`mcpServers` config snippet (`apps/desktop/src/renderer/settings/DesktopSettings.tsx`).
Stdio means only the configured tool can talk to it — no shared-secret auth
surface to manage.

MCP is deliberately broad for visible workspace files: agents can list,
read, write, search, create directories, move, and delete paths via
`dohc_list_files`, `dohc_read_file`, `dohc_write_file`,
`dohc_search_files`, `dohc_create_directory`, `dohc_move_path`, and
`dohc_delete_path`. Those tools are not markdown-only. They operate on the
same local files the user can touch, while every path still goes through
workspace-core validation and realpath containment, and `.dohc`, `.git`,
`node_modules`, symlink escapes, and hidden dohc internals stay out of the
user-facing surface.

The dohc-aware layer is the point of the server, not a restriction on useful
file access:

- History/provenance: `dohc_list_changes`, `dohc_read_change`, and
  `dohc_sync_now` expose recorded change sets and sync cursors.
- Cloud sync: `dohc_sync_cloud` runs the merge sync engine when the workspace
  is cloud-bound. Standalone MCP reads `dohc-cloud.json` when it can; Desktop
  managed agent sessions inject `DOHC_MCP_CLOUD_*` environment values after
  decrypting safeStorage credentials in the main process. The copyable
  Settings snippet never contains tokens.
- Apps/data: `dohc_create_app`, `dohc_test_app`, `dohc_import_data`, and
  `dohc_query_database` let an agent build/test source-backed apps and query
  visible databases without bypassing app trust or database read bounds.
- Collaboration boundaries: `dohc_share` returns `needs-confirmation` for
  sharing, and `dohc_resolve_conflict` only returns a clean merge when the
  markdown three-way merge is unambiguous.
- Desktop affordance: `dohc_list_workspaces`, `dohc_workspace_status`, and
  `dohc_open_in_dohc` let the agent orient the user in the desktop workspace.

MCP writes record dohc change sets directly. Agent writes made through the
desktop provider process are also attributed via the active-run slot above.
The proofs are `packages/mcp/src/tools.test.ts`,
`apps/desktop/src/agents/AgentProcessDrivers.test.ts`, and
`apps/desktop/e2e/localAgent.spec.ts` (real MCP client over stdio).

## Where cloud fits

Nothing in this document requires a server. When the user connects dohc Cloud
or a self-hosted server, sync and live co-editing layer on top of the same
folder, watcher, and history — see `docs/architecture/dohc-cloud.md` and
`docs/architecture/workspace-sync.md`.
