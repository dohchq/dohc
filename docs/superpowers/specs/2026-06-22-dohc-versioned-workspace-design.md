# dohc Versioned Workspace Design

Status: exploratory architecture direction
Date: 2026-06-22

## Core thesis

dohc should rethink source control as a versioned workspace, not as traditional
source-control concepts with new labels.

The user-facing promise is simple:

> Use normal files. Humans and agents can edit them. Authorized writes save
> immediately. dohc remembers what happened, preserves recovery, supports
> parallel versions, and helps reconcile conflicts.

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
- if an actor has write permission, the actor can edit.
- dohc records who or what changed the workspace.
- dohc can restore earlier states.

There is no special rule that agents cannot edit Main. dohc should not make
agents second-class writers. Safety comes from snapshots, permissions, history,
conflict preservation, and recovery, not from forcing all agent work through a
separate approval flow.

Immediate save is not permission bypass. Every save path must enforce
workspace-scoped authorization, protected-path rules, user locks, version
access, visibility boundaries, and skill-turn gates before applying a change.
Authenticated actor identity is derived by the server/engine, never trusted from
the caller. Humans, agents, automations, imports, and sync processes all pass
through the same protection checks before a write can land. The write path is
fail-closed: if any authorization, policy, visibility, protected-path,
user-lock, version-access, or skill-turn evaluator is unavailable or
indeterminate, the save is denied rather than applied.
Denied or quarantined ingests must still be durable in a non-canonical holding
area with enough metadata to retry or explain the decision after evaluators
recover. The holding area must be abuse-resistant: enforce per-workspace and
per-actor quotas, bounded retention/TTL, payload size caps, rate limits, and
deterministic backpressure so ingest floods cannot exhaust storage or starve
canonical durability paths. Eviction applies only to rejected-before-acceptance
items or to already-durable holding records that reached a declared TTL/retention
boundary; when an accepted holding record expires or is evicted, the engine
preserves durable rejection/expiration evidence. Humans, agents, imports, and
sync processes all get the same guarantee: an accepted change is not silently
lost, but it also does not become canonical workspace state until protection
checks pass.
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
version, event, chat link, projection, and history record carries `workspaceId`.
Write, read, query, search, import, sync, and projection boundaries reject
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

For raw local file edits, dohc does not need to prove whether the process was
a user, an agent CLI, a script, or an editor plugin. Those edits can be
attributed honestly as unverified local/device/session edits. That provenance
must not later be upgraded to authenticated human or agent identity without
cryptographic proof, a trusted session boundary, or a dohc-controlled action
record. Sync/import flows must preserve the original provenance class; if proof
is absent, the change remains local/device/session/import provenance.
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
causal precondition with the incoming bytes. Missing preconditions, multiple
incompatible guards, or stale tokens fail closed and return the same
deterministic current-vs-incoming conflict behavior as the API write flow
instead of blindly overwriting canonical state.

But the same workspace must also be accessible through APIs for cloud,
in-memory, browser, and agent runtimes:

```text
read(workspaceId, versionId, path)
write(workspaceId, versionId, path, bytes, {
  precondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash | expectedAbsent,
  targetObjectId?,
  idempotencyKey?
})
list(workspaceId, versionId, path)
search(workspaceId, versionId, query)
snapshot(workspaceId, versionId)
diff(workspaceId, versionAId, versionBId)
merge(workspaceId, sourceVersionId, targetVersionId, {
  precondition: exactly one of expectedTargetSnapshot | expectedTargetVersionEtag,
  idempotencyKey?
})
restore(workspaceId, versionId, pointInTime, {
  precondition: exactly one of expectedCurrentCheckpoint | expectedVersionEtag | expectedSnapshotId,
  idempotencyKey?
})
```

The filesystem is one interface. It should not be the only possible execution
environment.

API writes are never unconditional overwrites. A write must include exactly one
causal precondition: expected base version, etag, content hash, absence
assertion for creates, or another monotonic freshness token. Stable object ids
may identify the intended target object, but they are not causal freshness
guards and cannot authorize overwrite by themselves. If the precondition does
not match the current workspace/version/path state, the engine returns a
deterministic conflict response preserving current and incoming content instead
of mutating canonical state. Supplying no causal precondition or multiple
incompatible preconditions fails closed.

`snapshot(...)` and `diff(...)` are read-only scoped views. `merge(...)` and
`restore(...)` are write-producing operations and must use the same
workspace/version scoping, causal guard, idempotency, and conflict-response
rules as `write(...)`.

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

1. Can it take an immutable snapshot or hash-committed state?
2. Can it identify the base/fork point between versions?
3. Can it diff two states?
4. Can it merge from a common base, or honestly produce a conflict?
5. Can it project to files, UI, search, API, or export?
6. Can writable projections be ingested safely?
7. Can it recover or restore to a known-good state?

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

This is how dohc supports the Theo-inspired principle that open work does not
need to expose 100% of all work 100% of the time.

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
14. E2E proves `write(...)`, `merge(...)`, and `restore(...)` fail closed when
    causal preconditions are missing or multiple/incompatible, and only proceed
    when exactly one valid causal guard is supplied.

This proves the heart of the idea without forcing a full rewrite of every
content type on day one.
