# Think Bigger: dohc Workspace Engine Mega Plan

> **For agentic workers:** This is an orchestration plan, not a single coding
> task. Use subagents, CodeRabbit review loops, phase execution logs, and
> comprehensive automated plus manual QA. Do not start implementation until the
> user approves the overall direction and branch/PR strategy.

**Status:** mega-plan draft

**Date:** 2026-06-23

**Goal:** Turn dohc into a versioned, file-native, chat-aware AI workspace
engine: normal files for humans and agents, VCS-grade robustness underneath,
agent-native sync/materialization semantics, and fast channel/DM chats rebuilt
around work context instead of message streams.

**Core thesis:** dohc should feel obvious on the surface and ambitious
underneath.

```text
Use normal files.
Authorized writes save immediately.
Versions make parallel work obvious.
History and recovery are automatic.
The same workspace appears across machines and agents.
Chats happen where the work lives.
Agents collaborate like users, without special source-control knowledge.
```

## Source Specs

This mega plan collates and orchestrates:

- `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-chats-design.md`

Those files are the conceptual inputs. This file is the execution plan.

## North Star

dohc should not become:

- a VCS UI.
- a folder-sync clone.
- a standalone chat clone.
- a document app with a chatbot.

dohc should become:

> A shared versioned workspace where files, versions, agents, chats, decisions,
> apps, data, and history all belong to the same system.

The foundation is:

```text
Versioned workspace engine
  + native filesystem projection
  + source-backed chats
  + agent-safe tools
  + rigorous QA/review loops
```

## User-Facing Primitives

Keep the surface simple:

- **Workspace**: where the user's work lives.
- **Version**: a live parallel line of work, like Main, Client Version, or
  Agent Experiment.
- **Files**: the normal way humans and agents edit work.
- **History**: automatic memory inside a version.
- **Chats**: familiar communication surface, internally durable work threads.
- **Channels**: places for people and chats.
- **DMs**: fast direct or small-group conversation.
- **Share**: controlled exposure of files, folders, versions, chats, or channels.

Avoid exposing these as default UI language:

- commit
- branch
- worktree
- HEAD
- rebase
- checkout
- PR
- CRDT
- Merkle
- content-addressed object

Those are engine-room concepts.

## Non-Negotiables

### Product

- dohc must feel like normal files on the user's computer.
- dohc must feel native and fast even as the workspace engine gets more
  ambitious.
- Humans and agents follow the same write rules.
- Agents should not need dohc-specific version-control knowledge to edit files.
- Normal edits save immediately to the current version.
- Review/compare/merge appears only for real boundaries.
- Chats must feel fast and natural, not like a forum.
- Chats must be called **Chats** in the UI, even if the internal model is
  thread/post-shaped.
- Channels and DMs are required, not follow-up polish.
- Agent messages in shared chats display as `<User Name>'s agent`.

### Robustness

- Do not sacrifice VCS-grade durability.
- Stable object IDs are canonical. Paths are aliases.
- Every version must have clear ancestry/fork-point metadata.
- Meaningful state must be recoverable.
- Conflicts must preserve both sides.
- No silent last-writer-wins for tracked workspace content.
- No raw conflict markers as the primary UX.
- No hidden safety-relevant state.
- Every content/projection driver must declare snapshot, diff, merge/conflict,
  projection, search, export, restore, and ACL behavior.
- No skipped E2E tests for implemented, shipped, or in-scope surfaces;
  deferred surfaces are recorded as not applicable, not skipped.

### Performance

- Performance is a top-level product invariant, not a cleanup task.
- The app must remain native-feeling: instant local feedback, no renderer
  blocking during filesystem capture, no janky typing/composer/history UI, and
  no long opaque sync stalls.
- Every PR touching filesystem, versions, search, chats, projections, sync, or
  rendering must include measured performance evidence.
- Prefer incremental indexes, cached metadata, background work, batching,
  streaming, virtualization, lazy hydration, and bounded queues over eager
  whole-workspace work.
- Startup and reconciliation must be progressive: show useful workspace state
  quickly, then finish deeper scans in the background with honest status.
- Search must be indexed and policy-filtered efficiently; do not ship linear
  scans over large workspaces as the default path.
- Chat and history UIs must virtualize large lists.
- File capture must absorb bursty editor/agent writes without blocking the UI
  thread or flooding cloud sync.
- Performance regressions require the same seriousness as test failures. A PR
  can only exceed budget with explicit notes, measurements, and user-approved
  follow-up.

### Security And Privacy

- Authorization is derived server-side or engine-side. Clients, browsers,
  agents, and projections never provide trusted identity claims.
- Every object, event, projection, file, folder, version, chat, channel, DM,
  message, share, app, database, secret reference, search index entry, and
  export is scoped to a workspace.
- Agent writes must respect user locks, protected paths, folder/file access,
  sharing boundaries, and skill-turn gates.
- HTML atoms remain sandboxed and sanitized.
- Canonical Y.Doc state takes precedence over derived Markdown/body caches for
  rich document content.
- Secret-backed files are allowed, including `.env`, but plaintext secrets must
  not leak into normal history, search, public export, logs, or unauthorized
  projections.
- Secret values must not enter durable chats, summaries, agent replies,
  projections, notifications, search snippets, or logs unless explicitly
  declassified or redacted.
- This guarantee applies to dohc-controlled surfaces. If an authorized user,
  agent, or tool reads plaintext and writes it into an external process log,
  shell transcript, third-party provider, or non-dohc file, that is outside
  dohc's automatic containment and must be handled through process sandboxing,
  agent policy, and user-visible warnings.
- Policy files are source-backed, but enforcement is engine-backed.
- External/shared channels never grant broad workspace access by accident.
- Search, notifications, side rails, activity feeds, and export metadata are
  policy-critical surfaces, not convenience views.

### Engineering

- No giant unreviewable implementation PR.
- Every PR must have targeted tests, regression tests, and relevant E2E for its
  implemented, shipped, or in-scope surfaces.
- Every PR must go through the canonical CodeRabbit loop until approval or an
  explicitly approved non-sensitive override.
- Every security-sensitive PR must use subagent review.
- Every UI PR must include Playwright/visual QA where applicable.
- No weakening assertions or skipping tests to move forward.
- No "mostly done" final claims.

## Architecture Overview

```text
dohc Workspace Engine
  Workspace object identity registry
  Version and version-ref registry
  Content drivers
  Typed event log
  Snapshot/history/moment store
  Merge/conflict drivers
  Projection registry
  File policy resolver
  Effective permission/policy engine
  Native filesystem projection
  API-native workspace access
  Secret-backed file broker
  Search/index pipeline
  Chat/channel/DM subsystem
  Sharing/external channel subsystem
  Agent tools and activity integration
```

The three major product systems share one foundation:

```text
Versioned Workspace
  answers: what changed, where did it come from, how can it recover?

Native Filesystem
  answers: how do users and agents touch the workspace as normal files?

Chats
  answers: how do people and agents discuss work inside the workspace?
```

## Shared Substrate

The implementation must not build versioning, filesystem, and chats as three
separate systems. They share one substrate.

The canonical substrate is:

```text
WorkspaceObject
  stable identity for anything meaningful in the workspace

VersionRef
  optional pointer to a version, fork point, or history moment

Projection
  a file, UI, API, search, export, or chat-readable view over an object

Event
  typed record of something that happened

Policy
  effective access/materialization/export/search behavior
```

Everything meaningful eventually gets a stable ID, but Phase 0 starts with the
proof-arc identities required for the file/version/chat loop:

- files.
- folders.
- versions.
- history moments.
- chats.
- channels.
- messages.
- agent runs.
- shares.

Deferred substrate identities stay in the expansion backlog until their
contracts are mounted into the product surface:

- apps.
- databases.
- rows where row-level links are needed.
- secrets.
- projections.

Paths are aliases, not identity. Links, history, search, shares, and chats must
resolve through stable IDs so renames, moves, version forks, restores, and
exports do not break provenance.

### Typed Event Log

The system should not grow four unrelated timelines.

Use one typed event substrate with different projections:

- durability write event.
- meaningful moment event.
- chat message event.
- mention event.
- notification event.
- agent run event.
- merge event.
- restore event.
- policy change event.
- share/export event.

History, Activity, Chats, Notifications, Agent Runs, and Search are projections
over this event substrate. They can have different views and retention, but
they must not disagree about what happened.

### Projection Writeability

Every projection must declare its write contract:

- `canonical`: this projection is the canonical content surface.
- `writable`: edits can be ingested back into the object.
- `readOnly`: reference/export only.
- `lossy`: export is incomplete and cannot round-trip.
- `redacted`: intentionally hides data by policy.

Examples:

- normal source file projection: writable.
- `.dohc/chats/v1-<digest>.md`: read-only by default.
- public export of `.env`: redacted or excluded.
- generated dashboard summary: lossy unless explicitly source-backed.
- `.dohc/status.json`: read-only.
- `.dohc/files.toml`: writable policy request, but engine-validated.

### Effective Policy

All surfaces must use the same effective policy resolver:

```text
workspace defaults
  + actor permissions
  + version visibility
  + path/object policy
  + channel/chat membership
  + share/export context
  + projection contract
  = effective behavior
```

A user must not learn that a hidden file, version, chat, DM, secret, agent run,
or external share exists through:

- path listing.
- chat link.
- search result.
- notification.
- projection file.
- export metadata.
- activity feed.
- status API.

### Link Dereference

Links between chats, files, folders, versions, moments, and agent runs must store:

- target type.
- stable target ID.
- optional `VersionRef`.
- display path/title at link time.
- ACL/degrade behavior.

Links must survive rename/move, degrade cleanly when access is lost, and avoid
leaking hidden target metadata.

### Chats And Versioning

Chats are live workspace objects by default. They do not automatically fork,
merge, or restore as if they were ordinary files inside a version.

Rules:

- A chat can link to a specific version or history moment.
- A chat can discuss a version without becoming part of that version's file
  state.
- Restoring a file version must not erase live chat messages or read state.
- Export can include, redact, or exclude chats according to policy.
- A snapshotted/exported chat projection can be versioned as a file artifact,
  but the live chat object remains structured state.

This avoids accidental deletion, duplication, or merge of social state.

### `.dohc/` Boundary

`.dohc/` is an inspectable control/projection surface, not an unmanaged user
workspace.

Source-backed policy entries are explicitly allowlisted and validated before
they can affect engine behavior:

- `.dohc/files.toml`
- `.dohc/visibility.toml`
- optional workspace-root `.dohcignore`

Internal projection/reserved-state examples are inspectable, but they are not
source-backed user content, not importable as ordinary workspace files, and not
exported unless a purpose-built export policy explicitly includes redacted
derived state:

- `.dohc/status.json`
- `.dohc/conflicts/**`
- `.dohc/chats/**` read projections

Every `.dohc/` path must declare whether it is an allowlisted policy file or an
internal projection/reserved-state path, plus its projection writeability and
validation rules. The engine must reject unsafe direct edits and must never
re-ingest internal `.dohc/` projections as canonical user content.

## Engine Concepts

### Version

A Version is a live line of work.

Examples:

- Main
- Q3 Plan
- Client View
- Agent Experiment
- Security Fix

Edits inside a version save immediately.

### History

History is the time axis inside a version.

Use two tiers:

1. Fine-grained durability log for every captured write.
2. Meaningful moments for user-readable history and compare flows.

### File Policy

File policy resolves:

- tracked
- versioned
- synced
- materialized
- encrypted
- searchable
- visible to whom
- public export behavior
- dohc-controlled agent/tool access behavior

### Chat Thread

A ChatThread is a durable work conversation. It can appear in channels, DMs,
file side rails, version activity, search, and external shared channels.

### Channel

A Channel is a place where chats gather. Channels can attach to workspace scope:
folder, file, version, chat, share, agent run, or another stable
`WorkspaceObject` type after that type is defined in the roadmap.

### Shared Channel

A shared channel is an external collaboration surface with explicit resource
visibility, not broad workspace access.

## Implementation Strategy

This plan should run in two layers:

1. **Phase 0 Proof Arc:** a narrow, real vertical slice that proves the core
   model against the current dohc codebase.
2. **Expansion Roadmap:** the broader PR sequence that generalizes the proof
   into the full workspace engine.

Do not begin the expansion roadmap until Phase 0 passes. The biggest risk is
building a beautiful substrate that has not survived contact with files, merge,
history, UI, and chats in one loop.

Keep each implementation slice behind an alpha flag, non-default API path, or
internal workspace-engine adapter until the proof slice works end to end.
Do not expose a half-integrated version/filesystem/chats model as the default
product surface.

## External Review Incorporated

An external architecture review was incorporated before execution. The review
agreed with the direction, but pushed hard against starting with an abstract
universal substrate before proving the real loop.

The plan now incorporates that critique:

- Start with a Phase 0 vertical proof arc, not the whole engine at once.
- Decide the storage baseline and filesystem interposition strategy before
  making robustness promises.
- Keep Phase 0 merge honest: 3-way text/file merge only.
- Scope secret guarantees to dohc-controlled surfaces until sandboxing,
  declassification, and secret-broker flows exist.
- Treat file content as file-native and chats as action-native social objects
  with read-only text projections.
- Add crash recovery, multi-writer concurrency, merge property tests,
  prompt-injection-to-action tests, and accessibility gates.
- Defer external channels, large-scale lazy hydration, rich chat texture,
  semantic merge, non-text content drivers, and external VCS export fidelity until
  the proof arc passes.

## Refined Implementation Defaults

These defaults were selected after implementation-question refinement and
should be treated as the starting architecture unless a later PR proves a
better answer.

1. **Source of truth:** local dohc engine first, cloud sync second.
   - The user sees normal files, but the durable source of truth is the local
     dohc engine: object IDs, versions, history, conflicts, policy, and
     projections.
   - dohc Cloud syncs and coordinates engine state. It is not just a database
     that replaces the user's files.

2. **Filesystem surface:** watcher-backed folder for Phase 0, managed
   filesystem projection long-term.
   - Phase 0 may use a normal folder plus watcher/capture layer to move fast.
   - The boil-the-ocean answer is a dohc-managed filesystem projection or
     mount where dohc can enforce lazy hydration, policy, version views,
     conflict preservation, and secret materialization more reliably.

3. **Version meaning:** workspace-wide named versions.
   - A Version is a live parallel line of workspace work, such as Main,
     Experiment, Client Draft, or Agent Rewrite.
   - UI can show file/folder-scoped diffs, but ancestry and merge semantics are
     workspace-level.

4. **Metadata storage:** engine database is canonical; `.dohc/` is an optional
   source-backed/config/export surface.
   - Stable IDs, policy, version membership, provenance, and search/export
     behavior must not depend on path names alone.
   - `.dohc/files.toml` can be useful for humans and agents, but enforcement is
     engine-side and authorization-aware.

5. **Save/history model:** every durable write is captured; UI shows meaningful
   moments.
   - The engine may record fine-grained writes internally for recovery.
   - Users should see coalesced, understandable moments like "Updated
     strategy.md" or "Local edit to strategy.md" instead of noisy save events.
   - Coalescing is actor-neutral. It groups by activity shape: quiescence,
     related files, explicit checkpoints, imports, merges, restores, publishes,
     and known dohc action boundaries when available.
   - For ordinary local file writes, dohc does not need to distinguish whether
     the process was a user, an agent CLI, a script, or an editor plugin.
     Honest generic attribution such as local edit/device/session is
     acceptable.

6. **Conflict model:** preserve both sides; never silently overwrite tracked
   workspace content.
   - Same-version concurrent writes either merge deterministically or preserve
     both states.
   - Version merges preserve base/current/incoming on conflict.

7. **Content model:** content drivers own canonical state behind shared engine
   contracts.
   - Plain files use bytes/text.
   - Rich docs can use Y.Doc.
   - SQLite/app-backed objects get dedicated drivers later.
   - Every driver must declare snapshot, diff, merge/conflict, projection,
     search, export, restore, and ACL behavior.

8. **Secret model:** secret-backed files are a first-class driver, not ordinary
   plaintext with a label.
   - `.env` should eventually be safe to version and share through dohc
     permissions.
   - Plaintext materialization is explicit, local, authorized, and excluded
     from ordinary history/search/export/log/chat surfaces unless explicitly
     declassified.
   - dohc must not claim per-agent secret enforcement for arbitrary local
     processes after plaintext is materialized into a normal folder. Strong
     per-agent enforcement requires dohc-controlled APIs, launched processes,
     sandboxing, redacted projections, mounts, or secret injection.

9. **Policy model:** policy can be source-backed, but privileged policy changes
   require engine authorization.
   - An agent editing a config file must not be able to grant itself access by
     changing text.

10. **Chat model:** chats are action-native social objects with read-only text
    projections.
    - Humans and agents post through chat actions.
    - Agents can read projected chat context as text.
    - Editing a projection file does not mutate the chat.

11. **Agent capability principle:** users should be able to delegate anything
    they are allowed to do.
    - dohc should not limit agents because they are agents.
    - The boundary is user permission, workspace policy, locks, sharing, and
      explicit safety gates, not a smaller product surface for agents.
    - Agent identity is required for chat/social actions so shared spaces show
      `<User Name>'s agent`, but normal file versioning must work even when
      dohc only sees a local file change.

12. **Phase 0 success demo:** prove the full loop with one ordinary text file,
    one named version, history/restore, compare/merge/conflict preservation,
    one linked chat, search, and no `.env` leakage.

## Runtime And Language Strategy

Long term, Rust should be treated as the likely best language for the local
dohc workspace engine.

This does not mean rewriting all of dohc in Rust. It means drawing a clear
boundary:

```text
TypeScript:
  app UI
  desktop/web product flows
  cloud/service orchestration
  chats UI and product logic
  agent orchestration
  tests, fixtures, and rapid iteration surfaces

Rust:
  local workspace kernel
  filesystem reconciliation
  manifests and durability log
  content hashing/chunking
  version snapshots
  conflict-preserving merge primitives
  search/indexing plumbing where useful
  secret materialization boundaries
  future managed filesystem projection/mount
```

The goal is a Rust local kernel with a stable contract, not a giant native
rewrite of product semantics.

The rule is:

```text
Rust for the local workspace kernel.
TypeScript for product velocity and UI.
Stable contract between them.
Measure everything.
```

Why Rust is likely right for the kernel:

- predictable performance for filesystem-heavy work.
- memory safety for long-lived local daemons.
- strong concurrency for watcher/reconciliation/indexing queues.
- good fit for crash recovery, manifests, hashing, encryption, and mount work.
- better long-term foundation for native-feeling desktop behavior.

Candidate Rust-owned boundaries:

- filesystem projection/mount implementation.
- high-volume filesystem scan/reconciliation.
- content hashing and chunking.
- text diff/merge for very large files.
- search/indexing if ripgrep or an embedded index is insufficient.
- compression/encryption-heavy paths.
- SQLite/app-driver internals where WASM/native is clearly better.

The first Rust step should be a spike, not a full rewrite. The spike must
answer:

- Can the Rust kernel expose a small stable API to the TypeScript app?
- Should the boundary be IPC/JSON-RPC, HTTP over localhost, N-API, Tauri-style
  commands, or a sidecar daemon?
- How does the boundary authenticate local callers and bind each request to the
  server/engine-derived actor, workspace, and version?
- Can packaging work cleanly for macOS, Windows, and Linux?
- Can development stay fast enough for the MVP?
- Can tests run in CI without fragile native setup?
- Can the Rust path beat or match TypeScript for scan/reconcile/hash workloads?
- Can policy/authz contracts stay testable and shared?

Any local kernel bridge, regardless of transport, must be an authenticated local
channel. IPC/JSON-RPC, localhost HTTP, N-API, Tauri-style commands, and sidecar
daemons all must enforce channel binding plus server/engine-derived actor,
workspace, and version resolution on every request. Localhost alone is not a
security boundary.

Adoption criteria after the spike:

- Rust packaging is reliable across target OSes.
- IPC/API shape is boring and testable.
- measured scan/reconcile/hash performance is meaningfully better or more
  predictable than the TypeScript path.
- the TypeScript app remains easy to develop against.
- no second source of truth appears.
- failure modes, logs, crash recovery, and upgrade behavior are clear.

Avoid bad compromises:

- a giant native rewrite of workspace semantics.
- two sources of truth split across TypeScript and native code.
- native code owning authz/policy decisions without the same test matrix.
- introducing FFI/package complexity into product code before the spike proves
  the boundary.

Preferred package boundary order:

```text
contracts
  -> workspace object/version/event core
  -> file policy and projection contracts
  -> filesystem/API parity
  -> chats data/actions
  -> UI integration
  -> external sharing/search/hardening
```

Each PR must:

1. Start from an approved branch plan.
2. Add or update failing tests first where production behavior changes.
3. Implement the smallest coherent slice.
4. Run targeted tests.
5. Run required integration/E2E/security regressions.
6. Update the execution log.
7. Open a PR.
8. Run the canonical CodeRabbit loop defined below.

Recommended branch naming:

```text
<branch-prefix>/think-bigger-00-readiness-scaffold
<branch-prefix>/think-bigger-p0a-inventory
<branch-prefix>/think-bigger-p0r-rust-kernel
<branch-prefix>/think-bigger-p0b-versioned-store
<branch-prefix>/think-bigger-p0c-file-history
...
```

## Phase 0 Proof Arc

Phase 0 is the immediate execution target. It is intentionally smaller than the
full roadmap and must be grounded in the current repository implementation.

Phase 0 proves:

```text
normal file edit
  -> automatic history
  -> restore
  -> named version
  -> compare/merge
  -> conflict preservation
  -> one chat linked to the file
```

It should use one content driver first: ordinary text/file content. Do not
generalize to SQLite row merge, app-aware merge, full lazy hydration, external
channels, or rich chat texture until the proof arc passes.

Phase 0 must also prove the architecture is fast enough to build on. A correct
but sluggish proof is not acceptable; it must demonstrate native-feeling local
file edits, startup reconciliation, history display, search, and linked chat UI
under the initial performance budgets.

### Phase 0 Decisions

Before implementation starts, write a short decision note inside this plan's
execution log covering:

1. **Storage baseline**
   - Which existing dohc packages/tables/files are the starting point?
   - What is the minimal store for file content, stable object IDs, versions,
     moments, and conflicts?

2. **Filesystem interposition**
   - Is Phase 0 watcher-backed over normal folders, virtual filesystem-backed,
     or API-only with a simulated folder adapter?
   - What safety guarantees does that choice provide and not provide?

3. **Secret boundary**
   - Phase 0 must not promise unenforceable secret guarantees.
   - If secret-backed files are not implemented in Phase 0, default `.env`
     behavior is exclude/ignore/redact, not track plaintext.

4. **Merge scope**
   - Phase 0 supports honest 3-way text/file merge only.
   - Conflicts can use side-by-side or choose-current/choose-incoming UI.
   - No semantic code merge promise.

5. **Chat/file philosophy**
   - File content is file-native.
   - Chats are action-native social objects with read-only text projections.
   - Agents can edit files through files/API and can post chats through chat
     actions. This is not a contradiction; it is object-type appropriate IO.

6. **Rust kernel boundary**
   - What minimum Rust workspace-kernel API should Phase 0 spike?
   - Which contract stays in TypeScript/shared schemas?
   - Which process boundary is preferred: sidecar daemon, IPC/JSON-RPC,
     localhost HTTP, N-API, or another bridge?
   - How will packaging, CI, logs, crash recovery, and upgrades work?
   - Which Phase 0 filesystem/reconciliation workload should Rust benchmark
     against the TypeScript implementation?

### Phase 0 PRs

These PRs precede PR 01 in the expansion roadmap.
Do not begin PR 01 or any later roadmap PR until Phase 0 passes, and do not
begin contract or implementation work until P0A writes and gets approval for the
current-system inventory, storage/filesystem decision note, and unresolved
blockers in the execution log.

#### PR P0A - Current System Inventory And Decisions

**Goal:** Anchor the plan to the real codebase before building abstractions.

**Scope:**

- Inventory current storage, file, atom, Y.Doc, app, chat/agent, search, and
  sharing code paths.
- Identify reusable packages from prior filesystem/backend plans.
- Write the Phase 0 decision note in the execution log.
- Pick the Phase 0 storage and filesystem-interposition approach.

**Tests:**

- No production tests required unless inventory reveals broken existing tests.
- Run docs/link smoke if available.

**Acceptance:**

- execution log contains concrete current-to-target deltas.
- Phase 0 implementation path is chosen.
- unresolved decisions are explicit blockers, not implied.
- PR 01 and later roadmap work remain blocked until the P0A decision note is
  approved.

#### PR P0R - Rust Workspace Kernel Spike

**Goal:** Decide the Rust kernel boundary with evidence before deep engine
implementation.

**Scope:**

- Create a minimal Rust spike or design prototype for the local workspace
  kernel boundary.
- Define a small API for:
  - scan/reconcile a workspace root.
  - return changed path metadata.
  - hash changed candidates.
  - emit structured timing/log events.
- Compare bridge options:
  - sidecar daemon.
  - IPC/JSON-RPC.
  - localhost HTTP.
  - N-API/native module.
  - Electron/Tauri-style command bridge where relevant.
- Document packaging implications for macOS, Windows, and Linux.
- Document CI implications and local developer setup.
- Benchmark against equivalent TypeScript scan/hash/reconcile code on realistic
  generated fixtures.
- Record recommendation: Rust kernel now, Rust kernel later, or TypeScript
  Phase 0 with Rust-ready contracts.

**Tests:**

- Rust unit tests if code is created.
- TypeScript contract tests for request/response shape.
- fixture-based scan/hash benchmark.
- failure-mode test for malformed paths and missing workspace roots.

**Acceptance:**

- recommended kernel boundary is explicit.
- performance numbers are recorded.
- packaging and CI risks are recorded.
- no product PR depends on an unproven native bridge.

#### PR P0B - Minimal Versioned Text Store

**Goal:** Add Main plus one named version for ordinary text/file content.

**Scope:**

- Stable object ID for a file.
- Main version and one named version.
- Version-specific file content.
- Ancestry/fork point.
- Actor-neutral write metadata.

**Tests:**

- create Main.
- create named version from Main.
- write same path in both versions and prove isolation.
- path rename keeps stable object ID where supported.
- wrong workspace/version denied.

**Acceptance:**

- one file can have different contents in two versions.

#### PR P0C - File/API Write Capture And History

**Goal:** Prove ordinary writes save immediately and become recoverable
history.

**Scope:**

- Write/read/list/stat through the chosen Phase 0 surface.
- Fine-grained durability entries.
- Coalesced meaningful moments.
- Restore one file to a previous moment.

**Tests:**

- write file and read it back.
- temp-file/rename save sequence if watcher-backed.
- multiple rapid writes coalesce into a readable moment.
- restore creates forward history.
- API and filesystem/simulated filesystem agree.

**E2E:**

- edit `docs/plan.md`, see history, restore previous text.

**Acceptance:**

- normal edit -> history -> restore works.

#### PR P0D - Compare, Clean Merge, Conflict Preservation

**Goal:** Prove VCS-grade basics for one text/file driver.

**Scope:**

- Compare named version against Main.
- Clean merge from named version into Main.
- Preserve base/current/incoming on conflict.
- Minimal conflict UI or API.

**Tests:**

- clean non-overlapping merge.
- same-line conflict.
- delete-vs-edit conflict.
- deterministic merge result.
- no silent loss property checks for small corpus.

**E2E:**

- edit same file differently in Main and named version, compare, conflict,
  inspect both sides, resolve, restore.

**Acceptance:**

- merge either succeeds cleanly or preserves both sides.

#### PR P0E - Minimal Chat Linked To File

**Goal:** Prove chats can attach to work without becoming versioned files.

**Scope:**

- Minimal channel or workspace chat.
- One chat thread linked to a stable file object ID.
- Message send.
- Read-only text projection for agent context.
- Related chat appears beside the file in a simple side rail or equivalent UI.

**Tests:**

- create chat linked to file object.
- link survives file path display change where supported.
- message send.
- projection is read-only.
- unauthorized linked file degrades without metadata leak.

**E2E:**

- open file, create linked chat, send message, see related chat from file view.

**Acceptance:**

- conversation appears where the file work lives.

#### PR P0F - Search And Policy Smoke

**Goal:** Prove the first cross-surface policy/search loop.

**Scope:**

- Search text file and linked chat.
- Apply minimal effective policy to files, chat links, projections, and search.
- Default `.env` to ignored/excluded/redacted until secret-backed files exist.

**Tests:**

- search returns file and linked chat.
- unauthorized actor cannot see private file/chat result.
- `.env` plaintext does not enter search/history/export in Phase 0.
- workspace switch/request-token race test for file/search/chat loading.

**E2E:**

- search finds the chat and linked file together.
- switch workspace mid-load and verify old workspace data never repaints new.

**Acceptance:**

- search connects work and conversation without leaking policy-protected data.

#### PR P0G - Proof Arc QA And CodeRabbit Hardening

**Goal:** Make Phase 0 trustworthy before expanding.

**Scope:**

- Full Phase 0 test matrix.
- CodeRabbit loop for every Phase 0 PR.
- Architecture/security/QA subagent reviews.
- Manual QA script.
- Performance smoke.
- Migration impact note.

**Required E2E:**

- file edit/history/restore.
- named version isolation.
- compare/merge/conflict preservation.
- chat linked to file.
- search across chat/file.
- local agent CLI edits a file through the normal workspace surface and dohc
  captures history without the agent knowing dohc-specific version control.
- workspace-switch race.
- `.env` exclusion/redaction smoke.

**Acceptance:**

- Phase 0 passes without skipped critical E2E.
- Phase 0 records measured performance against the initial budgets.
- no Phase 0 path blocks the renderer on whole-workspace filesystem work.
- no unresolved P0/P1 findings.
- expansion roadmap is revised with lessons learned.

### Deferred From Phase 0

Do not include these in Phase 0 unless the user explicitly expands scope:

- external/shared channels.
- lazy hydration at scale.
- full virtual filesystem/FUSE/ProjFS implementation unless chosen by the
  interposition spike as the smallest viable path.
- user-authored `.dohc/files.toml` policy DSL beyond minimal hardcoded/default
  policy.
- encrypted synced secret-backed `.env` with full broker/declassification flow.
- SQLite row-level merge.
- app/site-aware merge and build gates.
- presence, typing indicators, reactions, digest mode, and quiet hours.
- mobile chat UI.
- external VCS export fidelity.
- semantic code merge.

## Agent And Review Workflow

### Execution Topology: Worktrees And Focused Implementation Threads

Use this main thread as the orchestration thread. It owns the mega plan,
execution log, cross-lane decisions, and final reconciliation.

Implementation should happen in isolated worktrees by default:

```text
main planning checkout
  -> <branch-prefix>/think-bigger-p0r-rust-kernel      in ../dohc-p0r-rust-kernel
  -> <branch-prefix>/think-bigger-p0b-versioned-store  in ../dohc-p0b-versioned-store
  -> <branch-prefix>/think-bigger-p0c-file-history     in ../dohc-p0c-file-history
  -> <branch-prefix>/think-bigger-p0e-linked-chat      in ../dohc-p0e-linked-chat
  -> <branch-prefix>/think-bigger-p0f-search-policy    in ../dohc-p0f-search-policy
```

Default rule:

- one implementation PR = one branch = one worktree.
- one focused implementation chat/thread may own that worktree when the lane is
  substantial.
- no two agents edit the same worktree at the same time.
- shared decisions flow back into this main thread and the execution log.
- generated artifacts, perf measurements, review notes, and migration notes
  must be copied back into the PR entry before the lane is considered done.

Create separate focused implementation chats/threads for major lanes, not for
tiny edits:

- **Rust Kernel Spike Thread:** PR P0R.
- **Versioned Store Thread:** PR P0B/P0D if merge work stays tightly coupled.
- **Filesystem Capture Thread:** PR P0C and later PR 05/06/09/10.
- **Chats Product Thread:** PR P0E and later PR 12-17.
- **Search/Policy Thread:** PR P0F and later PR 04/11/17/18.
- **QA/Performance Hardening Thread:** PR P0G and later release gates.

Each implementation thread should start with:

- this mega plan.
- the execution log.
- the relevant source spec.
- the exact PR scope.
- the branch/worktree path.
- required tests and performance budgets.
- CodeRabbit loop instructions.
- if the scope touches `apps/web`, the thread must read `apps/web/AGENTS.md`
  before editing and record that in its execution-log entry.
- if the scope touches `apps/app`, the thread must read `apps/app/AGENTS.md`
  before editing and record that in its execution-log entry.
- if the scope touches Convex code under `apps/app`, the thread must first
  check `apps/app/convex/_generated/ai/guidelines.md`, read it when present,
  and record the checked path or absence in its execution-log entry before
  editing.

Separate implementation chats/threads are user-visible and should only be
created when the user explicitly asks or approves. Subagents remain the default
for short bounded reviews inside the current thread.

Worktree hygiene:

- Create branches with the configured branch prefix for the environment.
- Keep worktrees narrow and disposable.
- Never share uncommitted edits across lanes.
- Rebase/merge only through explicit PR reconciliation.
- If a worktree setup fails, record the failure and fix the worktree before
  assigning implementation work to that lane.

### Required Subagent Roles

Use subagents for independent, bounded reviews. Do not let multiple agents edit
the same files at once unless their write scopes are disjoint.

Recommended roles:

- **Architecture Reviewer**: checks substrate coherence and invariants.
- **Security Reviewer**: checks authz, secret-backed files, sharing, external
  channels, and agent access.
- **Versioning Reviewer**: checks snapshots, ancestry, merge, conflict, restore.
- **Filesystem Reviewer**: checks file policy, materialization, watcher capture,
  and API/FS parity.
- **Chats Reviewer**: checks channel/DM/thread UX, notifications, search,
  external channels, and agent authorship.
- **QA Reviewer**: checks test coverage, E2E, visual QA, performance budgets,
  and skipped tests.
- **Performance Reviewer**: checks startup, filesystem capture, indexing,
  search, chat/history virtualization, renderer jank, memory, and budget
  regressions.
- **Migration Reviewer**: checks data migration, backwards compatibility, and
  deletion safety.

Each subagent review should return:

- top risks.
- missing tests.
- must-not-ship blockers.
- one destructive scenario to reproduce.
- recommended CodeRabbit focus prompts.

The main implementing agent must reconcile disagreements into one release gate
checklist before merging a milestone PR.

### CodeRabbit Loop

For every implementation PR:

```text
Open PR
  -> wait for CodeRabbit review
  -> triage every finding
  -> fix valid findings
  -> document rejected findings with reason
  -> rerun targeted/full tests
  -> request/re-run review if needed
  -> repeat until CodeRabbit approves or the user explicitly approves a
     documented non-sensitive override
```

CodeRabbit findings must not be "resolved" by:

- weakening tests.
- removing coverage.
- bypassing auth.
- hiding failed E2E.
- marking security concerns as follow-up.

Authorization, ownership, workspace isolation, secrets, privacy, data-loss, and
permission-boundary findings are non-overridable blockers for the relevant PR.
Overrides are only allowed for documented non-blockers such as preference
disagreements, false positives, or intentionally deferred polish, and only after
explicit user approval is recorded in the PR and execution log.

### Execution Log

Create and update:

```text
docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
```

For every PR/phase record:

- goal.
- branch.
- files changed.
- tests added.
- commands run.
- failures found.
- fixes made.
- CodeRabbit status.
- subagent reviews.
- manual QA.
- remaining risks.
- follow-up deletion conditions.

## Testing Standard

### Required Test Types

Each relevant PR must include:

- unit tests.
- integration tests.
- authorization/security tests.
- migration tests if schema/data changes.
- E2E tests for user-visible flows.
- visual QA for UI surfaces.
- performance checks for filesystem/search/chat-heavy flows.
- regression tests for known failure modes.
- projection writeability tests.
- workspace/request-token async race tests.
- crash/restart recovery tests for captured writes and history.
- multi-actor concurrency tests for shared versions and conflict paths.
- merge property tests for no silent loss, determinism, and recoverability.
- prompt-injection-to-action tests for chat/agent workflows.
- local agent CLI tests for normal file edits and chat actions.
- accessibility checks for chat, conflict, search, and version UI.

### Never Skip These E2E Areas

These E2E requirements apply to surfaces that are implemented, shipped, or in
scope for the PR/milestone under review. Deferred Phase 0 areas do not require
their E2E before they exist, but once a surface is introduced its listed E2E is
mandatory for that PR and future release gates.

- workspace creation/open.
- file editing and automatic save.
- external editor/process file edit while dohc is running.
- external editor/process file edit while dohc is stopped, followed by startup
  reconciliation.
- history/restore.
- named version creation and compare.
- conflict preservation.
- file policy behavior.
- secret-backed file redaction/export.
- chat channel creation and messaging.
- DM/small group messaging.
- chat linked to file side rail.
- agent reply displayed as `<User Name>'s agent`.
- notifications for mentions/DMs/followed chats.
- search across chats and files.
- external/shared channel visibility.
- filesystem/API parity for the same version.
- workspace switch while files/chats/search are loading; old workspace data must
  never repaint the new workspace.
- secret-backed content must not appear in UI, search, history, diff, export,
  logs, chat summaries, notifications, agent context, or public projections.
- crash or kill during file write/capture does not corrupt recoverable state.
- missed watcher event is recovered by startup reconciliation or periodic audit.
- two actors writing the same path/version concurrently preserve both states or
  merge deterministically.
- chat prompt injection cannot trick an agent tool into reading/writing outside
  allowed workspace/version/policy.
- local agent CLI can perform delegated work through ordinary files/actions
  without dohc-specific version-control knowledge.

If an E2E cannot run due to external services, use a deterministic local/mock
environment and record the limitation. Do not delete or skip the test.

### Local Agent CLI Testing

dohc must be tested with real local agent CLIs, because the product promise is
that agents can operate the workspace naturally.

The test harness should support:

```bash
DOHC_TEST_AGENT_CLI=codex
```

Defaults:

- `DOHC_TEST_AGENT_CLI` defaults to `codex`.
- `codex` should resolve from `DOHC_CODEX_CLI` or `codex` on `PATH`.
- `claude` should resolve from `DOHC_CLAUDE_CLI` or `claude` on `PATH`.

Required behavior:

- run against disposable local workspaces only.
- no production user data.
- no real secrets unless a test creates fake throwaway secrets.
- capture transcripts/artifacts for QA, with secret redaction.
- test the agent through normal files and normal dohc actions, not privileged
  internals, unless the PR is explicitly testing internal APIs.
- use `codex` as the required default path.
- run `claude` as a secondary compatibility path where available, especially
  before major milestone gates.

### Security Regression Matrix

Run security regression tests after any PR touching:

- auth/session identity.
- workspace scoping.
- version access.
- file policy.
- secret-backed files.
- chat/channel visibility.
- external shares.
- agent tools.
- app/database access.
- exports/imports.

Minimum cases:

- wrong workspace denied.
- wrong version denied.
- private path denied.
- secret-backed file denied.
- external channel cannot read unshared file.
- agent cannot exceed user's permissions.
- public export redacts/excludes private and secret-backed content.
- search does not leak unauthorized snippets.
- notification payload does not leak private content.
- chat projection does not leak private linked work.
- side rail link does not reveal hidden target metadata.
- search index entries are workspace-scoped and policy-filtered.
- secret values cannot be copied into durable chat/history/agent logs without
  explicit declassification.
- prompt-injection content in chats cannot expand agent permissions or bypass
  tool policy.

### Accessibility Gate

User-facing UI PRs must define and test an accessibility target. Default target:

- keyboard navigable.
- screen-reader labels for chat composer, version menu, history, compare,
  conflict choices, search results, and notification controls.
- visible focus.
- no color-only conflict/secret/privacy indicators.
- WCAG 2.2 AA where practical for shipped surfaces.

### Performance Budgets

Initial budgets are not final product promises, but every implementation should
move toward native-feeling performance instead of accepting slow architecture
and hoping to optimize later.

- open 1,000-file workspace to interactive tree: under 1.5s local dev target.
- show first useful workspace shell after launch: under 500ms local dev target.
- startup reconciliation for 10,000 unchanged materialized files: under 2s
  metadata pass, with UI interactive during the scan.
- list 10,000 paths through workspace API: under 200ms after metadata warm.
- open lazy file after metadata warm: under 300ms local/cloud target, excluding
  explicit remote cold-start conditions.
- external editor save reflected in dohc UI/history status: under 500ms local
  target after file watcher event.
- coalesce 100 file writes into a moment: under 3s without renderer blocking.
- absorb 1,000 ignored/cache file events without visible UI jank or sync flood.
- render channel with 1,000 chats: under 500ms to first useful content.
- scroll 10,000-message/channel history with virtualization and no obvious jank.
- search 10,000 chats/messages plus 10,000 files metadata: under 500ms for
  indexed search.
- conflict compare for two 250KB text files: under 1s.
- switching workspaces cancels/guards stale work without blocking interaction.

Record measured values in the execution log. If CI cannot meet local budgets,
record environment and assert regression thresholds.

Instrumentation requirements:

- Add timing spans or metrics before optimizing by guesswork.
- Record cold vs warm measurements separately.
- Record workspace size, file count, changed file count, chat/message count,
  machine/CI context, and whether content was local, lazy, or remote.
- Track renderer blocking/jank for UI-heavy PRs.
- Include a rollback or mitigation plan when a feature risks exceeding budget.

Performance anti-patterns:

- full-content hashing every file on every launch.
- synchronous whole-workspace scans on the renderer thread.
- unbounded watcher queues.
- unbounded chat/history DOM rendering.
- per-result authorization queries in search.
- sync fanout per filesystem event instead of batched durable changes.
- loading full file contents when metadata is enough.
- using cloud roundtrips for local-first interactions.
- choosing Rust as a blanket fix for architecture problems instead of a
  measured kernel boundary.

## PR Roadmap

The expansion roadmap is intentionally long. It starts only after Phase 0
passes and the plan is revised with what Phase 0 teaches.

Each PR should be reviewable by humans and CodeRabbit. If a PR grows too large,
split it before opening.

Milestones:

- **Foundation alpha:** PR 00-04 prove shared contracts, stable IDs, typed
  events, versions, and effective policy.
- **Filesystem/version proof:** PR 05-11 prove normal files, versions,
  snapshots, conflicts, policies, secrets, lazy hydration, and API parity.
- **Chats proof:** PR 12-17 prove channels, DMs, agent participation, side-rail
  links, notifications, and search.
- **Collaboration expansion:** PR 18-22 prove external/shared channels,
  integrated UX, agent work loops, migration, and full release hardening.

Do not expose the new system as the default product surface until the
Foundation alpha and the relevant surface proof are complete.

### PR 00 - Mega Plan And Readiness Scaffold

**Goal:** Land the design docs, mega plan, execution log, and readiness checks.

**Scope:**

- Add this mega plan.
- Add execution-log template.
- Add a tracking checklist doc or section.
- Add links from relevant product docs if appropriate.

**Tests:**

- docs lint if available.
- link/path smoke via `rg` or docs tooling.

**CodeRabbit focus:**

- plan clarity.
- missing QA gates.
- PR sizing.

**Acceptance:**

- user approves plan.
- execution log exists.
- no implementation starts before approval.

### PR 01 - Workspace Engine Contracts And Substrate

**Goal:** Define shared TypeScript contracts for the substrate all later work
must use.

**Scope:**

- Add or extend shared package for workspace engine contracts.
- Define `WorkspaceObject`, `StableObjectId`, `WorkspaceVersion`,
  `VersionRef`, `WorkspacePath`, `HistoryMoment`, `DurabilityEvent`,
  `WorkspaceEvent`, `FilePolicy`, `Projection`, `ProjectionWriteability`,
  `ConflictRecord`, `ChatThread`, `Channel`, `ThreadMessage`, `ThreadLink`.
- Define link dereference shape: target type, stable target ID, optional
  `VersionRef`, display path/title at link time, ACL degrade behavior.
- Define projection writeability values: `canonical`, `writable`, `readOnly`,
  `lossy`, `redacted`.
- Define one effective policy input/output type for filesystem, chats, search,
  notifications, export, and external shares.
- Add zod/valibot-style runtime validation if repo convention supports it.
- Add fixtures for personal, team, external shared, and agent-authored cases.

**Tests:**

- unit tests for validators and fixtures.
- type-level compile tests where useful.
- serialization round-trip tests.
- invalid workspace/version/path rejection.
- stable IDs survive path rename fixture.
- projection writeability fixture coverage.

**Subagents:**

- Architecture Reviewer.
- Security Reviewer.

**CodeRabbit focus:**

- stable names.
- no overbroad `any`.
- auth-sensitive fields clearly separated from display fields.
- no path-as-identity leakage.

**Acceptance:**

- contracts compile.
- fixtures cover version, filesystem, and chat use cases.
- every future PR can depend on the same object/event/policy/projection shapes.

### PR 02 - Version Registry And Typed Event Skeleton

**Goal:** Introduce the internal version and typed event model without changing
default user behavior.

**Scope:**

- Add storage schema/adapters for workspace versions.
- Add Main version for each workspace.
- Add typed event skeleton for writes, moments, chat activity, notifications,
  agent runs, merges, restores, policy changes, shares, and exports.
- Add history/moment projection tied to writes/imports/agent runs where safe.
- Add actor-neutral provenance fields, with file-level attribution allowed to
  be device/session-level for raw local writes.
- Add stable object ID registry for existing file/doc/chat-like state where
  applicable.
- Add migration/backfill for existing file/doc/chat substrate in current
  workspaces; defer app/data object-ID migration to the subsystem or migration
  milestone that introduces those identities.

**Tests:**

- migration tests.
- Main version auto-created.
- existing workspace opens unchanged.
- dohc-authenticated actions record actor kind without changing permissions.
- raw local file writes can record generic local/device/session provenance
  while still preserving history and recovery.
- typed events are workspace-scoped.
- event projections cannot read events from another workspace.
- existing path links resolve through stable object IDs where backfilled.

**E2E:**

- existing workspace open/edit still passes.

**CodeRabbit focus:**

- migration safety.
- workspace scoping.
- no client-trusted actor identity.
- event/log privacy.

**Acceptance:**

- current product behavior remains intact.
- every workspace has a version baseline.
- every new history/activity/chat-related feature has one event substrate to
  build on.

### PR 03 - Snapshot And Restore Foundation

**Goal:** Add VCS-grade snapshot/recovery primitives for file-backed content.

**Scope:**

- Hash-commit file states.
- Record ancestry/fork points for versions.
- Add restore-to-point primitives for basic text/file content.
- Add engine-level tests for snapshot immutability.

**Tests:**

- immutable snapshot tests.
- restore tests.
- hash changes on content changes.
- restore creates forward history, not silent history deletion.

**E2E:**

- edit file, view history, restore earlier state.

**CodeRabbit focus:**

- accidental mutation of snapshots.
- restore edge cases.
- data loss risks.

**Acceptance:**

- file content can recover to a known-good state.

### PR 04 - Effective Policy And File Policy Resolver

**Goal:** Implement `.dohc/files.toml` parsing and one effective policy
resolver used by files, versions, chats, links, search, notifications, and
exports.

**Scope:**

- Add policy parser.
- Add defaults for source, apps, data, `node_modules`, `dist`, cache, scratch,
  and `.env`.
- Resolve tracked/synced/materialized/encrypted/searchable/visibility/export
  policy.
- Resolve channel/chat membership and linked-work visibility into the same
  effective policy shape.
- Add projection writeability checks.
- Add UI/API-safe status shape.

**Tests:**

- parser unit tests.
- precedence tests.
- path glob tests.
- malformed policy tests.
- unauthorized policy escalation denied.
- private linked object hidden from chat link/search/notification fixtures.
- projection writeability enforced.

**Security tests:**

- local policy cannot grant external access beyond server/engine auth.
- a user cannot infer hidden file/version/chat/secret existence through links,
  search, notification, export, or status APIs.

**CodeRabbit focus:**

- glob correctness.
- deny-by-default for sensitive policy.
- no auth from local file alone.
- consistent policy use across surfaces.

**Acceptance:**

- effective policy can be computed for any path.
- effective policy can be computed for any link/projection/search/export
  request.

### PR 05 - Native Filesystem Capture MVP

**Goal:** Capture normal file writes into a version without making every FS
event a visible history item.

**Scope:**

- Add file watcher/capture adapter for local workspace folder.
- Add startup reconciliation for edits made while dohc was closed.
- Add periodic audit/reconciliation for missed watcher events.
- Add durability log.
- Add actor-neutral coalescing into moments based on quiescence, related file
  batches, explicit checkpoints, and known dohc action boundaries.
- Track cached file metadata, platform file IDs where available, and content
  hashes for changed candidates.
- Detect creates, edits, deletes, and likely renames/moves.
- Respect tracked/untracked policy.
- Ignore or localize `node_modules`, `dist`, and caches by default.

**Tests:**

- temp-file-rename save sequence.
- partial write then final write.
- delete/recreate.
- edit while dohc is closed, then launch and reconcile.
- missed watcher event recovered by audit.
- rename/move preserves or reconnects stable object ID where supported.
- local change and same-workspace concurrent change compare against common base.
- batch many writes into one moment.
- ignored files do not enter tracked history.

**E2E:**

- edit file through external process/editor simulation.
- edit file with dohc stopped, launch dohc, verify history/reconciliation.
- dohc reflects edit and history.

**Performance:**

- 100 file writes coalesce within budget.

**CodeRabbit focus:**

- watcher race conditions.
- startup scan correctness.
- avoiding naive full-content hash of every file on every launch.
- history noise.
- untracked file handling.

**Acceptance:**

- normal file edits save immediately and produce usable history.
- edits made outside dohc are detected while running or on next launch.

### PR 06 - Version Folders Or Mounts MVP

**Goal:** Make named versions tangible as folders/mounts or equivalent local
projections.

**Scope:**

- Create/list/delete named versions.
- Expose Main and named version folder projections.
- Ensure file writes save to the correct version.
- Prevent hidden global "current version" mistakes.

**Tests:**

- version creation.
- edits in Main do not affect named version.
- edits in named version do not affect Main.
- paths resolve through version identity, not client-supplied trust.

**E2E:**

- create version, edit file in both versions, compare changed state.

**CodeRabbit focus:**

- path/version confusion.
- accidental cross-version writes.

**Acceptance:**

- users and agents can work in separate version folders with normal file ops.

### PR 07 - Compare And Merge For Text/File Driver

**Goal:** Add common-base compare/merge for normal files and text.

**Scope:**

- Implement base/current/incoming model.
- Add clean merge.
- Add conflict preservation.
- Add `.dohc/conflicts/` projection or UI/API equivalent.
- Avoid raw conflict markers as primary UX.

**Tests:**

- clean merge.
- same-line conflict.
- delete-vs-edit conflict.
- rename or move handling if supported.
- conflict preserves base/current/incoming.

**E2E:**

- two versions edit same file.
- conflict appears and both sides are recoverable.

**CodeRabbit focus:**

- data loss.
- conflict correctness.
- deterministic merge behavior.

**Acceptance:**

- basic file versions can reconcile safely.

### PR 08 - Secret-Backed Files

**Goal:** Allow `.env`-style files to be tracked safely with policy,
encryption, redaction, and controlled materialization.

**Scope:**

- Add secret-backed file type or policy behavior.
- Store encrypted secret file content.
- Redact/exclude from public export and unauthorized projections.
- Prevent search/snippet leakage.
- Allow authorized local materialization.
- Add process env injection adapter if appropriate.

**Tests:**

- authorized actor reads `.env`.
- unauthorized actor denied/redacted.
- public export redacts/excludes.
- search cannot find secret values.
- history/diff does not expose plaintext.
- agent access policy allow/ask/explicit/deny.

**E2E:**

- create `.env`, sync/export/share, verify visibility behavior.

**Security subagent:**

- required.

**CodeRabbit focus:**

- plaintext leakage.
- auth bypass.
- logs/search/export.

**Acceptance:**

- dohc can "commit env files" safely.

### PR 09 - Lazy Hydration And Pinning

**Goal:** Make full tree metadata available immediately while content hydrates
on demand.

**Scope:**

- Add metadata-only tree listing.
- Add lazy content fetch/materialization.
- Add pin/unpin API.
- Add materialization status.
- Add prefetch hooks for search/build/open.

**Tests:**

- list tree without content.
- read hydrates content.
- pinned subtree remains local.
- unpinned large file does not hydrate until touched.
- offline behavior for pinned/unpinned.

**E2E:**

- simulate new machine/cloud agent opening workspace tree then reading one file.

**Performance:**

- tree listing and first read budgets.

**CodeRabbit focus:**

- cache invalidation.
- stale content.
- offline behavior.

**Acceptance:**

- cloud agents can start from tree metadata and hydrate only what they need.

### PR 10 - Workspace Status And Diagnostics

**Goal:** Make local/remote/tracked/synced/materialized/conflicted/secret state
legible.

**Scope:**

- Add status API.
- Add `dohc status` or equivalent dev diagnostic if CLI exists.
- Add UI badges/status panel.
- Add `.dohc/status.json` projection if useful.

**Tests:**

- status reflects policy.
- status reflects conflicts.
- status reflects lazy/pinned state.
- status does not leak private names to unauthorized viewers.

**E2E:**

- create conflict and inspect status.
- pin folder and inspect status.

**CodeRabbit focus:**

- hidden safety state.
- privacy leakage in status payloads.

**Acceptance:**

- users and agents can tell what state the filesystem is in.

### PR 11 - Search Foundation Across Versions And Files

**Goal:** Search works across files, versions, and policy-aware projections.

**Scope:**

- Index tracked/searchable files.
- Respect version scope.
- Respect file policy and permissions.
- Include history/moment references where useful.

**Tests:**

- searchable true/false.
- version-scoped results.
- unauthorized snippets denied.
- secret-backed values excluded.

**E2E:**

- search finds a file in Main and a different result in named version.

**Performance:**

- indexed search budget for 10k paths.

**CodeRabbit focus:**

- leakage via search.
- stale index.

**Acceptance:**

- search is policy-aware and version-aware.

### PR 12 - Chats Schema And Channel/DM Foundation

**Goal:** Add data model and APIs for channels, DMs, chat threads, messages,
links, activity, read state, and reactions.

**Scope:**

- Add schemas/adapters.
- Add API functions/actions.
- Add workspace scoping.
- Add channel membership/visibility.
- Add DMs and small group chat primitives.
- Add message authorship with human/agent display.
- Store chat links through stable target IDs plus optional `VersionRef`.
- Model live chats as workspace objects, not as files that automatically fork
  with versions.

**Tests:**

- create channel.
- create DM.
- send message.
- nested reply.
- reaction.
- read state.
- workspace boundary denial.
- agent message displays as `<User Name>'s agent`.
- chat link survives target rename/move.
- inaccessible linked target degrades without metadata leakage.
- restoring a file version does not erase live chat messages/read state.

**Security subagent:**

- required.

**CodeRabbit focus:**

- membership checks.
- cross-workspace leakage.
- agent identity display vs authority.
- chat/version interaction semantics.

**Acceptance:**

- chat primitives exist without UI.
- live chat state has explicit restore/merge/export behavior.

### PR 13 - Chats UI: Fast Channels, DMs, Composer

**Goal:** Ship the first fast, natural chat UI.

**Scope:**

- Add Chats top-level nav.
- Add channel list.
- Add DM/small group list.
- Add fast composer.
- Add message list.
- Add lightweight thread grouping without forum friction.

**Tests:**

- component tests if available.
- message rendering.
- composer send.
- DM creation.
- channel switching.

**E2E:**

- create channel.
- send messages.
- create DM.
- send DM.

**Visual QA:**

- desktop and mobile widths if web supports.
- empty/loading/error states.

**CodeRabbit focus:**

- UI state races.
- accessibility.
- over-formal/threaded UX.

**Acceptance:**

- chats feel fast, obvious, and natural.

### PR 14 - Chats Linked To Files, Versions, And History

**Goal:** Make chats part of work context, not detached messages.

**Scope:**

- Add `ThreadLink` UI and APIs.
- Link chats to files/folders/versions/moments and agent runs.
- Show related chats in file side rail.
- Show related chats in version/history views.
- Add one-way Markdown/text projection for agent context.
- Mark chat text projections `readOnly` by default.

**Tests:**

- link chat to file.
- link chat to version.
- linked chat appears in file side rail.
- projection includes allowed linked context only.
- unauthorized linked work is hidden/redacted.
- editing chat Markdown projection does not post a message.
- projection writeability is reported to agents/API.

**E2E:**

- open file, create related chat, see it in side rail.

**CodeRabbit focus:**

- linked-work permission checks.
- stale links.
- projection leakage.
- accidental two-way chat projection behavior.

**Acceptance:**

- discussion appears where the work lives.
- chat projection is useful for agent reading/reference without becoming the
  canonical write path.

### PR 15 - Agent Chat Participation Tools

**Goal:** Let agents read and participate in chats without UI scraping.

**Scope:**

- Add agent tools/actions:
  - `list_channels`
  - `list_chats`
  - `read_chat`
  - `create_chat`
  - `reply_to_chat`
  - `link_chat_to_work`
  - `summarize_chat`
- Bind tools to workspace permissions.
- Display agent replies as `<User Name>'s agent`.
- Add chat projection to context gathering.

**Tests:**

- agent can read allowed chat.
- agent cannot read denied chat.
- agent reply display.
- agent-created link respects permissions.
- agent cannot impersonate another user.

**E2E:**

- ask agent to reply to a chat.
- verify chat update and display name.

**CodeRabbit focus:**

- agent identity/auth.
- tool scoping.
- prompt injection from chat content.

**Acceptance:**

- agents participate as collaborators, not bots.

### PR 16 - Presence, Reactions, And Notification Core

**Goal:** Add the human texture and notification controls required for real
collaboration.

**Scope:**

- Presence states.
- Typing indicators.
- Lightweight reactions.
- Mentions.
- DM notifications.
- followed chat notifications.
- channel mute/unmute.
- agent update notification controls.
- reaction display, privacy, and notification behavior on top of the PR 12
  reaction API.
- quiet/digest settings if feasible.

**Tests:**

- mention notification.
- DM notification.
- muted channel suppresses notifications.
- followed chat notification.
- reaction visibility does not leak hidden users.
- presence does not leak hidden users.

**E2E:**

- two-user notification flow.
- muted channel flow.

**CodeRabbit focus:**

- notification privacy.
- presence leakage.
- noisy defaults.

**Acceptance:**

- notifications are useful without becoming spam.

### PR 17 - Search Across Chats, Files, Versions, And Agents

**Goal:** Make dohc search work-native by understanding conversation context.

**Scope:**

- Index chat threads/messages.
- Link search results to files, versions, moments, agent runs.
- Enforce permissions.
- Add ranking that favors active/relevant work.

**Tests:**

- search chat text.
- search linked file context.
- search agent reply.
- unauthorized private chat denied.
- unauthorized linked file snippet denied.

**E2E:**

- search term returns chat plus linked file.

**Performance:**

- indexed search budget for 10k chats/messages and 10k file metadata entries.

**CodeRabbit focus:**

- leakage.
- indexing invalidation.
- ranking regressions.

**Acceptance:**

- search connects conversation to work.

### PR 18 - External And Shared Channels

**Goal:** Support shared-channel collaboration composed with
dohc file/folder/version sharing.

**Scope:**

- Shared channel invitations.
- External participant/workspace model.
- Explicit cross-workspace share/federation objects.
- Resource visibility preview.
- Share selected files/folders/versions/chats.
- Deny unshared workspace reads.
- External notification/search constraints.

**Tests:**

- invite external workspace/user.
- external can read shared channel.
- external can read shared file.
- external cannot read unshared file.
- external search only sees allowed content.
- public/private/secret-backed file export behavior.
- shared channel does not relax workspace scoping.
- revoked link disappears without revealing hidden target metadata.

**E2E:**

- create shared channel with selected file, verify external view.

**Security subagent:**

- required.

**CodeRabbit focus:**

- cross-workspace leakage.
- share preview accuracy.
- revoked access.
- notification/search leakage across external boundary.

**Acceptance:**

- external/shared channels integrate with dohc sharing instead of bypassing it.
- every cross-workspace shared object is explicit and revocable.

### PR 19 - Versioned Workspace UX Integration

**Goal:** Tie versions, filesystem status, chats, and history into one product
experience.

**Scope:**

- Version dropdown/menu.
- History timeline.
- Compare versions.
- Related chats for versions/history moments.
- File status display.
- Restore flow.
- Conflict UX.

**Tests:**

- version menu.
- history timeline.
- compare versions.
- restore.
- conflict resolution.
- related chats display.

**E2E:**

- end-to-end flow:
  1. create named version.
  2. edit files.
  3. chat about file.
  4. compare version.
  5. resolve conflict.
  6. restore earlier point.

**Visual QA:**

- key desktop/mobile viewports.

**CodeRabbit focus:**

- hidden modes.
- confusing UI.
- stale async workspace/version state.

**Acceptance:**

- the three systems feel like one workspace.

### PR 20 - Agent End-To-End Work Loop

**Goal:** Prove an agent can use normal files and chats without dohc-specific
version-control knowledge.

**Scope:**

- Agent gets a workspace/version folder or API view.
- Agent edits files.
- dohc captures history without requiring agent-specific file attribution.
- Agent reads chat projection/context.
- Agent replies to chat through tool/action.
- UI shows `<User Name>'s agent`.
- Search connects agent reply and changed files.

**Tests:**

- agent file edit captured.
- agent file edit can appear as a generic local/device/session edit.
- agent chat reply.
- agent chat reply displays as `<User Name>'s agent`.
- agent linked work.
- agent cannot exceed permissions.
- agent does not need version-control command path.

**E2E:**

- "Ask agent to update doc and reply in chat" full path.

**CodeRabbit focus:**

- agent auth.
- provenance.
- prompt injection and tool misuse.

**Acceptance:**

- the AI-native loop is real and user-visible.

### PR 21 - Migration And Backwards Compatibility

**Goal:** Migrate existing docs, chat, app, data, and agent state into the new
substrate without data loss.

**Scope:**

- Migrate current chat threads if any, including messages, read state,
  membership/visibility, links, and shared-channel metadata.
- Migrate atoms/docs into Main version.
- Migrate apps/sites/data into file policy defaults.
- Preserve existing shares.
- Preserve current agent run history or map to moments where possible.
- Add rollback for migration.

**Tests:**

- representative old workspace fixtures.
- migration idempotency.
- migration rollback.
- legacy share compatibility.
- legacy chat membership/link/read-state compatibility.
- legacy agent run/history compatibility.

**E2E:**

- open pre-migration workspace after migration.

**CodeRabbit focus:**

- data loss.
- missing workspace scoping.
- migration ordering.

**Acceptance:**

- existing user work remains accessible and correct.

### PR 22 - Full QA Hardening And Release Readiness

**Goal:** Prove the system is robust enough for a major architecture landing.

**Scope:**

- Full test matrix.
- E2E matrix.
- visual QA.
- security review.
- performance review.
- accessibility pass.
- failure-mode drills.
- docs updates.
- deletion/tech debt audit.

**Tests:**

- all unit/integration/security/E2E suites.
- adversarial auth/share/search tests.
- conflict fuzz tests for file driver.
- file policy fuzz tests.
- chat notification/search tests.
- migration tests.

**Manual QA:**

- fresh personal workspace.
- existing migrated workspace.
- team workspace.
- external shared channel.
- offline/lazy hydration.
- conflict and restore.
- secret-backed `.env`.
- agent file edit plus chat reply.

**Subagents:**

- all reviewer roles.

**CodeRabbit focus:**

- full readiness.
- security.
- unreviewable complexity.

**Acceptance:**

- no skipped critical E2E.
- no unresolved P0/P1 findings.
- CodeRabbit approved or user explicitly overrides documented non-blockers.
- execution log complete.

## Workflow Loops

### PR Execution Loop

```text
Plan PR scope
  -> spawn focused subagents
  -> write failing tests
  -> implement
  -> run targeted tests
  -> run required E2E/security/perf
  -> update execution log
  -> open PR
  -> run the canonical CodeRabbit loop
  -> merge only after acceptance criteria
```

### QA Loop

```text
Unit pass
  -> integration pass
  -> E2E pass
  -> visual QA
  -> security regression
  -> performance budget
  -> manual smoke
  -> subagent QA review
  -> CodeRabbit
```

### Conflict/Failure Loop

For every bug found:

```text
Reproduce
  -> write regression test
  -> fix
  -> prove old failure fails before fix or document repro
  -> prove new test passes
  -> run adjacent suite
  -> record in execution log
```

### CodeRabbit Loop

Use the canonical `CodeRabbit Loop` section under `Agent And Review Workflow`
above. Do not move to the next PR with unresolved CodeRabbit findings unless
the finding is a documented non-sensitive non-blocker and the user explicitly
approves the override in the PR and execution log. Authorization, ownership,
workspace isolation, secrets, privacy, data-loss, and permission-boundary
findings remain non-overridable blockers.

## Cross-System Acceptance Scenarios

These are the product-level scenarios the full initiative must eventually pass.

### Scenario A - Normal Files, Automatic History

1. User opens workspace folder.
2. User edits `docs/plan.md` in a normal editor.
3. dohc captures the edit.
4. History shows a meaningful moment.
5. User restores the previous version.
6. Search reflects restored content.

### Scenario B - Agent Edits Like A Human

1. User asks agent to edit `docs/plan.md`.
2. Agent edits normal file.
3. dohc captures the edit as a normal local file change; exact agent
   attribution is not required.
4. No special apply step appears.
5. History can restore before agent edit.

### Scenario C - Named Version

1. User creates `Client Version`.
2. User edits files in that version folder.
3. Main remains unchanged.
4. User compares Client Version to Main.
5. dohc shows file/data/chat differences.

### Scenario D - Conflict Preservation

1. Main and named version both edit same paragraph.
2. User attempts reconcile.
3. dohc preserves base/current/incoming.
4. UI shows a simple choice, not raw conflict markers.
5. Both states remain recoverable.

### Scenario E - Safe `.env`

1. User creates `.env`.
2. Policy marks it tracked, encrypted, searchable false, private.
3. Authorized user sees plaintext locally.
4. Unauthorized collaborator sees denied/redacted state.
5. Public export emits `.env.example` or excludes `.env`.
6. Search never leaks secret value.

### Scenario F - Chat Where Work Lives

1. User opens `docs/pricing.md`.
2. User starts a chat from the file side rail.
3. Another user replies in `#product`.
4. Same chat appears in file side rail and channel.
5. Agent replies as `<User Name>'s agent`.
6. Search returns the chat and linked file together.

### Scenario G - External Shared Channel

1. User creates `#client-acme`.
2. User shares selected files and a version.
3. External participant can chat and view selected resources.
4. External participant cannot search/read private notes or secret-backed files.
5. Revoking share removes access.

### Scenario H - Lazy Cloud Agent

1. Cloud agent starts with tree metadata only.
2. Agent searches and reads only relevant files.
3. Contents hydrate on demand.
4. Agent writes normal files.
5. dohc captures history and syncs changes.

## Stop Conditions

An implementing agent may stop only when:

- the same blocker remains after three concrete attempts.
- continuing would violate a non-negotiable.
- an external secret/service/user decision is genuinely required.
- required CI or CodeRabbit service is unavailable and no local equivalent can
  provide useful progress.

Do not stop because:

- the plan is large.
- tests are slow.
- there are many failing tests.
- implementation is difficult.
- a phase is partially complete.
- CodeRabbit found issues.
- E2E is inconvenient.

Blocked report must include:

- exact blocker.
- attempts made.
- commands run.
- files inspected.
- current failing tests.
- smallest required input.

## Final Completion Contract

Do not claim the initiative is complete until:

- every PR is merged or explicitly deferred by user decision.
- all execution-log entries are complete.
- CodeRabbit loops are complete for every PR.
- subagent review loops are complete for major milestones.
- no P0/P1 issues remain.
- unit, integration, security, E2E, visual, migration, and performance checks
  have fresh results.
- no critical E2E is skipped.
- data migration has rollback proof.
- external sharing and secret-backed files have adversarial tests.
- docs are updated.
- user-facing UI has manual QA evidence.

## Deferred But Designed-For

These are important but do not need to land in the first full implementation
arc unless the user expands scope:

- mobile apps.
- calls/huddles.
- deep email/calendar replacement.
- full external VCS mirror/export.
- federation between self-hosted dohc instances.
- advanced semantic merge for rich docs beyond first useful conflict handling.
- large-scale enterprise retention/legal hold.
- custom plugin/skill registry tied to chats and versions.

## The Big Bet

The product will work only if all three systems reinforce each other:

```text
Versioned workspace without filesystem
  -> too abstract.

Filesystem without versioning
  -> naive folder sync.

Chats without files/versions
  -> standalone chat.

All three together
  -> dohc.
```

The execution plan should protect that integration at every step.
