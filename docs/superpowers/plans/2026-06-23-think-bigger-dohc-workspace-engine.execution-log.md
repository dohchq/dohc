# Think Bigger dohc Workspace Engine Execution Log

Status: PR 00 CodeRabbit approved; docs-only local-agent-CLI exception pending
Created: 2026-06-23

Plan:

- `docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md`

Source specs:

- `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-chats-design.md`

## How To Use This Log

Every implementation PR must append an entry before it is considered complete.

Required evidence:

- branch name.
- worktree path.
- implementation chat/thread, if used.
- PR link.
- scope completed.
- files changed.
- tests added.
- commands run.
- E2E/visual/manual QA evidence.
- local agent CLI QA evidence.
- CodeRabbit status.
- subagent reviews.
- unresolved findings.
- security/privacy notes.
- performance notes.
- performance measurements and budget status.
- migration notes.
- follow-up deletion conditions.

Do not mark a PR complete with skipped critical E2E, unresolved P0/P1 findings,
missing CodeRabbit review, or unmeasured performance-sensitive changes. Only
non-critical documentation-only exceptions may be overridden by explicit user
approval, and never for authorization, ownership, workspace-scope,
secret-handling, data-loss, or review-gate blockers.

## PR Status Table

P0A-P0G branches are provisional throughput work started after user approval for
unattended Phase 0 execution on 2026-06-24. They are not approved, complete, or
merge-ready. Do not open P0A-P0G lane PRs until the PR00 docs-only
local-agent-CLI exception approval and final approval clear. Do not merge them
until the stack base is reconciled and each lane PR has tests and CodeRabbit
approval.

| PR ID | Title | Status | Branch | Worktree | Implementation Thread | PR Link | CodeRabbit | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0A | Current System Inventory And Decisions | restacked on PR00; not approved | codex/think-bigger-p0a-inventory | sibling worktree | main/orchestrated | not opened | pending latest rerun after CodeRabbit follow-up fixes | docs + focused package tests | CodeRabbit rerun pending; blocked on PR00 docs-only exception approval, lane PR, and final approval. |
| P0R | Rust Workspace Kernel Spike | restacked on P0A; not approved | codex/think-bigger-p0r-rust-kernel | sibling worktree | main/orchestrated | not opened | pending | cargo test + perf | Blocked on PR00 docs-only exception approval, P0A lane PR, P0R lane PR, tests, and CodeRabbit. |
| P0B | Minimal Versioned Text Store | provisional branch pushed; not approved | codex/think-bigger-p0b-versioned-store | sibling worktree | main/orchestrated | not opened | pending | workspace-engine + typecheck | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| P0C | File/API Write Capture And History | provisional branch pushed; not approved | codex/think-bigger-p0c-file-history | sibling worktree | main/orchestrated | not opened | pending | workspace-history + typecheck | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| P0D | Compare, Clean Merge, Conflict Preservation | provisional branch pushed; not approved | codex/think-bigger-p0d-merge-conflicts | sibling worktree | main/orchestrated | not opened | pending | workspace-engine + workspace-history + typecheck | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| P0E | Minimal Chat Linked To File | provisional branch pushed; not approved | codex/think-bigger-p0e-linked-chat | sibling worktree | main/orchestrated | not opened | pending | workspace-engine + typecheck | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| P0F | Search And Policy Smoke | provisional branch pushed; not approved | codex/think-bigger-p0f-search-policy | sibling worktree | main/orchestrated | not opened | pending | workspace-engine + typecheck | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| P0G | Proof Arc QA And CodeRabbit Hardening | provisional branch pushed; not approved | codex/think-bigger-p0g-proof-qa | sibling worktree | main/orchestrated | not opened | pending | workspace-engine + typecheck + agent CLI smoke | Blocked on PR00 approval, stack reconciliation, lane PR, tests, and CodeRabbit. |
| 00 | Mega Plan And Readiness Scaffold | draft PR | codex/think-bigger-00-readiness-scaffold | `<current checkout>` | main | https://github.com/dohc-ai/dohc/pull/46 | approved | docs sanity + brand guard | CodeRabbit raised 0 issues on the latest committed diff; docs-only local-agent-CLI exception pending. |
| 01 | Workspace Engine Contracts And Substrate | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 02 | Version Registry And Typed Event Skeleton | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 03 | Snapshot And Restore Foundation | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 04 | Effective Policy And File Policy Resolver | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 05 | Native Filesystem Capture MVP | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 06 | Version Folders Or Mounts MVP | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 07 | Compare And Merge For Text/File Driver | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 08 | Secret-Backed Files | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 09 | Lazy Hydration And Pinning | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 10 | Workspace Status And Diagnostics | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 11 | Search Foundation Across Versions And Files | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 12 | Chats Schema And Channel/DM Foundation | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 13 | Chats UI: Fast Channels, DMs, Composer | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 14 | Chats Linked To Files, Versions, And History | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 15 | Agent Chat Participation Tools | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 16 | Presence, Reactions, And Notification Core | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 17 | Search Across Chats, Files, Versions, And Agents | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 18 | External And Shared Channels | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 19 | Versioned Workspace UX Integration | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 20 | Agent End-To-End Work Loop | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 21 | Migration And Backwards Compatibility | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |
| 22 | Full QA Hardening And Release Readiness | not started | TBD | TBD | TBD | TBD | TBD | TBD |  |

## Entry Template

Copy this section for each PR.

````md
## PR NN - Title

Status:
Branch:
Worktree:
Implementation chat/thread:
PR:
Date started:
Date completed:

### Scope

- [ ] ...

### Files Changed

- ...

### Tests Added Or Updated

- ...

### Commands Run

```bash
...
```

### E2E / Visual / Manual QA

- ...

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`:
- Codex result:
- Claude result, if available:
- Transcript/artifact path:
- Secret redaction notes:

### CodeRabbit

- Status:
- Findings:
- Fixes:
- Overrides:

### Unresolved Findings

- ...

### Subagent Reviews

- Architecture:
- Security:
- QA:
- Other:

### Security / Privacy Notes

- ...

### Performance Notes

- Budget areas touched:
- Metrics:
- Cold/warm distinction:
- Workspace/file/chat sizes:
- Machine/CI context:
- Budget pass/fail:
- Jank/blocking notes:
- Regression risk:
- Follow-up required:

### Migration Notes

- ...

### Remaining Risk

- ...

### Follow-Up / Deletion Conditions

- ...
````

## Milestone Gates

## PR 00 - Mega Plan And Readiness Scaffold

Status: draft PR
Branch: codex/think-bigger-00-readiness-scaffold
Worktree: `<current checkout>`
Implementation chat/thread: main orchestration thread
PR: https://github.com/dohc-ai/dohc/pull/46
Date started: 2026-06-24
Date completed:

### Scope

- [x] Capture versioned workspace source spec.
- [x] Capture native filesystem source spec.
- [x] Capture chats source spec.
- [x] Collate specs into the Think Bigger workspace engine mega plan.
- [x] Add Phase 0 proof arc and PR lane breakdown.
- [x] Add Rust workspace kernel strategy and P0R spike.
- [x] Add performance as a top-level invariant and gate.
- [x] Add worktree/focused implementation thread execution topology.
- [x] Create execution log for PR and milestone evidence.

### Files Changed

- docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md
- docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md
- docs/superpowers/specs/2026-06-23-dohc-chats-design.md
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md

### Tests Added Or Updated

- No code tests. Planning/docs-only scaffold.

### Commands Run

```bash
git status --short --branch
git remote -v
gh --version
gh auth status
rg -n "Execution Topology|worktree|implementation thread|one implementation PR|Rust Kernel Spike|Phase 0 branch/worktree/chat ownership" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
git diff --cached --check
git push -u origin codex/think-bigger-00-readiness-scaffold
gh pr create --draft --base main --head codex/think-bigger-00-readiness-scaffold --title "[codex] Add Think Bigger workspace engine plan"
coderabbit review --agent -t committed -c AGENTS.md
rg -n "/home/ice/dev/dohc|\| PR \||Ice's agent|server/engine-derived actor|secret-backed conflicts|workspace/request token|HTML atoms|Canonical Y.Doc" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md docs/superpowers/specs/2026-06-23-dohc-chats-design.md
git diff --check
pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts
curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz -o /tmp/dohc-node-v24.18.0-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/v24.18.0/SHASUMS256.txt -o /tmp/dohc-node-v24.18.0-SHASUMS256.txt
expected=$(grep ' node-v24.18.0-linux-x64.tar.xz$' /tmp/dohc-node-v24.18.0-SHASUMS256.txt | awk '{print $1}')
actual=$(sha256sum /tmp/dohc-node-v24.18.0-linux-x64.tar.xz | awk '{print $1}')
test "$expected" = "$actual"
printf '%s  %s\n' "$expected" "/tmp/dohc-node-v24.18.0-linux-x64.tar.xz"
rm -rf /tmp/dohc-node-v24.18.0-linux-x64
mkdir -p /tmp/dohc-node-v24.18.0-linux-x64
tar -xJf /tmp/dohc-node-v24.18.0-linux-x64.tar.xz -C /tmp/dohc-node-v24.18.0-linux-x64 --strip-components=1
/tmp/dohc-node-v24.18.0-linux-x64/bin/node -v
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --version
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts
```

### E2E / Visual / Manual QA

- Manual docs sanity only.
- Focused brand/no-legacy guard passed: `apps/web/src/__tests__/brandNoLegacy.test.ts`
  reported 1 file and 2 tests passed under Linux Node 24.18.0.
- Node 24 environment: official Linux Node v24.18.0 tarball extracted to
  `/tmp/dohc-node-v24.18.0-linux-x64/bin/node`.
- pnpm entrypoint: Node v24.18.0 Corepack resolved repo package manager
  `pnpm@10.24.0`.
- Earlier Node 18.19.1 run is retained only as exploratory output and is not
  counted as gate evidence because it does not satisfy the repo engine field.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for docs-only scaffold.
- Docs-only exception approval: pending human approval before PR00 is marked
  complete or merge-ready.
- Codex result: not run for PR00 docs-only scaffold; exception pending.
- Claude result, if available: not run for PR00 docs-only scaffold; exception
  pending.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### CodeRabbit

- Status: approved with 0 issues on the latest committed diff.
- Current findings: none.
- Historical findings fixed:
  - Major: versioned workspace spec needed explicit server/engine-derived
    authorization, locks, protected paths, and visibility-boundary checks before
    immediate save.
  - Major: filesystem conflict projection needed secret-backed conflict
    redaction rules for `.dohc/conflicts/`.
  - Major: chats spec needed server/engine-derived actor authorization,
    workspace-scoped chat action results, and stale workspace response guards.
  - Major: Phase 0 execution gate needed explicit security/data-integrity
    invariants.
  - Minor: plan scenario used a concrete user-specific agent token instead of
    the standardized `<User Name>'s agent`.
  - Minor: execution log used a machine-specific worktree path.
  - Minor: execution log table had ambiguous `PR` columns.
  - Second pass major: raw local file provenance needed a stronger trust
    boundary so unverified local/device/session attribution cannot become
    authenticated human/agent identity without proof.
  - Second pass major: durability log language needed to exclude raw secret
    bytes while preserving crash-safety.
  - Second pass major: chat thread ownership needed strict channel-vs-DM XOR.
  - Second pass major: effective file policy needed deterministic precedence,
    tie-breakers, and canonical key normalization.
  - Second pass major: conflict visible-value choice needed deterministic,
    auditable selection.
  - Second pass major: canonical plan examples needed neutral agent/tool
    wording.
  - Second pass trivial: duplicate PR review loop needed to reference the
    canonical CodeRabbit loop.
  - Third pass major: write-path authorization needed fail-closed behavior when
    an evaluator is unavailable.
  - Third pass major: immediate-save acknowledgement needed a durability
    boundary.
  - Third pass major: DM-backed chats needed at least two unique participants.
  - Third pass major: secret projection wording overstated process-level
    enforcement for normal local folders.
  - Fourth pass major: native filesystem examples used `redacted` instead of
    canonical `redact` export enum value.
  - Fourth pass major: chat authorization list omitted `list_channels`.
  - Fourth pass major: message reply parent integrity was underspecified.
  - Fourth pass major: local edits to read-only chat projection files needed a
    canonical reject/preserve/regenerate policy.
  - Fifth pass major: versioned workspace projections needed mandatory HTML
    sanitization and sandboxing.
  - Fifth pass major: secret references needed workspace-scoped fail-closed
    resolution.
  - Fifth pass minor: top-level execution status was stale.
  - Fifth pass major: Phase 0 workspace-scope gate needed atom/folder/entity
    coverage.
  - Fifth pass major: chat read state needed schema and monotonic update rules.
  - Fifth pass major: DM participant ids needed dedupe/stable-sort
    canonicalization.
  - Fifth pass major: messages needed direct workspace scoping.
  - Fifth pass major: filesystem async payloads needed workspace/version/request
    correlation.
  - Fifth pass major: secret access policy needed separate read/write
    permission rules.
  - Fifth pass major: raw local write reconciliation needed authorization before
    persisting into version history.
  - Sixth pass major: local ingest provenance still needed explicit quarantine
    or rejection when ownership/lock/visibility proof is missing.
  - Sixth pass major: first proof slice needed mandatory fail-closed and secret
    non-leak E2E checks.
  - Sixth pass major: chat message bodies needed explicit XSS-safe rendering
    and formatting-subset rules.
  - Sixth pass major: chat read state needed canonical ordering and unique
    upsert semantics.
  - Sixth pass major: chat action authorization needed user locks, sharing
    boundaries, and skill-turn/review gates.
  - Sixth pass major: secret-backed filesystem plaintext exclusion needed to
    include durability-log payloads.
  - Sixth pass major: `.dohc/**` needed an internal-state boundary with
    source-backed policy-file allowlist.
  - Sixth pass major: version mount examples needed canonical `.versions`
    naming.
  - Seventh pass major: chat read-state cursor needed to be sequence-based
    rather than timestamp fallback-based.
  - Seventh pass major: chat message deletes needed tombstone fields on
    `ThreadMessage`.
  - Seventh pass major: filesystem API writes needed causal preconditions
    instead of unconditional overwrites.
  - Seventh pass major: secret-backed writes still needed crash-safe durability
    entries as encrypted references/envelopes.
  - Seventh pass minor: Markdown document capitalization.
  - Seventh pass minor: restore wording used redundant "point in time".
  - Eighth pass major: Rust/local kernel bridge needed authenticated channel
    binding, not localhost trust.
  - Eighth pass major: workspace scoping needed to be a data-model invariant
    requiring `workspaceId` on persisted objects.
  - Eighth pass minor: "Everything saves" wording needed to be scoped to
    authorized writes.
  - Ninth pass major: implementation-thread kickoff checklist needed the
    `apps/web/AGENTS.md` read gate for `apps/web` work.
  - Ninth pass major: chat tombstone retention needed secret-safe audit/history
    storage rules.
  - Ninth pass major: chat search snippets and indexes needed explicit
    no-plaintext-secrets behavior.
  - Ninth pass major: shared channels needed per-message/link/reference
    authorization instead of broad thread inheritance.
  - Ninth pass major: filesystem restart reconciliation needed path-to-version
    binding instead of current-active-version fallback.
  - Ninth pass major: raw local filesystem reconciliation needed fresh
    server/engine-derived auth/policy context before persistence.
  - Tenth pass major: denied/quarantined ingests needed durable non-canonical
    holding records.
  - Tenth pass major: versioned workspace durability log wording needed to cover
    secret-backed writes as recovery-tracked encrypted references.
  - Tenth pass major: implementation thread kickoff needed the Convex
    guidelines pre-read gate.
  - Tenth pass major: Never Skip E2E wording needed to apply only to
    implemented/in-scope surfaces.
  - Tenth pass minor: branch naming examples drifted from the Phase 0 worktree
    topology.
  - Tenth pass major: filesystem policy parsing needed fail-closed unknown key
    and alias collision rejection.
  - Tenth pass major: channel sends needed to map to canonical
    `ChatThread -> ThreadMessage`.
  - Tenth pass major: reusable entry template needed an explicit Unresolved
    Findings section.
  - Eleventh pass major: versioned write/evaluator contract needed explicit
    skill-turn gates and fail-closed behavior when skill-turn evaluation is
    unavailable or indeterminate.
  - Eleventh pass major: native filesystem reserved `.versions` and `.dohc`
    namespace collisions needed fail-closed import/quarantine/manual-resolution
    behavior.
  - Eleventh pass major: export allowlist wording needed to clarify that only
    source-backed policy files are exported, not all `.dohc/**` internal state.
- Fixes:
  - Added write authorization/lock/protected-path invariants to the versioned
    workspace spec.
  - Added secret-backed conflict redaction/materialization rules.
  - Added chat action authorization and workspace async response guards.
  - Added Phase 0 security/data-integrity gates for actor identity, workspace
    scoping, agent write boundaries, HTML sandboxing, and canonical Y.Doc.
  - Standardized agent display placeholders.
  - Replaced absolute worktree path with `<current checkout>`.
  - Renamed table columns to `PR ID` and `PR Link`.
  - Marked raw local file provenance as unverified unless backed by proof.
  - Clarified secret-backed durability entries as encrypted references,
    redacted markers, or broker metadata.
  - Added exclusive channel-backed vs DM-backed chat thread types.
  - Added effective policy resolution order, tie-breakers, and camelCase
    canonical key normalization.
  - Added deterministic chosen/current conflict value rules.
  - Replaced concrete agent/tool examples with neutral wording in canonical
    specs and plan text.
  - Replaced the duplicate PR loop with a reference to the canonical CodeRabbit
    loop.
  - Added fail-closed write-path authorization language.
  - Added write-ack boundary after durable persistence.
  - Required DM-backed chat threads to have at least two unique participants.
  - Scoped process-level secret gating to dohc-controlled execution paths.
  - Normalized public export enum examples to `redact`.
  - Added `list_channels` to server/engine-derived chat authorization scope.
  - Added `parentMessageId` same-thread, no-self, no-cycle invariants.
  - Specified that local projection edits do not mutate canonical chat and must
    be preserved as recovery/status before projection regeneration.
  - Added mandatory sanitization/sandboxing for HTML/renderable projections.
  - Added workspace-scoped fail-closed secret reference resolution.
  - Updated top-level status to PR 00 in review.
  - Expanded Phase 0 workspace-scope gate to atoms, folders, and entities.
  - Added `ThreadReadState` schema and monotonic update rules.
  - Added DM participant canonicalization rules.
  - Added `ThreadMessage.workspaceId` and matching invariants.
  - Added async workspace/version/request correlation requirements.
  - Split secret read vs write permission requirements.
  - Added reconciliation-time authorization for raw local writes.
  - Clarified that unverified local ingest is server/engine policy-evaluated
    before becoming canonical and is quarantined/rejected on missing proof.
  - Added mandatory Phase 0 E2E checks for fail-closed authorization and no
    plaintext secret leakage across durability logs, history, diffs, export,
    search, and agent logs.
  - Added chat body escaping/sanitization requirements and a permitted rich-text
    subset.
  - Added canonical read-state ordering and unique
    `(workspaceId, threadId, actorId)` upsert semantics.
  - Extended chat action authorization to locks, sharing boundaries, protected
    work, and skill-turn/review gates.
  - Added durability-log payloads to secret-backed plaintext exclusion.
  - Added `.dohc/**` self-capture exclusion plus allowlisted policy files.
  - Replaced sibling `personal.versions/*` examples with in-workspace
    `.versions/*` projections.
  - Replaced chat read-state timestamp fallback with a canonical
    `(threadSequence, createdAt, messageId)` cursor.
  - Added `deletedAt`, `deletedById`, `deleteReason`, and `tombstone` fields to
    `ThreadMessage` and aligned edit/delete history language.
  - Required API writes to carry an expected base version, etag, or content
    hash and return conflicts on mismatch.
  - Clarified that secret-backed writes enter durability only as encrypted
    references/envelopes or broker metadata.
  - Capitalized Markdown document table entry.
  - Shortened restore proof wording to "earlier point".
  - Added authenticated local channel binding requirements for IPC/JSON-RPC,
    localhost HTTP, N-API, Tauri-style commands, and sidecar daemon bridge
    options.
  - Added `workspaceId` as a data-model invariant for persisted atoms, folders,
    entities, shares, captures, files, versions, events, chat links,
    projections, and history records.
  - Replaced broad "Everything saves" phrasing with "Authorized writes save."
  - Added `apps/web/AGENTS.md` to implementation-thread kickoff requirements
    for lanes touching `apps/web`.
  - Required chat tombstone audit/history retention to use secret-backed
    references, encrypted payloads, or redacted forms when secrets may exist.
  - Added secret classification/redaction requirements for chat/work search
    indexes and source-context snippets.
  - Required shared channels to re-authorize every message, link, and projected
    reference against normal policy.
  - Required restart reconciliation to write local/device/session changes to the
    path/mount-bound version and quarantine ambiguous version binding.
  - Required fresh server/engine-derived authorization and policy context before
    raw local writes persist into durability/history.
  - Required durable non-canonical holding records for denied/quarantined
    ingests, including retry/explanation metadata and secret-safe durability
    rules.
  - Clarified that the durability log tracks every save/write, with
    secret-backed writes represented only as encrypted references, redacted
    markers, or broker metadata.
  - Added the Convex guidelines pre-read requirement for implementation threads
    touching Convex code.

Twelfth pass:

- Fixed CodeRabbit follow-up findings:
  - Denied/quarantined ingest holding areas must remain secret-safe, with no
    plaintext secrets in payloads, indexes, logs, explanations, or retry
    metadata.
  - Defined `ThreadMessage.threadSequence` as the canonical per-thread monotonic
    sequence used with `createdAt` and `messageId` for read cursor advancement.
  - Required chat projections to classify and redact secrets before writing
    derived Markdown.
  - Made API writes explicit about create-only absence guards and overwrite
    targeting metadata.
  - Clarified `tracked`/`versioned` invariants and corrected `.env`
    materialization to the canonical `local` value.
  - Consolidated duplicate CodeRabbit loop language and made auth, ownership,
    isolation, secrets, privacy, data-loss, and permission-boundary blockers
    non-overridable.
  - Scoped Never Skip E2E requirements to implemented, shipped, or in-scope
    surfaces.
  - Aligned branch naming examples with the actual Phase 0 worktree topology.
  - Added fail-closed policy parser rejection for unknown/misspelled keys,
    duplicate semantic keys, and alias/canonical collisions.
  - Clarified that channel sends create/resolve `ChatThread` and persist as
    `ThreadMessage`; no separate durable `ChannelMessage` exists.
  - Added Unresolved Findings to the reusable execution-log template.
  - Added skill-turn gates to versioned write-path and evaluator fail-closed
    requirements.
  - Added fail-closed reserved namespace collision handling for imported or
    existing `.versions/**` and `.dohc/**` content.
  - Narrowed export wording to explicitly allowlist `.dohc/files.toml`,
    `.dohc/visibility.toml`, and optional `.dohcignore` while excluding
    generated/internal projections, indexes, caches, and durability internals.

Thirteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Removed external product comparison language from the chats and native
    filesystem specs while preserving the dohc-native product intent.
  - Tightened PR completion rules so critical E2E, unresolved P0/P1,
    CodeRabbit, performance, authorization, ownership, workspace-scope,
    secret-handling, data-loss, and review-gate blockers are non-overridable.
  - Added the missing `### Unresolved Findings` section to the live PR 00
    execution-log entry and marked it as none after fixes.

Fourteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Updated the duplicate CodeRabbit-loop pointer to reference the actual
    `CodeRabbit Loop` section under `Agent And Review Workflow`.
  - Clarified that importers evaluate allowlisted `.dohc/*` policy inputs
    before quarantining reserved `.dohc/**` namespace content.
  - Required atomic conditional upsert/CAS semantics for `lastReadCursor`
    advancement so stale concurrent reads cannot regress read state.
  - Required a unique `(workspaceId, threadId, threadSequence)` constraint and
    transactional or serialized sequence allocation for chat messages.

Fifteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Required exactly one write precondition mode per native filesystem API
    write, with invalid guard combinations failing closed.
  - Split file policy state into tracked/captured and versioned/history-visible
    axes so durable capture cannot be confused with user-facing history.
  - Added workspace-unique DM participant-set keys and atomic create semantics
    to prevent duplicate DM threads under concurrent creates.
  - Tightened execution-gate override wording to documented non-sensitive
    non-blockers only.
  - Removed remaining explicit external product comparison language from the
    touched planning/spec docs in favor of dohc-native vocabulary.
  - Cleaned execution-log grammar and normalized Markdown capitalization across
    the touched plan/spec docs.
  - Ran the focused web brand/no-legacy guard and recorded the Node engine
    warning from the local shell.
  - Updated the Phase 0 lane status table to show P0A-P0G branches as
    provisionally pushed with PRs pending until PR00 clears and the stack base
    is reconciled.

Sixteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Replaced legacy chats wording with dohc Chats terminology.
  - Cleaned the denied/quarantined ingest holding-area grammar in the execution
    log while preserving the secret-safe durability requirement.

Seventeenth pass:

- Fixed CodeRabbit follow-up findings:
  - Clarified that Markdown workspace documents use canonical Y.Doc state, with
    Markdown body/`atoms.body` only as a derived cache or projection.
  - Added a first-slice E2E proof for workspace-scoped persisted records and
    default rejection of cross-workspace references.
  - Made native filesystem API examples explicitly workspace/version scoped,
    while allowing validated bound sessions.
  - Aligned the versioned workspace API example with the same workspace/version
    scoped shape.
  - Required chat projection filenames to use filesystem-safe opaque or encoded
    thread ids and reject traversal/unsafe path input.
  - Added DM-backed thread authorization rules requiring the server-derived
    actor to be in the canonical participant set and authorized to message all
    participants before persistence/fanout.
  - Cleaned the denied/quarantined ingest holding-area grammar again with the
    exact secret-safe wording CodeRabbit requested.

Eighteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Changed the live PR 00 `Unresolved Findings` section from final
    no-open-items wording to provisional rerun-pending wording.
  - Clarified that `.dohc/files.toml` and `.dohc/visibility.toml` live under
    `.dohc/`, while optional `.dohcignore` is a workspace-root policy file.

Nineteenth pass:

- Fixed CodeRabbit follow-up findings:
  - Added causal replay gates for denied/quarantined ingest holding areas,
    including base version/CAS metadata and fresh apply-time auth/policy
    revalidation.
  - Required every chat primitive, including channels, links, activities, and
    read state, to carry and key lookups by `workspaceId`.
  - Added symlink/hardlink and filesystem-indirection boundary checks before
    import, capture, scan, sync, or reconciliation.
  - Added monotonic sequence/cursor ordering guards to async workspace/status
    payload application.
  - Replaced DM hash-only identity with exact canonical participant-set identity
    or hash plus exact-set verification.

Twentieth pass:

- Fixed CodeRabbit follow-up findings:
  - Added quota, TTL, rate-limit, payload-size cap, and backpressure/eviction
    requirements for denied/quarantined ingest holding areas.
  - Added E2E proof that stale CAS/base tokens and workspace/version mismatches
    cannot replay quarantined ingests into canonical state.
  - Reran the focused brand/no-legacy guard under Linux Node 24.18.0 and
    recorded the earlier Node 18 run as non-gating exploratory output.
  - Marked PR00 local agent CLI QA as a docs-only exception pending human
    approval before completion/merge-readiness.
  - Added legal-erasure handling for chat tombstones while preserving tombstone
    metadata and deletion-placeholder behavior.
  - Required invalid chat projection write recovery artifacts to be secret-safe,
    encrypted, or policy-redacted.
  - Added first-slice proof that channel sends map to `ChatThread` and
    `ThreadMessage`, not a separate durable channel-stream model.

Twenty-first pass:

- Fixed CodeRabbit follow-up findings:
  - Reworded the denied/quarantined ingest holding-area grammar in the Twelfth
    pass entry.
  - Added TOCTOU-safe descriptor/handle continuity requirements after
    filesystem path canonicalization.
  - Clarified that `ThreadLink` cross-workspace exceptions are allowed only for
    explicit shared-channel grants and must be re-authorized on every use.
  - Added a strict 16-participant cap for DM-backed threads and early rejection
    of oversized raw or canonical participant lists.

Twenty-second pass:

- Fixed CodeRabbit follow-up findings:
  - Added an explicit Overrides entry instead of leaving the field blank.
  - Rephrased the Twelfth-pass denied/quarantined ingest holding-area sentence.
  - Required shared-channel grant revoke/expiry cleanup to purge or reindex
    derived chat projections, search snippets, notification payloads, and export
    artifacts.
  - Defined deterministic DM participant canonicalization: persisted actor-id
    form, exact dedupe, and bytewise ascending sort before key generation.

Twenty-third pass:

- Historical outcome: CodeRabbit approved that committed diff with 0 findings.
- Updated PR00 status, CodeRabbit status, and unresolved findings to reflect the
  then-current approved review.

Twenty-fourth pass:

- Fixed CodeRabbit follow-up finding:
  - Aligned execution-log table titles for PR IDs 13-15 with the canonical mega
    plan entries.

Twenty-fifth pass:

- Fixed CodeRabbit follow-up findings:
  - Added canonical decimal-string encodings for chat sequence and timestamp
    fields, with BigInt/64-bit-safe comparison requirements.
  - Marked `ChatThread.title` and user/agent-authored thread metadata as
    untrusted text requiring escaping or sanitization across UI, search,
    notifications, projections, summaries, and exports.

Twenty-sixth pass:

- Fixed CodeRabbit follow-up findings:
  - Normalized PR00 execution-log status so historical approval remains
    historical and the current state is unambiguously rerun pending.
  - Added explicit causal write/merge/restore preconditions to the versioned
    workspace and native filesystem API contracts.
  - Made native filesystem restore non-destructive and guarded by the same
    precondition/conflict contract as writes.
  - Added first-slice E2E coverage for holding-area quotas, TTL bounds,
    payload-size caps, ingest rate limits, and deterministic
    eviction/backpressure.

Twenty-seventh pass:

- Fixed CodeRabbit follow-up findings:
  - Removed stable object ids from causal write precondition unions; object ids
    are now optional targeting metadata and must be paired with freshness
    tokens such as base version, etag, content hash, or absence assertion.
  - Added chat links to the first-slice workspace-scoping E2E checklist.
  - Replaced placeholder brand-guard command text with the exact Node 24.18.0
    setup and test command executed, while recording Node and pnpm environment
    details separately.

Twenty-eighth pass:

- Fixed CodeRabbit follow-up findings:
  - Rephrased the Twelfth-pass denied/quarantined holding-area grammar.
  - Aligned E2E policy wording so implemented, shipped, and in-scope surfaces
    cannot skip E2E while deferred surfaces are recorded as not applicable.
  - Added the current `apps/web/AGENTS.md` pre-edit check and a
    checked-if-present Convex guidance rule.
  - Required DM read/write paths and read-state updates to verify server-derived
    actor membership before routing, indexing, persistence, fanout,
    notifications, or cursor updates.
  - Required read-state cursor updates to resolve to an existing
    `ThreadMessage` in the same `(workspaceId, threadId)` before CAS advance.

Twenty-ninth pass:

- Fixed CodeRabbit follow-up finding:
  - Added repo-mandated `apps/app/AGENTS.md` and
    `apps/app/convex/_generated/ai/guidelines.md` kickoff checks alongside the
    existing `apps/web/AGENTS.md` check, with execution-log recording required.

Thirtieth pass:

- Fixed CodeRabbit follow-up findings:
  - Normalized the versioned workspace write precondition to the shared
    `expectedBaseVersion` schema name used by the native filesystem API.
  - Clarified that `.dohc/files.toml` is a source-backed policy entry while
    `.dohc/status.json`, `.dohc/conflicts/**`, and `.dohc/chats/**` are
    internal projections/reserved state unless a purpose-built export policy
    explicitly includes redacted derived state.

Thirty-first pass:

- Fixed CodeRabbit follow-up findings:
  - Reworded versioned workspace examples to use auto-save/automatic-history
    language instead of implying manual save.
  - Added first-slice E2E coverage for missing or incompatible causal
    preconditions on `write(...)`, `merge(...)`, and `restore(...)`.
  - Restored the missing PR00 table cell so CodeRabbit, Tests, and Notes remain
    aligned.
  - Required DM participant sorting to use bytewise ascending UTF-8 encoding of
    the canonical persisted actor id.
  - Added TOCTOU-safe, no-symlink chat projection write requirements.

Thirty-second pass:

- Fixed CodeRabbit follow-up finding:
  - Removed the host-specific pnpm path from the Node 24 brand-guard command
    and replaced it with the portable Node v24.18.0 Corepack invocation that
    resolves `pnpm@10.24.0` from the repo package manager field.

Thirty-third pass:

- Historical outcome: CodeRabbit approved that committed diff with 0 findings after the
  portable Node 24 test command fix.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Thirty-fourth pass:

- Fixed CodeRabbit follow-up finding:
  - Aligned the mega-plan `.dohc/` source-backed policy allowlist with the
    native filesystem spec by adding `.dohc/visibility.toml` and optional
    workspace-root `.dohcignore`.

Thirty-fifth pass:

- CodeRabbit approved the latest committed diff with 0 findings after the
  `.dohc` allowlist fix.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Thirty-sixth pass:

- Fixed CodeRabbit follow-up findings:
  - Clarified that filesystem-originated saves submit the same single causal
    precondition as API writes and fail closed on missing, stale, or
    incompatible guards.
  - Tightened holding-area abuse-resistance wording so eviction cannot imply
    silent loss of accepted ingests.
  - Distinguished managed `.versions/<version>/` roots from unmanaged
    reserved-namespace collisions.
  - Marked `.dohc/chats/**` as an explicit internal projection allowlist entry
    under fail-closed `.dohc/**` rules.
  - Made equal `lastReadCursor` tuples idempotent successes with no state
    change after message-existence validation.
  - Clarified that every DM is internally a DM-backed `ChatThread`, even when
    the UX remains lightweight.
  - Required collision-safe chat projection filename mapping on
    case-insensitive filesystems.

Thirty-seventh pass:

- Fixed CodeRabbit follow-up findings:
  - Required idempotency keys and deterministic duplicate-delivery behavior for
    `write(...)`, `merge(...)`, and `restore(...)`, including filesystem-captured
    saves.
  - Required chat read-state writes to derive `actorId` from authenticated
    server/engine identity rather than caller payloads.
  - Made DM participant sets immutable after creation; membership changes create
    or resolve a new canonical DM-backed `ChatThread` and link from the prior
    thread.

Thirty-eighth pass:

- Fixed CodeRabbit follow-up finding:
  - Marked P0A-P0G lane branches as provisional, not approved, and blocked on
    PR00 approval, stack reconciliation, lane PRs, tests, and CodeRabbit.
  - Added the 2026-06-24 user-approved unattended execution note that explains
    why provisional Phase 0 branches exist before PR00 is merge-ready.

Thirty-ninth pass:

- Fixed CodeRabbit follow-up findings:
  - Made native filesystem `write(...)`, `merge(...)`, and `restore(...)`
    require `idempotencyKey`, matching the versioned workspace contract.
  - Normalized historical Node test evidence to Linux Node 24.18.0, matching
    the executed brand-guard command.

Fortieth pass:

- CodeRabbit approved the latest committed diff with 0 findings after the
  native idempotency/Node evidence fix.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Forty-first pass:

- Fixed CodeRabbit follow-up findings:
  - Added SHA256 manifest verification before extracting or executing the Node
    v24.18.0 tarball used for the brand guard.
  - Changed native filesystem async payload sequence to a BigInt-safe decimal
    string ordering guard.
  - Required deterministic collision-proof quarantine rename destinations that
    never overwrite existing user content.
  - Required chat read-state authorization to happen before tuple-to-message
    existence checks so failures do not become existence oracles.

Forty-second pass:

- Fixed CodeRabbit follow-up findings:
  - Required overwrite calls to include `targetObjectId` plus exactly one causal
    freshness precondition, while create-only `expectedAbsent` calls omit
    `targetObjectId`.
  - Clarified that native filesystem conflict responses return secret-safe
    opaque handles, hashes, redacted previews, policy decisions, and metadata by
    default, with raw bytes materialized only through explicit server-side
    authorization.

Forty-third pass:

- Fixed CodeRabbit follow-up finding:
  - Aligned the versioned workspace `write(...)` contract with the native
    filesystem overwrite rule: overwrite requires `targetObjectId` plus exactly
    one causal freshness precondition, while create-only `expectedAbsent` omits
    `targetObjectId`.
  - Added secret-safe conflict envelope wording to the versioned workspace API
    contract.

Forty-fourth pass:

- Fixed CodeRabbit follow-up finding:
  - Defined the exact `.dohc/chats/**` projection filename algorithm:
    SHA-256 over `v1\0workspaceId\0threadId\0projectionKind`, lowercase
    RFC 4648 base32 without padding, and `v1-<digest>.md`.

Forty-fifth pass:

- Fixed CodeRabbit follow-up findings:
  - Added first-class `delete(...)`, `rename(...)`, and `move(...)` operations
    to the versioned workspace and native filesystem API surfaces.
  - Required source object identity, source freshness preconditions, destination
    absence guards for rename/move, and idempotency keys for those mutations.
  - Reworded `.dohc/chats/**` as a reserved internal projection scope, not an
    allowlisted user-content path.

Forty-sixth pass:

- CodeRabbit approved the latest committed diff with 0 issues after the
  mutation API parity and reserved chat projection scope fixes.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.

Forty-seventh pass:

- Fixed CodeRabbit follow-up finding:
  - Replaced the remaining legacy thread-id-shaped projection examples with the
    canonical deterministic `.dohc/chats/v1-<digest>.md` path shape and
    clarified that raw thread ids are not projection filenames.

Forty-eighth pass:

- Fixed CodeRabbit follow-up finding:
  - Added `stat(...)` and `watch(...)` to the versioned workspace API list so it
    matches the native filesystem API surface.
  - Clarified that `read(...)`, `list(...)`, `stat(...)`, `search(...)`,
    `watch(...)`, `snapshot(...)`, and `diff(...)` are read-only scoped views.

Forty-ninth pass:

- Fixed CodeRabbit follow-up finding:
  - Defined the string-to-bytes rule for chat projection filename hashes:
    normalize `workspaceId`, `threadId`, and `projectionKind` to Unicode NFC,
    encode them as UTF-8 bytes, then hash the framed byte sequence.

Fiftieth pass:

- Fixed CodeRabbit follow-up findings:
  - Required safe-rename destinations to be atomically reserved with
    create-if-absent/`O_EXCL`-equivalent semantics before activation.
  - Added a minimum 24-hour idempotency replay window and explicit expired-key
    fail-closed behavior to both native filesystem and versioned workspace
    write-producing operation contracts.

Fifty-first pass:

- Fixed CodeRabbit follow-up findings:
  - Required versioned async reads and `watch(...)` events to carry
    workspace/version/request-token binding plus abort or stale-response
    semantics.
  - Clarified that passive ordinary OS file edits may stay actor-neutral, but
    dohc-controlled agent/tool/skill-turn ingest cannot downgrade missing turn
    proof into unverified local provenance.

Fifty-second pass:

- CodeRabbit approved the latest committed diff with 0 issues after the
  versioned async/provenance fixes.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.

Fifty-third pass:

- Fixed CodeRabbit follow-up finding:
  - Replaced the stale thread-shaped chat projection plan example with the
    canonical deterministic `.dohc/chats/v1-<digest>.md` projection path.

Fifty-fourth pass:

- CodeRabbit approved the latest committed diff with 0 issues after the plan
  chat projection path fix.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

### Unresolved Findings

- Pending human approval for the PR00 docs-only local-agent-CLI exception before
  completion or merge-readiness.

### Subagent Reviews

- Architecture: prior planning review incorporated.
- Security: prior planning review incorporated.
- QA: prior planning review incorporated.
- Other: external architecture review incorporated.

### Security / Privacy Notes

- No production code or permission behavior changed.

### Performance Notes

- Budget areas touched: planning only.
- Metrics: not applicable.
- Cold/warm distinction: not applicable.
- Workspace/file/chat sizes: not applicable.
- Machine/CI context: not applicable.
- Budget pass/fail: not applicable.
- Jank/blocking notes: not applicable.
- Regression risk: none for runtime.
- Follow-up required: implementation PRs must record measurements.

### Migration Notes

- No migrations.

### Remaining Risk

- Phase 0 scope is large and must be split into lane PRs before implementation.
- Worktree/implementation-thread ownership is not yet assigned for P0 lanes.

### Follow-Up / Deletion Conditions

- Keep this log until the Think Bigger initiative is complete or superseded.

## PR P0A - Current System Inventory And Decisions

Status: restacked on PR00; not approved
Branch: codex/think-bigger-p0a-inventory
Worktree: `<p0a worktree>`
Implementation chat/thread: main orchestration thread + explorer subagents
PR: not opened
Date started: 2026-06-24
Date completed:

### Scope

- [x] Create dedicated P0A worktree.
- [x] Inventory current storage, file, atom, Y.Doc, app, search, sync, agent,
      and sharing/collaboration code paths.
- [x] Record current-to-target deltas.
- [x] Record initial Phase 0 decisions for storage, filesystem
      interposition, secrets, merge scope, chat/file philosophy, and Rust
      kernel boundary.
- [x] Fold in storage/Y.Doc explorer findings.
- [x] Fold in filesystem/sync explorer findings.
- [x] Fold in collaboration/chat explorer findings.
- [x] Run docs sanity commands recorded below (`git diff --check`, targeted `rg`
      evidence, and a Markdown link scan for the two touched docs).
- [x] Align `scanWorkspaceFiles` with shared ignored-segment policy after
      CodeRabbit review.
- [x] Wire share revocation to configured Hocuspocus admin
      disconnect-by-workspace-user hook after CodeRabbit review.
- [ ] Open the P0A lane PR only after the PR00 docs-only local-agent-CLI
      exception approval and final approval clear; after that approval, use
      either the normal base or a stacked PR target according to the stack state,
      and do not merge P0A until its tests and CodeRabbit approval clear.

### Files Changed

- docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
- packages/workspace-fs/src/scan.ts
- packages/workspace-fs/src/scan.test.ts
- services/workspace-api/src/main.ts
- services/workspace-api/src/routes/shared.ts
- services/workspace-api/src/routes/shares.ts
- services/workspace-api/src/routes/shares.test.ts
- services/workspace-api/src/routes/sharesRevocation.test.ts

### Tests Added Or Updated

- `packages/workspace-fs/src/scan.test.ts`
  - verifies scanner skips the same `.dohc`, `.git`, and `node_modules`
    segments shared by watcher/export/search policy.
- `services/workspace-api/src/routes/shares.test.ts`
  - verifies successful share revocation calls the configured Hocuspocus admin
    disconnect hook for the revoked recipient.
- `services/workspace-api/src/routes/sharesRevocation.test.ts`
  - fake-pool unit coverage for the admin disconnect hook without requiring a
    live Postgres service.
  - covers commit-before-disconnect ordering, pending disconnect event cleanup,
    missing admin fail-closed behavior, and rollback failure client
    destruction.

### Commands Run

```bash
git worktree add -b codex/think-bigger-p0a-inventory <p0a worktree> HEAD
git status --short --branch
find apps -maxdepth 3 -name AGENTS.md -print
sed -n '1,260p' apps/web/AGENTS.md
rg --files -g 'package.json' -g 'pnpm-lock.yaml' -g 'turbo.json' -g 'vite.config.*' -g 'playwright.config.*' -g 'convex.json' -g 'schema.ts' -g '*.config.ts'
find packages/workspace-contracts packages/workspace-core packages/workspace-fs packages/workspace-history packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop/src/workspaces apps/desktop/src/agents apps/desktop/e2e -maxdepth 2 -type f \( -name '*.ts' -o -name '*.tsx' \) | sort
git diff --check
rg -n "Subagent evidence|Postgres|atoms.body|write-policy parity|scanWorkspaceFiles|Startup reconciliation|MCP direct-history|ChatThread|Channel|DM|ThreadMessage|read-state|Phase 0 Decisions|P0R|DOHC_TEST_AGENT_CLI" docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
rg -n '\[[^\]\[]+\]\([^)]+\)' docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md || true
git rebase codex/think-bigger-00-readiness-scaffold
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm install --frozen-lockfile
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-fs test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-fs typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api test src/routes/shares.test.ts
docker compose -f docker-compose.dev.yml up -d postgres
```

### E2E / Visual / Manual QA

- Manual inventory plus focused package tests.
- Existing direct-disk E2E identified:
  `apps/desktop/e2e/workspace-direct-disk.spec.ts`.
- Live Postgres share lifecycle test could not run locally because Docker is not
  available in this WSL distro and `127.0.0.1:54329` was not accepting
  connections. The fake-pool revocation unit test covered the new admin hook.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for this inventory/low-level policy
  lane.
- Codex result: not run.
- Claude result, if available: not run.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### CodeRabbit

- Status: pending latest rerun after scan-policy and share-revocation fixes.
- Historical findings fixed:
  - Major: added explicit ID-model backfill/cutover plan.
  - Major: clarified `.dohc/chats/v1-<digest>.md` projections are surfaced
    through engine projection/search APIs, not the normal file scan loop.
  - Minor: set P0A PR metadata to `not opened`.
  - Minor: changed P0A table test evidence to `docs sanity`.
  - Minor: made rename/move semantics consistently alias-transfer over stable
    object identity.
  - Minor: made scan-policy gating consistent across the inventory and P0C
    boundary.
  - Minor: narrowed the `permissions` table note to distinguish the missing
    permission-specific implementation from the generic workspace auth helper.
  - Major: aligned `scanWorkspaceFiles` with shared ignored segments and removed
    scanner-specific SQLite-sidecar expectations.
  - Minor: wired successful share revocation to the Hocuspocus admin disconnect
    hook.
  - Minor: removed stale P0A approval wording while the latest rerun is pending.
  - Minor: clarified the PR-open checklist remains gated by PR00 docs-only
    exception approval.
  - Major: made collaboration startup fail fast when Hocuspocus JWT auth is
    enabled without an admin URL/token.
  - Major: moved share revocation into a transaction for lookup/authz and the
    durable database revoke; the Hocuspocus admin disconnect runs after commit
    and is retried from a persisted event if it fails.
  - Major: added a bounded timeout around Hocuspocus admin disconnect requests.
  - Minor: preserved `HOCUSPOCUS_ADMIN_URL` path prefixes when constructing
    admin disconnect request URLs.
  - Major: made share revocation fail closed before deleting when the
    Hocuspocus admin disconnect client is not configured.
  - Minor: updated stale scan/sync risk wording to name the remaining
    oversized-file, secret-detection, and materialization gaps.
  - Minor: updated share-revocation inventory wording to match the configured
    Hocuspocus admin disconnect path.
  - Major: reordered share revocation so the database revoke commits before the
    Hocuspocus admin disconnect, with a retryable pending disconnect event.
  - Major: destroys the Postgres client if transaction rollback fails.
  - Major: returns success after the durable revoke commit even if the immediate
    admin disconnect attempt fails, leaving the pending disconnect event for
    retry.
  - Major: defers missing-admin failure until after share lookup and authz so
    unauthorized callers keep uniform not-found behavior.
  - Major: validates `HOCUSPOCUS_ADMIN_URL` at startup instead of after a share
    revoke has already committed.
  - Major: rejects non-HTTP(S) Hocuspocus admin URLs during startup.
  - Major: no-collaboration deployments get a no-op admin disconnect client so
    share revocation can still complete.
  - Major: added a retry consumer for
    `share.revocation.disconnect_pending` events.
  - Major: scoped the shared mutation-ledger inventory requirement by
    workspace.
  - Minor: added captures to the workspace-object taxonomy.
  - Major: reserved conflict status, chosen/current visible value, and
    resolution metadata in the Phase 0 conflict record definition.
  - Minor: aligned PR00 gate wording between the status-table lead-in and the
    P0A row.
  - Major: retry worker deletes malformed pending-disconnect events so they
    cannot starve later valid retries.
  - Minor: retry worker treats `NaN` limits as the safe default before
    clamping.
  - Trivial: retry worker claims pending disconnect events in a transaction with
    `for update skip locked`.
  - Major: no-collaboration startup returns the no-op admin client before
    parsing stale Hocuspocus admin env vars.
  - Major: retry worker commits claimed rows before Hocuspocus network
    disconnects and performs cleanup in independent statements.
  - Major: retry worker can reclaim stale claimed events and treats post-success
    cleanup delete failure as best-effort instead of a failed disconnect.
  - Major: normalized `HOCUSPOCUS_JWT_SECRET` once for collab token and admin
    disconnect wiring.
  - Minor: `createHocuspocusAdminClient` now returns a concrete admin client on
    every non-exit path.
  - Major: share revocation retry claim handles scalar legacy JSON payloads.
  - Major: live owner-revoke test now passes the Hocuspocus admin override.
  - Major: inline share revocation inserts a pending disconnect event, then
    claims it after the durable revoke commit; if another worker claims first,
    the retry worker owns the disconnect.
  - Minor: scoped inventory gap wording to the Phase 0 paths reviewed here.
  - Trivial: split P0C secret policy gating from the later secret-backed file
    driver milestone.
  - Major: share revocation retry/claim due times now use Postgres-generated UTC
    timestamps instead of workspace-api host clocks.
  - Major: retry worker scans by effective due time (`retryAfter` or
    `claimExpiresAt`) before `created_at` so stale claims are not starved by
    older pending backlog.
  - Major: legacy claimed events without `claimExpiresAt` still apply the stale
    claim window before retry, with regression coverage for recent claims.
  - Major: retry worker claim batches are capped to the lease-safe maximum and
    Hocuspocus disconnect calls are time bounded before requeue.
  - Major: retry worker verifies each event's recipient against the
    workspace-scoped soft-deleted share row before claiming.
  - Major: Hocuspocus disconnect timeout now threads an `AbortSignal` through
    the admin-client contract so the real HTTP request is canceled.
  - Major: former workspace members who originally created a share can no
    longer revoke it after losing access; only current owners bypass
    membership.
  - Major: malformed revocation-event fallback share lookup is scoped by the
    event workspace.
- Fixes: latest CodeRabbit findings fixed in this committed diff; awaiting clean
  rerun.
- Ops note: CodeRabbit CLI hit recoverable rate limits during P0A review and was
  retried after the reported wait windows.
- Overrides:

### Subagent Reviews

- Storage/Y.Doc inventory: completed. Findings incorporated:
  current backend is Postgres/filesystem/Hocuspocus, not Convex; `atoms.body`
  is a derived markdown cache from the canonical Y.Doc, not writable full-body
  source content; direct API/sync writes need lock/share/effective-policy parity
  with Hocuspocus; folders are schema-present but not active first-class durable
  primitives; entity primitive was not found.
- Filesystem/sync inventory: completed. Findings incorporated:
  scan/sync inclusion policy is weaker than watcher/export/search; closed-app
  edits are not clearly recorded into local history; MCP direct history
  recording may duplicate watcher-recorded mutations; raw SQLite-byte sync
  versus structured database-operation sync needs a crisp contract.
- Collaboration/chat inventory: completed. Findings incorporated:
  no first-class chat/channel/DM/message/reaction/read-state substrate exists
  yet; current collaboration primitives are shares, data fragments,
  Hocuspocus awareness, local history, operational notices, and bounded agent
  session streams; chats need storage/actions/policy before UI.

### Security / Privacy Notes

- P0A identified that current cloud identity is server-derived through
  workspace-api session resolution and Postgres membership checks.
- P0A identified stale documentation risk:
  `docs/security/authz-boundaries.md` still describes Convex-era boundaries.
- P0A keeps generic external local file writes identity-light; they must not
  become authenticated human/agent attribution without trusted run context.
- P0A identified write-policy parity risk between direct API/sync writes and
  Hocuspocus writes.
- P0A fixed `scanWorkspaceFiles` parity for shared ignored segments `.dohc`,
  `.git`, and `node_modules`; raw SQLite file handling remains covered by the
  database-object sync contract.
- P0A wired share revocation so the delete commits first, a pending disconnect
  event remains retryable, and the configured Hocuspocus admin disconnect hook
  is attempted afterward.
- P0A identified startup reconciliation and duplicate-history risks for
  local filesystem mutations.

### Performance Notes

- Budget areas touched: planning plus `scanWorkspaceFiles` traversal filtering.
- Metrics: workspace-fs tests passed 40 tests in 2.74s locally after scanner
  filtering; no scaled scan benchmark yet.
- Existing performance budgets identified in `packages/performance/src/budgets.ts`.
- P0R must benchmark scan/reconcile/hash before deep engine implementation.
- Search and sync changes in later PRs must include measured evidence.
- Scan-policy hardening and startup reconciliation are performance-sensitive
  and must record measurements when implemented.

### Migration Notes

- P0A recommends extending existing workspace packages instead of introducing
  an unrelated second source of truth.
- No database migrations in this PR.
- Operators that want immediate Hocuspocus disconnects on share revocation must
  configure `HOCUSPOCUS_ADMIN_URL` and `HOCUSPOCUS_ADMIN_TOKEN` for
  `workspace-api`.

### Remaining Risk

- PR00 docs-only local-agent-CLI exception still needs explicit human approval
  before PR00 is marked complete or merge-ready.
- P0A is restacked on PR00 because it depends on the plan/log files introduced
  there.
- P0A still needs its own lane PR, CodeRabbit review, and final approval before
  it can be considered complete.

### Follow-Up / Deletion Conditions

- Keep this note until Phase 0 decisions are either implemented or superseded
  by a later architecture decision record.

## PR P0R - Rust Workspace Kernel Spike

Status: restacked on P0A; not approved
Branch: codex/think-bigger-p0r-rust-kernel
Worktree: `/home/ice/dev/dohc-p0r-rust-kernel`
Implementation chat/thread: main orchestration thread
PR:
Date started: 2026-06-24
Date completed:

### Scope

- [x] Create dedicated P0R worktree.
- [x] Add contained Rust workspace-kernel scanner spike.
- [x] Add TypeScript comparison scanner that calls current
      `scanWorkspaceFiles`.
- [x] Add local benchmark harness.
- [x] Add bridge-option recommendation note.
- [x] Run Rust tests.
- [x] Run TypeScript/Rust benchmark.
- [x] Record measurements and final recommendation.
- [ ] Open PR after PR00 docs-only exception approval and P0A lane PR decision
      are settled or use a stacked PR target.

### Files Changed

- crates/workspace-kernel-spike/Cargo.toml
- crates/workspace-kernel-spike/Cargo.lock
- crates/workspace-kernel-spike/src/main.rs
- scripts/workspace-kernel-spike/ts-scan.ts
- scripts/workspace-kernel-spike/bench.mjs
- .gitignore
- docs/superpowers/plans/2026-06-24-think-bigger-p0r-rust-kernel-spike.md
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md

### Tests Added Or Updated

- Rust unit tests inside `crates/workspace-kernel-spike/src/main.rs`.
- Benchmark harness for generated fixture comparison.

### Commands Run

```bash
git worktree add -b codex/think-bigger-p0r-rust-kernel /home/ice/dev/dohc-p0r-rust-kernel HEAD
rustc --version
cargo --version
pnpm install --filter @dohc/workspace-fs --frozen-lockfile
pnpm install --filter @dohc/workspace-core --filter @dohc/workspace-contracts --frozen-lockfile
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
git rebase codex/think-bigger-p0a-inventory
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
```

### E2E / Visual / Manual QA

- Not applicable yet. P0R is a kernel spike, not UI.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for this spike unless later wired into
  P0G.
- Codex result: not run.
- Claude result, if available: not run.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### CodeRabbit

- Status: pending.
- Findings:
- Fixes:
- Overrides:

### Subagent Reviews

- Architecture: pending.
- Security: pending.
- QA: pending.
- Other:

### Security / Privacy Notes

- Spike does not change production behavior.
- Rust scanner skips `.dohc`, `.git`, and `node_modules`.
- Rust scanner does not follow symlinks.
- Effective policy and authz stay outside native code for this spike.

### Performance Notes

- Budget areas touched: planning/spike only.
- Metrics:
  - Rust spike: min 6.89ms, max 8.57ms, average 7.70ms.
  - Current TypeScript baseline: min 332.91ms, max 337.55ms, average
    335.74ms.
- Workspace/file/chat sizes: generated 1,000-file fixture, 1,024 bytes per
  file, three iterations.
- Machine/CI context: local Codex machine; latest rerun happened after the P0A
  restack and used Linux Node v24.18.0 and Cargo 1.82.0.
- Budget pass/fail: no production budget applies yet. Result strongly supports
  continuing the Rust kernel lane behind shared contracts. The fixture now uses
  the same ignored-segment behavior for Rust and the TypeScript
  `scanWorkspaceFiles` baseline (`.dohc`, `.git`, and `node_modules`), but the
  numbers are still directional local smoke data rather than release budgets for
  the full future scan/hash/reconcile/indexing engine.

### Migration Notes

- No migrations.
- No production package depends on the spike.

### Remaining Risk

- Rust packaging and CI are not yet proven.
- Current Rust spike uses a one-shot CLI, not the recommended long-term
  sidecar/JSON-RPC bridge.
- The Rust scanner intentionally tests a stronger skip policy than current
  TypeScript `scanWorkspaceFiles`; benchmark results must note that comparison.
- PR00 docs-only local-agent-CLI exception and P0A lane PR approval remain
  upstream gates before P0R can be marked complete.

### Follow-Up / Deletion Conditions

- Delete once a production Rust kernel lane supersedes the spike, or keep as a
  benchmark fixture until cross-language contract tests replace it.

### Phase 0 Proof Arc

PRs:

- P0A
- P0R
- P0B
- P0C
- P0D
- P0E
- P0F
- P0G

Gate evidence:

- [ ] Current codebase inventory and storage/interposition decisions are
      recorded.
- [ ] Phase 0 branch/worktree/chat ownership is recorded for each PR lane.
- [ ] Rust workspace kernel spike completed or explicitly deferred by user.
- [ ] Rust vs TypeScript scan/reconcile/hash benchmark numbers are recorded.
- [ ] Rust bridge/packaging/CI recommendation is recorded.
- [ ] Main plus one named version works for one text/file driver.
- [ ] File/API writes save immediately and produce recoverable history.
- [ ] Server/engine-derived actor identity is enforced for write paths; callers
      cannot assert trusted user identity.
- [ ] Every atom, folder, entity, file, version, chat, share, capture, event,
      search result, and projection is workspace-scoped.
- [ ] Agent writes respect user locks, protected paths, folder/file access,
      sharing boundaries, and skill-turn gates.
- [ ] HTML atoms remain sandboxed and sanitized.
- [ ] Canonical Y.Doc state takes precedence over derived Markdown/body caches
      where rich docs are involved.
- [ ] External editor/process edits are detected while dohc is running.
- [ ] External editor/process edits made while dohc is stopped reconcile on
      next launch.
- [ ] Restore works.
- [ ] Clean merge works.
- [ ] Conflict preserves base/current/incoming.
- [ ] One chat can link to a file and appear beside the file.
- [ ] Chat projection is read-only.
- [ ] Search returns linked chat/file context without policy leaks.
- [ ] `.env` is excluded/redacted/ignored until secret-backed files exist.
- [ ] Workspace-switch async race E2E passes.
- [ ] Performance measurements are recorded for startup, reconciliation,
      watcher capture, history restore, search, and linked chat UI.
- [ ] Phase 0 performance budgets pass or budget misses have explicit user
      approval and follow-up.
- [ ] No renderer-blocking whole-workspace scan ships in Phase 0.
- [ ] Local agent CLI QA passes with `DOHC_TEST_AGENT_CLI=codex`.
- [ ] Claude local agent CLI compatibility is run or unavailable status is
      recorded.
- [ ] Local agent file edits are captured without requiring agent-specific file
      attribution.
- [ ] Agent chat replies display as `<User Name>'s agent`.
- [ ] CodeRabbit approved every Phase 0 PR or user approved documented
      non-sensitive non-blocker overrides.
- [ ] Architecture/security/QA subagent reviews complete.
- [ ] Expansion roadmap has been revised with Phase 0 findings.

### Foundation Alpha

PRs:

- 00
- 01
- 02
- 03
- 04

Gate evidence:

- [ ] Stable IDs exist for substrate fixtures.
- [ ] Typed events are workspace-scoped.
- [ ] Effective policy resolver covers files, links, search, notifications,
      projections, and export.
- [ ] CodeRabbit approved every PR or user approved documented non-sensitive
      non-blocker overrides.
- [ ] Security subagent review complete.

### Filesystem / Version Proof

PRs:

- 05
- 06
- 07
- 08
- 09
- 10
- 11

Gate evidence:

- [ ] File edits save immediately to the active version.
- [ ] API and filesystem writes agree.
- [ ] Named versions isolate state.
- [ ] Clean merge works.
- [ ] Conflict preserves both sides.
- [ ] `.env` can be secret-backed without plaintext leakage.
- [ ] Lazy hydration/pinning works.
- [ ] Search is policy-aware.
- [ ] Required E2E pass.

### Chats Proof

PRs:

- 12
- 13
- 14
- 15
- 16
- 17

Gate evidence:

- [ ] Channels work.
- [ ] DMs/small groups work.
- [ ] Fast composer works.
- [ ] Chat links to files/versions/history moments.
- [ ] File side rail shows related chats.
- [ ] Agent replies display as `<User Name>'s agent`.
- [ ] Mentions/reactions/presence/notifications work.
- [ ] Search links chats and work context.
- [ ] Required E2E pass.

### Collaboration Expansion

PRs:

- 18
- 19
- 20
- 21
- 22

Gate evidence:

- [ ] External/shared channels are explicit and revocable.
- [ ] Versioned workspace UX feels integrated.
- [ ] Agent file edit plus chat reply loop works.
- [ ] Migration path proven with rollback.
- [ ] Full QA hardening complete.
- [ ] No skipped critical E2E.
- [ ] No unresolved P0/P1 findings.
