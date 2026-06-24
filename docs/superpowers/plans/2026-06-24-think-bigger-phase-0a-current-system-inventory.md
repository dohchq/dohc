# Think Bigger Phase 0A: Current System Inventory And Decisions

Status: in progress
Date: 2026-06-24
Branch: `codex/think-bigger-p0a-inventory`

Subagent evidence:

- Storage/Y.Doc explorer completed.
- Filesystem/sync explorer completed.
- Collaboration/chat explorer completed.

## Purpose

This note anchors the Think Bigger workspace-engine plan to the codebase that
exists today. The goal is not to admire the current architecture or replace it
wholesale. The goal is to identify what is already strong enough to become
part of the new substrate, what must be generalized, and what Phase 0 should
prove before the larger versioned workspace engine expands.

## Files And Modules Inspected

Core contracts and domain:

- `packages/workspace-contracts/src/domain.ts`
- `packages/workspace-contracts/src/backend.ts`
- `packages/workspace-contracts/src/events.ts`
- `packages/workspace-core/src/changeSet.ts`
- `packages/workspace-core/src/watcher.ts`
- `packages/workspace-core/src/paths.ts`
- `packages/workspace-core/src/metadata.ts`

Local filesystem, history, sync:

- `packages/workspace-fs/src/scan.ts`
- `packages/workspace-fs/src/watch.ts`
- `packages/workspace-fs/src/watchEvents.ts`
- `packages/workspace-fs/src/diff.ts`
- `packages/workspace-fs/src/apply.ts`
- `packages/workspace-fs/src/metadata.ts`
- `packages/workspace-history/src/changeSetStore.ts`
- `packages/workspace-history/src/conflictResolution.ts`
- `packages/workspace-history/src/mergeMarkdown.ts`
- `packages/workspace-sync/src/batchedSync.ts`
- `packages/workspace-sync/src/cloudSync.ts`
- `packages/workspace-sync/src/collaborationPolicy.ts`

Desktop integration:

- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/ipc/bridgeContract.ts`
- `apps/desktop/src/workspaces/workspaceWatcher.ts`
- `apps/desktop/src/workspaces/workspaceActivity.ts`
- `apps/desktop/src/workspaces/historyRestore.ts`
- `apps/desktop/src/workspaces/workspaceFiles.ts`
- `apps/desktop/src/workspaces/workspaceAssets.ts`
- `apps/desktop/src/workspaces/workspaceSearch.ts`
- `apps/desktop/src/workspaces/WorkspaceRegistry.ts`
- `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
- `apps/desktop/src/renderer/ImportExportDialog.tsx`
- `apps/desktop/src/renderer/FileInspector.tsx`
- `apps/desktop/src/renderer/ShareDialog.tsx`
- `apps/desktop/src/renderer/WorkspaceManagementDialog.tsx`
- `apps/desktop/src/renderer/AgentPanelView.tsx`
- `apps/desktop/e2e/workspace-direct-disk.spec.ts`

Cloud workspace API and Postgres:

- `packages/workspace-postgres/src/db/schema.ts`
- `packages/workspace-postgres/src/policy/authorize.ts`
- `packages/workspace-postgres/src/repositories/atoms.ts`
- `packages/workspace-postgres/src/repositories/assets.ts`
- `packages/workspace-postgres/src/repositories/events.ts`
- `packages/workspace-postgres/src/services/backend.ts`
- `services/workspace-api/src/server.ts`
- `services/workspace-api/src/routes/files.ts`
- `services/workspace-api/src/routes/sync.ts`
- `services/workspace-api/src/routes/collab.ts`
- `services/workspace-api/src/auth/session.ts`
- `services/workspace-api/src/realtime/events.ts`

Y.Doc collaboration:

- `services/hocuspocus/src/server.ts`
- `services/hocuspocus/src/hooks.ts`
- `services/hocuspocus/src/persistence.ts`
- `services/hocuspocus/src/postgres-acl.ts`
- `services/hocuspocus/src/projection.ts`
- `services/hocuspocus/src/semantic-api.ts`
- `services/hocuspocus/src/auth.ts`
- `services/hocuspocus/src/doc-name.ts`
- `apps/desktop/src/renderer/collab/collabSession.ts`
- `apps/desktop/src/renderer/collab/useCollabDoc.ts`

Agent surfaces:

- `apps/desktop/src/agents/AgentDriver.ts`
- `apps/desktop/src/agents/AgentIntegration.ts`
- `apps/desktop/src/agents/AgentProcessDrivers.ts`
- `apps/desktop/src/agents/AgentSessionManager.ts`
- `packages/mcp/src/tools.ts`
- `services/agent-sandbox/src/workspaceMount.ts`
- `services/agent-sandbox/src/diffCapture.ts`

Database and structured file paths:

- `packages/workspace-core/src/databases.ts`
- `packages/workspace-postgres/src/services/databaseFiles.ts`

Performance and QA:

- `packages/performance/src/budgets.ts`
- `apps/desktop/playwright.config.ts`
- root `package.json`

## Current Primitives

### Workspace

Today a workspace exists in multiple forms:

- A local workspace root on disk, with `.dohc/manifest.json` as the local
  identity manifest.
- A desktop registry entry in the user's dohc home.
- A cloud workspace row in Postgres.
- A sync manifest at `.dohc/sync-manifest.json` for cloud baseline binding.

Current strengths:

- Workspace paths are treated as relative paths, never absolute caller data.
- Workspace root choice rejects filesystem root and the home directory itself.
- `.dohc`, `.git`, and `node_modules` are hidden from watchers/tree/search.
- `.dohc` metadata symlink escape is guarded in agent-run and MCP paths.
- Cloud sync manifest binds to server URL and remote workspace ID to prevent
  accidental mass-delete against the wrong server/workspace.

Current gap:

- Within the Phase 0 systems and paths reviewed here, there is no single
  `WorkspaceObject` registry. Files have table IDs and paths, Y.Doc document
  names use atom IDs, sync manifests carry per-path IDs, but this inventory did
  not find a unified object identity layer for files, folders, chats, versions,
  projections, history moments, captures, secrets, and shares.
- Folders exist in the Postgres schema, but this Phase 0 inventory did not find
  an active repository/API path using them as first-class durable primitives.
- Live primitives exist in the reviewed workspace-event, share, member, invite,
  capture, and event routes, but this inventory did not find a durable entity
  model or unified workspace-object registry for arbitrary business objects
  across files, chats, and history.
- Captures are first-class workspace-scoped objects in the product contract:
  every atom, folder, entity, share, and capture must resolve within a
  workspace boundary.

### Files

Current file-like objects are:

- `atom`: text-ish files with `body`, `kind`, `revision`, and optional
  `ydoc_state_key`.
- `asset`: binary/blob files with object storage, sha, media type, and
  revision.
- `database`: SQLite-backed files with row operations and version conflict
  handling.

Current strengths:

- `WorkspaceFile` includes `workspaceId`, `path`, `kind`, `contentType`,
  `revision`, and `updatedAt`.
- `WorkspacePath` rejects absolute paths and `..` segments.
- Atom and asset writes use optimistic revision checks.
- Repository write paths use row locks for update/delete/rename decisions.
- Atom revisions are recorded for cloud-side text changes.
- Paths are already recognized as mutable aliases in some places: Hocuspocus
  collab document names are keyed by stable `atoms.id`, not atom path.

Current gap:

- Path remains the primary join key in many local and sync paths.
- Stable object identity does not yet survive every local rename/move/restore
  path as a first-class primitive.
- Current file contracts do not carry version ID, projection contract, file
  policy, materialization policy, or content-driver metadata.
- Phase 0 target rule: rename/move is alias transfer over stable object identity.
  The current backend sync contract may still reject and decompose cross-folder
  rename as a legacy transport behavior, but that decomposition must not become
  canonical semantics. The adapter must either preserve the same
  `WorkspaceObjectId` across the alias transfer or quarantine the event as
  ambiguous.

### Canonical Rich Docs And Y.Doc

Today rich markdown collaboration is handled by Hocuspocus/Y.Doc:

- Collab token minting happens through workspace-api.
- Tokens contain server-derived user/workspace identity, actor kind, and authz
  version.
- Hocuspocus document names encode `workspaceId` and stable `atomId`.
- Y.Doc updates are persisted as sequential updates plus snapshots.
- Body cache projection writes markdown back to the atom body through a retry
  job queue.

Current strengths:

- Atom `body` is explicitly documented in contracts as a derived markdown/text
  cache, not raw Y.Doc state.
- Hocuspocus checks token workspace against document workspace.
- Hocuspocus rechecks read/write ACL and stale authz version.
- Hocuspocus validates Yjs update payloads before persistence.
- Awareness state is sanitized.
- Projection jobs include workspace ID, atom ID, projection hash, schema
  version, state vector, and ydoc sequence.
- Semantic API writes have operation IDs for idempotency.

Current gap:

- Y.Doc persistence and ordinary file history are separate timelines.
- Projection jobs update atom revision/body cache fields but are not yet part of
  a shared versioned event substrate.
- The new engine must treat Y.Doc as one content driver, not flatten every rich
  doc into raw markdown replacement.
- Ordinary text/file-driver bodies and rich-doc projection bodies must be
  treated as separate contracts. P0B owns ordinary text/file-driver writes only.
  For rich docs, `atoms.body` is not canonical; it remains a derived Markdown
  cache/projection of Y.Doc state.
- P0B must not add new direct `atoms.body` rich-doc writes or treat the derived
  Markdown/body cache as canonical. Rich-doc versioning needs a later Y.Doc
  content-driver lane that explicitly connects `document_states`,
  `atoms.ydoc_state_key`, projection sequence metadata, and derived
  `atoms.body` cache updates.
- Hocuspocus persistence is outside the main Drizzle workspace schema and is
  not visibly tied into `document_states` or `atoms.ydoc_state_key` in the
  inspected active code.

### Local File Watch And History

Today the desktop uses watcher-backed normal folders:

- Chokidar watches the workspace root.
- Events settle into batches.
- SQLite sidecars collapse into one base database change.
- Batches become `ChangeSet` records in `.dohc/history`.
- Small-text before/after snapshots are captured for history and restore.
- Direct disk edits are covered by an E2E spec.

Current strengths:

- Normal files on disk are already the primary affordance.
- Direct disk file creation appears in the explorer while dohc is running.
- Watchers ignore `.dohc`, `.git`, `node_modules`, editor noise, and symlinks.
- Watcher stop flushes pending changes to avoid dropping last-save history.
- History records are inspectable JSON files.
- History index writes are serialized and atomic.
- Corrupt history records are skipped without bricking the whole timeline.
- Restore verifies the live file state before writing/deleting.

Current gap:

- History is local change-set history, not a versioned workspace engine.
- History records are per workspace root and path, not stable object/version
  records.
- There is no named version registry, version fork point, or version-specific
  materialized view.
- Conflict preservation exists in sync and merge helpers, but not as a unified
  conflict object model with base/current/incoming per version merge.
- `workspace_events`, local `.dohc/history`, `atom_revisions`, and
  Hocuspocus update sequences are separate histories with no shared ordering or
  version identity.
- Edits made while the desktop app is closed are visible when the real folder
  is listed again, but no clear local-only startup reconciliation path was
  found that records those closed-period edits into `.dohc/history`.
- MCP tools can record history directly while the desktop watcher may also see
  the same filesystem mutation. A de-duplication/ownership rule was not found.
- The blocker is a missing shared reconciliation model across
  `workspace_events`, local `.dohc/history`, watcher-observed writes, and MCP
  direct-history writes: startup must replay closed-period edits into history,
  and every recorder needs one persisted ownership/dedupe rule before the same
  mutation can be safely observed through multiple paths.

### Sync And Conflict Preservation

Today cloud sync uses manifest diff and merge behavior:

- Push scans disk against `.dohc/sync-manifest.json`.
- Push sends create/update/delete/rename operations with expected revisions.
- Push rebuilds the baseline from the T0 scan and per-op server results, not a
  post-push rescan.
- Pull writes remote dirty conflicts beside local files as `<path>.conflict`.
- Pull does not clone-clobber the workspace.
- Conflict files are local-only and never uploaded.

Current strengths:

- No silent overwrite of dirty local work on pull.
- Mid-push and mid-pull races are covered by tests.
- Deterministic stress tests cover two desktop workspaces converging.
- Same-file offline conflicts preserve both sides without Git markers.
- Sync refuses server binding mismatch.
- Sync treats unauthorized cloud sessions as expired, not "connected".

Current gap:

- Conflicts are path artifacts today, not first-class workspace objects.
- Clean merge and conflict preservation are split between sync behavior and
  `mergeMarkdown`; they are not attached to named versions.
- Conflict redaction/materialization policy for secret-backed files is not
  implemented.
- Direct API/sync atom writes appear to check workspace membership and
  revisions, but not the same lock/share/effective-policy path that
  Hocuspocus uses.
- P0A aligned `scanWorkspaceFiles` with the shared ignored-segment policy for
  `.dohc`, `.git`, and `node_modules`, matching watcher/export/search segment
  skips. Remaining scan-policy gates for P0C are oversized-file handling,
  secret/materialization policy, and database-object sync boundaries.
- Database-object sync has exactly one canonical lane: structured database
  operations owned by the database object. The shared `classifyDatabaseFile` /
  `databaseSyncStrategy` selector in `@dohc/workspace-core` is the source of
  truth for scan, watch, sync, export, and search routing; components must not
  re-implement the lane decision independently. Raw `.sqlite`/`.db` files may be
  tracked only as explicit ordinary file artifacts with separate identity and no
  database-object binding. The same database object must never be represented in
  both lanes, or it can double-apply, partially-sync, or bypass
  operation-level policy. Before database-object routing is enabled for an
  existing workspace, every pre-existing raw database artifact must be
  deterministically classified by that same shared selector, then upgraded
  in-place into the database-object lane or quarantined as a raw artifact with a
  distinct identity in one uninterrupted transition. The cutover is a
  single-claim transaction with an explicit `database-object-upgrade-in-flight`
  state: claim the path/object identity, record the in-flight state with the
  chosen lane, selector version/result, claim owner, monotonic lease generation,
  heartbeat time, and lease expiry, write the tombstone or quarantine marker for
  the raw lane, durably install the database-object binding, then expose the
  database-object lane and mark the claim complete. Scans and watchers that see
  the in-flight state must read and honor the persisted lane decision and
  selector metadata, resuming the claimed upgrade path instead of reclassifying
  the artifact from scratch. If the heartbeat is stale past the TTL, a later
  scan/watch worker may atomically advance the lease generation and reclaim the
  claim, but it must keep the persisted selector decision and chosen lane intact
  and retry from the claim step. They must not reclassify the same path while the
  old raw artifact remains at the database-object path, and failed claims leave
  the path in its previous visible lane until the transition can be retried from
  the start with the same persisted selector decision. Any failure while writing
  the tombstone/quarantine marker, installing the binding, or exposing the new
  lane must roll back to the prior visible state or leave a durable retryable
  claim that hides nothing from the previous lane. A path must never be
  half-applied, temporarily invisible, or routable by both scan/watch/sync lanes;
  failed or reclaimed transitions restart from the claim step with the same
  selector rules and lease metadata.

### Search

Today search exists in two forms:

- Desktop content search uses ripgrep JSON streaming with bounded batches and
  renderer-safe paths.
- MCP search walks files directly with limits and hidden/internal skips.

Current strengths:

- Desktop search uses `@vscode/ripgrep`, argv arrays, `--`, hidden mode, and
  built-in exclusions after user globs.
- Search results are revalidated through path rules before crossing to the
  renderer.
- Search has performance budgets for first result, completion, and keystroke
  jank.

Current gap:

- Search is not yet a shared indexed substrate.
- Search is not policy-filtered across versions, chats, shares, history,
  projections, and secret references.
- MCP search is a bounded linear scan, acceptable for tools but not the
  long-term default search engine.

### Agents

Today agents can work through:

- Desktop-managed Codex app-server and Claude/generic ACP sessions.
- A dohc MCP server rooted at the workspace.
- Normal local filesystem edits.

Current strengths:

- MCP file tools operate on normal workspace files.
- MCP validates paths, rejects `.dohc`, rejects traversal, and checks realpath
  containment against symlink escape.
- MCP records file writes/moves/deletes into history.
- Agent sessions are main-owned; renderer callers do not supply workspace
  root, command, args, or identity.
- Agent probe environment is allowlisted to avoid leaking arbitrary secrets.
- Desktop-managed agent runs set a watcher attribution slot while active.

Current gap:

- Generic external edits by Notepad, Codex CLI, Claude Code, or scripts are
  intentionally only local/device/session changes unless dohc launched or
  tracked the run.
- That is acceptable for file versioning. It is not acceptable for chat
  authorship, where posting must use explicit chat actions.
- The Phase 0 test harness needs a local agent CLI QA wrapper:
  `DOHC_TEST_AGENT_CLI=codex` by default, with Claude compatibility when
  available.
- Agent sandbox flows can mount/copy workspace files and capture diffs, which
  should be considered for P0G local-agent QA but must not become a special
  version-control protocol agents need to understand.

### Chats And Communication

Today dohc has collaboration primitives, but not dohc Chats:

- Hocuspocus awareness supports live editor presence state.
- `workspace_events` exists in Postgres.
- Share, data fragment, member, invite, and event routes exist.
- Agent session UI records messages/items within an agent session.

Current strengths:

- There is already a typed-ish event table in Postgres.
- Sharing and external recipients already exist for files/fragments.
- Hocuspocus can distinguish actor kind in signed collab tokens.
- Existing app shape supports side rails and workspace-scoped UI state.
- Verified-user atom sharing supports `view`/`edit`, revoke/list,
  `/me/shares`, and signed-in shared atom pages.
- Email invites and workspace member listing already exist.
- Data fragments provide copied, recipient-scoped external collaboration
  without granting source-file access.
- Operational notices exist for sync conflicts, cloud disconnect, agent active,
  and update-ready states.

Current gap:

- There is no durable `ChatThread`, `Channel`, `DM`, `ThreadMessage`,
  reaction, read-state, notification, or chat projection model.
- There is no chat action API with explicit human/agent authorship.
- There is no policy-filtered search across chats/files/history.
- There is no canonical chat storage, channel/DM ownership validation,
  participant canonicalization, read-state monotonicity, mention routing,
  channel membership policy, or chat search index.
- Presence is document-awareness only, not workspace/channel presence.
- Notifications do not yet include mentions, DMs, follows, channel
  mute/unmute, per-channel levels, or privacy-filtered payloads.
- Share/data-fragment primitives are useful for external boundaries, but there
  is no external/shared channel model.
- Share revocation now commits the database revoke first, records a retryable
  pending disconnect marker, then calls the configured Hocuspocus admin
  disconnect-by-workspace-user path for the revoked recipient.
- Later sync/awareness/token ACL rechecks remain defense in depth after the
  revocation/effective-policy path has committed.

## Phase 0 Decisions

### 1. Storage Baseline

Decision: Phase 0 should build on the existing workspace packages and add the
missing versioned workspace contracts around them.

Starting points:

- `packages/workspace-contracts` for public TypeScript contracts.
- `packages/workspace-core` for path, change-set, metadata, and shared domain
  helpers.
- `packages/workspace-fs` for scan/watch/materialization/diff.
- `packages/workspace-history` for local history, snapshots, restore, and
  conservative text merge.
- `packages/workspace-sync` for manifest diff, conflict-preserving cloud sync,
  and collaboration policy.
- `packages/workspace-postgres` plus `services/workspace-api` for cloud-backed
  membership, atoms/assets/database files, shares, locks, agent runs, and
  workspace events.
- `services/hocuspocus` for the rich-doc Y.Doc content driver.

Phase 0 should add a minimal versioned text/file store, not rewrite every
storage layer at once.

Minimum new storage concepts for Phase 0:

- `VersionId`
- `WorkspaceObjectId`
- file object record with stable ID and current path alias
- version record with fork-point metadata
- per-version text snapshot for one ordinary file driver
- durability/history event that can point at workspace, object, version, path,
  and actor-neutral provenance
- conflict record with base/current/incoming text, chosen/current visible value,
  status, and resolution metadata for one file

Backfill and cutover rule:

- During Phase 0, new versioned file objects are created lazily for the first
  ordinary file paths touched by the engine proof.
- First touch must be an atomic alias-ownership claim, not the stable identity
  itself: within one transaction or serialized store operation, normalize the
  workspace/path alias, reserve it with a unique
  `(workspace_id, normalized_path)` alias owner, and either create the new
  `WorkspaceObjectId` or return the already-owned object. No check-then-write
  path may create a second object for the same path.
- The alias table maps path aliases to stable `WorkspaceObjectId` records.
  Renames and moves change alias ownership, not object identity.
- For existing path-keyed `.dohc/history` entries, the cutover process resolves
  the current path alias first, then applies any rename/move entries it can
  prove from history before attaching the entry to a `WorkspaceObjectId`.
- History attachment, alias resolution, rename/move handling, and
  `WorkspaceObjectId` creation use the same atomic owner lookup. If the alias
  owner changes while attaching history, retry against the current owner or
  quarantine the entry as ambiguous. Concurrent rename/move observations must
  never fork a second object for the same alias.
- `workspace_events`, `atom_revisions`, and Y.Doc sequence metadata remain
  authoritative for their current object types. When they reference a file-like
  path, the migration stores both the old path reference and the resolved object
  ID so old audit trails stay inspectable.
- If two historical paths plausibly map to one object, keep one canonical object
  with path aliases and record the ambiguity as a migration note. If a history
  entry cannot be resolved, quarantine it as an orphaned history record instead
  of inventing ancestry.
- Cutover is complete for a file only after reads, writes, history restore,
  compare, and search all use the same workspace/object/version identity.

### 2. Filesystem Interposition

Decision: Phase 0 uses watcher-backed normal folders over the existing local
workspace root.

This preserves dohc's current philosophy:

```text
It is just files on your computer.
Any editor or agent can change them.
dohc notices and records history.
```

What this choice provides:

- Direct compatibility with Notepad, shell scripts, Codex CLI, Claude Code,
  and normal editors.
- Immediate reuse of existing watcher, search, history, restore, sync, and E2E
  infrastructure.
- A real proof that dohc can improve source control without forcing agents to
  learn dohc-specific version-control commands.

What this choice does not provide yet:

- Strong per-process or per-agent secret enforcement after plaintext is
  materialized.
- Lazy hydration/mount semantics.
- Complete copy-on-write version views.
- Kernel-level guarantees against arbitrary local processes.

Phase 0 implementation requirement:

- Startup reconciliation must record closed-period local edits into history,
  not only show them in the file tree.
- Scan/sync inclusion policy must be brought to parity with watcher, export,
  and search before dohc-native filesystem claims are made.
- Pending implementation clarification: the following ledger flow is the Phase 0
  target, not current behavior. Today `workspaceWatcher`, MCP/tool writes, and
  `createChangeSetStore` still rely on local generated record IDs and do not yet
  implement a shared `writeObservationId` insert/claim/reclaim flow.
- Startup reconciliation, MCP direct-history recording, and watcher observation
  need one shared persisted mutation ledger per workspace with one owner per
  physical write. The authoritative mutation/event ID is created from a
  per-write observation token, either a UUID or durable monotonic sequence, by a
  single atomic insert-or-claim step on the unique workspace-scoped key
  `(workspaceId, writeObservationId)`. For dohc-controlled writes, including MCP
  tool writes and any future direct engine write path, that pending ledger row
  must be inserted or claimed before the disk mutation is committed; the write
  proceeds only with the reserved workspace-scoped `writeObservationId`.
  `createChangeSetStore` records the supplied token and must not mint one after a
  physical write already happened. For external writes from Notepad, shell tools,
  or agents that occur outside dohc, startup reconciliation and
  `workspaceWatcher` first compute a stable pre-mint claim key for the physical
  write, then atomically claim or attach to that row before history emission. The
  key is workspace-scoped and derived only from stable workspace/object identity
  inputs: normalized path, content digest, file size, and the strongest local
  file identity available for the platform, such as device/inode when present.
  Observed mtime/ctime windows are stored only as correlation metadata on the
  row; they must not participate in compare-and-swap identity or token minting.
  That key is not displayed as the public `writeObservationId`; it exists only
  to make two live observers race through one compare-and-swap/tie-breaker
  before either can mint the token. The winner mints and reserves the durable
  `writeObservationId`; losers re-read the row and reuse the winner's token. If
  the stable claim key collides ambiguously, the row must be marked
  conflict/pending-review instead of minting competing history entries. The
  ledger row stores workspace ID, pre-mint claim key, write observation ID,
  normalized path, content digest, file size, observed mtime/ctime window, local
  file identity, and observer/tie-breaker metadata. Timestamp fields remain
  correlation-only once the pre-mint claim has chosen a winner; path, digest,
  size, and local file identity are stable identity inputs, but they still cannot
  authorize minting a replacement token after a row exists. MCP tools create the
  ID only for the
  physical write they initiate, or carry an existing `writeObservationId` when
  they are recording a write already observed by the watcher or startup
  reconciliation. The first observer of an external physical write is the only
  subsystem allowed to win the pre-mint claim: startup reconciliation for
  closed-period edits and `workspaceWatcher` for live raw filesystem events.
  Later observers reattach by querying the workspace-scoped ledger for the stable
  claim row or a non-terminal row whose stored `writeObservationId` was supplied
  by the event, MCP operation, startup reconciliation cursor, or persisted
  pending work item. Observers must claim the existing pending row by its stable
  claim key or by `(workspaceId, writeObservationId)` and reuse that exact token
  before emitting history or finalizing failure. The claimed token is persisted
  in the workspace-scoped ledger row as the durable `writeObservationId`;
  `createChangeSetStore`, `workspaceWatcher`, and the MCP tools flow must all
  read, create, or reclaim that same row before emitting user-visible history.
  `createChangeSetStore` records the supplied ledger token with the history
  entry; it does not mint a new token for an already claimed physical write. The
  ledger row must include a durable recovery state plus an exclusive recovery
  owner/lease, compare-and-swap token, or equivalent atomic claim for `pending`
  rows: `pending` after claim/insert, `emitted` only after the history record ID
  is durably written, and `failed`/`abandoned` when
  recovery conclusively gives up with an explainable error. A crash after claim
  but before history emission must leave a `pending` row that startup
  reconciliation or the next recorder can atomically claim, resume using the
  same `writeObservationId`, complete, or transition to `failed` with a durable
  reason; it must not be skipped as already handled, replaced with a new token,
  or left in limbo. Only the actor that wins the pending-row recovery claim may
  emit history or mark failure; losers must re-read the row and skip it after
  detecting another owner. The claim-and-emit sequence may instead be one atomic
  transaction, but if it is split across `workspaceWatcher`, MCP tools, and
  `createChangeSetStore`, retries must reconcile `pending` rows and either
  complete/finalize the same claim's missing history entry or mark that claim
  failed before advancing.
  If two recorders observe the same workspace and exact write observation ID,
  exactly one history entry is created; matching path, digest, size, or mtime
  alone is insufficient.

Long term, this should evolve into a managed filesystem projection or mount.
The P0R Rust spike decides how soon that boundary should move native.

### 3. Secret Boundary

Decision: Phase 0 must not track plaintext `.env` as an ordinary text file.
Current active desktop/MCP/sync/search/export paths do not enforce that policy
uniformly yet; this is a Phase 0 implementation requirement, not a current
system guarantee.

Until the secret-backed file driver exists:

- A shared secret-path classifier must identify `.env` and similar secret files.
- History must exclude plaintext secret snapshots by default.
- Search must exclude secret file contents by default and may only return
  explicit redacted metadata once policy allows a secret-backed driver.
- Export must exclude plaintext secrets by default; user-facing export bundles
  must either omit them or include redacted placeholders.
- Sync must exclude plaintext secret files by default. Future secret sync must
  use encrypted secret references, not ordinary text-file snapshots.
- Existing process env and credential stores remain outside normal workspace
  history.
- dohc must not claim per-agent secret enforcement for arbitrary local
  processes reading materialized plaintext.

The long-term target remains stronger than Git:

- Secret-backed files become first-class workspace objects.
- Their content can be versioned as encrypted references and permissioned
  materialization, not searchable plaintext.
- Users can share secrets intentionally through dohc policy.

### 3a. Write-Policy Parity

Decision: Phase 0 must close the policy parity gap before relying on direct
API/sync writes for versioned workspace behavior.

Current evidence:

- Hocuspocus write access checks membership/share/lock through
  `services/hocuspocus/src/postgres-acl.ts`.
- Direct atom/asset API and sync writes use workspace membership plus revision
  checks in `packages/workspace-postgres`, but a richer effective policy path
  was not found.
- `packages/workspace-postgres/src/policy/authorize.ts` and
  `services/workspace-api/src/routes/shared.ts` are not shared write-policy
  evaluators for the new versioned write paths; they do not by themselves prove
  Hocuspocus-equivalent lock/share enforcement.
- Current `authorize` and shared route handling still center on userId-based
  membership/share checks and do not yet normalize every caller into the shared
  principal envelope with separate delegated grant/resource scope described
  below.

Phase 0 implication:

- P0B/P0C write paths must either use Hocuspocus-equivalent semantics from
  `services/hocuspocus/src/postgres-acl.ts` through a shared effective policy
  resolver or explicitly prove matching lock/share/protected-path enforcement.
- The shared effective-policy resolver must derive actor identity only from the
  authenticated server session/token. Browser/client-provided user ids are
  untrusted hints and must never select authorization scope. The resolver must
  normalize every non-browser caller into the same canonical principal envelope,
  while keeping authenticated actor identity and delegated grant/resource scope
  as separate policy inputs. User sessions, service accounts, share-link
  requests, and other server-auth principals retain their actor type and
  server-derived identity; delegated access carries its own grant id, target
  resource, visibility scope, expiry/revocation state, and lock/share
  capabilities. The Hocuspocus ACL path in
  `services/hocuspocus/src/postgres-acl.ts`, the write-policy flow in
  `packages/workspace-postgres`, and `services/workspace-api/src/routes/shared.ts`
  must consume that same server-authenticated principal envelope plus any
  delegated grant scope and produce the same workspace-scoped
  lock/share/protected-path decision. A client-provided user id may help
  correlate logs, but it must never override the server principal, select a
  different grant scope, or widen access for service-account, share-link, or
  browser requests.
- If the policy evaluator is unavailable or indeterminate, writes must fail
  closed.

### 4. Merge Scope

Decision: Phase 0 supports honest 3-way text/file merge only.

Use the existing conservative line merge as a baseline:

- Clean same-file non-overlap can merge.
- Overlap conflicts preserve both sides.
- Large files may conflict rather than risking slow/wrong merge.
- No semantic code merge promise.
- No raw Git conflict markers as the primary UX.

The Phase 0 conflict object must preserve:

- base
- current
- incoming
- chosen/current visible value
- conflict status and resolution metadata

### 5. Chat/File Philosophy

Decision: Files are file-native. Chats are action-native.

Files:

- Humans and agents edit normal files.
- Local writes are captured without distinguishing human vs agent unless dohc
  has trusted run context.
- Versioning/history is actor-neutral when attribution is uncertain.

Chats:

- Humans and agents post through chat actions.
- Chat authorship must be explicit, because shared social spaces need to show
  whether `<User Name>` or `<User Name>'s agent` posted.
- Chat projections into `.dohc/chats/v1-<digest>.md` are read-only generated
  context for humans and agents. Editing the projection does not mutate the
  canonical chat.
- Because `.dohc` is a reserved hidden namespace, chat projections are surfaced
  through the engine projection/search API, not by expecting the existing normal
  file watcher/tree/search loop to scan `.dohc`. If a later UI needs a visible
  filesystem-facing chat view, it should be a separate read-only virtual mount
  or indexed surface that still writes back only through chat actions.

This does not violate the dohc philosophy. It makes IO object-type appropriate:
files are edited as files, chats are posted as actions.

### 6. Rust Kernel Boundary

Decision: Run P0R before deep engine implementation. Do not block P0A on Rust,
but do not let TypeScript-only convenience accidentally define the long-term
kernel.

P0R should spike:

- scan/reconcile a workspace root
- hash changed candidates
- emit structured timing events
- compare sidecar daemon, JSON-RPC/IPC, localhost HTTP, N-API, and
  Electron/Tauri-style command bridges
- benchmark against equivalent TypeScript scan/hash/reconcile fixtures
- document packaging, CI, logs, crash recovery, and upgrade behavior

Recommended default until P0R returns:

- Define contracts in TypeScript/shared schemas.
- Keep Phase 0 storage semantics small and Rust-ready.
- Use existing TypeScript packages for P0B/P0C only if P0R recommends "Rust
  later" or if the Rust bridge is not yet reliable enough for MVP development.

## Current-To-Target Delta

| Area | Current | Target | First PR |
| --- | --- | --- | --- |
| Identity | File IDs exist per table; paths still dominate local flows. | Stable `WorkspaceObjectId` for ordinary text/file-driver path aliases first; chat, rich-doc, projection, and full history identity later. | P0B |
| Versions | No named workspace versions. | Main plus one named version with fork point. | P0B |
| History | `.dohc/history` change sets and cloud atom revisions. | Durable version-aware events plus meaningful moments. | P0C |
| Filesystem | Watcher-backed normal folder. | Phase 0 watcher-backed; later managed projection/mount. | P0C, P0R |
| Merge | Sync conflicts plus `mergeMarkdown`. | Version compare/merge/conflict object preserving base/current/incoming. | P0D |
| Rich docs | Y.Doc canonical, body cache derived. | Y.Doc as content driver under engine contracts. | after P0D |
| Chats | Events/shares/awareness, no chat model. | Channels, DMs, messages, read state, reactions, notifications, search. | P0E then PR 12+ |
| Search | Ripgrep/MCP file search. | Indexed, policy-filtered search across files/chats/versions/history. | P0F |
| Secrets | Env/credentials outside normal workspace; no secret driver. P0C owns the shared classifier plus exclusion/materialization gates. | Phase 0 adds secret-aware policy gates; the later secret-backed file driver adds encrypted refs and user-controlled materialization. | P0C for policy; driver after Phase 0 |
| Agents | Normal files/MCP; managed runs can be attributed. | Agent file edits stay normal; agent chat posts explicit. | P0G/P0E |
| Policy | Hocuspocus has richer lock/share ACL than direct API/sync writes. | Shared fail-closed effective policy across all write/read/projection surfaces. | P0B/P0C |
| Scan policy | P0A aligned ignored segments across scan/watch/export/search; size, secret, and materialization policy remain split. | One inclusion/materialization policy for scan/watch/export/search/sync. | P0C |

## Recommended First PR Boundaries

### PR P0R: Rust Workspace Kernel Spike

Run before P0B. P0R must complete and record the Rust bridge recommendation
before any P0B engine work begins.

Write set:

- New spike package or design prototype under a clearly marked experimental
  location.
- Benchmark fixtures and result notes.
- Execution-log P0R entry.

No production behavior should depend on P0R until the spike recommendation is
recorded, but P0B must wait for that recommendation before defining storage hot
paths.

### PR P0B: Minimal Versioned Text Store

Owns the first actual engine contract.

Likely write set:

- `packages/workspace-contracts`
- `packages/workspace-core` or a new focused `packages/workspace-engine`
- Tests for version isolation, stable object ID, wrong workspace/version denial

Do not touch chat UI, cloud sync, or rich Y.Doc behavior in this PR.

Before P0B can merge, it must remain strictly ordinary text/file-driver storage
outside the rich-doc Y.Doc path. Direct `atoms.body` writes, Y.Doc cache writes,
and derived rich-doc projection writes are not in P0B scope.

### PR P0C: File/API Write Capture And History

Owns the normal-file loop.

Likely write set:

- `packages/workspace-fs`
- `packages/workspace-history`
- desktop workspace activity/watch glue
- E2E for edit -> history -> restore

Must preserve existing direct-disk E2E behavior.

Must include write-policy parity tests if it introduces new direct write paths
or routes existing API/sync writes into the versioned engine.

P0A already made `scanWorkspaceFiles` skip the same ignored segments as watcher,
export, and search. P0C must finish the remaining scan-policy work:

- Cover oversized files with regression tests.
- State the raw-SQLite-file versus structured database-operation sync
  contract.
- Own the secret/materialization gate for normal files: one shared secret-path
  classifier must apply to scan, watcher, startup reconciliation, history,
  search, export, sync, and local materialization. Until a secret-backed file
  driver exists, plaintext `.env`-style materializations are excluded from ordinary
  history/search/export by default and must be represented as private,
  policy-marked file entries rather than normal searchable text snapshots.

Must add startup reconciliation for closed-period edits or explicitly split
that as a blocker PR before P0C can satisfy the Phase 0 gate.

### PR P0D: Compare, Clean Merge, Conflict Preservation

Owns Git-grade basics for one text driver.

Likely write set:

- engine merge/conflict module
- conflict tests and property-style corpus
- minimal UI/API for inspect/resolve

Must not use raw conflict markers as the primary user-facing state.

### PR P0E: Minimal Chat Linked To File

Owns the smallest chat proof.

Likely write set:

- chat contracts/schema/actions
- one channel/workspace chat or thread path
- link to stable file object ID
- read-only text projection
- simple desktop side rail

Must make agent chat authorship explicit as `<User Name>'s agent`.

Should start with chat contracts/storage and pure validators before UI:

- workspace-scoped channel/thread/message/link/read-state types.
- channel-backed vs DM-backed thread ownership XOR.
- sorted/deduped DM participants.
- monotonic read state.
- server-derived human/agent authorship.
- link to stable workspace object/file ID.

### PR P0F: Search And Policy Smoke

Owns first cross-surface search/policy proof.

Likely write set:

- search contracts/index smoke
- policy filtering for files/chat links/projections
- workspace switch/request token regression
- `.env` exclusion/redaction smoke

## P0A Recommendation

Proceed with a stacked Phase 0 sequence:

1. Finish the `00` Mega Plan And Readiness Scaffold review.
2. Merge `00` or keep P0A stacked against it until it lands.
3. Land P0A inventory/decisions.
4. Run P0R Rust spike.
5. Start P0B only after P0R records whether the Phase 0 kernel should be Rust
   now or TypeScript with Rust-ready contracts.

This still honors "go big or go home". It does not compromise the long-term
engine. It prevents the project from accidentally boiling the ocean in a way
that cannot survive the current product, tests, and performance expectations.

## Open Risks

- `docs/security/authz-boundaries.md` still describes Convex-era boundaries,
  while current code uses Postgres/workspace-api/Hocuspocus. This should be
  refreshed in a focused docs/security PR or folded into the first
  security-sensitive implementation PR.
- Direct API/sync writes need lock/share/effective-policy parity with
  Hocuspocus before the versioned engine can treat them as equally protected.
- The `permissions` table exists, and the generic workspace auth helper is
  active for membership checks, but P0A did not identify a
  permission-specific repository or policy implementation using that table.
- Foreign-key constraints are largely deferred in the current schema, so
  referential integrity remains application-enforced.
- There are older split/prunable worktrees in the repository environment.
  They should not be touched by Phase 0 lanes unless explicitly needed.
- The current local history can attribute desktop-managed agent runs, but
  generic external agent/editor writes must remain generic local edits.
- Search and sync already have performance-sensitive code. Any engine changes
  must add measurements instead of relying on unit tests alone.
- Scan/sync still needs early filesystem hardening for oversized-file handling,
  secret detection, and materialization behavior.
- Startup reconciliation for edits made while dohc is closed needs proof.
- Chat work is a new substrate, not a UI-only feature; it needs storage,
  actions, policy, read state, notification, and search contracts.
