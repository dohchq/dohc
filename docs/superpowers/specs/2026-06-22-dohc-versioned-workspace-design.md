# dohc Versioned Workspace Design

Status: exploratory architecture direction
Date: 2026-06-22

## Core thesis

dohc should rethink source control as a versioned workspace, not as Git with
new labels.

The user-facing promise is simple:

> Use normal files. Humans and agents can edit them. Everything saves
> immediately. dohc remembers what happened, preserves recovery, supports
> parallel versions, and helps reconcile conflicts.

This keeps the dohc philosophy intact: the workspace should still feel like
files on the user's computer. Agents should not need to know dohc-specific
version-control concepts to work safely.

## What changes from Git

Git's surface primitives are not the right default for agents or normal users:

- commits force people to think about history too early.
- branches expose implementation ceremony for parallel work.
- worktrees are awkward, stale, and filesystem-heavy.
- public/private is usually repo-level instead of object/path/change-level.
- source control assumes a real OS and filesystem.

dohc should keep Git-grade robustness while replacing Git-shaped interaction.

| Git concept | dohc user concept |
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

Review appears only when crossing a real boundary:

- merging one version into another.
- sharing private work.
- publishing a version or projection.
- resolving a real conflict.
- restoring shared or published state.
- changing visibility or permission boundaries.

Normal editing remains:

```text
edit -> save -> automatic history
```

Parallel work is:

```text
create/open version -> edit normally -> compare or merge when ready
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

1. Does this actor have permission to write this version/path/object?
2. Can the change be recorded durably?
3. Can the system preserve recovery and honest provenance?
4. Does the change create a conflict or cross a visibility boundary?

If the actor can write, the change saves immediately to that version.

For raw local file edits, dohc does not need to prove whether the process was
Ice, Codex, Claude, a script, or an editor plugin. Those edits can be attributed
honestly as local/device/session edits. Agent-specific authorship is required
for social actions like chat replies, where the message display must make clear
whether the human or the user's agent wrote it.

## Robustness invariants

dohc should steal Git's robustness, not Git's UX.

The underlying engine must preserve:

- immutable snapshots or hash-committed states.
- clear ancestry and fork points between versions.
- content addressing or equivalent tamper-evident commitments.
- common-base reconciliation for divergent versions.
- recoverability to known-good states.
- local durability and export.
- conflict preservation when merge safety is uncertain.
- meaningful provenance for human, agent, and system changes.

These are not Git quirks. They are the physics of reliable versioned work.

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
  Codex Experiment

History inside Main
  10:05 Ice edited docs/plan.md
  10:12 Codex updated apps/finance/index.html
  10:20 CSV import added 812 rows
```

This avoids confusing "version" as both branch and point-in-time snapshot.

## Two-tier history

Immediate save should not mean noisy visible history.

dohc should track two levels:

1. **Fine-grained durability log**
   - every save/write needed for recovery.
   - crash-safe and time-travel friendly.
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
| markdown document | Y.Doc / markdown body | `docs/plan.md` |
| code file | file/blob content | `code/fs/file.c` |
| post | markdown body + structured comments | `posts/q3-pricing.post.md` |
| database | SQLite or table store | `data/transactions.sqlite` or projections |
| app/site | file tree + manifest | `.apps/finance/index.html` |
| agent run | execution trace + changed paths | history/timeline projection |

Files remain a first-class affordance. The engine gives them stronger history,
visibility, recovery, and merge behavior.

## Filesystem/API duality

Agents should not need a special dohc source-control protocol.

They should be able to operate through normal files:

```text
read file
write file
run command
save
```

But the same workspace must also be accessible through APIs for cloud,
in-memory, browser, and agent runtimes:

```text
read(path)
write(path, bytes)
list(path)
search(query)
snapshot(version)
diff(versionA, versionB)
merge(sourceVersion, targetVersion)
restore(version, pointInTime)
```

The filesystem is one interface. It should not be the only possible execution
environment.

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
- surface conflicts without raw Git conflict markers by default.
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

History, diffs, search, exports, and agent logs must not capture secret values.

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
Codex Experiment
Create version
View history
```

History:

```text
Today

10:20 CSV import
Added 812 rows to transactions

10:12 Codex edited Finance Tracker
Changed 6 files

10:05 Ice edited Budget Notes
Changed 1 document
```

Compare versions:

```text
Compare: Codex Experiment -> Main

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
- Codex Experiment paragraph
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

> You are editing a version of your workspace. Everything saves. dohc remembers
> everything. You can create other versions, compare them, merge them, share
> them, or go back.

## Open questions

1. What are the first supported version scopes?
   - single file.
   - folder.
   - app/site.
   - whole workspace.

2. Which drivers must ship first?
   - markdown/Y.Doc.
   - normal file/blob.
   - SQLite/table.
   - post/comment.

3. How should local filesystem changes be captured?
   - file watcher.
   - virtual filesystem.
   - explicit dohc sync process.
   - all of the above in stages.

4. How much of the version graph should be exportable as Git/JJ?

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
7. A restore can return a version to an earlier point in time.
8. The engine records honest provenance without changing write rules:
   dohc-authenticated actions can distinguish human/agent/system, while raw
   local file edits may be local/device/session changes.

This proves the heart of the idea without forcing a full rewrite of every
content type on day one.
