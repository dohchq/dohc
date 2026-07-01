# dohc Native Filesystem Design

Status: exploratory architecture direction
Cohort: dohc Think Bigger Workspace Engine
Think Bigger Spec: true
Date: 2026-06-23

Companion: `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`

## Core thesis

dohc should feel like a normal folder on the user's computer, but that folder
should be backed by a versioned workspace engine.

The user-facing promise:

> Your workspace is just files. Humans and agents can use normal editors,
> terminals, and tools. dohc quietly adds versions, history, sync, virtual
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

Editing a file is captured immediately for the version represented by that
folder or mount once the engine has bound the save to the active workspace,
immutable version, and server/engine-derived principal. Local capture is not the
same as canonical history: the write becomes canonical only after the
quarantine/reconcile/promote path validates workspace, version, policy, and
conflict rules. For allowed canonical writes there is still no user-visible
commit step, apply step, or special agent protocol.

When local capture is accepted but canonical promotion is still pending, callers
must receive the shared `WriteResult.kind: 'durable-pending'` shape with a
`holdingRecordId`, not a successful canonical write. Rejection, quarantine, and
retryable/terminal failures are distinct client-visible outcomes.
Accepted-but-not-yet-promoted writes surface only as `durable-pending`; this spec
does not define a separate `accepted-pending` status name.

The authoritative native-filesystem write-result vocabulary is the shared
versioned-workspace `WriteResult.kind` enum:

- `canonical`: the write was promoted into canonical workspace history.
- `durable-pending`: the write was captured durably in holding storage with a
  `holdingRecordId`, but has not been promoted yet.
- `conflict`: promotion found a preserved base/current/incoming conflict
  envelope.
- `quarantined`: capture or promotion cannot safely continue without an
  explainable holding record and later disposition.
- `rejected`: validation reached an authorization, policy, visibility,
  protection, lock, version-access, skill-turn, provenance, attribution, or proof
  denial before canonical acceptance.
- `retryable-failure`: infrastructure or evaluator state is unavailable or
  indeterminate, and the same operation should retry with its original
  idempotency identity.
- `terminal-retired`: a previously retained holding or idempotency record is no
  longer actionable but still has minimal audit/idempotency metadata; this is a
  lifecycle/retention state for records the engine can still identify.
- `idempotency-expired`: the retry horizon has passed, so the old key cannot be
  silently treated as a new write; this is a retry-horizon outcome for late
  retries after the retained idempotency metadata is no longer actionable.

Native capture maps outcomes through that enum only: accepted-but-not-promoted
writes return `durable-pending`; policy denials return `rejected`; suspicious,
reserved, malformed-after-capture, or indeterminate local filesystem material
returns `quarantined`; transient capture/promote outages return
`retryable-failure`; conflict preservation returns `conflict`; successful
promotion returns `canonical`; holding-retention expiry returns
`terminal-retired`; and `idempotency-expired` is reserved for retries that arrive
after the configured retry horizon has elapsed. Capture, retry, and status paths
must use that boundary consistently: lifecycle/retention transitions are
`terminal-retired`, while late retry attempts after the retry horizon are
`idempotency-expired`.
Persisted workspace status surfaces, including `.dohc/status.json`, API status
responses, and UI badges, must not serialize `idempotency-expired` as durable
workspace state. They serialize the current lifecycle state, such as
`terminal-retired`, and return `idempotency-expired` only from retry-flow APIs for
late attempts against an expired idempotency/replay horizon.

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
workspace. They are not ordinary user-created folders. Reconciliation runs the
reserved-namespace scan before any generic materialized workspace walker applies
its default `.versions/**` skip rule. That scan enumerates and classifies every
`.versions` tree: engine-bound `.versions/<version>/` mounts for the active
workspace are handed to the engine's workspace/version mount resolver, and only
that resolver may enter each managed root with an explicit workspace/version
binding. Managed `.versions/<version>/` is opt-in per attached workspace, not a
retroactive reservation on every existing folder named `.versions`.
Before a workspace opts into the managed namespace, ordinary user-created
`.versions/**` content is classified by the reserved-namespace scan as
`legacy_unmanaged_versions_content`; the materialized workspace walker may then
ingest it as ordinary user content for that workspace, while the
workspace/version mount resolver must refuse to treat it as a named-version
mount. Activation surfaces a user-facing migration choice instead of immediate
quarantine: move the legacy content to a collision-proof ordinary path, bind
eligible children as managed versions, preserve the legacy content outside the
future skipped namespace while choosing another managed namespace, or cancel
activation. Activation is all-or-nothing: either every legacy `.versions/**`
entry is moved, explicitly reclassified, or preserved outside the skipped
namespace in the same cutover that records the workspace
`versionsNamespaceMode: 'managed_versions'`, or the workspace remains
`legacy_unmanaged`, the materialized workspace walker continues treating those
entries as ordinary content, and the workspace/version mount resolver still
refuses to enter them as managed roots. Managed-namespace opt-in cannot be
finalized while legacy unmanaged entries still live under a `.versions/**` path
that the ordinary walker will skip. Only after the cutover commits may the
ordinary content walker apply the default `.versions/**` skip rule and may the
workspace/version mount resolver own named-version mounts. On any activation
failure, the workspace record, ordinary-walker skip rule, and resolver-owned
mount bindings roll back together. After the cutover commits, unmanaged entries
created under `.versions/**` are still detected by the reserved-namespace
scan/watcher path before the ordinary walker applies its skip rule. If an entry
is not bound to a known workspace/version mount by the workspace/version mount
resolver, it fails closed into quarantine or manual resolution. Unmanaged
entries are never silently ignored, skipped, or promoted into a named version.
The activation path must also persist a workspace-wide
`versionsNamespaceActivationFence` beside `versionsNamespaceMode` before any
scan, move, reclassify, or mount-binding work begins. The fence carries a
monotonic migration generation, the activation decision, the set of planned
legacy-path outcomes, and status `activating`, `committing`, or `rolling_back`.
While the fence is present, the ordinary materialized workspace walker and the
workspace/version mount resolver must honor that generation: generic walkers may
not blindly skip `.versions/**`, resolvers may enter only generation-bound
managed roots, and concurrent local/API writes under `.versions/**` are held in
the same quarantine/manual-resolution path instead of racing the cutover. If the
process restarts mid-activation, startup reloads the fence and resumes the
commit or rollback using the recorded generation before ordinary walking or
managed mount resolution can proceed. The fence is cleared only after the
activation transaction has durably committed every move/reclassification,
resolver binding, skip-rule transition, and
`versionsNamespaceMode: 'managed_versions'`; rollback restores the previous
mode, walker behavior, and resolver bindings before clearing the fence.

The path is an affordance, not the security boundary. The engine resolves the
active workspace, immutable version, effective file policy, and
server/engine-derived principal before a raw local write can enter workspace
durability capture. A pre-auth local filesystem event may be placed in an
isolated device-local spool or quarantine envelope for crash recovery and user
explanation, but that envelope is not workspace durable state: it is not version
history, not searchable, not synced, not exported, and not visible through
workspace APIs. Only after workspace/version binding and principal resolution
succeed may the engine append a captured write to the workspace durability log;
then the normal policy path decides whether it becomes canonical,
durable-pending, quarantined, rejected, retryable-failure, or conflict.

Reserved namespace collisions fail closed. Reserved namespace handling for
import, attach, sync, and raw filesystem scan is defined by this table:

| Candidate | Import / Attach / Sync / Raw Scan Action |
| --- | --- |
| Allowlisted policy inputs: `.dohc/files.toml`, `.dohc/visibility.toml` | Parse as engine policy input outside the ordinary captured-content pipeline. |
| Known engine-owned `.dohc/**` projections, status, conflict, index, cache, and durability internals | Classify as reserved engine state and route only to engine-specific recovery/status handling with an explainable reserved-internal disposition; never silently skip or re-ingest as user content. |
| Foreign non-allowlisted `.dohc/**` or aliases of `.dohc` where dohc expects engine state | Quarantine with an explainable record or send to manual resolution; never propose ordinary user-content safe rename. |
| Managed `~/dohc/<workspace>/.versions/<version>/` bound to a known workspace/version by the engine | Allow only through the engine workspace/version mount resolver, not generic tree walkers. |
| Pre-opt-in ordinary `.versions/**` content in an existing attached workspace | Classify as `legacy_unmanaged_versions_content`; allow ordinary-content ingest only through the materialized workspace walker, never through the workspace/version mount resolver, and surface the explicit migration choices before managed namespace activation. |
| Unmanaged or out-of-contract `.versions/**` or aliases of `.versions` after managed namespace opt-in, or where dohc already expects engine state | Quarantine with an explainable record or send to manual resolution; never silently promote into a named version. |
| Ordinary user content outside engine-managed namespaces that collides with a reserved namespace | May receive a deterministic collision-proof safe-rename proposal before activation. |

Only ordinary user content outside engine-managed namespaces may be proposed for
a deterministic collision-proof safe rename before the workspace is activated.
`.dohc/**` and `.versions/**` collisions remain quarantine-only or
manual-resolution-only. Secret-backed or secret-eligible inputs never receive
deterministic safe rename proposals from raw scan/import/attach flows; they stay
in quarantine records or manual resolution unless a separate explicit
authorization flow emits a fully opaque replacement label. Quarantine records for
secret-backed or secret-eligible inputs must redact sensitive basenames, raw
hashes, and path details, using opaque placeholders or keyed commitments instead.
Safe rename proposals must never overwrite existing user content; destination
names are derived only from a stable sanitized basename plus a workspace-scoped
content/id hash for ordinary non-secret inputs, then reserved atomically at
activation time with create-if-absent, `O_EXCL`, or an equivalent exclusive
reservation primitive. A non-atomic check-then-create flow is not allowed.
Activation may proceed only if the reservation succeeds; reservation failure is
a fail-closed collision that stays in quarantine or manual resolution only when
the exclusive reservation proves an actual destination-name collision. Transient
mount, storage, permission-probe, or reservation-service failures are classified
separately as `retryable-failure` or the equivalent retryable capture outcome;
they do not consume collision disposition or become safe-rename quarantine
records unless a real namespace collision is proven.
Internal non-allowlisted `.dohc/**` state is never re-ingested as user content,
and unmanaged `.versions/**` content is never silently promoted into a named
version. Pre-opt-in legacy `.versions/**` content that the reserved-namespace
scan classified as `legacy_unmanaged_versions_content` remains ordinary user
content until the user completes one of the explicit migration choices.

Path canonicalization must happen before API path handling, import, attach,
sync, raw filesystem scan, watcher reconciliation, or policy evaluation, and
before any storage access. Canonicalization first normalizes separators,
collapses repeated separators, resolves `.` segments, rejects unresolved `..`
traversal, rejects platform device/UNC/root-escape forms outside the workspace
contract, then normalizes path segments to Unicode NFC and applies one
workspace-wide path-equivalence profile for all mounts, scans, API calls, sync
clients, and imports. That profile must define case sensitivity/folding and
Unicode equivalence once for the workspace; mounts or filesystems that cannot
enforce the profile are rejected, quarantined, or attached read-only until a
compatible projection is available. Workspace-boundary resolution and
reserved-namespace checks use that same workspace-level identity rule, so
composed/decomposed or case variants cannot resolve differently on different
clients or bypass the same `.dohc/**` and `.versions/**` rules. If two distinct
native paths normalize to the same canonical workspace path after NFC,
case-folding, or the workspace equivalence profile, import, reconciliation,
scan, API dispatch, and storage access fail closed: all colliding candidates are
quarantined or activation aborts until the user resolves the collision. The
engine must not merge the paths, alternate between them, or pick a winner
implicitly. After
canonicalization, reserved namespace
handling is defined only by the reserved-namespace collision contract above: the
allowlisted policy inputs are `.dohc/files.toml` and `.dohc/visibility.toml`;
workspace-root `.dohcignore` import, precedence, and source-band semantics are
deferred to a later PR and must not be parsed as live policy input in this phase.
All other `.dohc/**` content and post-opt-in unmanaged `.versions/**` fail
closed into rejection, quarantine, or manual resolution. Pre-opt-in legacy
`.versions/**` content follows the compatibility path defined by the
reserved-namespace scan, materialized workspace walker, and workspace/version
mount resolver above. Safe rename proposal remains available only for non-engine
user content that collides with a reserved namespace. Hardlinks are prohibited in
writable or materialized workspace
projections, including same-workspace hardlinks, because multiple paths sharing
one inode break the path-centric object
identity model; capture/API paths reject or quarantine them before treating the
path as workspace content. Symlinks, junctions, bind mounts, aliases, or any
equivalent filesystem indirection that resolves outside the active workspace,
crosses into another workspace, or enters a disallowed reserved namespace must be
rejected or quarantined before capture or API dispatch. If the engine cannot
prove the resolved target and file identity are inside the active workspace
boundary, it fails closed. This path boundary applies to every API path operation
and file capture that may back an atom, folder, entity, share, or capture record.
Canonicalization must also be TOCTOU-safe: after a path is resolved, subsequent
stat/read/write/capture work must use the same verified descriptor, handle,
inode/file-id binding, or equivalent identity-bound mechanism. The engine must
not validate one path and then reopen a different path for content. If the
handle identity no longer matches the canonicalized path, workspace, version,
or reserved-namespace decision, the operation is quarantined or rejected.

Identity-light discovery is allowed; identity-light workspace capture and commit
are not. During reconciliation, each raw local write must resolve an active
workspace, immutable version, source mount binding, effective policy envelope,
and server/engine-derived principal before it is appended to the workspace
durability log or persisted into version history. Unauthorized, unbound, or
indeterminate writes remain in isolated local spool/quarantine state rather than
being merged into canonical history or treated as durable workspace capture.
Promotion to shared history waits for fresh server/engine-derived validation.
Before classification and policy checks complete, secret-eligible captures that
include payload bytes must retain an encrypted payload envelope plus metadata
until the write is promoted or explicitly discarded. Metadata-only quarantine is
allowed only for pure discovery events that did not read or write payload bytes.
Quarantine must not persist plaintext secret bytes in ordinary durability
payloads, logs, search, previews, or conflict artifacts.
Authorization/policy resolution is fail-closed: if authoritative workspace
membership, share state, lock state, or effective-policy inputs are stale,
unavailable, or indeterminate, the write remains quarantined and is not promoted
into version history until fresh server/engine-derived validation succeeds.

## Same rules for humans and agents

dohc should not make agents second-class writers.

If an actor has version-level write access and passes the path-level policy
checks below, the actor can edit files in that version. Version membership alone
does not bypass user locks, folder/atom access, sharing boundaries, protected
paths, skill-turn gates, or any other effective-policy check. The actor can be:

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
Managed mounts and dohc-controlled agent launches must bind the capture session
to an active server/engine-derived principal before writes can promote to
version history. Ordinary local editor and shell writes use the same
server-derived principal resolution path; OS session binding and explicit attach
tokens are inputs to that derivation, never independent promotion authority.
Before quarantine can be lifted, the capture/promotion policy path must perform
explicit server/engine validation and the same policy checks for workspace scope,
user locks, folder/atom access, sharing boundaries, protected paths, and
skill-turn gates. If a raw OS write arrives without a resolvable active
principal, dohc may record device/session provenance in the local durability log,
but promotion to canonical history stays quarantined until a valid principal and
policy decision are established.

## Local capture and reconciliation

External edits are not an edge case. They are the core promise.

If a user edits `notes/todo.txt` in a native editor, IDE, terminal editor, shell
script, or agent CLI, dohc should notice the same kind of file change.

Phase 0 should use a normal folder plus reconciliation:

1. **First open/import**
   - Walk the materialized workspace tree.
   - Apply file policy.
   - Assign stable object IDs.
   - Store `workspaceId`, source mount binding, and either a canonical path for
     ordinary entries or an opaque/redacted path token for protected,
     secret-backed, or engine-managed entries. File identity where available,
     size, mtime, immutable `versionId`, version/base metadata, and either a
     plain content hash for ordinary non-secret entries or a keyed commitment /
     opaque authorized hash handle for protected or secret-backed entries are
     stored with that redacted form; the real protected path remains only inside
     the authorization envelope.

2. **While dohc is running**
   - Use OS file watching for create/modify/delete/rename events.
   - Debounce noisy save sequences.
   - Stat and hash changed candidates.
   - Resolve workspace, immutable version, source mount binding,
     server/engine-derived principal, and effective file policy before appending
     tracked changes to the workspace durability log. If any binding is missing,
     ambiguous, stale, or indeterminate, keep the event in isolated local
     spool/quarantine state and do not expose it as workspace history, search,
     sync, export, status success, or an API-visible capture.
   - Append bound tracked changes to the durability log with `workspaceId`,
     immutable `versionId`, source mount binding, version/base metadata, capture
     token, and actor/device/session provenance. Ordinary paths may include the
     canonical path. Protected or secret-backed paths must use an opaque/redacted
     path token plus keyed commitment or opaque authorized hash handle in the
     durability log; reusable raw content hashes for those paths must not be
     persisted or exported. The real path remains only inside the authorization
     envelope. Secret-backed writes are included only as encrypted
     references/envelopes or broker metadata, never plaintext secret content.
     Provenance is stored as a policy-governed envelope: durable internal audit
     retains actor id, actor kind, authorizing principal, source kind
     (`human`, `agent`, `import`, `sync`, or `automation`), device id, session id,
     mount binding, and capture source token when available. Normal status,
     search, shared views, and ownership exports expose actor kind and permitted
     display label only; device/session/process identifiers are redacted or
     replaced with stable opaque tokens unless the viewer has workspace owner/admin
     audit permission. Public or cross-workspace exports must not reveal
     unredacted device, session, process, mount, or protected-path provenance.
   - Coalesce them into meaningful history moments.

3. **When dohc starts after being closed**
   - Run a reconciliation pass before declaring the workspace clean.
   - Walk metadata for the materialized tree.
   - Compare against the last known index.
   - Hash files whose metadata or identity changed, plus any candidate whose
     metadata cannot prove content stability on the active filesystem. A
     filesystem-specific trust guarantee may skip this fallback only when it can
     prove unchanged content despite preserved size/mtime.
   - Resolve workspace, immutable version, source mount binding,
     server/engine-derived principal, and effective file policy before appending
     a change to the workspace durability log. If any binding is missing,
     ambiguous, stale, or indeterminate, keep the event in isolated local
     spool/quarantine state and do not expose it as workspace history, search,
     sync, export, status success, or an API-visible capture.
   - Detect creates, edits, deletes, and likely renames/moves.
   - Promote a captured result only when the persisted `workspaceId`, immutable
     `versionId`, and source mount binding match the workspace, version, and
     mount being reconciled.
   - Record each result only in the immutable version captured at write time;
     restart reconciliation may use persisted mount metadata to verify that
     `versionId` binding, never to infer a different version after mount rename
     or remap.
   - If workspace binding, mount binding, or immutable version binding is
     ambiguous or cannot be proven from the captured record,
     quarantine and require explicit user resolution; never fall back to the
     current active workspace or version.

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
whether a subtree is local or virtual, and whether it is pinned. Policy schema,
status reporting, and UI must use `virtual` as the canonical label for a
non-materialized path that remains addressable through dohc APIs. On-demand
hydration is behavior of a `virtual` path, not a separate persisted state;
legacy/imported `lazy` labels map to `virtual` before validation or status
output. `pinned` is an orthogonal boolean retention request, not a third
materialization value.

Non-mounted clients need the same control plane. Browser runtimes, cloud agents,
and sandboxes call `hydrate(...)` to request content materialization in the
current runtime/mount cache or an equivalent streamable projection, and
`setPinned(...)` to toggle the offline-retention request when policy allows.
`hydrate(...)` may change `materialized` from `virtual` to `local` only for the
authorized runtime or mount that can hold bytes; `setPinned(...)` changes the
orthogonal `pinned` boolean and does not by itself invent a third
materialization state.
API-originated `hydrate(...)` and `setPinned(...)` requests are mutating
control-plane operations and require a caller-provided `idempotencyKey` for
request dedupe. `requestToken` is a server-issued transport/correlation token:
the first accepted call mints it, responses echo it, and callers may echo it only
to correlate follow-up transport state; it is not caller authority and is not the
replay identity. The handler records the idempotency key with the
workspace/version/path/runtime identity, the full operation tuple (`hydrate`
versus `setPinned`, with `recursive` included for both and `pinned` only for
`setPinned`), and the server-derived actor/session equivalence class before
applying workspace state changes. Authorization and actor/session identity are
derived only server-side; callers cannot widen authority by choosing request
fields. Retries with the same expanded idempotency key must replay the original
result or deduplicate the already-enqueued hydration/pin side effects instead of
applying them again, while different recursive, pinned, runtime, actor, or
session operations remain distinct.

## API-native access

The filesystem is the default interface, but not the only interface.

The same workspace should be accessible through API calls for cloud agents,
browser runtimes, in-memory sandboxes, and "no real filesystem" environments:

```text
read(workspaceId, versionId, path)
write(workspaceId, versionId, path, bytes, {
  precondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only) | expectedAbsent,
  targetObjectId: required for overwrite; omit only when expectedAbsent is used,
  idempotencyKey
})
delete(workspaceId, versionId, path, {
  precondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only),
  targetObjectId: required,
  idempotencyKey
})
rename(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only),
  sourceObjectId,
  destinationPrecondition: expectedAbsent,
  idempotencyKey
})
move(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only),
  sourceObjectId,
  destinationPrecondition: expectedAbsent,
  idempotencyKey
})
replace(workspaceId, versionId, fromPath, toPath, {
  sourcePrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only),
  sourceObjectId,
  destinationPrecondition: exactly one of expectedBaseVersion | expectedEtag | expectedContentHash(non-secret only) | expectedAuthorizedHashHandle(secret/protected only),
  destinationObjectId,
  idempotencyKey
})
list(workspaceId, versionId, path, { pageToken, pageSize })
stat(workspaceId, versionId, path)
status(workspaceId, versionId, path?, { requestToken?: ServerIssuedRequestToken })
hydrate(workspaceId, versionId, path, { recursive?, idempotencyKey, requestToken?: ServerIssuedRequestToken })
setPinned(workspaceId, versionId, path, { pinned, recursive?, idempotencyKey, requestToken?: ServerIssuedRequestToken })
search(workspaceId, versionId, query, { pageToken, pageSize })
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

`watch`, `snapshot`, and `diff` expose the same secret-safe projection contract
as `read`, `stat`, `list`, and `search`. They must never emit raw
secret-backed contents or raw secret-backed paths in event payloads, snapshot
entries, diff headers, diff hunks, nested metadata, derived labels, or repair
records. Before any output leaves the engine boundary, secret-backed path and
content fields are redacted, omitted, or replaced with authorized opaque tokens
according to the effective file policy and viewer authorization.

In every API shape above, `expectedContentHash` is accepted only for
non-secret-backed object operands. Secret-backed overwrite, delete,
rename/move source, and replace source/destination operands must use another
permitted freshness guard such as `expectedBaseVersion` or `expectedEtag`;
plaintext or redacted secret hash equality is not a valid precondition.
For secret-backed operands, `expectedEtag`, `expectedBaseVersion`, and
`expectedAuthorizedHashHandle` are server-minted freshness tokens, not
client-provided content hashes. Callers may present only opaque tokens obtained
from an authorized read/status path; the server re-derives actor identity,
authorization, workspace/version scope, and token validity before accepting the
guard. Browser or client-provided payload digests, redacted hashes, or equality
claims are ignored for secret-backed overwrite, delete, rename/move, replace
source, and replace destination checks.

`rename` and `move` use the same atomic path-change primitive and validation
rules. `rename` is the preferred API name when the parent path is unchanged and
only the basename changes; `move` is the preferred API name when the parent path
changes. Both require source identity, destination absence, causal
preconditions, and idempotency, and neither may degrade into delete-plus-create
semantics. If source and destination resolve to different physical filesystems,
volumes, or mount projections, `rename(...)` and `move(...)` use a staged
canonical rebind plus projection reconciliation instead of a raw OS rename: the
engine verifies `sourceObjectId`, the source freshness precondition,
destination absence, workspace/version binding, and idempotency before
publishing any canonical path change. The canonical store records one logical
mutation that preserves `sourceObjectId`, creates the new path binding, removes
the old path binding, appends history, and records the idempotency result within
the backend transaction or serializable unit it actually supports.
Cross-filesystem projection side effects are not a distributed transaction; any
required local byte copy, hydration, copy-on-write, eviction, or delete cleanup is
staged with compensating rollback before the canonical publish where possible and
best-effort cleanup/repair records after publish where necessary. Those
projection chores are not the canonical mutation and must not be exposed as
delete-plus-create history. If the source identity/freshness or
destination-absence proof cannot be established, the operation returns a
`rejected`, `quarantined`, or `retryable-failure` result with manual-follow-up
metadata according to the capture/API path.
`conflict` remains reserved for cases where the engine can form the
base/current/incoming preservation envelope described above.
If canonical source and destination paths are identical after path-equivalence
normalization, `rename(...)` or `move(...)` returns a deterministic no-op only
after verifying `sourceObjectId`, source freshness, workspace/version binding,
and idempotency identity. If any guard fails, the operation returns the normal
`rejected`, `quarantined`, `retryable-failure`, or `conflict` outcome required by
that failed guard. A same-path operation must never be
represented as delete-plus-create history.
If the destination already exists, the operation is an overwrite-rename and must
map to `replace(...)`, not plain `rename(...)` or `move(...)`. Watcher and restart
reconciliation must classify common editor temp-file-then-rename saves this way:
the temp source provides `sourceObjectId`, the existing destination provides
`destinationObjectId`, and both sides carry freshness preconditions. If the
destination identity cannot be proven, the capture resolves to `rejected` or
`quarantined` with manual-follow-up metadata instead of applying a path-only
overwrite. When the temp source and existing destination sit on different
filesystems, volumes, or mount projections, `replace(...)` uses a staged
cross-projection replace fallback: verify `sourceObjectId`,
`destinationObjectId`, the source freshness precondition, the destination
freshness precondition, workspace/version binding, and idempotency; durably
ingest the source bytes or content reference before publishing the destination
update; then record one logical replace history moment and the idempotency result
in the canonical backend transaction or serializable unit it actually supports.
Retiring or quarantining the temp source binding and cleaning materialized
projection bytes use staged copy plus compensating rollback before canonical
publish where possible and best-effort cleanup/repair records after publish
where necessary; those cleanup steps must not be presented as a second user
mutation. The destination object identity is preserved for temp-file saves, and
the source object remains provenance for the incoming bytes. If source bytes
cannot be read durably, either freshness precondition fails, either identity
cannot be proven, or a required pre-publish staging step cannot be made durable,
the fallback aborts before the canonical mutation and resolves through the same
deterministic validation, `rejected`, `quarantined`, or `retryable-failure` path
as other write-producing mutations. Reserve `conflict` for cases where the
engine has a preserved base/current/incoming envelope proving true merge
divergence. If post-publish projection cleanup fails, the engine records
repair/quarantine follow-up without exposing partial canonical state. Manual
follow-up is operator workflow metadata,
not a `WriteResult.kind`. For secret-backed inputs, staged bytes, rollback
artifacts, quarantine records, and cleanup/repair records must stay encrypted or
redacted; plaintext `.env` bytes or other secret values must never be written
into staging, rollback, quarantine, or cleanup artifacts.

This answers the API-native workspace requirement. The file mount and the API
are peer views over the same versioned workspace engine. The canonical wire
examples below use explicit `workspaceId` and required version identifiers. A
`read(...)` or `stat(...)` response includes the stable `objectId`, current
`etag`, and `versionId` needed by mutation preconditions. `contentHash` is
returned only for non-secret entries. Secret-backed paths never expose reusable
raw `contentHash` values through read/stat responses, even when plaintext is
materialized for that caller; they omit the hash or return an opaque authorized
hash handle suitable for mutation preconditions. `list(...)` and `search(...)`
entries use redacted labels or opaque path tokens for protected or secret-backed
entries; ordinary filenames and path components are returned only when policy
allows plaintext disclosure. Redacted entries still include stable `objectId`
and allowed freshness metadata so authorized mutation preconditions can be built
without leaking secret directory structure.
Callers obtain `sourceObjectId`, `targetObjectId`, and `destinationObjectId`
through `stat(...)`, `read(...)`, or paginated `list(...)` before invoking
overwrite-oriented flows: `write(...)` when overwriting, `delete(...)`,
`rename(...)`, `move(...)`, or `replace(...)`. Create-only `write(...)` calls
with `expectedAbsent` omit `targetObjectId`.
`list(...)` and `search(...)` return bounded pages with an
opaque `nextPageToken`; `pageSize` is capped by the server, an absent
`pageToken` starts a new query, and a returned `nextPageToken` resumes the exact
authorized workspace/version/query snapshot or fails closed if that snapshot is
no longer valid for the caller. A validated bound session is represented to
clients only as opaque session material. The server resolves the principal plus
workspace/version binding from that session material and then dispatches the
same explicit workspace/version operation shape; browser/client callers never
supply trusted identity or auth-context fields. Each operation still supplies
the version identifiers it actually needs: single-version operations such as
read/write/list/stat/status/hydrate/setPinned/search/watch/snapshot/restore bind
one version, while diff and merge bind the required source/target or
versionA/versionB pair inside that same workspace. Server-side session binding
must match those explicit
identifiers or fail closed before filesystem or storage access. Cross-workspace
path or version references fail closed before filesystem or storage access.

`write(workspaceId, versionId, path, bytes, ...)` is never an unconditional
overwrite. It must carry a causal precondition such as the expected base
version, etag, non-secret-backed content hash, opaque authorized hash handle, or
an absence assertion for creates. Secret-backed overwrites must use
`expectedBaseVersion`, `expectedEtag`, or `expectedAuthorizedHashHandle`;
hash-based equality is not a valid freshness proof for protected paths.
Create and overwrite calls must be explicit: `precondition: expectedAbsent` is
the create-only precondition token, means "create only if no object exists at
this path", and must omit `targetObjectId`.
Overwrite must provide `targetObjectId` for the intended existing object plus
exactly one causal freshness precondition such as `expectedEtag`,
`expectedContentHash` (non-secret only), `expectedAuthorizedHashHandle`
(secret/protected only), or `expectedBaseVersion`.
Secret-backed operands must never use `expectedContentHash`; they must use
`expectedBaseVersion`, `expectedEtag`, or `expectedAuthorizedHashHandle`.
`targetObjectId` binds object identity so delete/recreate substitution cannot
satisfy a path-only overwrite, but it is not a freshness guard by itself. If the
precondition or target object does not match the current workspace/version/path
state, the API returns a conflict response rather than applying the mutation.
Exactly one precondition mode may be
supplied per write. Supplying no causal precondition, omitting `targetObjectId`
for overwrite, or combining incompatible guards such as `expectedAbsent` with
`expectedEtag` fails closed with a distinct validation error and does not mutate
canonical content or reuse the conflict code path. `expectedAbsent` is represented only as that mutually
exclusive precondition mode, not as a separate boolean field beside another
precondition.

Conflict responses are secret-safe envelopes by default: they return only
opaque object/version handles, keyed commitments, operation kinds, and minimal
conflict status. Policy decisions, explanatory metadata, redacted previews, raw
digests, and full current/incoming/restored/secret-backed bytes are materialized
only through the server-side authorization path for that caller and resolution
session.

`delete(...)`, `rename(...)`, and `move(...)` are write-producing filesystem
mutations. Delete requires the path's `targetObjectId`, exactly one freshness
precondition, and an idempotency key. Rename and move require the source
`sourceObjectId` plus exactly one source freshness precondition and an
idempotency key. Rename/move with
`destinationPrecondition: expectedAbsent` is create-at-destination only. Atomic
overwrite uses `replace(...)`, which carries `sourceObjectId`,
`destinationObjectId`, source freshness precondition, destination freshness
precondition, and idempotency key. That gives temp-file-then-rename saves a
one-call atomic replace path without allowing a path-only overwrite. `replace(...)`
uses the same underlying filesystem or mount projection for the fast local
rename path when available. Cross-device or cross-projection replace attempts
must use the engine-atomic cross-projection replace fallback described above:
destination identity is preserved, source identity and freshness are verified,
source bytes are durably ingested before acknowledgement, and idempotent retries
replay the same result instead of creating duplicate objects or
delete-plus-create history.

`merge(workspaceId, sourceVersionId, targetVersionId, ...)` is also
write-producing and must carry causal preconditions for both the source and
target versions. If either version changed since the caller's expected source
snapshot/etag or target base, the merge returns a deterministic conflict
response instead of applying stale output.

API-originated write-producing operations must carry an idempotency key bound to
the stable actor identity, any policy-required session-equivalence class,
workspace, version, operation type, target, causal precondition, full operation
operand tuple after workspace path canonicalization and equivalence
normalization, and a server-scoped opaque operand fingerprint. A transient
session handle is not part of the replay identity when auth refresh or editor
restart re-derives the same actor and required session-equivalence class.
Non-secret operands may derive that fingerprint from a canonical payload digest.
For secret-backed operands, payload bytes must contribute only inside the
server/secret boundary through a keyed digest, handle, or equivalent opaque
fingerprint; raw payload bytes, reusable payload digests, and equality-oracle
fingerprints must never be returned to clients, exported, logged as ordinary
metadata, or included in a client-visible idempotency identity. Payload or
operand changes must still produce a different idempotency identity even when
the path and precondition are unchanged. Duplicate delivery with the same
idempotency key returns the original result or a
deterministic equivalent without creating extra canonical mutations, history
entries, projections, notifications, or search-index side effects. Idempotency
records must be persisted through the documented maximum retry horizon for that
operation type and transport after the operation reaches a terminal result. After
that horizon, an API retry with the same key must fail closed with an explicit
`idempotency-expired` response; it must not silently apply as a new mutation.
Implementations may garbage-collect expired key tombstones only after the same
maximum retry horizon has passed or the operation namespace is rotated.
Tombstone garbage collection is not enough by itself: after a namespace is
rotated or tombstones are compacted, the engine must retain a reject-only
namespace-version marker, retired-key range, or equivalent durable fence for the
expired workspace/version/operation namespace. Late retries under that retired
namespace must resolve to `idempotency-expired` instead of being treated as fresh
writes; new writes must use a non-retired operation namespace.
Retry-horizon values come from the same Phase 0 decision note and PR 01 shared
`WorkspaceIdempotencyPolicy` contract as the versioned workspace spec:
`apiWriteTerminalRetryHorizonMs`, `apiWriteTombstoneRetentionMs`,
`filesystemCaptureDedupHorizonMs`, and
`filesystemCaptureTombstoneRetentionMs`. Numeric baselines are deferred/TBD until
that shared contract lands; the native filesystem layer must not define or copy
independent horizon values.

Mounted-folder and file-watch captured saves cannot rely on caller-generated API
idempotency keys, because native editors and shell tools do not provide them.
Those paths use engine-side capture deduplication instead: bind the capture to
the watcher/session id, workspace, version, path, observed filesystem event
sequence when available, file size/mtime where trustworthy, and either a
non-secret content hash or a secret-safe keyed commitment / opaque fingerprint
for protected paths, plus the causal base token. Deduplication may collapse
duplicate native events into one canonical mutation, but it must not be exposed
as the API idempotency-key contract and must still preserve conflicts when the
causal base no longer matches.

`restore(workspaceId, versionId, checkpointId, ...)` is also write-producing, but
it is never a destructive rollback. A successful restore records a new
checkpoint in the target version whose content is derived from the selected
earlier checkpoint, preserving intervening history for audit, compare, and
recovery. Timestamp-based restore selection is a server-side lookup alias that
must resolve to a deterministic `checkpointId` before the write-producing
restore request is admitted. Implementations may require explicit `checkpointId`
and reject timestamp aliases. If timestamp aliases are supported, the lookup must
either resolve to exactly one checkpoint or apply a documented stable ordering
such as `(checkpointCreatedAt, checkpointId)` with bytewise `checkpointId`
tie-breaks before selecting; ambiguous matches without that deterministic rule
fail closed before admission.
Restore must carry exactly one causal precondition for the target version. If
the current version state no longer matches that guard, the API returns the
same deterministic secret-safe conflict envelope as `write(...)`, preserving
references to current and requested-restored content instead of applying the
restore.

Every async watch/status/snapshot/list/search payload must include workspace
identity, version identity, a request token or equivalent correlation id, and a
monotonic ordering guard before it can update UI state:

```ts
// Canonical base-10 unsigned 64-bit integer.
type UInt64DecimalString = string
type ServerIssuedRequestToken = string & { readonly __brand: 'ServerIssuedRequestToken' }

type WorkspaceAsyncPayload = {
  workspaceId: string
  versionId: string
  requestToken: ServerIssuedRequestToken
  sequence: UInt64DecimalString
  pageToken?: string
}

type WorkspaceWriteState =
  | 'canonical'
  | 'durable-pending'
  | 'conflict'
  | 'quarantined'
  | 'rejected'
  | 'retryable-failure'
  | 'terminal-retired'
// The concrete allowed values are derived from the authoritative
// native-filesystem write-result vocabulary above. This subset excludes
// retry-only `idempotency-expired`.

type WorkspaceStatusPayload = {
  workspaceId: string
  versionId: string
  path?: string
  tracked: boolean
  versioned: boolean
  versionsNamespaceMode: 'legacy_unmanaged' | 'managed_versions'
  synced: boolean
  materialized: 'local' | 'virtual'
  materializationPresentation: 'hydrated' | 'placeholder'
  pinned: boolean
  searchable: boolean
  visibility: 'private' | 'workspace' | 'team' | 'shared' | 'public'
  publicExport: 'include' | 'redact' | 'exclude'
  agentAccess: 'allow' | 'ask' | 'explicit' | 'deny'
  exportState: 'included' | 'redacted' | 'excluded' | 'not_exportable'
  secretProjection: 'none' | 'opaque' | 'protectedLocal' | 'plaintextLocal'
  conflictState: 'none' | 'preserved' | 'resolution_pending' | 'resolved'
  writeState: WorkspaceWriteState
  holdingRecordId?: string
  conflictProjectionPath?: string
  conflictReplayToken?: string
  idempotencyResultId?: string
  idempotencyReplayToken?: string
}

type WorkspaceStatusTransportPayload = WorkspaceAsyncPayload & {
  status: WorkspaceStatusPayload
}

type WorkspaceListTransportPayload<Entry> = WorkspaceAsyncPayload & {
  entries: Entry[]
  nextPageToken: string | null
}

type WorkspaceSearchTransportPayload<Result> = WorkspaceAsyncPayload & {
  results: Result[]
  nextPageToken: string | null
}

type WorkspaceSnapshotTransportPayload<Snapshot> = WorkspaceAsyncPayload & {
  snapshot: Snapshot
}

type WorkspaceWatchTransportPayload<Event> = WorkspaceAsyncPayload & {
  event: Event
}
```

`WorkspaceStatusPayload` carries durable policy and legibility axes directly; it
does not persist request-stream freshness metadata such as `requestToken`,
`sequence`, or `pageToken`. Status clients must not infer `tracked`,
`versioned`, `synced`, `pinned`, `searchable`, `visibility`, `publicExport`,
`agentAccess`, export handling, or conflict location by scraping path
conventions, policy files, or conflict views. Status/export serializers and
re-import deserializers preserve the full resolved `FilePolicyBase` tuple:
`tracked`, `versioned`, `synced`, `pinned`, `searchable`, `visibility`,
`publicExport`, `agentAccess`, and `materialized`.
`versionsNamespaceMode` is persisted workspace status, not a per-client guess:
`legacy_unmanaged` means pre-opt-in `.versions/**` content is ordinary content
classified by the compatibility path, while `managed_versions` means
`.versions/<version>/` is reserved for engine-managed version mounts and generic
walkers must skip it after the reserved-namespace scan.
`materializationPresentation` is a UI/status hint for whether the current actor
sees hydrated bytes/projection or a placeholder for a virtual/lazy path; it does
not create a third persisted `materialized` value.
`conflictProjectionPath` points at the policy-safe `.dohc/conflicts/` projection
when one may be shown; secret-backed or unauthorized conflicts still report
`conflictState` without leaking a projection path.

`requestToken` is an opaque server/engine-minted request-stream token carried by
`WorkspaceAsyncPayload` when the initiating watch/status/snapshot/list/search or
filesystem-loading request is accepted. Callers may hold and echo the request
handle, but they do not choose or forge the token. Every async transport payload
for that request stream, including `WorkspaceStatusTransportPayload`, echoes the
exact token minted for the initiating request, and stale-response checks compare
that token together with workspace/version/page identity before applying results.
Concrete `list(...)`, `search(...)`, `snapshot(...)`, and `watch(...)` responses
must use `WorkspaceListTransportPayload`, `WorkspaceSearchTransportPayload`,
`WorkspaceSnapshotTransportPayload`, and `WorkspaceWatchTransportPayload` (or a
schema-equivalent generated shape) so `workspaceId`, `versionId`, `requestToken`,
`sequence`, and for list/search the opaque `nextPageToken` is present before
any UI, cache, projection, or renderer state is updated.
Filesystem loading and local reconciliation mint the same kind of token from the
engine context before emitting progress or result payloads. The `requestToken`
parameters on `status(...)`, `hydrate(...)`, and `setPinned(...)` are echo-only
transport freshness metadata: callers may pass back a server/engine-issued token
from an accepted request stream, but client-generated tokens are ignored or
rejected and never establish request ownership.

`WorkspaceAsyncPayload.sequence` uses `UInt64DecimalString`: ASCII base-10
digits only, no sign, separators, decimal point, whitespace, locale/non-ASCII
digits, or leading zeros except the literal `0`, with range
`0..18446744073709551615`. Producers must serialize this canonical form, and
clients must parse, range-check, and reserialize before freshness comparison.
Handlers for `watch(workspaceId, versionId, path)`,
`snapshot(workspaceId, versionId)`, `list(workspaceId, versionId, path, ...)`,
`search(workspaceId, versionId, query, ...)`, async status transports, and
filesystem loading must verify `WorkspaceAsyncPayload` fields before applying
results. Each handler also compares the transport payload sequence against the
latest applied value for the same
workspace/version/request stream using BigInt-safe comparison of canonical
`UInt64DecimalString` values, never floating-point numbers, locale string
collation, or non-canonical decimal strings. For paginated `list` and `search`,
the `pageToken` or cursor is part of the request stream identity and must match
the currently active workspace/version/request before appending or replacing
results; a page for an older token, older sequence, or different request stream
is stale. Server timestamps are metadata only and must not decide freshness
unless they are explicitly defined as a monotonic per-stream counter. A stale
response from one workspace/version/session must never repaint another or
regress current UI state.
`status(...)`, CLI status streaming, and UI status badges must use the persisted
`WorkspaceStatusPayload` plus separate `WorkspaceAsyncPayload` freshness metadata
when status is delivered asynchronously. `.dohc/status.json` generation writes
only the durable `WorkspaceStatusPayload` shape, with no `requestToken`,
`sequence`, or `pageToken`. An async status update must be dropped before
mutating UI/cache state unless its transport `workspaceId`, `versionId`,
`requestToken`, and `sequence` match the currently active
workspace/version/request stream, the nested status `workspaceId`/`versionId`
match the transport envelope, and the sequence advances the canonical per-stream
sequence.
Internal status fields are server-derived only. Browser and client callers do
not supply `includeInternal`; if they send such a flag through an older client or
raw transport, the server strips or ignores it. Owner/admin/audit-only internal
details are included only after server-side authorization checks derive that the
actor can view internal engine-managed or secret-backed state.

## File state axes

dohc must not collapse every file into a single
tracked/versioned/synced/pinned/materialized state.

At least six independent dimensions are needed:

1. **Tracked/captured**
   - Should changes be observed, captured, and made durable by the workspace
     engine?

2. **Versioned/history-visible**
   - Should captured changes appear in user-facing version history and named
     versions?

3. **Synced/durable**
   - Should contents sync to dohc Cloud or another remote?

4. **Materialized locally**
   - Should contents exist on local disk, hydrate on demand from `virtual`, or
     remain virtual?

5. **Pinned/offline-retained**
   - Should dohc keep local bytes hydrated for offline availability when policy
     allows, independent of whether the path is currently `local` or `virtual`?

6. **Secret-backed/protected**
   - Are bytes stored or referenced as secret material that needs encrypted
     storage, redacted history/export/search, and explicit plaintext
     materialization permission for each human or agent?

Examples:

| Path | Tracked | Versioned | Synced | Materialized | Pinned | Secret-backed | Secret projection |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docs/**` | yes | yes | yes | virtual | optional | no | none |
| `apps/**` | yes | yes | yes | virtual | optional | no | none |
| `data/raw/**` | yes | yes | yes | virtual | no | no | none |
| `node_modules/**` | no | no | no | local | no | no | none |
| `dist/**` | no | no | no | local | no | no | none |
| `.cache/**` | no | no | no | local | no | no | none |
| `scratch/**` | no | no | no | local | no | no | none |
| `.env` | yes | yes | yes | local | no | yes | protectedLocal |

This avoids naive folder-sync behavior such as syncing `node_modules`, build
output, and cache folders.
Materialization describes storage shape only; authorization decides whether a
specific actor can hydrate or read local plaintext for a protected path such as
`.env`.

Secret-backed paths are never ordinary synced text. For `.env`, `synced` means
encrypted/opaque sync of secret references, encrypted blobs, hashes, and redacted
status, not plaintext replication or server-side plaintext hydration. Its
`materialized: 'local'` state means bytes or a projection are present locally,
while `secretProjection` distinguishes opaque, protected local, and plaintext
exposure. Historical state, exports, search results, conflict envelopes,
projections, and agent-readable views store opaque handles, hashes, and redacted
status by default. Plaintext hydration requires explicit server-side
materialization permission and must be recorded separately from normal
materialization as `secretProjection: 'plaintextLocal'` so `.env` does not
become a plain history blob, search document, or cloud-readable text payload.

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

Workspace-root `.dohcignore` compatibility is deferred. This phase must not
parse `.dohcignore` as a live source-backed policy input, must not assign it a
policy precedence band, and must not import it as ordinary content. The durable
model can add `.dohcignore` compatibility later through an explicit migration
that defines source order, import behavior, and conflicts with `.dohc/files.toml`.

`.dohc/**` is engine-managed internal state and is excluded from normal
capture/sync ingestion by default. Recursive self-capture is forbidden: history,
status, conflicts, indexes, caches, generated projections, durability internals,
and any other internal `.dohc/**` content must be hard-denied from export,
search, sync, import-as-user-content, and re-ingestion as ordinary files. The
importer applies the same allowlist-before-quarantine rule here only for
engine-specific policy parsing: the explicit policy inputs
`.dohc/files.toml` and `.dohc/visibility.toml` may be parsed and normalized as
engine policy inputs outside the normal captured-content pipeline, not as
ordinary tracked files. Workspace-root `.dohcignore` remains deferred and is not
part of this allowlist. No user policy may opt internal `.dohc/**` history,
status, conflicts, indexes, caches, generated projections, or durability
internals into tracking, export, search, sync, or ordinary file re-ingest. All
other `.dohc/**` paths are reserved,
non-user-content inputs that must be quarantined with an explainable record or
handled through engine-specific recovery rather than captured as ordinary files
or silently skipped.

Example:

```toml
[[rule]]
match = "node_modules/**"
tracked = false
versioned = false
synced = false
pinned = false
materialized = "local"

[[rule]]
match = "dist/**"
tracked = false
versioned = false
synced = false
pinned = false
materialized = "local"

[[rule]]
match = "docs/**"
tracked = true
versioned = true
synced = true
pinned = false
materialized = "virtual"

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
pinned = false
materialized = "local"
secret_projection = "protectedLocal"

[[rule]]
match = ".env.team"
tracked = true
versioned = true
synced = true
encrypted = true
searchable = false
visibility = "team"
agent_access = "ask"
pinned = false
materialized = "local"
secret_projection = "protectedLocal"
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

Deny/restrictive outcomes win when two rules conflict. Authorized explicit user
overrides can only tighten effective policy unless the rule type explicitly
permits an exception; permitted exceptions are still intersected with actor
permissions and sharing/export context. For equal specificity, rules sort by
explicit priority when present, then by canonical policy source ordinal, then by
explicit rule index within that source, then by lexical rule id. Exact paths are
more specific than globs; longer literal prefixes are more specific than shorter
prefixes.
The canonical policy source ordinal is a stable engine-assigned integer for the
normalized policy source after imports and aliases are resolved. Because
workspace-root `.dohcignore` is deferred, the live source-order bands in this
phase are built-in defaults, object hard constraints, version policy,
`.dohc/files.toml`, `.dohc/visibility.toml`, and authorized user overrides.
Importer, materializer, export, quarantine, tracking, and effective-policy
resolution must not synthesize a `.dohcignore` band until a later PR explicitly
adds that compatibility path. Multiple files inside the same band are
ordered by canonical workspace-relative path using bytewise UTF-8 order. The
resolved ordinal is recorded with the normalized rule so equal-specificity
conflicts are replayable.

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
type FilePolicyBase = {
  tracked: boolean
  versioned: boolean
  synced: boolean
  pinned: boolean
  searchable: boolean
  visibility: 'private' | 'workspace' | 'team' | 'shared' | 'public'
  publicExport: 'include' | 'redact' | 'exclude'
  agentAccess: 'allow' | 'ask' | 'explicit' | 'deny' // dohc-controlled access
  materialized: 'local' | 'virtual'
}

type NonSecretFilePolicy = FilePolicyBase & {
  encrypted: false
  secretProjection: 'none'
}

type SecretBackedOpaqueFilePolicy = FilePolicyBase & {
  encrypted: true
  searchable: false
  publicExport: 'redact' | 'exclude'
  materialized: 'virtual'
  secretProjection: 'opaque'
}

type SecretBackedLocalFilePolicy = FilePolicyBase & {
  encrypted: true
  searchable: false
  publicExport: 'redact' | 'exclude'
  materialized: 'local'
  secretProjection: 'protectedLocal' | 'plaintextLocal'
}

type SecretBackedFilePolicy =
  | SecretBackedOpaqueFilePolicy
  | SecretBackedLocalFilePolicy

type FilePolicy = NonSecretFilePolicy | SecretBackedFilePolicy
```

`materialized` describes hydration state only: whether bytes are present locally
or represented virtually. `pinned` is the independent offline-retention request
that asks dohc to keep local bytes hydrated when policy allows; pinning does not
change tracking, versioning, searchability, export behavior, or visibility.
`secretProjection` describes exposure for secret-backed paths separately from
storage hydration: `opaque` means handles/redacted status only,
`protectedLocal` means brokered or policy-controlled local projection, and
`plaintextLocal` means ordinary OS-readable plaintext after an explicit grant.
Policy validation and builders must emit `secretProjection: 'none'` for
non-secret paths and `SecretBackedFilePolicy` for protected secret paths; secret
entries cannot omit `secretProjection` or use the non-secret placeholder value.
They must reject inconsistent pairs before status/export/access data is produced:
`secretProjection: 'opaque'` requires `materialized: 'virtual'`, while
`protectedLocal` and `plaintextLocal` require `materialized: 'local'`.
Secret-backed policies must also force `searchable: false` and
`publicExport: 'redact' | 'exclude'`; plaintext export or indexing requires a
separate future policy with explicit review and must not be expressible through
this first-proof union.
Status APIs, UI serialization, and agent-readable views must emit both
`materialized` and `secretProjection` so protected secret material is never
confused with normal local plaintext.
When a subtree is both pinned and currently non-materialized, policy, status
APIs, and UI represent it as `materialized: 'virtual'` plus `pinned: true`.
`virtual` remains the canonical non-materialized label; pinned is shown as an
offline-retention request or pending hydration state, not as a third
materialization value.

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

Example opt-in policy for an already-authorized protected local projection:

```toml
[[rule]]
match = ".env"
tracked = true
versioned = true
encrypted = true
searchable = false
visibility = "private"
public_export = "redact"
agent_access = "explicit"
materialized = "local" # protected/explicit local projection, not default exposure
secret_projection = "protectedLocal"
```

For an authorized user on their own machine, `.env` can look like a normal file
only after explicit materialization permission grants that protected local
projection:

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

The default safe file projection for secret-backed bytes is a protected or
ephemeral mount, brokered API read, or dohc-controlled execution path. Normal
local-folder materialization of plaintext is an explicit opt-in exposure policy,
not the default safe model. A materialized plaintext projection may exist only
for an authorized workspace, version, and user/device, and it must be labeled as
local OS-readable exposure because arbitrary local processes can read it through
normal OS permissions once it exists. Process-level secret gating applies only
to dohc-controlled execution paths, such as brokered API access, managed mounts,
or injected runtime secrets, not arbitrary local processes.

When launching a process or agent, dohc may inject only explicitly approved
low-sensitivity secrets as environment variables from the same broker.
Higher-sensitivity secrets must use brokered files, fds, or ephemeral mounts.
File materialization and process injection are two projections of the same
secret-backed source.

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

Rule:

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
- otherwise use the stable engine fallback order: highest logical clock wins; if
  tied, choose the lexicographically smallest UTF-8 tuple of
  `(versionId, objectId, actorId, operationId)` among the conflicting candidates.
- record `chosen_from`, `base`, the winning fallback tuple, and rationale in
  conflict metadata.
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

Every status projection must expose:

- materialization state: `local` vs `virtual`, with orthogonal `pinned` and
  hydrated/placeholder presentation flags when the path is lazily materialized;
  `remote` is a sync/presentation label, not a persisted materialization state.
- file-policy state: tracked vs ignored, versioned vs unversioned, and synced vs
  local-only.
- write state from `WorkspaceWriteState`, the durable subset derived from the
  authoritative native-filesystem write-result vocabulary above.
- secret state: secret-backed vs non-secret, explicit `secretProjection`
  (`none`, `opaque`, `protectedLocal`, or `plaintextLocal`), whether plaintext is
  materialized for this actor/session, and whether the path is excluded or
  redacted on export.
- conflict state: whether the visible path has a preserved conflict record, plus
  the conflict projection location when policy permits.

Required surfaces:

- dohc UI badges.
- `dohc status`.
- `.dohc/status.json`.
- API status calls.

Optional platform surfaces such as file attributes/xattrs may mirror this state
where available, but they are not the source of truth.

Hidden mechanics are okay. Hidden safety-relevant state is not.
Status projections must use the same write-state terminology as the API
contract. If a save is captured locally but not yet canonical, `dohc status`, UI
badges, `.dohc/status.json`, and API status calls must show the materialization
state, including `materialized` and `pinned`, file-policy state, write state,
secret state, including the exact `secretProjection` value, export state, and
conflict state above in one coherent record. They must preserve the
`protectedLocal` versus `plaintextLocal` distinction in serialized status output
and include the relevant
`holdingRecordId`, `conflictReplayToken`,
`idempotencyResultId`/`idempotencyReplayToken`, and conflict
projection path when policy permits. A status projection must report `canonical`
once the same write has promoted into history. `idempotency-expired` is not a
persisted workspace status or badge state; it appears only as an operation result
for late retries and retry-flow APIs after the retry horizon has elapsed. Status
projections must not invent names outside the durable subset of the shared
`WriteResult.kind` vocabulary.
`.dohc/status.json` is an engine status projection, not user content; it follows
the `.dohc/**` internal-state boundary and must not be re-ingested as a normal
workspace file.

## Export and ownership

dohc must preserve the user's ownership of their work.

Export should produce:

- readable files.
- the full policy envelope required to re-import without changing file
  semantics, including the full `FilePolicyBase` tuple (`tracked`, `versioned`,
  `synced`, `pinned`, `searchable`, `visibility`, `publicExport`,
  `agentAccess`, and `materialized`), whether each governed entry is
  secret-backed or non-secret, its `secretProjection` variant (`opaque`,
  `protectedLocal`, or `plaintextLocal`), plus the effective-policy resolver's
  normalized source ordinal and rule index for each emitted rule.
- only allowlisted source-backed policy files such as `.dohc/files.toml` and
  `.dohc/visibility.toml`; `.dohcignore` remains deferred and is not emitted as
  a live policy input in this phase.
- history/provenance metadata, with actor kind and permitted display labels
  preserved, device/session/process/mount identifiers tokenized by default, and
  unredacted provenance available only in owner/admin audit exports governed by
  the source workspace policy envelope.
- non-secret entries emit hashes for verification.
- secret-backed entries emit only opaque commitments or authorized handles for
  verification.
- redacted/excluded secret files according to policy.
- enough metadata to re-import and compare, including the workspace
  path-equivalence profile: case sensitivity/folding, Unicode normalization, and
  mount-compatibility constraints.
- the persisted `versionsNamespaceMode` for the workspace so re-import uses the
  same reserved-namespace scan, materialized workspace walker, and
  workspace/version mount resolver behavior for `.versions/**` on every machine.
- no in-flight `versionsNamespaceActivationFence`: default ownership export must
  fail closed while the fence is active. Authorized operator migration export may
  serialize the fence metadata alongside `versionsNamespaceMode` only as
  engine-managed migration state, never as ordinary content, and re-import must
  restore or complete/roll back that fence before ordinary `.versions/**`
  walking or managed version mount resolution proceeds.

Default ownership export operates on a clean canonical snapshot. If the selected
workspace scope contains unresolved `durable-pending`, `quarantined`, or
`conflict` records, export fails closed with a status report identifying the
non-canonical records the caller is allowed to see. It must not silently omit,
flatten, or convert those reconciliation artifacts into ordinary files. A
separate operator reconciliation export may carry pending/quarantine/conflict
metadata through an authorized diagnostic path, but that bundle is not ordinary
workspace export and must preserve the same redaction, secret, and policy
boundaries as status/conflict views.

Export must never include `.dohc/**` history, status, conflicts, indexes, caches,
generated projections, durability internals, or other engine state as ordinary
workspace files. Only the explicitly allowlisted policy inputs above may cross
the boundary, and only through the engine policy parsing/export path.
That engine policy export path is responsible for preserving enough normalized
policy state to reconstruct secret-backed versus non-secret files on re-import,
including the full resolved policy tuple (`tracked`, `versioned`,
`synced`, `pinned`, `searchable`, `visibility`, `publicExport`, `agentAccess`,
`materialized`, and `secretProjection`), equal-specificity tie-breaking from the
original source ordinal and rule index plus the workspace path-equivalence
profile used during canonicalization and the persisted `versionsNamespaceMode`;
re-import must fail closed rather than treating an entry with missing policy
envelope, missing or incompatible resolved policy tuple, ordering data, a
missing/incompatible path-equivalence profile, or a missing/incompatible
versions-namespace mode as ordinary content.
If an export declares an active
`versionsNamespaceActivationFence`, re-import treats the fence as required
migration state and must resume/complete or roll back the cutover before
ordinary content import continues; if that fence metadata is missing or
incompatible, import fails closed. Legacy exports that predate
`versionsNamespaceMode` require an explicit import-time migration choice before
activation.

Generated or internal `.dohc/**` state is excluded from export unless it is one
of the named policy inputs above and crosses through the engine policy export
path. Status projections, conflict projections, indexes, caches, derived chat
projections, and durability internals are not exported as ordinary user files.

External VCS export may remain useful for code-heavy projects, but should be an
integration/export surface rather than dohc's native model.

## What to avoid

Avoid naive folder sync:

- no blind last-writer-wins.
- no syncing `node_modules` by default.
- no materializing everything by default.
- no single state axis for tracked/versioned/synced/pinned/materialized.
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
3. Editing files in either folder captures immediately for that version, then
   promotes through quarantine/reconcile before canonical history updates.
4. dohc records a durability log and coalesced meaningful history.
5. `.dohc/files.toml` controls tracked/versioned/synced/pinned/materialized
   behavior for a few path patterns.
6. `node_modules/**` and `dist/**` are local materialized but untracked,
   unversioned, and unsynced.
7. A `.env` path pattern can be tracked as secret-backed/private through
   `.dohc/files.toml`: read/write captures durably, status shows
   secret-backed plus redacted/export-excluded state, conflicts project through
   `.dohc/conflicts/` without plaintext leakage, and unauthorized export redacts
   or excludes the `.env` file.
8. One non-`.env` secret-backed fixture proves the same durable capture,
   redacted status, conflict projection, and export behavior without relying on
   `.env`-specific policy.
9. A simple non-secret conflict preserves both sides and exposes
   `.dohc/conflicts/`.
10. An API can read/write the same version without relying on a real filesystem.

If this works, dohc has the beginning of a filesystem that feels normal to
humans and agents while being much safer and more powerful than normal folders,
folder sync, or conventional worktree flows.
