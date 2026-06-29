# dohc Versioned Workspace Design

Status: exploratory architecture direction
Date: 2026-06-22

## Core thesis

dohc should rethink source control as a versioned workspace, not as traditional
source-control concepts with new labels.

The user-facing promise is simple:

> Use normal files. Humans and agents can edit them. Accepted writes are durably
> recorded immediately. Writes that pass protection checks become canonical
> immediately; writes that cannot yet become canonical return `durable-pending`,
> and denied writes keep durable recovery/audit handles. dohc remembers what
> happened, supports parallel versions, and helps reconcile conflicts.

This keeps the dohc philosophy intact: the workspace should still feel like
files on the user's computer. Agents should not need to know dohc-specific
version-control concepts to work safely.

## What changes from traditional source control

Traditional source-control surface primitives are not the right default for
agents or normal users:

- commits force people to think about history too early.
- branches expose implementation ceremony for parallel work.
- worktrees are awkward, stale, and filesystem-heavy.
- public/private is usually repo-level instead of object/path/change-level.
- source control assumes a real OS and filesystem.

dohc should keep VCS-grade robustness while replacing VCS-shaped interaction.

| Traditional concept | dohc user concept |
| --- | --- |
| repository | workspace |
| branch | version |
| commit | automatic history checkpoint / moment |
| worktree | live version view |
| pull request | compare / merge boundary |
| merge | reconcile versions |
| revert | restore / undo |
| clone | local or lazy-hydrated workspace |
| `.env` | secret reference resolved by a broker |

The important change is that dohc does not make users or agents perform source
control rituals before doing work.

## User-facing model

The core user-facing primitive is a **Version**.

Main is a version. A rewrite is a version. A client-safe workspace is a version.
An agent experiment is a version. A security-fix line is a version.

Each version behaves like a live file workspace:

- files save immediately.
- history is automatic.
- humans and agents follow the same write rules.
- if the server-derived actor identity has workspace/version/path authority and
  every protection gate passes, the actor can edit.
- dohc records who or what changed the workspace.
- dohc can restore earlier states.

There is no special rule that agents cannot edit Main, but Main still uses the
same ownership, authorization, and review gates as any other protected write.
dohc should not make agents second-class writers. Safety comes from snapshots,
permissions, review gates where policy requires them, history, conflict
preservation, and recovery, not from forcing all agent work through a separate
approval flow.

Immediate save is not permission bypass. Every save path must enforce
workspace-scoped authorization, ownership/review gates required by policy,
protected-path rules, user locks, version access, visibility boundaries, and
skill-turn gates before applying a change. Authenticated actor identity is
derived by the server/engine, never trusted from the caller. Humans, agents,
automations, imports, and sync processes all pass through the same protection
checks before a write can land. The write path is fail-closed: if any
authorization, ownership/review gate, policy, visibility, protected-path,
user-lock, version-access, or skill-turn evaluator is unavailable or
indeterminate, the save is denied rather than applied.
Canonical save success is acknowledged only after the mutation is durably
committed to canonical workspace state and is visible to normal `read` and
`watch` semantics for that version. Search indexing is eventually consistent
from canonical state and must not gate write acknowledgment. If the durability
path accepts a non-canonical
holding record, the response is a distinct durable-pending result, not a
successful immediate save. UIs may show that pending record only in explicit
ingest/recovery/status surfaces marked non-canonical. In this spec, "files save
immediately" means authorized writes that pass protection checks become
canonical without an extra human apply/review step.
Write results are explicit:

```ts
type UnixMsDecimalString = string // canonical base-10 Unix epoch milliseconds

type DeniedOrQuarantinedStatus =
  | 'rejected_before_acceptance'
  | 'quarantined_protection'
  | 'quarantined_attribution'
  | 'quarantined_policy'

type PublicDeniedReasonCode =
  | 'not_authorized'
  | 'policy_denied'
  | 'policy_indeterminate'
  | 'protected_path'
  | 'locked'
  | 'version_access_denied'
  | 'skill_turn_denied'
  | 'invalid_request'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'replay_metadata_mismatch'

type TerminalRetirementReason =
  | 'auto_retired_payload_retention_expired'
  | 'operator_disposition_retired'

type ExpiredRetryRecordKind =
  | 'accepted_holding_record'
  | 'rejected_or_quarantined_record'

type WriteResult =
  | {
      kind: 'canonical'
      workspaceId: string
      versionId: string
      historyMomentId: string
      objectId: string
    }
  | {
      kind: 'durable-pending'
      holdingRecordId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      acceptedAt: UnixMsDecimalString
      replayUntil: UnixMsDecimalString
      operatorDispositionDueAt: UnixMsDecimalString
      status: 'pending_protection' | 'pending_canonicalization' | 'overdue_disposition'
    }
  | {
      kind: 'denied'
      holdingRecordId: string
      workspaceId: string
      requestedVersionId?: string
      idempotencyKey: string
      reasonCode: PublicDeniedReasonCode
      rejectedAt: UnixMsDecimalString
      retentionUntil: UnixMsDecimalString
      status: DeniedOrQuarantinedStatus
    }
  | {
      kind: 'terminal-retired'
      holdingRecordId: string
      workspaceId: string
      versionId?: string
      idempotencyKey: string
      retiredAt: UnixMsDecimalString
      reasonCode: TerminalRetirementReason
      retainedMetadata: 'minimal_audit_idempotency_and_explanation_only'
    }
  | {
      kind: 'idempotency-expired'
      holdingRecordId: string
      workspaceId: string
      idempotencyKey: string
      expiredAt: UnixMsDecimalString
      recordKind: ExpiredRetryRecordKind
      reasonCode: 'idempotency_expired'
    }
  | { kind: 'conflict'; workspaceId: string; conflictId: string }
```

Public `reasonCode` fields are safe closed enums only. Rich evaluator traces,
stack details, policy rule names, secret/path internals, and operator notes stay
server-side and appear only through separately authorized diagnostics.

Denied or quarantined ingests must still be durable in a non-canonical holding
area with enough metadata to retry or explain the decision after evaluators
recover. The `denied` result is addressable by `holdingRecordId`; operators,
status APIs, retry tooling, and audit/export jobs use that id to correlate the
response with the retained rejected-before-acceptance or quarantined record.
The holding area separates rejected-before-acceptance items from accepted
holding records. It must be abuse-resistant: enforce per-workspace and
per-actor quotas, bounded retention/TTL, payload size caps, rate limits, and
deterministic backpressure so ingest floods cannot exhaust storage or starve
canonical durability paths. TTL eviction applies only to
rejected-before-acceptance items. Accepted holding records are durable accepted
writes, even though they are not yet canonical workspace state. They must remain
recoverable with reconstructable payload and retry metadata until protection
checks succeed and canonicalization completes, or until explicit operator
disposition is recorded for a record that cannot safely become canonical. For
accepted holding records, any TTL, retry-horizon, compaction, or colder-storage
policy may throttle retries, compact derived retry/index metadata, or move
accepted payload bytes to colder durable storage, but it must preserve the
reconstructable payload bytes until canonicalization completes or explicit
operator disposition is recorded; it is not an eviction or deletion policy for
accepted payloads. If a rejected-before-acceptance item
expires, or if an accepted record is retired through explicit disposition, the
engine preserves durable rejection, disposition, or expiration evidence. Humans,
agents, imports, and sync processes all get the same guarantee: an accepted
change is not silently lost, but it also does not become canonical workspace
state until protection checks pass.
Accepted records still have a bounded operator-visible lifecycle. The Phase 0
decision note defines `AcceptedHoldingRecordPolicy.maxPendingCanonicalizationMs`
and `operatorDispositionDueAt`; when the deadline is reached, the record must be
escalated into an explicit disposition queue, marked overdue in status APIs, and
compacted or moved to colder durable storage according to policy. Garbage
collection may remove only derived retry/index metadata after the disposition
deadline while the operator window is open; the reconstructable payload remains
until canonicalization succeeds, an explicit operator disposition record retires
it, or the non-overrideable terminal retention bound is reached. The terminal
bound is derived from `operatorDispositionDueAt` plus
`AcceptedHoldingRecordPolicy.maxPendingCanonicalizationMs` unless Phase 0 sets a
shorter global safety limit. At that bound, a still-unresolved accepted record
must be automatically retired with an operator-visible
`auto_retired_payload_retention_expired` disposition: reconstructable payload
bytes are deleted, cryptoshredded, or compacted into a non-reconstructable
evidence record, while minimal metadata needed for audit, idempotency expiry,
abuse controls, and user-facing explanation is retained. Workspace policy cannot
extend or disable this terminal payload-retention rule.
Status APIs and retry tooling represent that state as a `terminal-retired`
`WriteResult` for the same `holdingRecordId`; they must not collapse it into
`denied`, quarantine, conflict, or generic expiration.
Retries using the same idempotency key and matching replay metadata before the
record's retry horizon return the same addressable result for the same
`holdingRecordId`: `durable-pending` before `replayUntil`, or `denied` before
`retentionUntil` for rejected/quarantined records. After the relevant horizon,
a retry with the same key returns an `idempotency-expired` result tied to the
same `holdingRecordId`, returns the stable `terminal-retired` result, or resolves
through the explicit operator disposition/expiration record; it must not
silently create a second accepted holding record or an uncorrelated denial.
Accepted holding records are not visible through normal `read`, `watch`, or
`search` as workspace content before canonicalization. Those paths expose the
last canonical workspace state only. Holding records may be surfaced only through
explicit ingest/recovery/status views that are policy-authorized for the actor,
marked non-canonical, and scoped to the relevant workspace/version so previews do
not masquerade as committed file, history, search, or watch results.
This holding area follows the same secret-backed durability rules as canonical
history: it must not persist plaintext secret values in payloads, indexes, logs,
explanations, or retry metadata. Secret-bearing ingests are stored only as
encrypted references, redacted forms, or broker metadata until an authorized
read path reconstructs them.
Replay from the holding area must be causal and fail-closed. Retry metadata
must include `workspaceId`, `versionId`, and the `expectedBaseVersion`, content
hash, or equivalent CAS token captured with the original ingest. At
apply time, the engine revalidates workspace scope plus server-derived
authorization, policy, visibility, protected-path, lock, version-access, and
skill-turn checks. If the base advanced, the workspace binding is ambiguous, or
permissions changed, the retry degrades to conflict/manual reconciliation or
stays quarantined instead of becoming canonical state.

Workspace scoping is a required data-model invariant, not just an authorization
check. Every persisted atom, folder, entity, share, capture, file object,
version, event, chat link, projection, history record, holding record,
durability-log entry, and idempotency tombstone carries `workspaceId`. Write,
read, query, search, import, sync, and projection boundaries reject
cross-workspace references by default, even when an actor is otherwise valid.

Review appears only when crossing a real boundary:

- merging one version into another.
- sharing private work.
- publishing a version or projection.
- resolving a real conflict.
- restoring shared or published state.
- changing visibility or permission boundaries.

Normal editing remains:

```text
authorized edit -> auto-save -> automatic history
```

Parallel work is:

```text
create/open version -> edit with automatic saves -> compare or merge when ready
```

## Actor-neutral rule

dohc version control is actor-neutral.

The version engine should not care whether a change came from:

- a human.
- an agent.
- an automation.
- a sync process.
- an import.

It should ask only:

1. What server/engine-derived actor is performing the write?
2. Does this actor have permission to write this workspace/version/path/object?
3. Is the path/object protected by a user lock, policy boundary, or visibility
   boundary?
4. Is the write allowed by the active skill-turn gate, when the actor is an
   agent/tool/action running inside a delegated turn?
5. Can the change be recorded durably?
6. Can the system preserve recovery and honest provenance?
7. Does the change create a conflict or cross a visibility boundary?

If the actor can write, the change saves immediately to that version.

For raw passive local file edits observed through the normal OS filesystem,
dohc does not need to prove whether the process was a user, an external agent
CLI, a script, or an editor plugin. Those edits can be attributed honestly as
unverified local/device/session edits. That provenance must not later be
upgraded to authenticated human or agent identity without cryptographic proof,
a trusted session boundary, or a dohc-controlled action record.
Agent-origin-capable ingest paths are different: dohc-controlled agent
runtimes, skill turns, MCP/tool bridges, privileged agent workspace mounts, or
sync/import channels that carry agent/run metadata must supply verifiable
skill-turn context before becoming canonical state. If that proof is missing,
stale, or indeterminate, the ingest is quarantined or rejected; it must not be
downgraded into unverified local/session provenance. Sync/import flows must
preserve their original provenance class. Only truly passive ordinary OS writes
with no dohc-controlled agent/run context may remain local/device/session
provenance when proof is absent; import/sync ingests without proof stay
quarantined until they can be attributed or rejected.
Unverified local, device, or session edits still pass through server/engine-side
workspace ownership, lock, protected-path, and visibility checks before they
become canonical workspace state. If the engine cannot prove the required access
or policy/skill-turn state, the ingest is quarantined or rejected rather than
trusted. Agent-originated writes must fail closed when the relevant skill-turn
gate cannot be evaluated or is indeterminate; local provenance does not bypass
that evaluator when the write is being applied through a dohc-controlled
agent/tool action.
Agent-specific authorship is required for social actions like chat replies,
where the message display must make clear whether the human or the user's agent
wrote it.

## Robustness invariants

dohc should keep VCS-grade robustness, not VCS-shaped UX.

The underlying engine must preserve:

- immutable snapshots or hash-committed states.
- clear ancestry and fork points between versions.
- content addressing or equivalent tamper-evident commitments.
- common-base reconciliation for divergent versions.
- recoverability to known-good states.
- local durability and export.
- conflict preservation when merge safety is uncertain.
- meaningful provenance for human, agent, and system changes.

These are not tool-specific quirks. They are the physics of reliable versioned
work.

## Versions and history

Version and history are separate ideas.

- A **Version** is a live parallel line of work.
- **History** is the time axis inside a version.

Example:

```text
Versions
  Main
  Q3 Rewrite
  Client Version
  Agent Experiment

History inside Main
  10:05 <User Name> edited docs/plan.md
  10:12 Agent updated apps/finance/index.html
  10:20 CSV import added 812 rows
```

This avoids confusing "version" as both branch and point-in-time snapshot.

## Two-tier history

Immediate save should not mean noisy visible history.

dohc should track two levels:

1. **Fine-grained durability log**
   - every save/write needed for recovery.
   - secret-backed writes are recovery-tracked only as encrypted references,
     redacted markers, or broker metadata instead of raw secret bytes.
   - crash-safe and time-travel friendly.
   - write-ack boundary: a save is acknowledged only after the durability-log
     record is persisted to recoverable storage, or after an equivalent
     durability guarantee, so acknowledged writes survive process crash/restart.
   - not necessarily the main visible timeline.

2. **Meaningful moments**
   - quiescent edit bursts.
   - related file batches.
   - explicit checkpoints.
   - known dohc action boundaries, when available.
   - imports.
   - merges.
   - publishes.
   - restores.

Humans usually read moments. The engine keeps the finer log for robustness.

## Workspace objects and files

The product should feel file-native, but the engine may understand richer
workspace objects.

A file path can be a projection or the canonical content for a workspace object.
The rule is:

> Content lives where the richest authoring happens. History, permissions,
> provenance, and visibility live in dohc.

Examples:

| Workspace object | Likely content driver | File experience |
| --- | --- | --- |
| Markdown document | Canonical Y.Doc; Markdown body/`atoms.body` is a derived cache or projection | `docs/plan.md` |
| code file | file/blob content | `code/fs/file.c` |
| post | Markdown body + structured comments | `posts/q3-pricing.post.md` |
| database | SQLite or table store | `data/transactions.sqlite` or projections |
| app/site | file tree + manifest | `.apps/finance/index.html` |
| agent run | execution trace + changed paths | history/timeline projection |

Files remain a first-class affordance. The engine gives them stronger history,
visibility, recovery, and merge behavior.

For rich documents, the projection contract must be explicit. If a Markdown
document is backed by a canonical Y.Doc, `docs/plan.md` is a Markdown projection
and `atoms.body` is a derived cache. Saving that file must either translate the
edit back through a Y.Doc transaction with the same causal precondition rules as
API writes, or reject/preserve the edit as a conflict if the driver cannot
round-trip it safely. The engine regenerates Markdown/`atoms.body` from the
canonical Y.Doc after a successful commit; direct file edits must not create a
second authoritative body that can diverge from Y.Doc state.

Projection safety is mandatory. Any HTML/renderable projection, including HTML
atoms and app/site previews, must be sanitized and sandboxed before display.
Content drivers must declare projection safety behavior as part of their
snapshot/diff/merge/projection/export/search contract.

## Filesystem/API duality

Agents should not need a special dohc source-control protocol.

They should be able to operate through normal files:

```text
read file
write file
run command
save
```

Normal filesystem saves are translated into the same write contract as
`write(workspaceId, versionId, path, bytes, ...)`. When a file is read or
materialized, the engine records exactly one causal token for that path, such
as the last seen base version, etag, content hash, or absence assertion. When
the file is saved or captured, the filesystem path must submit exactly one valid
causal precondition with the incoming bytes. Missing preconditions or multiple
incompatible guards are malformed request/protocol errors and fail closed before
the conflict path. A well-formed but stale causal token is a real write conflict
and returns the same deterministic current-vs-incoming conflict behavior as the
API write flow instead of blindly overwriting canonical state.

But the same workspace must also be accessible through APIs for cloud,
in-memory, browser, and agent runtimes:

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
  sourcePrecondition: exactly one of expectedSourceSnapshot | expectedSourceVersionEtag,
  precondition: exactly one of expectedTargetSnapshot | expectedTargetVersionEtag,
  idempotencyKey
})
restore(workspaceId, versionId, checkpointId, {
  precondition: exactly one of expectedCurrentCheckpoint | expectedVersionEtag | expectedSnapshotId,
  idempotencyKey
})
```

The filesystem is one interface. It should not be the only possible execution
environment.

Read-only API responses and streamed events must be bound to the requested
`workspaceId`, every requested version identifier, and a request token, epoch, or
equivalent correlation id. Single-version reads bind `versionId`; pairwise reads
bind the full requested pair such as `versionAId`/`versionBId`; merge/diff
previews bind their source and target version identifiers. Async reads such as
`list(...)`, `stat(...)`, `search(...)`, `snapshot(...)`, and `diff(...)` must
accept abort semantics or an equivalent request-cancellation contract, and
callers must ignore responses whose token, workspace, or any requested version
identifier no longer matches the active view. `watch(...)` events must carry the
same binding and must stop or no-op after abort, workspace switch, or version
switch. A stale read or watch event from one workspace or version set must never
repaint or leak data into a newer workspace context.

API writes are never unconditional overwrites. Create and overwrite modes are
explicit: `expectedAbsent` is create-only and must omit `targetObjectId`.
Overwrite must include `targetObjectId` plus exactly one causal freshness
precondition, such as `expectedBaseVersion`, `expectedEtag`, or
`expectedContentHash`. `targetObjectId` binds the intended object identity so a
delete/recreate substitution cannot satisfy a path-only overwrite, but it is
not a freshness guard by itself. If the precondition or target object does not
match the current workspace/version/path state, the engine returns a
deterministic secret-safe conflict envelope instead of mutating canonical state.
Supplying no causal precondition, omitting `targetObjectId` for overwrite, or
providing multiple incompatible preconditions is a validation/protocol error that
fails closed before conflict materialization.

Conflict envelopes return only opaque object/version handles, hashes, operation
kinds, and minimal conflict status by default. Policy decisions, explanatory
metadata, redacted previews, and full current/incoming/restored/secret-backed
bytes are materialized only through the server-side authorization path for that
caller and resolution session.

`read(...)`, `list(...)`, `stat(...)`, `search(...)`, `watch(...)`,
`snapshot(...)`, and `diff(...)` are read-only scoped views. `delete(...)`,
`rename(...)`, `move(...)`, `replace(...)`, `merge(...)`, and `restore(...)` are
write-producing operations and must use the same workspace/version scoping,
causal guard, idempotency, and conflict-response rules as `write(...)`.
Merge must guard both the source and target versions: the source snapshot/etag
freezes what is being merged, and the target snapshot/etag freezes where it is
being applied.
Delete requires the path's `targetObjectId`. Rename and move require the source
`sourceObjectId` plus exactly one source freshness precondition. Rename/move with
`destinationPrecondition: expectedAbsent` is create-at-destination only. Atomic overwrite uses
`replace(...)`, which requires `sourceObjectId`, `destinationObjectId`, one
source precondition, one destination precondition, and one idempotency key. This
models temp-file-then-rename saves without an extra read/round trip and without
allowing a path-only delete/recreate substitution.
API-originated write-producing operations must carry an idempotency key bound to
the actor/session, workspace, version context, operation type, target, write
payload digest or canonical operation payload fingerprint, full operation
operand tuple, and causal precondition set. Payload changes must produce a
different idempotency identity even when the target and precondition are
unchanged. The operand tuple includes materially distinguishing values such as
source/destination paths, sourceVersionId, targetVersionId, versionA/versionB
identifiers, checkpointId, snapshot ids, merge inputs, and restore targets as
applicable, so different `merge(...)`, `replace(...)`, or `restore(...)`
requests cannot collide under one key. Duplicate delivery with the same
idempotency key must return the original result or a deterministic equivalent
and must not create additional canonical mutations, duplicate history events,
duplicate projections, or repeated notification/search side effects.
Idempotency records must be persisted through the documented maximum retry
horizon for that operation type and transport after the operation reaches a
terminal result. The idempotency record/tombstone must be committed in the same
transactional boundary as the canonical mutation. If an
implementation cannot share a transaction boundary, it must provide an equivalent
write-ahead guarantee: reserve the idempotency key durably before applying the
mutation, make recovery complete either the original mutation or tombstone the
reserved key deterministically, and never acknowledge success until the
idempotency result and canonical mutation are durable together. After the retry
horizon, an API retry with the same key must fail closed with an explicit
`idempotency_expired` response or a deterministic conflict response; it must not
silently apply as a new mutation. Implementations may garbage-collect expired key
tombstones only after the same maximum retry horizon has passed or the operation
namespace is rotated.
The canonical retry-horizon values are defined once by the Phase 0 decision note
under `Idempotency Retry Horizons`, then promoted into the PR 01 shared
`WorkspaceIdempotencyPolicy` contract. This spec and the native filesystem spec
both reference those policy names instead of duplicating values:
`apiWriteTerminalRetryHorizonMs`, `apiWriteTombstoneRetentionMs`,
`filesystemCaptureDedupHorizonMs`, and
`filesystemCaptureTombstoneRetentionMs`. Any PR that changes the values must
update the shared contract and execution log before changing implementation
behavior.

Filesystem-captured saves cannot rely on caller-generated API idempotency keys.
Those paths use an engine-generated capture token and engine-side deduplication
bound to the watcher/session id, workspace, version, path, observed filesystem
event sequence when available, file size/mtime where trustworthy, content hash,
and causal base token. Deduplication may collapse duplicate native events into
one canonical mutation, but it must not be exposed as the API idempotency-key
contract and must still preserve conflicts when the causal base no longer
matches.

## Conflict behavior

dohc should not block normal edits by default.

If changes collide, dohc should preserve both states and surface the conflict
only when needed.

For collaborative documents, this can feel like Google Docs:

- live edits merge in the document.
- history records who changed what.
- if semantic conflict exists, show it as a document-level choice.

For code and file trees:

- preserve base, current, and incoming states.
- use common-base merge.
- surface conflicts without raw conflict markers by default.
- allow power users to inspect raw diffs when useful.

For databases:

- prefer row identity and transactional operations.
- preserve conflicting row/cell edits.
- never silently corrupt invariants.

For apps/sites:

- merge file trees with app-aware checks.
- run build/test/eval gates when configured.

The principle:

> Smart when possible. Deterministic when necessary. Honest when uncertain.

## Driver robustness contract

Every content driver should be evaluated against this contract:

1. Take an immutable snapshot or hash-committed state.
2. Identify the base/fork point between versions.
3. Diff two states.
4. Merge from a common base, or honestly produce a conflict.
5. Project to files, UI, search, API, or export.
6. Ingest writable projections safely.
7. Recover or restore to a known-good state.

If a driver cannot satisfy part of the contract, dohc must degrade honestly:

- read-only projection.
- lossy export label.
- manual conflict required.
- last-writer-wins only when explicit and recoverable.

No silent robustness theater.

## Visibility and sharing

Visibility must not be repo-level only.

dohc should support visibility at multiple scopes:

- workspace.
- version.
- path/folder.
- workspace object.
- projection.
- moment/change.
- shared export.

Possible visibility states:

- private.
- workspace.
- shared with selected people.
- public.
- embargoed.
- redacted.

This is how dohc supports open work without requiring 100% of all work to be
visible 100% of the time.

## Secrets

Secrets should not be normal files in history.

Workspace files may contain secret references, but values should live in a
secret broker:

- OS keychain.
- dohc Cloud KMS.
- self-hosted secret store.

History, durability logs, diffs, search, exports, and agent logs must not
capture raw secret values. Secret-backed content may be persisted only as
encrypted references, redacted forms, or broker-managed metadata while the
timeline remains crash-safe and recoverable.

Secret reference resolution is workspace-scoped and fail-closed. A reference
issued for one workspace must not be dereferenced from another workspace,
version, share, export, capture, search, or agent-log context.

## Interface sketch

The default workspace surface should be calm:

```text
Version: Main
Saved 12 seconds ago
```

Version menu:

```text
Main
Q3 Rewrite
Client Version
Agent Experiment
Create version
View history
```

History:

```text
Today

10:20 CSV import
Added 812 rows to transactions

10:12 Agent edited Finance Tracker
Changed 6 files

10:05 <User Name> edited Budget Notes
Changed 1 document
```

Compare versions:

```text
Compare: Agent Experiment -> Main

Changed
- 6 app files
- 812 transaction rows
- 1 budget document

Conflicts
- none

Visibility changes
- none
```

Conflict:

```text
Budget Notes changed in both versions.

Choose what to keep:
- Main paragraph
- Agent Experiment paragraph
- open side-by-side editor
```

No default `commit`, `branch`, `HEAD`, `rebase`, or conflict-marker language.

## Why this is still dohc

This model preserves the core dohc philosophy:

- text and files remain natural affordances.
- agents can work like humans against the workspace.
- users own inspectable local files.
- dohc adds safety, recovery, history, permissions, and sync.
- repeated work can become reusable structure.

The engine is sophisticated, but the user experience should remain obvious:

> You are editing a version of your workspace. Authorized writes save. dohc
> remembers everything. You can create other versions, compare them, merge them,
> share them, or go back.

## Open questions

1. What are the first supported version scopes?
   - single file.
   - folder.
   - app/site.
   - whole workspace.

2. Which drivers must ship first?
   - Markdown/Y.Doc.
   - normal file/blob.
   - SQLite/table.
   - post/comment.

3. How should local filesystem changes be captured?
   - file watcher.
   - virtual filesystem.
   - explicit dohc sync process.
   - all of the above in stages.

4. How much of the version graph should be exportable through external VCS
   formats?

5. Which conflict UI is required for the first useful version?

6. How do version permissions interact with per-path visibility?

7. What is the minimal Merkle/hash commitment needed for tamper-evident history?

8. How do cloud-hosted agent versions and local filesystem versions reconcile?

## First proof slice

The first proof should be small but real:

1. A workspace has `Main` and one named version.
2. Normal file edits save immediately inside the active version.
3. dohc records automatic history.
4. A user can compare the named version against Main.
5. A clean file merge can move changes from one version to another.
6. A conflicting text edit preserves both sides and shows a simple conflict.
7. A restore can create a new checkpoint from an earlier point without deleting
   intervening history.
8. The engine records honest provenance without changing write rules:
   dohc-authenticated actions can distinguish human/agent/system, while raw
   local file edits may be local/device/session changes.
9. E2E proves fail-closed behavior when authorization, policy, visibility,
   protected-path, lock, version-access, or skill-turn evaluators are
   unavailable or indeterminate.
10. E2E proves plaintext secrets do not enter durability-log payloads, history,
    diffs, export bundles, search indexes, or agent logs.
11. E2E proves every persisted atom, folder, entity, share, capture, file,
    version, event, chat link, projection, and history record is
    workspace-scoped, and that cross-workspace references are rejected by
    default.
12. E2E proves holding-area replay is causal: stale base/CAS tokens or
    workspace/version mismatches never apply as canonical state and instead
    degrade to conflict/manual reconciliation or remain quarantined.
13. E2E proves holding-area abuse resistance: per-workspace/per-actor quotas,
    TTL retention bounds, payload-size caps, ingest rate limits, and
    deterministic backpressure prevent storage exhaustion or canonical
    durability starvation without silently dropping accepted holding records.
14. E2E proves `write(...)`, `merge(...)`, `replace(...)`, and `restore(...)`
    fail closed when required causal preconditions are missing or incompatible,
    and only proceed when the operation-specific guard set is supplied and each
    guard is individually valid.

This proves the heart of the idea without forcing a full rewrite of every
content type on day one.
