# dohc Native Filesystem Design

Status: exploratory architecture direction
Date: 2026-06-23

Companion: `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`

## Core thesis

dohc should feel like a normal folder on the user's computer, but that folder
should be backed by a versioned workspace engine.

The user-facing promise:

> Your workspace is just files. Humans and agents can use normal editors,
> terminals, and tools. dohc quietly adds versions, history, sync, lazy
> hydration, permissions, conflict recovery, and safe secrets.

This is the dohc-native version of workspace sync for humans and agents: one
consistent workspace structure across machines and agent environments, with the
safety, versioning, and permission semantics dohc needs.

## Relationship to version control

The filesystem and version control are not separate products.

- The filesystem is how humans, agents, editors, and tools touch a version.
- The version engine records snapshots, ancestry, history, conflicts, and
  recovery underneath.

```text
normal files and folders
  -> live Version
  -> versioned workspace engine
  -> history, merge, sync, permissions, recovery
```

Editing a file saves immediately to the version represented by that folder or
mount. No commit step. No apply step. No special agent protocol.

## Filesystem shape

A dohc workspace should have a normal, obvious folder shape:

```text
~/dohc/personal/
  docs/
  posts/
  apps/
  data/
  code/
```

That folder can represent `Main`.

Named versions can appear as their own folders or mounts:

```text
~/dohc/personal/                         # Main
~/dohc/personal/.versions/q3-plan/       # Q3 Plan version
~/dohc/personal/.versions/agent-try/     # Agent Try version
~/dohc/personal/.versions/client-view/   # Client-facing version
```

These `.versions/<version>/` roots are valid managed version locations only
when the engine creates or resolves them as named-version mounts for the active
workspace. They are not ordinary user-created folders.

The path is an affordance, not the security boundary. The engine still resolves
the active workspace, version, and effective file policy for captured writes.
For raw local filesystem writes, exact process identity is not required; the
write can be reconciled as a local/device/session change.

Reserved namespace collisions fail closed. The importer evaluates the explicit
source-backed policy allowlist before applying reserved-namespace quarantine:
approved policy inputs such as `.dohc/files.toml`, `.dohc/visibility.toml`, and
optional workspace-root `.dohcignore` may be tracked as policy files, while all
other `.dohc/**` content remains reserved engine state. If import, attach,
sync, or a raw filesystem scan finds unmanaged or out-of-contract
`.versions/**`, non-allowlisted `.dohc/**`, or aliases of those names where
dohc expects engine state, dohc must not treat the content as normal workspace
data. Managed `~/dohc/<space>/.versions/<version>/` roots are allowed only when
they are bound to a known workspace/version by the engine. Other reserved
namespace content is quarantined with an explainable record, proposed for a
deterministic collision-proof safe rename outside reserved namespaces, or sent
to manual resolution before the workspace is activated. Safe rename proposals
must never overwrite existing user content; destination names are derived from a
stable sanitized basename plus a workspace-scoped content/id hash, then
reserved atomically at activation time with create-if-absent, `O_EXCL`, or an
equivalent exclusive reservation primitive. A non-atomic check-then-create flow
is not allowed. Activation may proceed only if the reservation succeeds;
reservation failure is a fail-closed collision that stays in quarantine or
manual resolution.
Internal non-allowlisted `.dohc/**` state is never re-ingested as user content,
and unmanaged `.versions` content is never silently promoted into a named version.

Path canonicalization must happen before import, attach, sync, raw filesystem
scan, watcher reconciliation, or policy evaluation. Symlinks, hardlinks,
junctions, bind mounts, aliases, or any equivalent filesystem indirection that
resolves outside the active workspace, crosses into another workspace, or enters
reserved engine state such as `.dohc/**` or unmanaged `.versions/**` must be
rejected or quarantined before capture. Managed `.versions/<version>/` roots are
valid only when the path is already bound to that workspace/version by the
engine. If the engine cannot prove the resolved target and
file identity are inside the active workspace boundary, it fails closed. This
path boundary applies to every file capture that may back an atom, folder,
entity, share, or capture record.
Canonicalization must also be TOCTOU-safe: after a path is resolved, subsequent
stat/read/write/capture work must use the same verified descriptor, handle,
inode/file-id binding, or equivalent identity-bound mechanism. The engine must
not validate one path and then reopen a different path for content. If the
handle identity no longer matches the canonicalized path, workspace, version,
or reserved-namespace decision, the operation is quarantined or rejected.

Identity-light capture is allowed; identity-light commit is not. During
reconciliation, each raw local write must be revalidated against workspace
scope, active locks, folder/atom access, sharing boundaries, skill-turn gates,
and effective policy before it is persisted into version history. Unauthorized
or indeterminate writes must be quarantined or rejected rather than merged.
Authorization/policy resolution is fail-closed: if authoritative workspace
membership, share state, lock state, or effective-policy inputs are stale,
unavailable, or indeterminate, the write remains quarantined and is not
persisted to durability/history until fresh server/engine-derived validation
succeeds.

## Same rules for humans and agents

dohc should not make agents second-class writers.

If an actor can write to a version, the actor can edit files in that version.
The actor can be:

- a human.
- an agent.
- an automation.
- a sync process.
- an import.

The filesystem layer records authorship and provenance, but it does not impose
different write semantics just because the actor is an agent.

For ordinary local filesystem writes, provenance can be device/session-level
rather than agent-level. A user should be able to point an agent CLI, script,
or text editor at the dohc folder without teaching that tool dohc identity
rules. dohc captures the file change; explicit agent authorship is only
required when the agent performs a social/action-native operation such as
posting a chat message.

## Local capture and reconciliation

External edits are not an edge case. They are the core promise.

If a user edits `notes/todo.txt` in a native editor, IDE, terminal editor, shell
script, or agent CLI, dohc should notice the same kind of file change.

Phase 0 should use a normal folder plus reconciliation:

1. **First open/import**
   - Walk the materialized workspace tree.
   - Apply file policy.
   - Assign stable object IDs.
   - Store path, file identity where available, size, mtime, content hash, and
     version/base metadata.

2. **While dohc is running**
   - Use OS file watching for create/modify/delete/rename events.
   - Debounce noisy save sequences.
   - Stat and hash changed candidates.
   - Append captured tracked changes to the durability log. Secret-backed
     writes are included only as encrypted references/envelopes or broker
     metadata, never plaintext secret content.
   - Coalesce them into meaningful history moments.

3. **When dohc starts after being closed**
   - Run a reconciliation pass before declaring the workspace clean.
   - Walk metadata for the materialized tree.
   - Compare against the last known index.
   - Hash only files whose metadata or identity changed, plus suspicious cases.
   - Detect creates, edits, deletes, and likely renames/moves.
   - Record each result as a local/device/session change in the version bound to
     the edited path or mount at capture time, or deterministically inferred
     from persisted mount metadata during restart reconciliation.
   - If version binding is ambiguous, quarantine and require explicit user
     resolution; never fall back to the current active version.

4. **Periodic audit**
   - Recheck parts of the tree over time to recover from missed watcher events,
     crashes, filesystem quirks, clock skew, or external sync tools.

5. **Remote/cloud reconciliation**
   - If cloud state changed while local files also changed, compare both sides
     against the common base.
   - Clean merges can apply automatically.
   - Conflicts preserve base/current/incoming instead of using last-writer-wins.

This should be optimized, not naive. dohc should not read and hash every byte
of every file on every launch unless policy or corruption recovery requires it.
Use cached metadata, platform file IDs where available, content hashes for
changed candidates, batching, background work, and visible status such as
"Reconciling workspace..." for large trees.

## Lazy hydration

New machines and cloud agents should see the workspace tree immediately.

The tree should be available before all content is local:

```text
docs/
apps/
data/
code/
```

Content hydrates when needed:

- a user opens a file.
- an agent reads a file.
- search needs full content.
- a build needs source files.
- an app preview needs assets.
- a folder is pinned offline.

The system should support explicit materialization:

```text
pin docs/**
pin apps/finance/**
pin code/kernel/**
```

Materialization state must be legible. Users and agents should be able to tell
whether a subtree is local, lazy, virtual, or pinned. Policy schema, status
reporting, and UI must use `virtual` as the canonical label for a
non-materialized path that remains addressable through dohc APIs.

## API-native access

The filesystem is the default interface, but not the only interface.

The same workspace should be accessible through API calls for cloud agents,
browser runtimes, in-memory sandboxes, and "no real filesystem" environments:

```text
read(workspaceId, versionId, path)
write(workspaceId, versionId, path, bytes, {
  precondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash | expectedAbsent,
  targetObjectId: required for overwrite; omit only when expectedAbsent is used,
  idempotencyKey
})
delete(workspaceId, versionId, path, {
  precondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash,
  targetObjectId,
  idempotencyKey
})
rename(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash,
  sourceObjectId,
  destinationPrecondition: expectedAbsent,
  idempotencyKey
})
move(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash,
  sourceObjectId,
  destinationPrecondition: expectedAbsent,
  idempotencyKey
})
replace(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash,
  sourceObjectId,
  destinationPrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash,
  destinationObjectId,
  idempotencyKey
})
list(workspaceId, versionId, path)
stat(workspaceId, versionId, path)
search(workspaceId, versionId, query)
watch(workspaceId, versionId, path)
snapshot(workspaceId, versionId)
diff(workspaceId, versionAId, versionBId)
merge(workspaceId, sourceVersionId, targetVersionId, {
  precondition: exactly one of expectedTargetSnapshot | expectedTargetVersionEtag,
  idempotencyKey
})
restore(workspaceId, versionId, pointInTime, {
  precondition: exactly one of expectedCurrentCheckpoint | expectedVersionEtag | expectedSnapshotId,
  idempotencyKey
})
```

This answers the API-native workspace requirement. The file mount and the API
are peer views over the same versioned workspace engine. APIs may use a
validated bound session instead of repeating `workspaceId`/`versionId` in every
call, but every read, write, list, stat, search, watch, snapshot, diff, merge,
and restore request must resolve inside exactly one workspace and, where
content is versioned, exactly one version. Cross-workspace path or version
references fail closed before filesystem or storage access.

`write(workspaceId, versionId, path, bytes, ...)` is never an unconditional
overwrite. It must carry a causal precondition such as the expected base
version, etag, content hash, or an absence assertion for creates.
Create and overwrite calls must be explicit: `expectedAbsent: true` means
"create only if no object exists at this path" and must omit `targetObjectId`.
Overwrite must provide `targetObjectId` for the intended existing object plus
exactly one causal freshness precondition such as `expectedEtag`,
`expectedContentHash`, or `expectedBaseVersion`. `targetObjectId` binds object
identity so delete/recreate substitution cannot satisfy a path-only overwrite,
but it is not a freshness guard by itself. If the precondition or target object
does not match the current workspace/version/path state, the API returns a
conflict response rather than applying the mutation. Exactly one precondition
mode may be supplied per write. Supplying no causal precondition, omitting
`targetObjectId` for overwrite, or combining incompatible guards such as
`expectedAbsent` with `expectedEtag` fails closed with a validation/conflict
response and does not mutate canonical content.

Conflict responses are secret-safe envelopes by default: they return only
opaque object/version handles, hashes, operation kinds, and minimal conflict
status. Policy decisions, explanatory metadata, redacted previews, and full
current/incoming/restored/secret-backed bytes are materialized only through the
server-side authorization path for that caller and resolution session.

`delete(...)`, `rename(...)`, and `move(...)` are write-producing filesystem
mutations. Delete requires the path's `targetObjectId`. Rename and move require
the source `sourceObjectId` plus exactly one source freshness precondition and an
idempotency key. Rename/move with
`destinationPrecondition: expectedAbsent` is create-at-destination only. Atomic
overwrite uses `replace(...)`, which carries `sourceObjectId`,
`destinationObjectId`, source freshness precondition, destination freshness
precondition, and idempotency key. That gives temp-file-then-rename saves a
one-call atomic replace path without allowing a path-only overwrite.

`merge(workspaceId, sourceVersionId, targetVersionId, ...)` is also
write-producing and must carry a causal precondition for the target version.
If the target version changed since the caller's expected base, the merge
returns a deterministic conflict response instead of applying stale output.

API-originated write-producing operations must carry an idempotency key bound to
the actor/session, workspace, version, operation type, target, and causal
precondition. Duplicate delivery with the same idempotency key returns the
original result or a deterministic equivalent without creating extra canonical
mutations, history entries, projections, notifications, or search-index side
effects. Idempotency records must be persisted for a documented minimum replay
window of at least 24 hours after the operation reaches a terminal result. After
that window, an API retry with the same key must fail closed with an explicit
`idempotency_expired` response or a deterministic conflict response; it must not
silently apply as a new mutation. Implementations may garbage-collect expired key
tombstones only after the documented maximum retry horizon has passed or the
operation namespace is rotated.

Mounted-folder and file-watch captured saves cannot rely on caller-generated API
idempotency keys, because native editors and shell tools do not provide them.
Those paths use engine-side capture deduplication instead: bind the capture to
the watcher/session id, workspace, version, path, observed filesystem event
sequence when available, file size/mtime where trustworthy, content hash, and
causal base token. Deduplication may collapse duplicate native events into one
canonical mutation, but it must not be exposed as the API idempotency-key
contract and must still preserve conflicts when the causal base no longer
matches.

`restore(workspaceId, versionId, pointInTime, ...)` is also write-producing, but
it is never a destructive rollback. A successful restore records a new
checkpoint in the target version whose content is derived from the selected
earlier point, preserving intervening history for audit, compare, and recovery.
Restore must carry exactly one causal precondition for the target version. If
the current version state no longer matches that guard, the API returns the
same deterministic secret-safe conflict envelope as `write(...)`, preserving
references to current and requested-restored content instead of applying the
restore.

Every async watch/status/snapshot payload must include workspace identity,
version identity, a request token or equivalent correlation id, and a monotonic
ordering guard before it can update UI state:

```ts
type UInt64DecimalString = string // canonical base-10 unsigned 64-bit integer

type WorkspaceAsyncPayload = {
  workspaceId: string
  versionId: string
  requestToken: string
  sequence: UInt64DecimalString
}
```

Handlers for `watch(workspaceId, versionId, path)`,
`snapshot(workspaceId, versionId)`, status APIs, and filesystem loading must
verify these fields before applying results. Each handler also compares the
payload sequence, cursor, or server timestamp against the latest applied value
for the same workspace/version/request stream using BigInt-safe decimal-string
comparison, and applies only newer responses. A stale response from one
workspace/version/session must never repaint another or regress current UI
state.

## File state axes

dohc must not collapse every file into a single
tracked/versioned/synced/materialized state.

At least five independent dimensions are needed:

1. **Tracked/captured**
   - Should changes be observed, captured, and made durable by the workspace
     engine?

2. **Versioned/history-visible**
   - Should captured changes appear in user-facing version history and named
     versions?

3. **Synced/durable**
   - Should contents sync to dohc Cloud or another remote?

4. **Materialized locally**
   - Should contents exist on local disk, hydrate lazily, or remain virtual?

5. **Secret-backed/protected**
   - Are bytes stored or referenced as secret material that needs encrypted
     storage, redacted history/export/search, and explicit plaintext
     materialization permission for each human or agent?

Examples:

| Path | Tracked | Versioned | Synced | Materialized | Secret-backed |
| --- | --- | --- | --- | --- | --- |
| `docs/**` | yes | yes | yes | lazy or pinned | no |
| `apps/**` | yes | yes | yes | lazy or pinned | no |
| `data/raw/**` | yes | yes | yes | lazy | no |
| `node_modules/**` | no | no | no | local | no |
| `dist/**` | no | no | no | local | no |
| `.cache/**` | no | no | no | local | no |
| `scratch/**` | optional | optional | no | local | no |
| `.env` | yes | yes | yes | local | yes |

This avoids naive folder-sync behavior such as syncing `node_modules`, build
output, and cache folders.
Materialization describes storage shape only; authorization decides whether a
specific actor can hydrate or read local plaintext for a protected path such as
`.env`.

Secret-backed paths are never ordinary synced text. Their historical state,
exports, search results, conflict envelopes, projections, and agent-readable
views store opaque handles, hashes, and redacted status by default. Plaintext
hydration requires explicit server-side materialization permission and must be
recorded separately from normal materialization so `.env` does not become a
plain history blob or search document.

`tracked` and `versioned` are related but not identical. `versioned = true`
implies `tracked = true`; `tracked = false` implies `versioned = false`.
`tracked = true, versioned = false` is allowed for local or synced artifacts
that should be captured, reconciled, or made durable without appearing in
user-facing version history.

## Workspace file policy

dohc needs a richer source-backed file policy.

Traditional ignore rules mostly ask:

```text
track this file or not?
```

dohc asks:

```text
track this?
sync this?
materialize this?
encrypt this?
search this?
share this?
redact this on export?
allow dohc-controlled agent tools/API to read/write this?
```

The policy should be source-backed and inspectable, but enforcement must be
engine-backed.

## Policy files

A workspace can define readable policy files such as:

```text
.dohc/files.toml
.dohc/visibility.toml
```

Early versions may start with a simpler workspace-root `.dohcignore`, but the
durable model should support richer rules.

`.dohc/**` is engine-managed internal state and is excluded from normal
capture/sync ingestion by default. Recursive self-capture is forbidden: history,
status, conflicts, indexes, caches, and generated projections under `.dohc/`
must not be exported, searched, synced, or re-ingested as ordinary user files.
The importer applies the same allowlist-before-quarantine rule here: only a
small explicit allowlist of source-backed policy files such as
`.dohc/files.toml`, `.dohc/visibility.toml`, or a temporary workspace-root
`.dohcignore` may participate in normal tracking, and even those files are
interpreted as policy inputs, not arbitrary captured content. All other
`.dohc/**` paths are reserved, non-user-content inputs that must be quarantined,
ignored, or handled through engine-specific recovery rather than captured as
ordinary files.

Example:

```toml
[[rule]]
match = "node_modules/**"
tracked = false
versioned = false
synced = false
materialized = "local"

[[rule]]
match = "dist/**"
tracked = false
versioned = false
synced = false
materialized = "local"

[[rule]]
match = "docs/**"
tracked = true
versioned = true
synced = true
materialized = "lazy"

[[rule]]
match = ".env"
tracked = true
versioned = true
synced = true
encrypted = true
searchable = false
visibility = "private"
public_export = "redact"
agent_access = "explicit"
materialized = "local"

[[rule]]
match = ".env.team"
tracked = true
versioned = true
synced = true
encrypted = true
searchable = false
visibility = "team"
agent_access = "ask"
materialized = "local"
```

The policy file is not blindly trusted as authorization. It expresses desired
workspace behavior. The engine/server still derives and enforces actual
permissions.

`agent_access` applies only to dohc-controlled agent tools, APIs, and launched
processes. It cannot reliably distinguish arbitrary local processes after
plaintext content is materialized into a normal folder. For raw local file
access, the enforceable controls are workspace materialization, encryption,
redaction, OS permissions, and whether the user explicitly exposes that folder
or secret to a tool.

## Effective policy

dohc resolves effective policy from:

- workspace defaults.
- version policy.
- path/folder rules.
- object type.
- actor permissions.
- sharing/export context.
- explicit user overrides.

Resolution order is deterministic:

1. Start from workspace defaults.
2. Apply object-type hard constraints.
3. Apply version policy.
4. Apply path/folder rules from least specific to most specific.
5. Apply authorized explicit user overrides.
6. Intersect with actor permissions.
7. Intersect with sharing/export context.

Deny/restrictive outcomes win when two rules conflict. For equal specificity,
rules sort by explicit priority when present, then by stable source order, then
by lexical rule id. Exact paths are more specific than globs; longer literal
prefixes are more specific than shorter prefixes.

Internal policy keys are canonical camelCase. Human-authored policy files may
use snake_case aliases, but parsers must normalize them into canonical camelCase
before validation, storage, API responses, indexing, or enforcement. Clients
and services must enforce the canonical schema, not a mix of key spellings.
Policy parsing is fail-closed: unknown keys, misspelled keys, duplicate semantic
keys, and alias-plus-canonical collisions in the same rule are rejected before
validation or storage. Canonical normalization must not silently accept
ambiguous input.

Example internal shape:

```ts
type FilePolicy = {
  tracked: boolean
  versioned: boolean
  synced: boolean
  encrypted: boolean
  searchable: boolean
  visibility: 'private' | 'workspace' | 'team' | 'shared' | 'public'
  publicExport: 'include' | 'redact' | 'exclude'
  agentAccess: 'allow' | 'ask' | 'explicit' | 'deny' // dohc-controlled access
  materialized: 'local' | 'lazy' | 'pinned' | 'virtual'
}
```

The key rule:

> Policy is source-backed, but enforcement is engine-backed.

## Secret-backed files

dohc should support committing `.env`-style files safely.

Theo's critique is correct: it is strange that modern source control cannot
store the file that a project actually needs while controlling who can see it.

dohc should allow:

```text
.env
.env.local
.env.team
```

to exist as real files in the workspace, while treating them as secret-backed
files with stricter policy.

Example policy:

```yaml
path: ".env"
tracked: true
versioned: true
encrypted: true
searchable: false
visibility: private
publicExport: redact
agentAccess: explicit
materialized: local
```

For an authorized user on their own machine, `.env` can look like a normal file:

```text
DATABASE_URL=postgres://...
STRIPE_KEY=sk_live_...
```

For an unauthorized collaborator, the same path might show:

```text
[private secret file]
```

For public export, dohc may emit:

```text
.env.example
DATABASE_URL=
STRIPE_KEY=
```

or exclude the file entirely, depending on policy.

## Secret storage

Secret-backed files should not store plaintext values in normal history,
durability-log payloads, search, diffs, public export, or agent logs.

Implementation can use:

- local OS keychain.
- dohc Cloud KMS.
- self-hosted secret storage.
- encrypted blob storage with per-actor/workspace keys.

The file projection may materialize plaintext only for an authorized workspace,
version, and user/device. Process-level secret gating applies only to
dohc-controlled execution paths, such as brokered API access, managed mounts,
or injected runtime secrets, not arbitrary local processes that can read a
materialized plaintext file via OS permissions.

When launching a process or agent, dohc can also inject secrets as environment
variables from the same broker. File materialization and process injection are
two projections of the same secret-backed source.

## Secret access by tools and agents

Agents follow the same write model as humans, but secret access still respects
policy where dohc controls the access path.

Possible policies:

- `allow`: dohc-controlled tools can read when they have read permission plus
  the secret capability, and write when they have write permission plus the
  secret capability.
- `ask`: ask before first access in a run/session.
- `explicit`: the user must grant this run/process access.
- `deny`: never expose through dohc-controlled agent/tool paths.

The user-facing framing should be:

```text
Agent wants to read .env
Visibility: private
Reason: run local tests

[Allow once] [Allow for this version] [Deny]
```

This is not because agents are second-class writers. It is because secret
access is a separate capability from normal file write access.

Important caveat: if a plaintext secret file is materialized into a normal
folder, any local process with OS permission to read that file may read it.
dohc should not claim per-agent secret enforcement for arbitrary local
processes. Strong per-agent enforcement requires a dohc-controlled process,
API, sandbox, mount, redacted projection, or secret injection path.

## Capture semantics

Filesystem tools write in messy ways:

- temp file then rename.
- partial write then fsync.
- delete and recreate.
- save on every keystroke.
- generated files and cache churn.

dohc should not make every filesystem event a visible history item.

Use two layers:

1. **Durability log**
   - captures low-level writes for recovery and crash safety.
   - hash-committed and version-specific.

2. **Meaningful checkpoint**
   - coalesces writes by quiescence, related file batch, explicit checkpoint,
     import, merge, non-destructive restore, publish, or a known dohc action
     boundary.
   - appears in history and compare views.

This preserves "everything saves immediately" without turning history into
noise.

## Conflict behavior in the filesystem

A real file path is single-valued. Normal tools expect one readable file at a
path.

dohc should therefore keep the mounted tree coherent and buildable while still
preserving conflicts.

Possible rule:

- the visible path shows the chosen/current value.
- all conflicting states are preserved in the engine.
- conflicts appear in UI, status APIs, and a `.dohc/conflicts/` view.
- no conflicting state is silently dropped.
- secret-backed conflicts do not materialize plaintext in `.dohc/conflicts/`
  by default.
- `.dohc/conflicts/` is an engine projection and is not captured, synced,
  searched, or exported as ordinary workspace input.

The chosen/current value must be deterministic and auditable:

- prefer an explicit user/system resolution commit when present.
- otherwise use a stable engine rule, such as highest logical clock followed by
  deterministic actor/version tiebreaker.
- record `chosen_from`, `base`, and rationale in conflict metadata.
- never switch the visible winner silently without emitting a status/event
  update.

Example:

```text
.dohc/conflicts/
  docs/plan.md/
    main.md
    incoming.md
    base.md
    conflict.toml
```

Normal tools keep working. Users and agents can inspect conflicts explicitly.

The filesystem may simplify. It must not lie about loss.

Secret-backed paths need stricter conflict projection rules. The engine should
preserve base/current/incoming states, but `.dohc/conflicts/` must show redacted
placeholders or metadata-only artifacts unless the actor is authorized and
secret access is explicitly granted for that resolution session. The visible
path/current-value rule must not silently expose secret content through a
conflict artifact.

## Status and legibility

"Feels like a normal folder" must not mean invisible magic.

The system should expose:

- what is local vs remote.
- what is pinned vs lazy.
- what is tracked vs ignored.
- what is synced vs local-only.
- what is conflicted.
- what is secret-backed.
- what is excluded/redacted on export.

Possible surfaces:

- dohc UI badges.
- `dohc status`.
- file attributes/xattrs where available.
- `.dohc/status.json`.
- API status calls.

Hidden mechanics are okay. Hidden safety-relevant state is not.
`.dohc/status.json` is an engine status projection, not user content; it follows
the `.dohc/**` internal-state boundary and must not be re-ingested as a normal
workspace file.

## Export and ownership

dohc must preserve the user's ownership of their work.

Export should produce:

- readable files.
- only allowlisted source-backed policy files such as `.dohc/files.toml`,
  `.dohc/visibility.toml`, and optional workspace-root `.dohcignore`.
- history/provenance metadata.
- hashes or commitments for verification.
- redacted/excluded secret files according to policy.
- enough metadata to re-import and compare.

Generated or internal `.dohc/**` state is excluded from export unless explicitly
allowlisted. Status projections, conflict projections, indexes, caches, derived
chat projections, and durability internals are not exported as ordinary user
files.

External VCS export may remain useful for code-heavy projects, but should be an
integration/export surface rather than dohc's native model.

## What to avoid

Avoid naive folder sync:

- no blind last-writer-wins.
- no syncing `node_modules` by default.
- no materializing everything by default.
- no single state axis for tracked/versioned/synced/materialized.
- no "conflicted copy from Bob's MacBook" as the primary conflict model.

Avoid overcomplicated invisible magic:

- no filesystem mount that lies about local/remote state.
- no silent secret materialization.
- no silent conflict loss.
- no history spam from every low-level save event.
- no dohc-only agent protocol required for ordinary file editing.

## First proof slice

The first proof should demonstrate the whole shape without solving every driver:

1. A workspace folder represents `Main`.
2. A named version appears as a second folder or mount.
3. Editing files in either folder saves immediately to that version.
4. dohc records a durability log and coalesced meaningful history.
5. `.dohc/files.toml` controls tracked/versioned/synced/materialized behavior
   for a few path patterns.
6. `node_modules/**` and `dist/**` are local materialized but untracked,
   unversioned, and unsynced.
7. A `.env` file can be tracked as secret-backed and private.
8. Unauthorized export redacts or excludes `.env`.
9. A simple conflict preserves both sides and exposes `.dohc/conflicts/`.
10. An API can read/write the same version without relying on a real filesystem.

If this works, dohc has the beginning of a filesystem that feels normal to
humans and agents while being much safer and more powerful than normal folders,
folder sync, or conventional worktree flows.
