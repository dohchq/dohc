# dohc Versioned Workspace Design

Status: exploratory architecture direction
Cohort: dohc Think Bigger Workspace Engine
Date: 2026-06-22

## Core thesis

dohc should rethink source control as a versioned workspace, not as traditional
source-control concepts with new labels.

The user-facing promise is simple:

> Use normal files. Humans and agents can edit them. Writes have two explicit
> phases: durable recording and canonical acceptance. Writes that pass protection
> checks become canonical immediately; writes that are durably recorded but cannot
> yet become canonical return `durable-pending`; evaluator outages or
> indeterminate evaluator results return `retryable-failure` without pretending
> the write was durably accepted; and rejected/quarantined writes keep durable
> recovery/audit handles. dohc remembers what happened, supports parallel
> versions, and helps reconcile conflicts.

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
checks before a write can land. The write path is fail-closed: substantive
authorization, ownership/review gate, policy, visibility, protected-path,
user-lock, version-access, skill-turn, provenance, attribution, or proof
decisions can deny a write, but an unavailable or indeterminate evaluator is
classified as `retryable-failure`.
`retryable-failure.commitState: 'no_canonical_commit_recorded'` means the engine
proved no canonical mutation was applied. `retryable-failure.commitState:
'commit_state_unknown_retry_required'` means the mutation may already be
canonical but acknowledgement failed or cannot be proven; callers must retry with
the same idempotency key instead of issuing a fresh write.
Canonical save success is acknowledged only after the mutation is durably
committed to canonical workspace state and is visible to normal `read` semantics
for that version. `watch` propagation and search indexing are eventually
consistent from canonical state and must not gate write acknowledgment. If the
durability path accepts a non-canonical
holding record, the response is a distinct durable-pending result, not a
successful immediate save. UIs may show that pending record only in explicit
ingest/recovery/status surfaces marked non-canonical. In this spec, "files save
immediately" means authorized writes that pass protection checks become
canonical without an extra human apply/review step.
Write results are explicit:

```ts
type UnixMsDecimalString = string // canonical base-10 Unix epoch milliseconds
type UInt64DecimalString = string // canonical base-10 unsigned 64-bit integer

type DeniedOrQuarantinedStatus =
  | 'rejected_before_acceptance'
  | 'quarantined_authorization'
  | 'quarantined_protection'
  | 'quarantined_review_gate'
  | 'quarantined_attribution'
  | 'quarantined_policy'
  | 'quarantined_visibility'
  | 'quarantined_provenance'
  | 'quarantined_proof'
  | 'quarantined_locked'
  | 'quarantined_version_access'
  | 'quarantined_skill_turn'

type QuarantinedStatus = Exclude<
  DeniedOrQuarantinedStatus,
  'rejected_before_acceptance'
>

type PublicDeniedReasonCode =
  | 'not_authorized'
  | 'review_gate_denied'
  | 'policy_denied'
  | 'visibility_denied'
  | 'protected_path'
  | 'locked'
  | 'version_access_denied'
  | 'skill_turn_denied'
  | 'provenance_denied'
  | 'attribution_denied'
  | 'proof_denied'

// `not_authorized` maps to `rejected_before_acceptance` before durable
// acceptance, and to `quarantined_authorization` for replayed or
// post-acceptance authorization failures.

type PublicValidationErrorCode =
  | 'invalid_request'
  | 'malformed_request'
  | 'missing_precondition'
  | 'incompatible_precondition'
  | 'invalid_path'
  | 'invalid_version'
  | 'replay_metadata_mismatch'

type RetryableWriteFailureCode =
  | 'service_unavailable'
  | 'evaluator_unavailable'
  | 'evaluator_indeterminate'
  | 'quota_exceeded'
  | 'rate_limited'

type TerminalRetirementReason =
  | 'auto_retired_payload_retention_expired'
  | 'operator_disposition_retired'

type ExpiredRetryRecordKind =
  | 'canonical_result'
  | 'retryable_failure_record'
  | 'conflict_record'
  | 'accepted_holding_record'
  | 'rejected_record'
  | 'quarantined_record'
  | 'terminal_retired_record'

type HoldingExpiredRetryRecordKind = Extract<
  ExpiredRetryRecordKind,
  | 'accepted_holding_record'
  | 'rejected_record'
  | 'quarantined_record'
  | 'terminal_retired_record'
>

type NonHoldingExpiredRetryRecordKind = Extract<
  ExpiredRetryRecordKind,
  | 'canonical_result'
  | 'retryable_failure_record'
  | 'conflict_record'
>

type WriteResult =
  | {
      kind: 'canonical'
      workspaceId: string
      versionId: string
      historyMomentId: string
      objectId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
    }
  | {
      kind: 'durable-pending'
      holdingRecordId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      acceptedAt: UnixMsDecimalString
      replayUntil: UnixMsDecimalString
      operatorDispositionDueAt: UnixMsDecimalString
      pendingState:
        | 'pending_protection'
        | 'pending_review'
        | 'pending_canonicalization'
        | 'overdue_disposition'
    }
  | {
      kind: 'retryable-failure'
      workspaceId: string
      versionId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      reasonCode: RetryableWriteFailureCode
      failedAt: UnixMsDecimalString
      retryAfterMs: UInt64DecimalString
      commitState:
        | 'no_canonical_commit_recorded'
        | 'commit_state_unknown_retry_required'
    }
  | {
      kind: 'rejected'
      holdingRecordId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      reasonCode: PublicDeniedReasonCode
      rejectedAt: UnixMsDecimalString
      retentionUntil: UnixMsDecimalString
      rejectionState: 'rejected_before_acceptance'
    }
  | {
      kind: 'quarantined'
      holdingRecordId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      reasonCode: PublicDeniedReasonCode
      acceptedAt: UnixMsDecimalString
      quarantinedAt: UnixMsDecimalString
      operatorDispositionDueAt: UnixMsDecimalString
      retentionUntil: UnixMsDecimalString
      quarantineState: QuarantinedStatus
    }
  | {
      kind: 'terminal-retired'
      holdingRecordId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      retiredAt: UnixMsDecimalString
      reasonCode: TerminalRetirementReason
      retainedMetadata: 'minimal_audit_idempotency_and_explanation_only'
    }
  | {
      kind: 'idempotency-expired'
      recordScope: 'holding'
      holdingRecordId: string
      idempotencyResultId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      expiredAt: UnixMsDecimalString
      recordKind: HoldingExpiredRetryRecordKind
      reasonCode: 'idempotency_expired'
    }
  | {
      kind: 'idempotency-expired'
      recordScope: 'non_holding'
      idempotencyResultId: string
      workspaceId: string
      versionId: string
      idempotencyKey: string
      expiredAt: UnixMsDecimalString
      recordKind: NonHoldingExpiredRetryRecordKind
      reasonCode: 'idempotency_expired'
    }
  | {
      kind: 'conflict'
      workspaceId: string
      versionId: string
      conflictId: string
      idempotencyKey: string
      idempotencyResultId: string
      idempotencyReplayToken: string
      conflictReplayToken: string
      recordedAt: UnixMsDecimalString
      operationKind: 'write' | 'delete' | 'rename' | 'move' | 'replace' | 'merge' | 'restore'
      targetObjectId?: string
      baseObjectId?: string
      currentObjectId?: string
      incomingObjectId?: string
      currentContentHash?: string
      incomingContentHash?: string
      conflictState: 'unresolved' | 'manual_resolution_required'
    }
```

`visibility_denied` is an external public denial reason for visibility-boundary
failures that are rejected before canonical acceptance. Visibility failures that
enter holding storage use `quarantineState: 'quarantined_visibility'` and still
carry `reasonCode: 'visibility_denied'`.

Public `reasonCode` fields are safe closed enums only. Rich evaluator traces,
stack details, policy rule names, secret/path internals, and operator notes stay
server-side and appear only through separately authorized diagnostics.
Malformed requests, missing or incompatible preconditions, invalid path/version
shapes, and replay metadata mismatches return non-persistent
`PublicValidationErrorCode` responses before holding-area persistence. They do
not become `rejected` or `quarantined` `WriteResult` values, do not allocate
holding records, and do not consume denied/quarantined-write quota. Only
server-side authorization, ownership/review gate, policy, visibility,
protection, lock, version-access, skill-turn, provenance, attribution, and proof
failures can enter the durable denial/quarantine flow. Visibility failures use
`visibility_denied` externally and `quarantined_visibility` when accepted into
holding storage.
Transient infrastructure outages are not public denial reasons and must not be
represented as terminal `rejected` or `quarantined` outcomes. They return the
distinct `kind: 'retryable-failure'` shape, preserving any idempotency key for a
later retry while preserving commit-state uncertainty when the engine cannot yet
prove whether a canonical mutation was acknowledged.
`retryable-failure` participates in the same idempotency-result envelope as
write, conflict, and durable-pending results: repeated delivery with the same
operation fingerprint returns the same `idempotencyResultId`,
`idempotencyReplayToken`, and `commitState` until retry handling can prove and
return a canonical/durable result or a deterministic terminal outcome.
Before acknowledging `kind: 'retryable-failure'`, the engine must durably
persist that idempotency result state for the same workspace, version,
idempotency key, operation fingerprint, `idempotencyResultId`,
`idempotencyReplayToken`, and `commitState`. If the retryable-failure result
state itself cannot be persisted, the engine must not acknowledge a replayable
`WriteResult`; the caller must retry until the engine can durably record and
replay the outcome or prove a canonical/durable result.
`commitState` on `retryable-failure` is the single source of truth for whether a
canonical mutation is known absent (`no_canonical_commit_recorded`) or unknown
and requires retry (`commit_state_unknown_retry_required`). If retry handling
later proves the canonical mutation was recorded, it returns the canonical or
durable result rather than continuing to return `retryable-failure`.
Retryable failures always carry the original `idempotencyKey` and a non-optional
`retryAfterMs` minimum delay. Callers must not retry the same idempotency key
before that delay elapses; the engine chooses the delay for
`service_unavailable`, `evaluator_unavailable`, `evaluator_indeterminate`,
`quota_exceeded`, and `rate_limited` so retry pressure is bounded by policy
rather than by each caller. Retries must preserve the original idempotency key.
`terminal-retired` is a first-class terminal `WriteResult` while
its retained retirement metadata is addressable; it degrades to
`idempotency-expired` only after the retained idempotency/retry metadata for the
retired record has expired.

Non-persistent validation failures are separate from durable rejected writes:
malformed requests, missing preconditions, invalid path/version shapes, and
replay metadata mismatches return `PublicValidationErrorCode`, allocate no
`holdingRecordId`, and store no `rejectedAt`, `acceptedAt`, or `quarantinedAt`.
Durable `rejected` and `quarantined` ingests live in a non-canonical holding area
with enough metadata to explain the decision, retry where allowed, or audit the
outcome after evaluators recover. `rejected` means the write failed a protection
gate before canonical acceptance and stores `rejectedAt`; `quarantined` means
the write was accepted into the holding area but could not become canonical and
stores `acceptedAt` plus `quarantinedAt`. Both durable results carry the required
`versionId` for the requested or accepted version bound to the holding record.
Both durable results are addressable by `holdingRecordId`; operators, status
APIs, retry tooling, and audit/export jobs use that id to correlate the response
with the retained rejected-before-acceptance or quarantined record.
The holding area separates rejected-before-acceptance items from accepted
holding records. It must be abuse-resistant: enforce per-workspace and
per-actor quotas, bounded retention/TTL, payload size caps, rate limits, and
deterministic backpressure so ingest floods cannot exhaust storage or starve
canonical durability paths. TTL eviction applies only to
rejected-before-acceptance items. Accepted holding records are durable accepted
writes, even though they are not yet canonical workspace state. They must remain
recoverable with reconstructible payload and retry metadata until protection
checks succeed and canonicalization completes, until explicit operator
disposition is recorded for a record that cannot safely become canonical, or
until the finite `AcceptedHoldingRecordPolicy.maxRecoverableHoldingPayloadMs`
hard cap is reached. For accepted holding records, any TTL, retry-horizon,
compaction, or colder-storage policy may throttle retries, compact derived
retry/index metadata, or move accepted payload bytes to colder durable storage,
but it must preserve reconstructible payload bytes until one of those three
events occurs. If the hard cap wins before canonicalization or disposition, the
record transitions to `terminal-retired` and payload bytes may be deleted,
cryptoshredded, or compacted into non-reconstructible evidence. If a
rejected-before-acceptance item expires, or if an accepted record is retired
through explicit disposition or payload-retention expiry, the engine preserves
durable rejection, disposition, retirement, or expiration evidence. Humans,
agents, imports, and sync processes all get the same guarantee: an accepted
change is not silently lost inside the recoverable window, but it also does not
become canonical workspace state until protection checks pass.
Accepted records still have a bounded operator-visible lifecycle. The Phase 0
decision note defines
`AcceptedHoldingRecordPolicy.maxPendingCanonicalizationMs`,
`operatorDispositionDueAt`, and a mandatory finite
`AcceptedHoldingRecordPolicy.maxRecoverableHoldingPayloadMs`; when the
canonicalization deadline is reached, the record must be escalated into an
explicit disposition queue, marked overdue in status APIs, and only derived
retry/index metadata may be compacted or moved to colder durable storage
according to policy. Garbage collection may remove only derived retry/index
metadata after the disposition deadline while the operator window is open; the
reconstructible payload remains until
canonicalization succeeds, an explicit operator disposition record retires it,
or the effective finite `maxRecoverableHoldingPayloadMs` bound is reached.
`operatorDispositionDueAt` marks the item overdue for operator/status handling;
it does not itself cryptoshred or compact reconstructible bytes.
Deadline precedence is fixed when lifecycle fields disagree:
`replayUntil` controls how long the idempotency result must replay and never
extends reconstructible payload retention; `operatorDispositionDueAt` and
`maxPendingCanonicalizationMs` control when `pending_canonicalization` becomes
`overdue_disposition`; `retentionUntil` and
`maxRecoverableHoldingPayloadMs` control reconstructible payload retention, with
the earlier effective payload-retention deadline winning. If payload retention
expires before `replayUntil`, the record transitions exactly once to
`terminal-retired` with reason
`auto_retired_payload_retention_expired`; retries before `replayUntil` replay
that minimal terminal result without reconstructible bytes. Only retries after
`replayUntil` may return `idempotency-expired`.
No accepted holding record may remain recoverable forever: if no
workspace-specific recovery-retention policy is configured, the engine's default
finite `maxRecoverableHoldingPayloadMs` applies, and workspaces may only choose
values inside the product/org maximum. When the effective maximum recovery
window is reached, still-unresolved accepted records must enter terminal
retirement with `auto_retired_payload_retention_expired`: payload bytes are
deleted, cryptoshredded, or compacted into a non-reconstructible evidence
record, while minimal metadata needed for audit, idempotency expiry, abuse
controls, and user-facing explanation is retained.
Status APIs and retry tooling represent that state as a `terminal-retired`
`WriteResult` for the same `holdingRecordId`; they must not collapse it into
`rejected`, `quarantined`, conflict, or generic expiration.
Holding-record retries apply only when a real `holdingRecordId` exists. Retries
using the same idempotency key, `holdingRecordId`, and matching replay metadata
derive the response from the holding record's current durable state, not only
from the original `replayUntil` window. If the accepted record has promoted,
retry returns the canonical result or deterministic equivalent. If it is still
accepted but not promoted, retry returns `durable-pending` while the
idempotency/retry horizon allows key reuse. If it has become `rejected`,
`quarantined`, or `terminal-retired`, retry returns that current state while the
corresponding retention or retirement metadata is still addressable. Only after
the holding record's retry horizon or retained idempotency metadata expires does
the write API return the canonical `idempotency-expired` response for that
`holdingRecordId`, with `recordKind: 'accepted_holding_record'`,
`recordKind: 'rejected_record'`, `recordKind: 'quarantined_record'`, or
`recordKind: 'terminal_retired_record'`.
Canonical writes, retryable failures, and conflicts without holding records use
the terminal idempotency replay path with the persisted `idempotencyResultId`
and `idempotencyReplayToken` only; they do not require or accept
`holdingRecordId`. Those terminal replay records use
`recordKind: 'canonical_result'`, `recordKind: 'retryable_failure_record'`, or
`recordKind: 'conflict_record'`, and the retryable-failure/conflict cases remain
terminal replay records rather than holding-record retries. Disposition,
expiration, and lookup-only details beyond that canonical terminal response live
in the status query path, not alternate write-retry responses. A stale retry
must not silently create a second accepted holding record or an uncorrelated
denial.
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
Replay from the holding area must be causal and fail-closed. Retry metadata must
include `workspaceId`, `versionId`, and the `expectedBaseVersion`, content hash,
or equivalent CAS token captured with the original ingest. At apply time, the
engine revalidates workspace scope plus server-derived authorization,
ownership/review gate, policy, visibility, protected-path, lock, version-access,
skill-turn, provenance, attribution, and proof checks. The retry outcome matrix
is deterministic for the same replay metadata:

Replay evaluation is first-match in this order; once a class matches, later
checks cannot replace its `reasonCode`, `quarantineState`, or validation result:
malformed/cross-scope binding, authorization/permission, ownership/review gate,
policy, visibility, protected-path, lock, version-access, skill-turn,
provenance, attribution, proof, then causal base conflict. If multiple
server-derived checks fail in one replay attempt, the earliest matching class in
that order wins.

- If workspace/version binding metadata is malformed, mismatched, crosses
  workspace scope, or cannot be proven before a holding record exists, return a
  `PublicValidationErrorCode` before holding-area persistence. Only
  already-persisted accepted records with syntactically valid replay metadata but
  unresolved server-side provenance or binding evidence can stay quarantined or
  manual-only while resolution proceeds.
- If server-derived authorization, permission, ownership/review gate, policy,
  visibility, protected-path, lock, version-access, skill-turn, provenance,
  attribution, or proof checks fail after replay, the record resolves to the
  corresponding durable denial/quarantine state.
  Authorization and permission failures use `not_authorized` externally and
  `quarantined_authorization` internally.
  Ownership or review-gate failures use `review_gate_denied` externally and
  `quarantined_review_gate` internally; replay cannot become canonical until
  the required server-side review decision is satisfied or the durable record is
  explicitly disposed.
  Policy failures use `policy_denied` externally and `quarantined_policy`
  internally.
  Protected-path failures use `protected_path` externally and
  `quarantined_protection` internally.
  Visibility-boundary failures use `visibility_denied` externally and
  `quarantined_visibility` internally; they must not be collapsed into
  `policy_denied` or `not_authorized`.
- If the causal base is stale, advanced, missing, or otherwise no longer matches
  the target version state, the retry returns a deterministic `conflict` and
  preserves the incoming record for manual reconciliation. Stale causal state is
  not classified as quarantine or rejection.
- If the captured causal base still matches and apply-time policy revalidation
  passes, the record may become canonical.

The same replay metadata cannot move between these classes across attempts
unless the durable record itself changes state through an explicit operator,
policy, or conflict-resolution action.

Workspace scoping is a required data-model invariant, not just an authorization
check. Every persisted atom, folder, entity, share, capture, file object,
version, event, chat link, projection, history record, holding record, conflict
envelope, conflict replay token, durability-log entry, idempotency result, and
idempotency tombstone carries `workspaceId`. Write, read, query, search, import,
sync, and projection boundaries reject cross-workspace references by default,
even when an actor is otherwise valid.

Review gates are enforced whenever workspace policy, protected-path rules,
ownership rules, skill-turn policy, or visibility policy requires them, including
ordinary writes. Boundary-crossing cases add more review points; they are not the
only review triggers:

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
5. Does policy require mandatory review before this write can become canonical?
6. Can the change be recorded durably?
7. Can the system preserve recovery and honest provenance?
8. Does the change create a conflict or cross a visibility boundary?

If the actor can write, all required policy/review gates pass, and the change
does not create a conflict or cross a visibility boundary, the change saves
immediately to that version. If the change creates a conflict, crosses a real
visibility boundary, or requires mandatory review before canonicalization, it
routes to conflict preservation/reconciliation or the relevant review/share flow
instead of the immediate canonical save path.

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
stale, or substantively invalid, the ingest is quarantined or rejected; if the
required evaluator is unavailable or indeterminate, the ingest returns
`retryable-failure` and does not become canonical. It must not be downgraded
into unverified local/session provenance. Sync/import flows must preserve their
original provenance class. Only truly passive ordinary OS writes with no
dohc-controlled agent/run context may remain local/device/session provenance
when proof is absent; import/sync ingests without proof stay quarantined until
they can be attributed or rejected.
Unverified local, device, or session edits still pass through server/engine-side
workspace ownership, lock, protected-path, and visibility checks before they
become canonical workspace state. If the engine cannot prove the required access
or policy/skill-turn state because the evaluator is unavailable or
indeterminate, the ingest returns `retryable-failure`; substantive denial,
missing proof, or invalid proof is quarantined or rejected rather than trusted.
Substantive visibility failures use the dedicated `visibility_denied` response
reason, with the durable record marked as `quarantined_visibility` when the
payload was accepted into holding storage for recovery or operator disposition.
Local provenance does not bypass that evaluator when the write is being applied
through a dohc-controlled agent/tool action.
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
   - durability-ack boundary: no write result is acknowledged until the
     durability-log record is persisted to recoverable storage, or an equivalent
     durability guarantee exists, so acknowledged writes survive process
     crash/restart.
   - canonical-write-success boundary: an immediate-save success is acknowledged
     only after the canonical mutation is durable and visible through `read`.
     `watch` catches up asynchronously. A durability ack without canonical
     visibility can return only `durable-pending`, `retryable-failure`,
     `rejected`, `quarantined`, `idempotency-expired`, `terminal-retired`, or
     `conflict`, never `canonical`.
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
API writes, or normalize benign serializer/formatter changes and preserve only
semantic mismatches as conflicts if the driver cannot round-trip them safely.
The driver decides clean round-trip by parsing the edited Markdown projection,
applying the canonical serializer/formatter normalization, and comparing the
resulting semantic Y.Doc operation against the causal base captured when the
projection was materialized. If the normalized semantic operation applies
cleanly to the current Y.Doc under that precondition, the write commits through a
Y.Doc transaction. If parsing loses structure, serializer normalization changes
meaning, or the causal base no longer matches, the write returns a semantic
conflict with current Y.Doc state and incoming Markdown preserved for
reconciliation.
The engine regenerates Markdown/`atoms.body` from the canonical Y.Doc after a
successful commit; direct file edits must not create a second authoritative body
that can diverge from Y.Doc state.

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

Normal filesystem saves are translated into the same semantic write contract as
`write(workspaceId, versionId, path, bytes, ...)`, but they do not require an
external editor or agent to synthesize a client precondition. When a file is read
or materialized, or when a new local path is first created/imported, the engine
records exactly one engine-owned capture/replay token for that path, such as the
last seen base version, etag, content hash, absence assertion, watcher sequence,
or session capture id. First-write bootstrap uses an engine-owned
`expectedAbsent`-equivalent token for a path with no prior object, not a missing
token. When the file is saved or captured, the filesystem path submits that
engine-owned token with the incoming bytes. Missing or ambiguous engine capture
tokens fail closed through quarantine or retryable capture failure; a well-formed
but stale capture token is a real write conflict and returns the same
deterministic current-vs-incoming conflict behavior as the API write flow instead
of blindly overwriting canonical state.

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

Single-operand API writes require exactly one client-supplied causal
precondition; multi-operand API writes such as `replace(...)` and `merge(...)`
must provide one precondition per guarded operand in the `precondition`,
`sourcePrecondition`, or `destinationPrecondition` field that applies to that
operand. Missing preconditions or multiple incompatible guards for the same
operand are malformed request/protocol errors and fail closed before the
conflict path. Filesystem capture uses the engine-owned capture/replay token
described above instead; native local edits are not malformed merely because no
client-supplied precondition exists.

`rename(...)` is the same-directory basename-change operation: `fromPath` and
`toPath` must share a canonical parent path, and the destination must be absent.
`move(...)` is the cross-directory relocation operation: the canonical parent
path changes, the destination must be absent, and the same source precondition,
`sourceObjectId`, `destinationPrecondition`, and `idempotencyKey` rules apply.
Destination-present path changes are not `rename(...)` or `move(...)`; they must
use `replace(...)` with both source and destination identities.

The filesystem is one interface. It should not be the only possible execution
environment.

Read-only API responses and streamed events must be bound to the requested
`workspaceId`, every requested version identifier, and a request token, epoch, or
equivalent correlation id. Single-version reads bind `versionId`; pairwise reads
bind the full requested pair such as `versionAId`/`versionBId`; merge/diff
previews bind their source and target version identifiers. Async reads such as
`list(...)`, `stat(...)`, `search(...)`, `snapshot(...)`, and `diff(...)` must
accept abort semantics or an equivalent request-cancellation contract, and the
server must abort or drop any in-flight response whose token, workspace, or
requested version no longer matches the active request; callers should still
ignore late responses defensively. `watch(...)` events must carry the same
binding and must stop or no-op after abort, workspace switch, or version switch.
A stale read or watch event from one workspace or version set must never repaint
or leak data into a newer workspace context.

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
operand tuple, and causal precondition set. If the same idempotency key
reappears with a different actor/session, workspace, version context, operation
type, target, payload digest, operand tuple, or causal precondition set, return
the non-persistent `replay_metadata_mismatch` validation error before
holding-area persistence instead of minting a new idempotency identity. The
operand tuple includes materially distinguishing values such as source/destination
paths, sourceVersionId, targetVersionId, versionA/versionB identifiers,
checkpointId, snapshot ids, merge inputs, and restore targets as applicable, so
different `merge(...)`, `replace(...)`, or `restore(...)` requests cannot collide
under one key. Duplicate delivery with the same idempotency key must return the
original result or a deterministic equivalent and must not create additional
canonical mutations, duplicate history events, duplicate projections, or
repeated notification/search side effects.
Conflict results are replay-guaranteed too. Before returning `kind: 'conflict'`,
the engine persists the conflict envelope, `conflictReplayToken`, and
idempotency result for the same workspace/version/idempotency identity. A retry
with matching replay metadata returns that same conflict envelope even if later
workspace state changes. If the engine cannot persist the conflict envelope and
idempotency tombstone durably, it must not acknowledge the conflict response.
It returns `kind: 'retryable-failure'` for the same idempotency identity with
`reasonCode: 'service_unavailable'`, commitState
`'commit_state_unknown_retry_required'`, and a non-optional `retryAfterMs`
minimum delay. A retry
with matching replay metadata must either finish and replay the durable conflict
result, prove and return a canonical/durable result, or continue returning the
same retryable failure until the commit state is no longer unknown.
Idempotency records must be persisted through the documented maximum retry
horizon for that operation type and transport after the operation reaches a
terminal result. The idempotency record/tombstone must be committed in the same
transactional boundary as the canonical mutation. All derived side effects
including projections, notifications, search indexing, and export/index fanout
must be recorded in a durable outbox or side-effect ledger committed with the
same workspace/version/idempotency identity. Retries replay, complete, or
suppress side effects from that ledger exactly once; duplicate deliveries must
not emit duplicate projections, notifications, search updates, export records,
or other derived work. If an implementation cannot share a transaction boundary,
it must provide an equivalent write-ahead guarantee: reserve the idempotency key
durably before applying the mutation, make recovery complete either the original
mutation plus side-effect ledger or tombstone the reserved key deterministically,
and never acknowledge success until the idempotency result, canonical mutation,
and required side-effect outbox entries are durable together. After the retry
horizon, an API retry with the same key must fail closed with an explicit
`idempotency_expired` response or a deterministic conflict response; it must not
silently apply as a new mutation. Implementations may garbage-collect expired key
tombstones only after the same maximum retry horizon has passed or the operation
namespace is rotated.

### Idempotency Retry Horizons And WorkspaceIdempotencyPolicy

This PR00 section is reference-only for retry-horizon names and invariants. It
does not own numeric baselines. PR 01's shared `WorkspaceIdempotencyPolicy`
contract is the sole source of truth for the numeric values of:
`apiWriteTerminalRetryHorizonMs`, `apiWriteTombstoneRetentionMs`,
`filesystemCaptureDedupHorizonMs`, and
`filesystemCaptureTombstoneRetentionMs`. This spec and the native filesystem
spec may reference those policy names, but must not duplicate values before PR
01 lands the shared contract. Implementation PRs must not ship independent
defaults before that contract lands. Any PR that sets or changes the values must
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

Visibility is resolved by intersection, not by last-writer-wins. The engine
evaluates the applicable scopes in this order and each later scope may narrow
but not silently broaden the effective audience:

1. workspace ceiling.
2. version ceiling.
3. path/folder policy.
4. workspace object policy.
5. projection/view policy.
6. moment/change policy.
7. shared-export grant.

`redacted` is a content-deny cap and wins for the covered payload even when a
broader scope says `workspace` or `public`; only an authorized placeholder or
opaque reference may render. Active `embargoed` is a time/condition cap: while
the embargo is active it behaves as hidden for unauthorized readers, and when
the embargo expires the engine recomputes visibility from the remaining scopes.
`private`, `shared with selected people`, `workspace`, and `public` compose as
increasingly broad audiences, so the effective audience is the intersection of
all non-redacted, non-embargoed scopes plus server-side authorization. A public
object inside a private version is not public; a workspace-visible folder inside
a selected-person shared export is visible only to the selected export
participants; a public export can include a resource only when the export grant
explicitly includes it and no workspace/version/path/object/projection/moment
scope narrows or redacts it for that viewer. Explicit shares and shared exports
are allowlists over the resolved resource graph, not bypasses around ordinary
workspace, version, path, object, projection, moment, secret, and policy checks.

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
9. E2E proves fail-closed behavior when authorization, ownership/review gate,
   policy, visibility, protected-path, lock, version-access, skill-turn,
   provenance, attribution, or proof decisions deny access, and retryable
   no-mutation behavior when required evaluators are unavailable or
   indeterminate.
10. E2E proves plaintext secrets do not enter durability-log payloads, history,
    diffs, export bundles, search indexes, or agent logs.
11. E2E proves every persisted atom, folder, entity, share, capture, file,
    version, event, chat link, projection, and history record is
    workspace-scoped, and that cross-workspace references are rejected by
    default.
12. E2E proves holding-area replay is causal: stale base/CAS tokens degrade to
    conflict/manual reconciliation, while malformed or cross-scope
    workspace/version bindings fail validation before holding storage.
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
