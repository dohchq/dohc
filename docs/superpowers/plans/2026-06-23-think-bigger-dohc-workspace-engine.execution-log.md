# Think Bigger dohc Workspace Engine Execution Log

Status: see the canonical live-status block in the latest PR00 pass below.
Created: 2026-06-23

Plan:

- [Think Bigger dohc Workspace Engine](./2026-06-23-think-bigger-dohc-workspace-engine.md)

Source specs:

- [dohc Versioned Workspace Design](../specs/2026-06-22-dohc-versioned-workspace-design.md)
- [dohc Native Filesystem Design](../specs/2026-06-23-dohc-native-filesystem-design.md)
- [dohc Chats Design](../specs/2026-06-23-dohc-chats-design.md)

## Current PR Pointer

- **Canonical live status block:** the latest PR00 pass below owns CodeRabbit
  status, test evidence, open overrides, and completion state.
- **Pointer role:** this header is not a mutable status summary; update the
  canonical pass block instead of restating live state here.
- **PR00 PR:** draft PR on `codex/think-bigger-00-readiness-scaffold` at
  [https://github.com/dohc-ai/dohc/pull/46](https://github.com/dohc-ai/dohc/pull/46).

## How To Use This Log

Every implementation PR must append an entry before it is considered complete.

Required evidence:

- branch name.
- worktree path.
- implementation workstream, if used.
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

## PR Lane Inventory

P0A-P0G branches are provisional throughput work started after user approval for
unattended Phase 0 execution on 2026-06-24. Current live state is recorded only
in the canonical live-status block in the latest PR00 pass below. This table
records static lane ownership, branch, worktree, and planned validation shape.

| PR ID | Title | Branch | Worktree | Implementation Workstream | Planned Tests | Static Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0A | Current System Inventory And Decisions | codex/think-bigger-p0a-inventory | provisional sibling worktree | TBD lane PR workstream | docs + minimal storage/filesystem smoke + focused package tests | Provisional lane. |
| P0R | Rust Workspace Kernel Spike | codex/think-bigger-p0r-rust-kernel | provisional sibling worktree | TBD lane PR workstream | cargo test + perf | Provisional lane. |
| P0B | Minimal Versioned Text Store | codex/think-bigger-p0b-versioned-store | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0C | File/API Write Capture And History | codex/think-bigger-p0c-file-history | provisional sibling worktree | TBD lane PR workstream | workspace-engine/history/mcp/desktop + feasible matrix | Provisional lane. |
| P0D | Compare, Clean Merge, Conflict Preservation | codex/think-bigger-p0d-merge-conflicts | provisional sibling worktree | TBD lane PR workstream | workspace-engine + workspace-history + typecheck | Provisional lane. |
| P0E | Minimal Chat Linked To File | codex/think-bigger-p0e-linked-chat | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0F | Search And Policy Smoke | codex/think-bigger-p0f-search-policy | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0G | Proof Arc QA And CodeRabbit Hardening | codex/think-bigger-p0g-proof-qa | provisional sibling worktree | TBD lane PR workstream | workspace-engine + history + typechecks + local agent smoke | Provisional lane. |
| 00 | Mega Plan And Readiness Scaffold | codex/think-bigger-00-readiness-scaffold | current PR00 checkout | main orchestration workstream | docs link/anchor check + brand guard | Scaffold lane. |
| 01 | Workspace Engine Contracts And Substrate | TBD | TBD | TBD | TBD | Roadmap lane. |
| 02 | Version Registry And Typed Event Skeleton | TBD | TBD | TBD | TBD | Roadmap lane. |
| 03 | Snapshot And Restore Foundation | TBD | TBD | TBD | TBD | Roadmap lane. |
| 04 | Effective Policy And File Policy Resolver | TBD | TBD | TBD | TBD | Roadmap lane. |
| 05 | Native Filesystem Capture MVP | TBD | TBD | TBD | TBD | Roadmap lane. |
| 06 | Version Folders Or Mounts MVP | TBD | TBD | TBD | TBD | Roadmap lane. |
| 07 | Compare And Merge For Text/File Driver | TBD | TBD | TBD | TBD | Roadmap lane. |
| 08 | Secret-Backed Files | TBD | TBD | TBD | TBD | Roadmap lane. |
| 09 | Lazy Hydration And Pinning | TBD | TBD | TBD | TBD | Roadmap lane. |
| 10 | Workspace Status And Diagnostics | TBD | TBD | TBD | TBD | Roadmap lane. |
| 11 | Search Foundation Across Versions And Files | TBD | TBD | TBD | TBD | Roadmap lane. |
| 12 | Chats Schema And Channel/DM Foundation | TBD | TBD | TBD | TBD | Roadmap lane. |
| 13 | Chats UI: Fast Channels, DMs, Composer | TBD | TBD | TBD | TBD | Roadmap lane. |
| 14 | Chats Linked To Files, Versions, And History | TBD | TBD | TBD | TBD | Roadmap lane. |
| 15 | Agent Chat Participation Tools | TBD | TBD | TBD | TBD | Roadmap lane. |
| 16 | Presence, Reactions, And Notification Core | TBD | TBD | TBD | TBD | Roadmap lane. |
| 17 | Search Across Chats, Files, Versions, And Agents | TBD | TBD | TBD | TBD | Roadmap lane. |
| 18 | External And Shared Channels | TBD | TBD | TBD | TBD | Roadmap lane. |
| 19 | Versioned Workspace UX Integration | TBD | TBD | TBD | TBD | Roadmap lane. |
| 20 | Agent End-To-End Work Loop | TBD | TBD | TBD | TBD | Roadmap lane. |
| 21 | Migration And Backwards Compatibility | TBD | TBD | TBD | TBD | Roadmap lane. |
| 21R | Sync Replication And Offline Rejoin | TBD | TBD | Replication and offline reconciliation | TBD | Roadmap lane. |
| 22 | Full QA Hardening And Release Readiness | TBD | TBD | TBD | TBD | Roadmap lane. |

## Entry Template

Copy this section for each PR.

````md
## PR NN - Title

Status:
Branch:
Worktree:
Implementation workstream, if used:
PR Link:
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

### Phase 0 Decision Note

- Storage baseline:
- Filesystem interposition:
- Secret boundary:
- Merge scope:
- Chat/file philosophy:
- Rust kernel boundary:
- Approval/status:

### Local Agent CLI QA

#### Pre-Edit Checks

- Root `AGENTS.md` reviewed:
- `apps/app/AGENTS.md` reviewed when working in `apps/app`:
- `apps/web/AGENTS.md` reviewed when working in `apps/web`:
- `apps/app/convex/_generated/ai/guidelines.md` reviewed when touching Convex:
- Other required instructions reviewed:

- `DOHC_TEST_AGENT_CLI`:
- Local agent result:
- Alternative local-agent result, if available:
- Transcript/artifact path:
- Secret redaction notes:

### CodeRabbit

- Status:
- Findings:
- Fixes:
- Overrides:
- Override approval reference:

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
- Baseline profile:
- Baseline commit/fixture:
- Baseline values:
- Accepted tolerance/variance:
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

> Historical entry; see Current PR Pointer above and the canonical live-status
> block in the latest PR00 pass for live status.

Status: draft PR
Branch: codex/think-bigger-00-readiness-scaffold
Worktree: `<current checkout>`
Implementation workstream, if used: main orchestration workstream
PR Link: [https://github.com/dohc-ai/dohc/pull/46](https://github.com/dohc-ai/dohc/pull/46)
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
- docs/superpowers/plans/2026-06-23-think-bigger-docs.manifest.json
- scripts/check-think-bigger-doc-links.mjs
- .github/workflows/think-bigger-docs.yml

### Tests Added Or Updated

- No new code tests were added. Planning/docs-only scaffold validation runs are
  recorded below.

### Commands Run

#### Setup And Discovery

```bash
git status --short --branch
git remote -v
gh --version
gh auth status
rg -n "Execution Topology|worktree|implementation thread|one implementation PR|Rust Kernel Spike|Phase 0 branch/worktree/chat ownership" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
```

#### Initial Validation

```bash
git diff --cached --check
rg -n "<workspace-root>|\| PR \||Ice's agent|server/engine-derived actor|secret-backed conflicts|workspace/request token|HTML atoms|Canonical Y.Doc" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md docs/superpowers/specs/2026-06-23-dohc-chats-design.md
git diff --check
pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts
node scripts/check-think-bigger-doc-links.mjs
```

#### Node 24 Validation

```bash
curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz -o /tmp/dohc-node-v24.18.0-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/v24.18.0/SHASUMS256.txt -o /tmp/dohc-node-v24.18.0-SHASUMS256.txt
expected=$(grep ' node-v24.18.0-linux-x64.tar.xz$' /tmp/dohc-node-v24.18.0-SHASUMS256.txt | awk '{print $1}')
actual=$(sha256sum /tmp/dohc-node-v24.18.0-linux-x64.tar.xz | awk '{print $1}')
test "$expected" = "$actual"
printf '%s  %s\n' "$expected" "/tmp/dohc-node-v24.18.0-linux-x64.tar.xz"
rm -rf /tmp/dohc-node-v24.18.0
mkdir -p /tmp/dohc-node-v24.18.0
tar -xJf /tmp/dohc-node-v24.18.0-linux-x64.tar.xz -C /tmp/dohc-node-v24.18.0 --strip-components=1
/tmp/dohc-node-v24.18.0/bin/node -v
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" /tmp/dohc-node-v24.18.0/bin/corepack pnpm --version
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" /tmp/dohc-node-v24.18.0/bin/corepack pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts
```

#### Remote PR And Review

```bash
git push -u origin codex/think-bigger-00-readiness-scaffold
gh pr create --draft --base main --head codex/think-bigger-00-readiness-scaffold --title "Add dohc Think Bigger workspace engine plan"
coderabbit review --agent -t committed -c AGENTS.md
```

### E2E / Visual / Manual QA

- Manual docs sanity only.
- Focused brand/no-legacy guard passed: `apps/web/src/__tests__/brandNoLegacy.test.ts`
  reported 1 file and 2 tests passed under Linux Node 24.18.0.
- Node 24 environment: official Linux Node v24.18.0 tarball extracted to
  `/tmp/dohc-node-v24.18.0/bin/node`.
- pnpm entrypoint: Node v24.18.0 Corepack resolved repo package manager
  `pnpm@10.24.0`.
- Earlier Node 18.19.1 run is retained only as exploratory output and is not
  counted as gate evidence because it does not satisfy the repo engine field.
- Docs link/anchor checker passed over the exact five PR00 docs with result:
  `docs link/anchor check passed for 5 files`.
  Covered docs:
  `docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md`,
  `docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md`,
  `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`,
  `docs/superpowers/specs/2026-06-23-dohc-chats-design.md`, and
  `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for docs-only scaffold.
- Docs-only exception approval: pending human approval before PR00 is marked
  complete or merge-ready.
- Current implementation evidence exists in P0G, where the local agent CLI smoke
  passed with a real provider child process in a disposable workspace using a
  provider-specific danger-full-access sandbox override as a one-off temporary QA
  exception. This unsafe sandbox mode is not baseline behavior; the default safe
  sandbox remains the intended path.
- Open follow-up: restore default safe-sandbox validation when local sandbox
  support is available.
- Local agent result: not run for PR00 docs-only scaffold; exception pending.
- Alternative local-agent result, if available: not run for PR00 docs-only
  scaffold; exception pending.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### CodeRabbit

- Status: see the newest owning PR00 pass entry below.
- Current findings: see the newest owning PR00 pass entry below; this section is
  historical and intentionally avoids mutable issue counts.
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
  - Added durability-ack boundary after durable persistence.
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

Fifty-fifth pass:

- Historical snapshot: recorded the then-current provisional pushed P0A-P0G
  stack, where P0D-P0G were restacked on the latest P0C line and P0G local
  validation had passed on the integrated proof arc.
- Recorded the current local-agent evidence boundary: PR00 remains docs-only,
  while P0G proves the real provider child-process file edit in a disposable
  workspace using a provider-specific danger-full-access sandbox override as a
  one-off temporary QA exception. Default safe-sandbox validation remains the
  intended path and is blocked locally by the missing sandbox helper.

Fifty-sixth pass:

- Fixed CodeRabbit follow-up findings:
  - Added canonical Y.Doc/Markdown projection save semantics so `atoms.body`
    remains derived from the authoritative document driver.
  - Added explicit atomic `replace(...)` contracts for versioned workspace and
    native filesystem temp-file-then-rename saves.
  - Restricted default conflict envelopes to opaque handles, hashes, operation
    kinds, and minimal status; policy decisions, previews, explanations, and
    bytes now require server-side materialization authorization.
  - Removed the external-person-inspired wording from the open/private work
    principle.
  - Added the secret-backed/protected file-state dimension and `.env` plaintext
    materialization rules.
  - Narrowed Phase 0 stable IDs to proof-arc identities and moved rows, secrets,
    and projections to deferred substrate scope.
  - Clarified chat async renderer guards must recheck the workspace/request
    token at apply time.
  - Marked Phase 0 lane worktree/thread cells as provisional/TBD until lane PRs
    are actually opened and staffed.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Fifty-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added a minimum retry/retention horizon for accepted quarantined records,
    tied to the maximum expected evaluator outage or retry window.
  - Normalized rename, move, and replace object-id names across the versioned
    workspace and native filesystem specs with `sourceObjectId` and
    `destinationObjectId` semantics.
  - Removed app sharing from current shared-channel scope until app identity is
    explicitly introduced by a later substrate milestone.
  - Moved reaction persistence/API ownership to PR 12 and left PR 16 responsible
    for reaction display, privacy, and notification behavior.
  - Added append-only chat edit activity with previous body snapshots, editor
    identity, edit timestamp, and secret-safe history materialization.
  - Reframed app/site and database/row chat links as deferred substrate links.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Fifty-eighth pass:

- CodeRabbit approved the latest committed diff with 0 findings after the
  fifty-seventh pass fixes.
- Updated PR00 status, CodeRabbit status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.

Fifty-ninth pass:

- Fixed CodeRabbit follow-up findings from the final confirmation rerun:
  - Bound read/watch responses to every requested version identifier, including
    diff/merge version pairs, plus workspace and request token/epoch.
  - Limited shared-channel grant-revocation cleanup to server-held projections,
    search snippets, notification caches, export staging artifacts, and other
    service-owned materializations.
  - Declared `ThreadLink` the canonical source for chat linked work,
    `ChatThreadProjection.linkedWork` a derived read model/cache, and link
    activity events append-only provenance.
  - Standardized native filesystem materialization terminology on `virtual`.
  - Scoped idempotency keys to API-originated write mutations and separated
    mounted-folder/file-watch deduplication from API idempotency semantics.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixtieth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Standardized `replace(...)` destination freshness guards on
    `destinationPrecondition` in the versioned workspace and native filesystem
    specs.
  - Kept `.env` within the existing materialization enum by using `local` in the
    file-state table and leaving plaintext permission to secret-backed rules.
  - Made P0A a hard prerequisite for PR 01 and later roadmap contract or
    implementation work until its decision note is approved.
  - Narrowed PR 02 stable-ID and migration scope to file/doc/chat substrate,
    deferring app/data object-ID migration.
  - Replaced the Phase 0 remote/cloud compare test with a same-workspace
    concurrent local change comparison.
  - Required message edit activity and body replacement to occur in one atomic
    transaction or serialized unit of work.
  - Required shared-channel rendering, search, projection, notifications, and
    export to re-authorize or redact free-text mentions of hidden workspace
    objects.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-first pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Tightened write-authority language so server-derived actor identity plus all
    workspace/version/path protection gates are required before edits land.
  - Split malformed or incompatible write preconditions into validation/protocol
    errors, while preserving conflict envelopes for well-formed stale causal
    tokens.
  - Added stable `ThreadLink` identifiers, tombstone deletion state, link target
    tuples, and reaction replay tuples to chat activity.
  - Made deterministic chat projection filenames grant-aware by including
    projection scope in the digest input.
  - Broadened PR 21 chat migration scope to preserve read state,
    membership/visibility, links, and shared-channel metadata.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-second pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Rewrote the content-driver checklist with concise direct labels.
  - Required `ThreadLink` create/update paths to validate cross-workspace grants,
    target identity, and visibility scope against trusted server-side grant state
    before persistence.
  - Extended server/engine-derived chat authorization to edits, deletes,
    reactions, read-state updates, worker mutations, notifications, summaries,
    and projections.
  - Limited channel attachment examples to currently defined stable workspace
    object types, with future object types allowed only after they are defined in
    the roadmap.
  - Normalized remaining shared-channel and side-rail examples to file, folder,
    and version resources so current examples use defined identities.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-third pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Changed idempotency replay retention in the versioned workspace and native
    filesystem specs from a fixed 24-hour floor to the documented maximum retry
    horizon for each operation type and transport.
  - Split `ThreadActivity` into message and link activity shapes so
    message-scoped events and reaction events require `messageId`.
  - Added an Accessibility Reviewer role for keyboard navigation, focus order,
    ARIA semantics, contrast, screen reader behavior, and WCAG regressions.
  - Replaced the later duplicate CodeRabbit guidance with a reference to the
    canonical CodeRabbit Loop section.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added source-side merge preconditions to freeze both source and target
    versions before merge execution.
  - Clarified local capture can be recorded in the local durability log while
    promotion to shared version history waits for fresh authoritative validation.
  - Replaced invalid optional scratch policy booleans with schema-valid `no`
    values.
  - Made chat parent-message validation a pre-persistence invariant for message
    create/update paths.
  - Standardized grant-aware chat projection scope on a server-issued opaque
    `projectionScopeId`.
  - Added async workspace-scoped response gating to the mega-plan robustness
    invariants.
  - Added atoms, captures, and history moments to the workspace-scoping
    invariant.
  - Synced the PR00 and P0D-P0G status table rows with the current provisional
    stack and latest review state.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Moved linked work out of canonical `ChatThread` state into
    `ChatThreadProjection.linkedWork` so `ThreadLink` remains the source of
    truth.
  - Added a `ReactionIdentity` XOR so reaction activity must carry either a
    stable `reactionId` or a complete deterministic reaction tuple.
  - Added the pending CodeRabbit rerun to unresolved findings while preserving
    the docs-only local-agent-CLI exception note.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Split versioned-workspace replay semantics into API idempotency keys and
    engine-generated filesystem capture tokens.
  - Made chat edit activity and `ThreadMessage.body`/`bodyRevision` visibility
    atomic at commit.
  - Added a canonical Current PR Snapshot block and changed live status fields in
    the PR table to reference it instead of duplicating the same state.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Normalized the logged workspace path in the commands block to a placeholder.
  - Bound managed local filesystem capture and dohc-controlled agent launches to
    an active server/engine-derived principal before history promotion.
  - Required async filesystem/watch/status handlers to apply only monotonic
    sequence or cursor freshness, treating server timestamps as metadata unless
    explicitly defined as per-stream counters.
  - Narrowed `.env` acceptance to encrypted-at-rest, redacted/excluded derived
    surfaces, and authorized dohc-controlled plaintext materialization.
  - Made rename/move stable-object-ID preservation unconditional, with
    reconciliation fallback when the platform cannot surface the move atomically.
  - Removed older conditional qualifiers from stable-ID preservation test
    criteria.
  - Made `ThreadLink` target/grant/scope fields immutable after creation and
    required remove+add for link changes.
  - Added deletion body snapshots to `message_deleted` activity.
  - Defined the v1 `ChatProjectionKind` enum and compatibility rule for future
    projection kinds.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Kept accepted holding records recoverable until canonicalization succeeds or
    an explicit operator-approved escalation path resolves them.
  - Required API idempotency records/tombstones to commit atomically with the
    canonical mutation, or before acknowledgement.
  - Reframed robustness bullets as target invariants pending Phase 0 baseline and
    filesystem-interposition decisions.
  - Made `message_deleted.previousBodyRevision` mandatory for normal in-system
    delete activity and documented legacy import fallback separately.
  - Consolidated live PR status into Current PR Snapshot and converted the table
    into static lane inventory.
  - Added reusable pre-edit check fields to the local-agent QA template.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Sixty-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Clarified that sync/import ingests carrying agent/run metadata cannot
    downgrade to unverified local/session provenance when proof is absent.
  - Relaxed API version cardinality so operations resolve in exactly one
    workspace while supplying the version identifiers each operation needs.
  - Renamed implementation lane terminology to internal workstreams and reserved
    explicit approval requirements for user-visible agent chats.
  - Tightened `ChatThreadProjection.linkedWork` to active non-tombstoned links
    only.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventieth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added holding records, durability-log entries, and idempotency tombstones to
    the versioned workspace `workspaceId` scoping invariant.
  - Added bounded accepted-record expiry/compaction semantics through
    operator-approved escalation after retry windows are exceeded.
  - Made native filesystem delete prose explicitly require an idempotency key.
  - Marked `ChatThreadBase.lastActivityAt` server-managed from canonical activity
    writes and rejected client ownership of that field.
  - Added length-prefixed digest framing for chat projection filenames.
  - Added explicit `message_deleted_legacy` activity for legacy import fallback
    deletes.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-first pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added a first-class Phase 0 decision-note section to the execution log
    template covering storage baseline, filesystem interposition, secret
    boundary, merge scope, chat/file philosophy, and Rust kernel boundary.
  - Labeled the safe `.env` scenario as post-Phase 0 / PR 08+ to match the
    deferred secret-backed file milestone.
  - Clarified that accepted holding records remain recoverable until
    canonicalization succeeds or explicit operator disposition is recorded, and
    that compaction cannot discard reconstructable payload before then.
  - Added `apps/web/AGENTS.md` to the reusable pre-edit check template.
  - Extended DM membership revocation fail-closed behavior to edits and deletes.
  - Closed chat `ThreadLink.targetType` through an enum and server-side resolver
    registry with fail-closed handling for unknown or unregistered target types.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-second pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Made accepted holding-record retention explicit: TTL, retry horizon,
    compaction, and colder-storage policies cannot delete reconstructable
    accepted payloads before canonicalization or explicit operator disposition.
  - Added a negative-first Rust bridge acceptance gate requiring P0R/P0F/P0G to
    reject or ignore forged client-supplied actor/workspace/version metadata.
  - Added PR21 migration scope and tests for rebuilding, invalidating, or
    reindexing workspace-scoped derived projections after migration and rollback.
  - Marked the PR00 execution-log entry as historical-only, with Current PR
    Snapshot remaining the live status source.
  - Made `ThreadActivityBase.actorId` the authoritative reaction actor identity.
  - Renamed chat edit/delete actions to `edit_chat_message` and
    `delete_chat_message` for API consistency.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-third pass:

- Fixed CodeRabbit follow-up finding from the latest rerun:
  - Aligned the native filesystem write contract with the versioned-workspace API
    by representing create-only writes as the mutually exclusive
    `precondition: expectedAbsent` token, not as a boolean field beside other
    preconditions.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Made secret egress fail closed outside dohc-controlled surfaces unless an
    explicit declassification step and sandboxed transport are in place.
  - Rephrased deferred projection backlog language so the core `Projection`
    contract remains part of the substrate.
  - Clarified that dohc Cloud syncs and replicates engine state but never becomes
    authoritative over local writes, identity, versions, history, conflicts,
    policy, or projections.
  - Made runtime validation mandatory for shared boundary types carrying
    workspace, version, and policy data.
  - Tightened API idempotency so records commit in the same transaction as the
    canonical mutation, or through an explicit write-ahead equivalent.
  - Changed non-allowlisted `.dohc/**` handling from ignore-or-recover to
    quarantine-or-engine-specific recovery.
  - Added canonical decimal-string validation rules for chat sequence and
    timestamp fields.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added performance baseline requirements before numeric budgets can act as
    release gates, including machine/CI profile, baseline values, fixtures, and
    accepted tolerance.
  - Added execution-log fields for baseline profile, baseline commit/fixture,
    baseline values, and accepted variance.
  - Extended shared-channel grant reauthorization to replay and history
    reconstruction consumers.
  - Required message edits to verify the current `bodyRevision` or equivalent
    message version inside the same atomic edit unit.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Treated stable secret references as first-class substrate identities while
    keeping secret-backed file materialization deferred to PR 08.
  - Added `Share`, `ShareGrant`, `ExternalChannel`, and `SecretReference` to the
    shared contract set, with one canonical share/external-channel shape for
    export, search, notifications, and shared channels.
  - Clarified that bound sessions are an authentication wrapper around the same
    explicit workspace/version request shape, not a second ambiguous API shape.
  - Replaced the vague policy source-order tie-break with canonical policy
    source ordinal plus explicit rule index.
  - Made channels persist by stable `(workspaceId, channelId)`, with slugs as
    lookup aliases only.
  - Clarified that accepted holding records stay hidden from normal
    `read`/`watch`/`search` until canonicalization, except for explicit
    authorized non-canonical ingest/recovery/status views.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added `replace(...)` to the versioned workspace write-producing operation
    list and to the E2E guard-set proof statement.
  - Made PR 17 primary to the Search/Policy workstream and a reviewer/dependency
    for Chats Product instead of assigning it to both lanes.
  - Added idempotency/uniqueness rules for reaction writes by stable
    `reactionId` or deterministic `(messageId, actorId, reactionKey)`.
  - Added active `ThreadLink` uniqueness by canonical target tuple so retries
    cannot create duplicate active links or fanout.
  - Updated the current PR snapshot to reflect pending/opened provisional lane
    PR state.
  - Added holding records, durability-log entries, and idempotency tombstones to
    the Phase 0 workspace-scoping checklist.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added a canonical `Idempotency Retry Horizons` source of truth in the Phase 0
    decision note and PR 01 `WorkspaceIdempotencyPolicy`, referenced by both
    versioned workspace and native filesystem specs.
  - Strengthened P0A testing so inventory must include a minimal smoke/contract
    validation for the chosen storage and filesystem baseline.
  - Replaced the PR00 `rg` link/path smoke with a docs link checker or equivalent
    link/anchor validation requirement.
  - Added a `Last updated` marker to Current PR Snapshot and renamed the reusable
    entry-template field to `PR Link`.
  - Made active `ThreadLink` uniqueness tombstone-aware so deleted links do not
    block future relinks.
  - Added fail-closed `chat_thread` self-link and cycle rejection before
    `link_added` or projection/search/export fanout.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Seventy-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Replaced the future-looking `Last updated` timestamp with a date-only PR00
    review-loop marker.
  - Added atom access to the Phase 0 agent-write authorization checklist.
  - Added `workspaceId` and source mount binding to native filesystem capture and
    restart reconciliation promotion rules.
  - Converted `ThreadLink` into target/scope variants so required
    `targetVersionRef`, `shareGrantId`, and `visibilityScope` fields are encoded
    by schema.
  - Defined message `bodyRevision` initial value and exact-by-one CAS advancement
    for successful edits.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eightieth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Distinguished canonical save success from durable-pending holding records so
    normal `read`/`watch`/`search` visibility matches ACK semantics.
  - Expanded idempotency keys to include full operation operands for merge,
    replace, restore, and other write-producing operations.
  - Removed the old PR title prefix from the recorded PR creation command.
  - Labeled `DOHC_CODEX_SANDBOX=danger-full-access` as a one-off QA exception and
    kept default safe-sandbox validation as the intended open follow-up.
  - Aligned DM participant-cap wording with the raw-submission and canonicalized
    list enforcement rule.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-first pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added `bodyRevision` to canonical numeric-string validation and boundary
    normalization rules.
  - Added durable `MentionNotificationThreadActivity` records so notification,
    mention, search, export, and replay rebuilds have a canonical activity source.
  - Ran and recorded a docs link/anchor checker over the five PR00 plan/spec docs.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-second pass:

- Fixed CodeRabbit follow-up finding from the latest rerun:
  - Marked `delete(...)` `targetObjectId` as explicitly required in the native
    filesystem API signature, matching the later delete prose.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-third pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Corrected the logged docs-link checker `PATH` to the extracted Node
    v24.18.0 directory used by the workspace.
  - Replaced the local QA result label with `Local agent result` while preserving
    the one-off unsafe sandbox exception note.
  - Narrowed PR 01 to core workspace/version/event/projection contracts and
    deferred chat/share/external-channel/secret-specific schemas to their first
    consuming PRs.
  - Made `LinkThreadActivity.linkTarget` require `shareGrantId` and
    `visibilityScope` for share targets and forbid them for non-share targets.
  - Changed DM participant cap wording to treat the canonicalized
    `dmParticipantIds` set as source of truth.
  - Clarified raw local writes are durability capture only until promotion gets a
    server/engine-derived principal and policy decision.
  - Extended TOCTOU-safe path canonicalization to API path handling before
    storage access.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added bounded accepted-holding-record lifecycle fields and operator-visible
    overdue disposition handling while preserving reconstructable payloads.
  - Standardized native filesystem non-materialized state on `virtual`, with
    on-demand hydration treated as behavior rather than a separate state label.
  - Narrowed PR 04 policy resolver scope to file/version/search/export substrate
    and neutral extension hooks, deferring later chat bindings to PR 12/14/16.
  - Added chat read-state cursors, unread/mention projections, and cursor-derived
    notification state to PR 21 migration rebuild/invalidation scope.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Removed mutable active-status duplication from Unresolved Findings; Current
    PR Snapshot remains the only active status source.
  - Added atomic channel `ChatThread` get-or-create by `(workspaceId, channelId)`
    before channel sends create `ThreadMessage` records.
  - Required `MentionNotificationThreadActivity.mentionedActorIds` to be
    deduplicated and bytewise sorted before storage.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Broadened async workspace-scoped response gating from UI state to every
    workspace-bound side effect.
  - Added explicit `WriteResult` variants, including `durable-pending`, and
    replay rules for accepted holding records.
  - Distinguished accepted payload bytes from derived retry/index metadata in
    compaction and garbage-collection wording.
  - Updated `LinkThreadActivity.linkTarget` to preserve `ThreadLinkScope` for all
    target types.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added `holdingRecordId` and retry-horizon fields to denied/quarantined
    `WriteResult` responses so operators can correlate retained non-canonical
    records back to API results.
  - Replaced ambiguous active chat link uniqueness with a normalized
    `CanonicalThreadLinkKey` contract and reserved sentinels shared by link
    creation, projections, search, and export.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Reframed the versioned workspace promise around immediate durable acceptance
    plus immediate canonicalization only after protection checks pass.
  - Added a non-overrideable terminal retention bound for accepted holding
    records so unresolved payload bytes cannot persist indefinitely.
  - Required internal chat links to keep `targetWorkspaceId === workspaceId`
    before persistence, fanout, projection, search, notification, export, or
    replay.
  - Scoped the secret-backed content restriction to unauthorized/public surfaces
    while preserving authorized local plaintext materialization.
  - Updated the PR00 live test status to include the docs link/anchor check.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Eighty-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added a dedicated `terminal-retired` `WriteResult` for accepted holding
    records whose payloads are retired by operator disposition or hard retention.
  - Changed `ChatThreadProjection` to extend `ChatThread` so channel and DM
    ownership discriminators remain available to projection consumers.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninetieth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Changed canonical save acknowledgment to require durable canonical commit
    plus read/watch visibility, with search indexing eventually consistent.
  - Replaced public denied `reasonCode: string` with a safe closed enum and kept
    richer diagnostics internal.
  - Corrected live PR00 status to reflect the latest 8-issue CodeRabbit pass
    and keep the rerun gate pending.
  - Constrained secret env injection to dohc-managed trusted/sandboxed launch
    flows with redaction and no arbitrary process injection.
  - Declared `WorkspaceVersion` as the exported contract name and `Version` as
    user-facing shorthand.
  - Expanded PR 12 chat link storage to the canonical `ThreadLink` shape with
    display snapshot and ACL/degraded-render state.
  - Split `FilePolicy.pinned` from `materialized` so offline retention and
    hydration state are separate.
  - Replaced restore `pointInTime` write targets with deterministic
    `checkpointId` targets; timestamp selection is only a server-side lookup
    alias.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-first pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Added `workspaceId` to canonical `WriteResult` success and conflict results
    so all write outcomes are workspace-correlatable.
  - Added a dedicated `idempotency-expired` `WriteResult` tied to the same
    `holdingRecordId` used by pending/denied retry horizons.
  - Split projection writeability from projection validation so writable
    source-backed policy files can be engine-validated without becoming
    canonical content projections.
  - Added source/owning workspace ID and target workspace ID to the shared link
    dereference contract and PR 01 contract list.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-second pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Clarified the opening versioned-workspace promise so durable recording,
    `durable-pending`, canonical promotion, and denied audit handles are separate.
  - Added explicit ownership/review gate language to Main write handling and the
    immediate-save enforcement path.
  - Made `MessageDeleteThreadActivity` the canonical chat deletion source, with
    `ThreadMessage` deletion fields only a derived cache that replay/export must
    verify or repair.
  - Kept the Current PR Snapshot aligned with the latest 4-issue rerun while
    follow-up fixes await the next CodeRabbit pass.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-third pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Bound API idempotency identities in both versioned-workspace and native
    filesystem specs to write payload digests or canonical operation payload
    fingerprints.
  - Trimmed PR 12 `ThreadLink` scope back to non-share chat link fields; share
    grant and visibility-scope fields remain deferred to PR 18.
  - Clarified channel-backed sends so `channelId` is context/container identity,
    while `ChatThread` remains the durable conversation identity.
  - Changed the PR00 execution-log "Tests Added Or Updated" note to say no new
    code tests were added while preserving validation evidence below.
  - Updated Current PR Snapshot to reflect the latest 5-issue CodeRabbit rerun.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Removed the shorter global safety-limit escape hatch from accepted holding
    record payload retirement; terminal retention is derived from
    `operatorDispositionDueAt` plus
    `AcceptedHoldingRecordPolicy.maxPendingCanonicalizationMs`.
  - Added PR 21R, Sync Replication And Offline Rejoin, as the dedicated
    replication/offline reconciliation workstream and pointed the source-of-truth
    default plus package boundary order at it.
  - Required atomic `ThreadMessage` creation with matching `message_created`
    activity visibility for replay/export/projection consistency.
  - Made mention notification `notificationId` deterministic from message
    revision/body hash/canonical mention set and required enqueue/resolve/replay
    dedupe by that id.
  - Aligned the PR00 lane inventory row with the actual docs link/anchor and
    brand-guard validation evidence.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Split durability acknowledgments from canonical write success in the
    versioned-workspace history/write-ack language.
  - Expanded conflict `WriteResult` with workspace/version, operation kind,
    opaque object handles, hashes, and minimal status.
  - Made equal `lastReadCursor` retries idempotent after authorization without
    requiring another message-existence lookup.
  - Required Phase 0 filesystem interposition to use watcher-backed normal
    folders; API-only simulated-folder adapters cannot satisfy P0C/P0F gates.
  - Made mention notification `bodyHash` required and defined the exact canonical
    mentioned-actor JSON encoding used by `notificationId`.
  - Updated Current PR Snapshot to reflect the latest 6-issue CodeRabbit rerun.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Routed conflict/visibility-boundary writes in the actor-neutral checklist to
    conflict preservation/reconciliation or review/share flows rather than the
    immediate canonical save path.
  - Reconciled Phase 0 filesystem interposition wording with the deferred VFS/FUSE
    list so watcher-backed normal folders are the only Phase 0 gate path.
  - Moved `SecretReference` out of the Phase 0 proof-arc identity list and kept
    it deferred to PR 08 with secret-backed file drivers/materialization.
  - Labeled Current PR Snapshot as a derived summary of the latest owning pass
    entry rather than an independent source of truth.
  - Removed `bodyHash` from mention `notificationId` composition while keeping it
    required audit evidence for the immutable persisted body revision.
  - Tightened shared chat projection scope to use exact server-issued
    `authzScopeId` authorization/redaction context.
  - Expanded the workspace-scope checklist to list concrete persisted chat
    primitives: thread, message, link, read state, notification, and activity.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Clarified that review gates apply to ordinary writes whenever policy requires
    them; boundary-crossing cases are additional examples, not the only triggers.
  - Added `delete`, `rename`, and `move` to conflict `operationKind`.
  - Aligned Phase 0 chat proof with schema ownership by making P0E own minimal
    provisional chat/link contracts and PR 12 own the full chat schema.
  - Made channel-backed thread association immutable and unique by
    `(workspaceId, channelId, channelConversationId)`.
  - Updated Current PR Snapshot to reflect the latest 5-issue CodeRabbit rerun.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Removed `watch` from canonical save success/write-critical-path language;
    `watch` now catches up asynchronously after durable canonical commit and
    `read` visibility.
  - Added mandatory policy-review evaluation to the actor-neutral write decision
    tree before immediate canonical save.
  - Replaced the PR00 lane inventory worktree placeholder with
    `<repo-root>`.
  - Added PR 21R to the Collaboration Expansion milestone list.
  - Aligned shared substrate vocabulary with `WorkspaceObject`, `VersionRef`,
    `Projection`, `WorkspaceEvent`, `DurabilityEvent`, `FilePolicy`, and
    effective policy terms.
  - Added `ThreadReadState` shape, cursor, and API scope to PR 12.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Ninety-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Normalized the PR00 lane inventory worktree cell to the portable
    `current PR00 checkout` label.
  - Updated the Current PR Snapshot to describe the active six-issue rerun fix
    state before the next review.
  - Clarified native filesystem bound sessions so the server derives principal
    and workspace/version binding from opaque session material; clients only
    send the token and explicit operation identifiers.
  - Clarified secret-backed file projection so plaintext is safe by default only
    through protected/ephemeral mounts, brokered APIs, or dohc-controlled
    execution paths; normal local plaintext materialization is opt-in exposure.
  - Expanded PR 21R replication scope to include share grants/revocations,
    membership/visibility, read-state/unread cursors, and first-class replicated
    records when exact reconstruction is not possible.
  - Marked chat thread/link/message/activity provenance actor fields as
    server-owned and immutable in the schema shapes.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundredth pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Marked Channels/DMs as eventual product requirements while keeping Phase 0 to
    the single linked-chat proof and assigning first channel/DM surfaces to PR
    12/13.
  - Assigned `.dohc/visibility.toml` parsing/enforcement to PR 04 alongside
    `.dohc/files.toml`.
  - Clarified reserved-namespace canonicalization so only trusted policy inputs
    (`.dohc/files.toml`, `.dohc/visibility.toml`, and optional workspace-root
    `.dohcignore`) bypass `.dohc/**` quarantine as source-backed requests.
  - Split `WriteResult` rejected-before-acceptance and quarantined-after-
    acceptance lifecycles into distinct `rejected` and `quarantined` variants.
  - Made stale idempotent retries return one canonical terminal write response,
    with disposition/expiration/lookup-only details moved to status queries.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-first pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Reframed Current PR Snapshot as a non-authoritative orientation summary and
    pointed source-of-truth status to the newest owning PR00 pass entry.
  - Updated the snapshot to identify the `935bbd6` five-issue review rerun.
  - Changed Channel attachment wording so `WorkspaceObject` is treated as the
    existing shared substrate/package contract, not a future roadmap-only type.
  - Narrowed P0E to a workspace-local file-linked chat thread, leaving channel
    and DM surfaces to PR 12/13.
  - Made `ThreadMessage.parentMessageId` immutable after `message_created`, with
    any future reparenting requiring a dedicated replayed activity.
  - Added server-derived `authzScopeId` to mention notification activity and the
    deterministic `notificationId` key so shared/redacted scopes cannot collide.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-second pass:

- Fixed CodeRabbit follow-up findings from the latest rerun:
  - Replaced legacy named-chat wording with neutral user-visible agent chats
    terminology.
  - Changed Current PR Snapshot `Last updated` to derive from the newest owning
    pass entry instead of carrying a literal date that can become stale or
    future-looking.
  - Defined canonical `UInt64DecimalString` encoding and BigInt-safe comparison
    for `WorkspaceAsyncPayload.sequence`.
  - Clarified `.env` sync semantics so `synced` means encrypted/opaque secret
    reference or blob replication, not plaintext replication or server-side
    plaintext hydration.
  - Made mention `notificationId` canonical across runtimes with percent-encoded
    components, literal separators, canonical `bodyRevision`, canonical mention
    actor JSON, and lowercase hex SHA-256 hashing.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-third pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Made `rejected` and `quarantined` `WriteResult` variants use required
    `versionId`, matching the replay/status contract for holding records.
  - Removed hardcoded commit/issue state from Current PR Snapshot so CodeRabbit
    status derives from the newest owning PR00 pass entry.
  - Restored `.env` table values to the supported `FilePolicy` vocabulary while
    clarifying in prose that `synced: true` means encrypted/opaque secret sync
    and `materialized: local` does not imply default plaintext exposure.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Normalized `WriteResult` so `kind` is the public variant discriminator and
    variant-specific substates use `pendingState`, `rejectionState`,
    `quarantineState`, and `conflictState` instead of a second generic `status`
    discriminator.
  - Updated Current PR Snapshot to mirror the `2eefeb9` three-issue rerun and
    hundred-fourth pending-fix state.
  - Narrowed shared-channel redaction so unshared links are hidden, while
    explicitly shared links and work references stay visible only while their
    server-side grant remains valid for the viewer and redaction scope.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Trimmed Phase 0 proof-arc identities to the file/version/chat loop and moved
    channels, agent runs, and shares back to deferred substrate identities.
  - Clarified P0E chat contracts as shared substrate package contracts and the
    first cut of the final `ChatThread`, `ThreadMessage`, and `ThreadLink`
    shapes.
  - Consolidated reserved namespace handling into the first canonical block and
    made path canonicalization cross-reference that contract.
  - Marked `.env` `materialized: local` as an opt-in protected local projection,
    not default secret exposure.
  - Standardized DM duplicate handling to reject duplicate participants before
    canonical participant set/key generation.
  - Replaced sentinel/prefix `CanonicalThreadLinkKey` serialization with a
    collision-free framed tuple plus canonical JSON and SHA-256 helper used by
    link creation, upserts, and projections.
  - Made mention notification lifecycle state required on every mention
    notification activity.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Made `terminal-retired` and `idempotency-expired` `WriteResult` variants
    carry required `versionId` for deterministic routing and audit.
  - Aligned DM participant canonicalization so duplicate canonical participants
    are always rejected rather than silently deduped.
  - Split PR 21R into independently reviewable milestones for replication
    transport/replay ordering, machine-to-machine state replication, projection
    invalidation/rebuilds, offline rejoin conflicts, and secret redaction.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Added stable `ChatThreadBase.createdById` and clarified `createdBy` as a
    display label only.
  - Made `nextBodyHash` and `tombstoneHash` required on normal message
    create/edit/delete activities.
  - Added retry-safe idempotency rules for `create_chat`, `reply_to_chat`,
    `edit_chat_message`, `delete_chat_message`, and `link_chat_to_work`.
  - Added the PR 12 migration/backfill requirement for provisional shared
    substrate chat contracts.
  - Replaced vague docs link tooling guidance with the mandatory
    `node scripts/check-think-bigger-doc-links.mjs` command.
  - Updated Remaining Risk to reflect pending lane approval/reruns rather than
    unassigned P0 ownership.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Made the docs link checker skip fenced code blocks and generate duplicate
    heading anchors as `base`, `base-1`, `base-2`, matching markdown behavior.
  - Added conflict replay tokens and durable idempotency handling for
    `WriteResult.kind: 'conflict'`.
  - Froze the P0E provisional chat schema as a versioned shared-substrate
    boundary before PR 12/18 consumption.
  - Clarified that pinned non-materialized subtrees are represented as
    `materialized: 'virtual'` plus `pinned: true`.
  - Reworded native filesystem saves as immediate local capture followed by
    canonical quarantine/reconcile/promote validation.
  - Made thread-link target resolution scope-aware by keying resolvers on
    `(scopeKind, ThreadLinkTargetType)` or the full canonical link tuple.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest eight-issue rerun:
  - Updated Current PR Snapshot to mirror the `ff29e88` eight-issue rerun and
    hundred-ninth pending-fix state.
  - Updated the docs link checker to respect fenced-code delimiter length and to
    validate same-document `#fragment` links.
  - Added bytewise UTF-8 `messageId` comparison to the read-cursor comparator.
  - Tightened chat projection scope into a canonical tagged tuple with fixed
    percent-encoding before digest generation.
  - Defined canonical policy source ordinal for equal-specificity policy
    conflicts.
  - Restricted environment-variable secret injection to explicitly approved
    low-sensitivity secrets and preferred brokered files, fds, or ephemeral
    mounts for higher-sensitivity secrets.
  - Updated the native filesystem proof slice to describe immediate capture
    followed by quarantine/reconcile promotion before canonical history updates.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-tenth pass:

- Fixed CodeRabbit follow-up findings from the latest nine-issue rerun:
  - Made the docs link checker accumulate missing source files and invalid
    percent-encoded link targets as validation failures instead of throwing.
  - Added retryable `gate_indeterminate` and `service_unavailable` denial reason
    codes for transient evaluator/gate failures.
  - Clarified historical command ordering so validation evidence precedes push
    and PR creation in the PR00 command list.
  - Clarified that P0E seeds provisional chat/link scaffolding while PR 01
    formalizes the shared contract boundary before PR 12/18 consume it.
  - Added client-visible `durable-pending` semantics for accepted local capture
    that has not yet promoted to canonical history.
  - Clarified `rename` versus `move` as names over the same atomic path-change
    primitive with distinct preferred use.
  - Defined canonical `messageId` form for read-cursor comparison and canonical
    inputs for chat body/tombstone hashes.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eleventh pass:

- Fixed CodeRabbit follow-up findings from the latest two-minor-issue rerun:
  - Added fenced-code-aware link collection to
    `scripts/check-think-bigger-doc-links.mjs` so example markdown no longer
    creates false link/anchor failures.
  - Normalized the recorded Node 24 extraction directory and validation PATH to
    `/tmp/dohc-node-v24.18.0`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twelfth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Required docs link targets to resolve to regular files and decoded link
    fragments before anchor comparison.
  - Added the P0D provisional `ConflictRecord` shape with preserved
    base/current/incoming snapshots and an explicit PR 01 migration boundary.
  - Tightened async read/watch contracts so stale responses are aborted or
    dropped server-side, with callers still defending against late responses.
  - Pinned chat message, activity, and read-state timestamps to server time.
  - Clarified the chat proof slice as channel-thread get-or-create plus
    `ThreadMessage` persistence, not one new `ChatThread` per send.
  - Updated the Current PR Snapshot to the `84a6bda` seven-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirteenth pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Resolved the docs link checker from the script's repo root instead of the
    caller's current working directory.
  - Rewrote chat decimal-string canonicalization into a continuous
    parse/range-check/reserialize-before-use boundary requirement.
  - Required repeated idempotency keys to resolve to the original operation and
    reject changed payloads, operand tuples, or causal preconditions.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`, confirming repo-root-stable path resolution.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fourteenth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Constrained docs link targets under the checker repo root before `stat` or
    file reads.
  - Added `pending_review` to durable pending writes and separated
    `service_unavailable` into a retryable non-denial `WriteResult`.
  - Clarified rich-document Markdown/Y.Doc projection saves so benign
    serializer normalization is not treated as conflict.
  - Tightened secret-backed conflict envelopes to expose keyed commitments, not
    raw hashes, by default.
  - Required ordinary local writes to attach to a server-derived principal
    before leaving quarantine and promoting to canonical history.
  - Added a branded `DmParticipantIds` canonicalization path with the shared
    2-16 participant constraint before persistence or uniqueness-key generation.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`, confirming repo-root-stable path resolution and
    root containment.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifteenth pass:

- Fixed CodeRabbit follow-up findings from the latest five-issue rerun:
  - Added the missing `UInt64DecimalString` alias used by retryable failure
    `retryAfterMs`.
  - Factored fenced-code skipping into a shared `contentLines` helper and made
    anchor comparison use the same slug normalization as collected headings.
  - Assigned the provisional chat schema freeze to P0E only, with PR 01
    consuming that frozen substrate instead of introducing parallel schemas.
  - Narrowed shared-channel grant revoke/expiry cleanup to derived caches and
    projections while preserving durable audit/history/export records.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixteenth pass:

- Fixed CodeRabbit follow-up findings from the latest four-issue rerun:
  - Added explicit retryable-failure idempotency replay fields and commit-state
    reporting so retries can dedupe safely when commit state is unknown.
  - Reworded save-path and ingest evaluator failures so substantive decisions
    deny/quarantine, while unavailable or indeterminate evaluators return a
    retryable no-mutation outcome.
  - Added `secretProjection` beside `materialized` so protected local secret
    projections and ordinary plaintext hydration are represented distinctly in
    schema, status/UI serialization, and agent-readable views.
  - Updated the Current PR Snapshot to the `30c2887` four-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventeenth pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Made PR 07 explicitly generalize the P0D-owned compare/merge/conflict
    contract instead of defining overlapping ownership.
  - Added anchor caching to the docs link checker and reused the current file's
    parsed anchors for self-links.
  - Updated heading slug normalization to handle inline link/image visible text
    and avoid collapsing repeated hyphens.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighteenth pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Moved `quota_exceeded` and `rate_limited` from terminal denial reasons into
    retryable failure reasons.
  - Made holding-record retries derive responses from the record's current
    durable state rather than only the original replay window.
  - Fixed chat timestamp canonicalization to use one shared
    `UnixMsDecimalString` range with platform-specific bounds left to
    translation layers.
  - Updated docs-link slugging so every whitespace character maps to a hyphen
    instead of collapsing runs.
  - Split `FilePolicy` into non-secret and secret-backed variants so
    secret-backed policies require a concrete `secretProjection`.
  - Updated the Current PR Snapshot to the `76f6a25` six-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-nineteenth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Tightened docs-link fenced-code handling so only valid closing fences close
    an active fence, and preserved literal trailing heading `#` characters.
  - Generalized `idempotency-expired` to cover canonical results, retryable
    failures, and conflict records without holding records.
  - Added secret-safe quarantine storage rules for secret-eligible captures
    before classification and policy checks finish.
  - Added `secretProjection` to the policy summary matrix.
  - Defined server-issued deterministic non-default `channelConversationId`
    values for channel chat threads.
  - Added persisted `bodyHash` to message lifecycle activities for replay,
    export, and mention verification.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twentieth pass:

- Fixed CodeRabbit follow-up findings from the latest four-issue rerun:
  - Preserved retryable-failure commit uncertainty by allowing
    `recordedAsCanonicalMutation: 'unknown'`.
  - Split Phase 0 into strict must-pass gates and stretch/follow-up outcomes.
  - Added a docs CI/workflow requirement to run
    `node scripts/check-think-bigger-doc-links.mjs` on every docs PR.
  - Updated the Current PR Snapshot to the `40b1ca9` four-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-first pass:

- Fixed CodeRabbit follow-up findings from the latest nine-issue rerun:
  - Clarified opening write-outcome terminology so `durable-pending` means
    accepted-but-not-canonical and `retryable-failure` means evaluator outage or
    indeterminate state.
  - Allowed retryable-failure replay to later prove canonical mutation by using
    `recordedAsCanonicalMutation: true | false | 'unknown'`.
  - Pointed Phase 0 decision notes and blockers at the exact execution-log file.
  - Kept PR 00 as docs/readiness setup and moved Foundation alpha proof wording
    to PR 01-04.
  - Marked `ThreadMessage.id`, `editedById`, and `deletedById` as
    server-assigned identity fields and required authorization before parent
    existence lookup.
  - Added Unicode NFC normalization before reserved namespace checks in
    filesystem path canonicalization.
  - Added the required `.env.team` `secret_projection` example field.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-second pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Made `commitState` the single source of truth for retryable-failure canonical
    commit state.
  - Added conflict envelopes, conflict replay tokens, and idempotency results to
    the workspace-scoping invariant.
  - Skipped inline code spans during docs link collection.
  - Defined `.dohcignore` policy precedence by normalizing it into the
    `.dohc/files.toml` source-order band.
  - Added async workspace/request-token gating to the required Phase 0 decision
    note.
  - Updated the Current PR Snapshot to the `743f8cc` six-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-third pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Added canonical idempotency replay envelope fields to `WriteResult.kind:
    'canonical'`.
  - Reworked accepted holding-record retention so reconstructable payloads retire
    only through explicit operator disposition or workspace policy with a
    documented recovery SLA.
  - Made `.dohcignore` an alias within the `.dohc/files.toml` source-order band
    in the canonical policy ordinal list.
  - Aligned chat create/reply mutation contracts with server-assigned
    `threadId`/`messageId` idempotency results.
  - Scoped the docs CI/workflow link check to the Think Bigger docs covered by
    `scripts/check-think-bigger-doc-links.mjs`.
  - Updated docs-link slugging to preserve underscores and non-ASCII characters.
  - Updated the Current PR Snapshot to the `8298c32` seven-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Decoded HTML entities before docs-link slug comparison.
  - Made `retryable-failure.idempotencyKey` required and clarified that
    `terminal-retired` bypasses `idempotency-expired`.
  - Converted source spec references into Markdown links covered by the checker.
  - Clarified that P0G local-agent CLI validation remains a required
    implementation E2E gate; only PR00 has a docs-only exception.
  - Marked chat `authorKind` server-assigned and rejected client-supplied
    `authorId`/`authorKind` alongside other server-owned message identity
    fields.
  - Reworded the Current PR Snapshot to derive live status from the newest pass
    entry instead of hardcoding SHA/count values.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-fifth pass:

- Fixed CodeRabbit follow-up finding from the latest one-issue rerun:
  - Made docs-link duplicate heading anchors unique against final emitted anchor
    values, so literal suffixed headings cannot collide with generated duplicate
    anchors.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Made PR 14 UI-only over the PR 12-owned canonical `ThreadLink` contract.
  - Replaced the mutable Current PR Snapshot details with a pointer to the newest
    owning PR00 pass entry.
  - Tightened `.dohc/**` wording so allowlisted policy inputs are parsed as
    engine policy, not normal captured content.
  - Reworded materialization so only `local` and `virtual` are persisted states,
    with `pinned` as an orthogonal flag.
  - Clarified broader channel attachment concepts as mappings to supported
    `ThreadLinkTargetType` values unless new enum/resolver support is added.
  - Added the server-side `channelConversationId` get-or-create minting rule.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 files.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 files from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest nine-issue rerun:
  - Added the shared idempotency replay envelope to replayable `WriteResult`
    variants and removed `canonical_commit_recorded` from retryable failures.
  - Redacted secret-backed reserved-namespace quarantine and safe-rename records.
  - Required serialized `chat_thread` cycle checks before `link_added` fanout.
  - Added `deleteReason` text-safety rules for history/export/projection
    surfaces.
  - Reworded the docs CI/workflow requirement around manifest/glob target
    discovery for Think Bigger docs.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Removed duplicated retryable-failure replay fields.
  - Added paginated `list(...)`/`search(...)` contracts and stable object IDs on
    read/stat/list lookup responses.
  - Made chat idempotency reservation atomic with mutation writes and documented
    retention/expiry behavior.
  - Renamed the source spec link to `dohc Native Filesystem Design`.
  - Populated Current PR Snapshot with concrete latest PR00 status.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-twenty-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Added exact expected Think Bigger docs coverage to the docs link checker so
    it cannot silently pass after checking zero or too few files.
  - Replaced the old embedded docs-link command record with the hardened shared
    checker script.
  - Split engine-state quarantine from user-content safe-rename handling for
    `.dohc/**` and unmanaged `.versions/**` collisions.
  - Required encrypted payload envelopes for secret-eligible quarantine writes
    that captured payload bytes.
  - Added storage-level active-link uniqueness enforcement for
    `CanonicalThreadLinkKey`.
  - Pinned shared TypeScript boundary validation to Zod.
  - Updated the Current PR Snapshot to the `03e7634` seven-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirtieth pass:

- Fixed CodeRabbit follow-up findings from the latest seven-issue rerun:
  - Added `terminal_retired_record` to expired retry records and aligned
    `terminal-retired` replay lifecycle wording.
  - Normalized discovered checker paths to POSIX repo-relative strings and
    ignored variable-length inline code spans during Markdown link collection.
  - Required full path normalization for separators, dot segments, traversal,
    and platform device/UNC escape forms before path policy checks.
  - Extended async freshness guards to paginated `list(...)` and `search(...)`
    payloads with workspace/version/request/page-token validation.
  - Surfaced `durable-pending`, quarantined, rejected, retryable, and retired
    write states in filesystem status projections.
  - Added Versioning and Filesystem reviewers to the PR01 subagent lane.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-first pass:

- Fixed CodeRabbit follow-up findings from the latest four-issue rerun:
  - Added a finite maximum recovery-retention path for accepted holding records
    so unresolved durable-pending payloads eventually become terminal-retired
    evidence instead of remaining unbounded.
  - Added a stable `Idempotency Retry Horizons And WorkspaceIdempotencyPolicy`
    contract heading for the retry-horizon source section.
  - Made docs link target validation resolve symlinks before repository-boundary
    checks.
  - Replaced the execution-log `Last updated` ordinal with a generic newest-pass
    pointer.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-second pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Added missing Markdown spacing before the
    `Idempotency Retry Horizons And WorkspaceIdempotencyPolicy` heading.
  - Made Think Bigger docs discovery tolerate missing directories and report the
    expected-docs validation failure instead of a raw `ENOENT` stack.
  - Added baseline machine/CI profile, cold/warm fixture state, measured values,
    variance/tolerance, and explicit non-sensitive override approval references
    to required PR/phase execution-log records.
  - Reflowed the native filesystem bound-session paragraph.
  - Marked `ThreadActivityBase.actorKind` as readonly server-owned provenance.
  - Updated the Current PR Snapshot to the `da8c1d6` six-issue rerun.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-third pass:

- Fixed CodeRabbit follow-up findings from the latest four-issue rerun:
  - Included `retryable-failure` in non-canonical durability acknowledgments.
  - Required exact decoded fragment matching in the Think Bigger docs link
    checker instead of re-slugging link fragments.
  - Made the Current PR Snapshot delegate CodeRabbit status to the newest owning
    PR00 pass entry instead of hardcoding commit/count values.
  - Removed provider-specific product names from local-agent QA prose while
    preserving the disposable-workspace and unsafe-sandbox exception evidence.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-fourth pass:

- Fixed CodeRabbit follow-up findings from the latest two-issue rerun:
  - Collapsed the Current PR Snapshot into a pointer to the newest owning PR00
    pass entry plus the stable draft PR link.
  - Replaced a machine-specific checker evidence path with the portable
    `<repo-root>` placeholder.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-fifth pass:

- Fixed CodeRabbit follow-up findings from the latest five-issue rerun:
  - Kept `.env` ignored/excluded/redacted by default until PR 08 introduces
    secret-backed files.
  - Reworded the shared validation plan so Zod is the current TypeScript source
    while Rust/bridge consumers use explicit round-trip adapters or schema
    generators.
  - Split malformed request/replay metadata errors into non-persistent validation
    errors instead of durable denied/quarantined write results.
  - Tightened reserved namespace handling so unmanaged `.dohc/**` and
    `.versions/**` collisions remain quarantine/manual-resolution only.
  - Added explicit `decision` and `task` `ThreadLinkTargetType` values.
  - Removed mutable CodeRabbit issue counts from the historical CodeRabbit
    section.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-sixth pass:

- Fixed CodeRabbit follow-up findings from the latest eight-issue rerun:
  - Added a deterministic holding-record replay outcome matrix that treats stale
    causal state as conflict, not quarantine.
  - Added durable side-effect outbox/ledger requirements to idempotent write
    handling.
  - Marked retry-horizon numeric baselines as deferred/TBD until the PR 01 shared
    `WorkspaceIdempotencyPolicy` contract lands.
  - Added native-filesystem late-retry fences that survive tombstone compaction or
    namespace rotation.
  - Clarified immutable `ChannelChatThread` context tuples and scoped chat-link
    acyclicity to `chat_thread` edges only.
  - Converted execution-log plan/spec references into checker-visible Markdown
    links.
  - Extended the Think Bigger docs link checker to collect reference-style links,
    autolinks, and angle-bracket destinations outside code spans.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-seventh pass:

- Fixed CodeRabbit follow-up findings from the latest four-issue rerun:
  - Split `idempotency-expired` into holding-record and non-holding-record
    variants so holding-record expirations always carry `holdingRecordId`.
  - Expanded inline link parsing to handle empty labels and single-quoted or
    parenthesized titles.
  - Aligned `LinkThreadActivity.linkTarget.targetVersionRef` with canonical null
    representation.
  - Removed duplicated chat projection-path mechanics from the chat spec and
    replaced them with a pointer to the native filesystem projection writer
    contract.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-eighth pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Added a source-file `isFile()` guard before docs checker reads.
  - Made the Think Bigger docs checker use a checked-in manifest and fail when
    manifest entries diverge from repository inventory.
  - Reworded PR00 scope so the execution log is the only status/checklist
    tracker for progress, blockers, and evidence.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-thirty-ninth pass:

- Fixed CodeRabbit follow-up findings from the latest five-issue rerun:
  - Expanded idempotency replay mismatch checks to every scoped binding, not only
    payload/operand/precondition fields.
  - Split malformed replay metadata from already-persisted unresolved records in
    the holding-area replay matrix.
  - Added Setext heading and shortcut-reference support to the Think Bigger docs
    checker.
  - Redacted protected/secret path values in filesystem durability logs.
  - Added deterministic timestamp-alias handling for restore checkpoint lookup.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fortieth pass:

- Fixed CodeRabbit follow-up findings from the latest five-issue rerun:
  - Added provenance/attribution/proof failures to durable denial/quarantine
    scope while keeping server-side authorization explicit.
  - Added chat mutation side-effect outbox/ledger requirements for notifications,
    search, export/history fanout, projection invalidation, and fanout recovery.
  - Made docs heading slugging strip underscore emphasis markers and made numeric
    HTML entity decoding tolerate invalid code points.
  - Hardened `.dohc/**` internal-state denial for export, search, sync,
    import-as-user-content, generated projections, and durability internals.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-first pass:

- Fixed CodeRabbit follow-up findings from the latest three-issue rerun:
  - Added provenance/attribution/proof denial and quarantine enum values.
  - Filtered raw HTML closing tags out of docs-checker autolink collection.
  - Added concrete `DecisionThreadLink` and `TaskThreadLink` variants plus
    resolver authorization requirements.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-second pass:

- Fixed CodeRabbit follow-up findings from the latest six-issue rerun:
  - Added explicit `visibility_denied`/`quarantined_visibility` outcomes to the
    versioned workspace write and replay contracts.
  - Made chat tombstones terminal for `message_edited`, with no body revision,
    activity, projection, search, notification, or summary update after delete.
  - Aligned chat search coverage with Phase 0 linked-work identities by including
    folders and tasks in the search target list and search pipeline contract.
  - Required native filesystem export to preserve the policy envelope needed to
    re-import secret-backed versus non-secret files without changing semantics.
  - Added the explicit Phase 0 gate before Foundation alpha PR 01-04 work.
  - Replaced the remaining Zod-authority wording with a language-neutral
    contract/IDL source of truth and generated/conformance-tested consumers.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-third pass:

- Fixed CodeRabbit's remaining minor docs-CI finding:
  - Added `.github/workflows/think-bigger-docs.yml` with a pinned checkout,
    pinned Node setup, and `node scripts/check-think-bigger-doc-links.mjs`.
  - Named that workflow in the PR00 plan scope so the CI hook is explicit.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-fourth pass:

- Fixed CodeRabbit's seven follow-up findings from the workflow/spec rerun:
  - Widened the Think Bigger docs workflow path filters to directory-level
    plan/spec doc matches while keeping workflow, manifest, and checker triggers.
  - Added visibility to the versioned workspace durable denial/quarantine
    classification text.
  - Made PR 01 carry forward and extend P0D's `ConflictRecord` contract instead
    of defining an unrelated new conflict type.
  - Clarified chat lifecycle `bodyHash` semantics for create/edit resulting body
    revisions versus delete preserved previous-body and tombstone verification.
  - Required one workspace-wide path-equivalence profile for native filesystem
    canonicalization and reserved-namespace checks.
  - Classified editor temp-file-then-rename saves as overwrite-renames that map
    to `replace(...)` rather than plain `rename(...)` or `move(...)`.
  - Updated the PR00 plan text to name directory-level workflow coverage.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-fifth pass:

- Fixed CodeRabbit's three low-severity follow-up findings:
  - Removed the hardcoded Think Bigger spec-name fragment list from the docs link
    checker and derived candidates from the manifest's directories plus
    manifest/content relationship checks.
  - Updated the P0A inventory row to match the broader minimal
    storage/filesystem smoke and focused-package validation shape.
  - Reworded the Phase 0 proof gate so File/API writes durably capture
    immediately, while canonical promotion remains validation-gated.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-sixth pass:

- Fixed CodeRabbit's ten follow-up findings:
  - Replaced content-driven docs discovery with deterministic root/path rules and
    kept the manifest as the expected-set comparator.
  - Added holding/non-holding `idempotency-expired` discriminants and centralized
    expired record-kind aliases.
  - Clarified `rename(...)` versus `move(...)` semantics in the versioned
    workspace API and routed destination-present path changes to `replace(...)`.
  - Standardized `reconstructible` terminology in the holding-record lifecycle.
  - Added a dedicated `message_restored` activity and restore cache/projection
    lifecycle to the chat activity model.
  - Replaced native filesystem `VersionRef` wording with `versionId`.
  - Added the PR 01 Chats Reviewer, narrowed cross-workspace share wording, and
    converted PR links to Markdown link syntax.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-seventh pass:

- Fixed CodeRabbit's five follow-up findings:
  - Made the docs checker skip indented Markdown code blocks in addition to
    fenced code blocks.
  - Narrowed spec discovery to the explicit Think Bigger source-spec cohort.
  - Added a shared `VersionRef` definition and canonical serialization rule to
    chat thread link and link-activity contracts.
  - Clarified that the Think Bigger docs workflow is manifest-driven and runs for
    doc path changes, renames, and manifest updates.
  - Reworded PR 01 so the language-neutral contract/IDL is the single canonical
    schema source and TypeScript/Rust contracts are generated or
    conformance-tested consumers.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-eighth pass:

- Fixed CodeRabbit's four follow-up findings:
  - Added `quarantined_locked`, `quarantined_version_access`, and
    `quarantined_skill_turn` to the internal write-gate failure taxonomy.
  - Made native filesystem accepted-but-not-promoted state consistently surface
    as `durable-pending`, with no separate `accepted-pending` status.
  - Made chat activity ids server-assigned and unique within workspace/thread
    scope.
  - Made `ThreadLink.deletedById` server-owned and populated only from the
    canonical `link_removed` activity.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-forty-ninth pass:

- Fixed CodeRabbit's six follow-up findings:
  - Removed path filters from `.github/workflows/think-bigger-docs.yml` so linked
    target moves/deletions outside docs still run the checker.
  - Updated PR00 plan wording so the docs workflow explicitly covers
    plan/spec/execution-log edits, manifest updates, renames, and linked target
    moves.
  - Split non-persistent validation failures from durable `rejected` and
    `quarantined` holding-record paths in the versioned workspace spec.
  - Removed `authzScopeId` from mention notification identity while keeping it as
    server-issued projection/fanout context.
  - Expanded migration cutover scope to include versions, chats, messages,
    search-index entries, exports, and projections.
  - Marked deferred agent run events as provisional history/search references
    with a stable surrogate key until first-class promotion.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fiftieth pass:

- Fixed CodeRabbit's four follow-up findings:
  - Made DM participant canonicalization take the server-derived actor
    separately and merge it before uniqueness-key generation.
  - Added the full operation operand tuple to native filesystem idempotency
    identity.
  - Deferred workspace-root `.dohcignore` until a policy resolver PR owns
    implementation and enforcement.
  - Narrowed the Foundation Alpha effective-policy gate to files, search, and
    export substrate.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-first pass:

- Fixed CodeRabbit's six follow-up findings:
  - Added Think Bigger cohort metadata to the three source specs and made the
    docs checker discover specs by that metadata instead of an explicit filename
    list.
  - Preserved indented nested list items while still skipping true indented code
    blocks in the docs checker.
  - Added a concrete `canonicalizeDmParticipantIds` helper signature with
    server-derived actor input.
  - Clarified `ChannelChatThread` identity so creation context determines
    `channelConversationId` and later `ThreadLink` metadata changes do not mutate
    it.
  - Made provisional agent-run surrogate keys use immutable source identifiers,
    with `createdAt` as metadata only.
  - Expanded the historical docs-check evidence to name the exact five PR00 docs,
    including this execution log.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-second pass:

- Fixed CodeRabbit's three follow-up findings:
  - Made unresolved reference-style links produce checker failures instead of
    being silently skipped.
  - Made the Current PR Snapshot self-contained with live CodeRabbit, validation,
    open-override, and completion-state fields.
  - Removed the duplicate `canonicalizeDmParticipantIds(rawActorIds: string[])`
    declaration so only the server-aware helper signature remains.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-third pass:

- Fixed CodeRabbit's ten follow-up findings:
  - Restored path filters on the Think Bigger docs workflow so unrelated PRs and
    pushes do not run the docs job.
  - Kept nested-list continuation prose eligible for docs link checking while
    still skipping true indented code blocks.
  - Skipped any valid absolute URI scheme in the docs checker instead of only a
    few hard-coded schemes.
  - Added the retryable conflict-persistence fallback with
    `commit_state_unknown_retry_required`.
  - Made retry-horizon numeric ownership strictly reference-only in PR00, with
    PR 01's `WorkspaceIdempotencyPolicy` as the sole numeric source of truth.
  - Added `canonical_commit_recorded` to the retryable write `commitState`
    vocabulary and named it in the prose.
  - Split Phase 0 success criteria into must-pass, demo-only, and future-phase
    buckets.
  - Added the early Phase 0 shared-substrate baseline freeze before P0B/P0D/P0E.
  - Added one authoritative native-filesystem `WriteResult.kind` outcome map.
  - Extended chat mutation idempotency/replay/outbox semantics to reactions,
    read-state updates, summaries, and worker-owned mutations.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-fourth pass:

- Fixed CodeRabbit's eight follow-up findings:
  - Changed the Think Bigger docs workflow path filters from fixed document
    filenames to manifest/checker-aligned patterns for Think Bigger plan docs
    and spec docs.
  - Expanded `PublicValidationErrorCode` so malformed requests, missing or
    incompatible preconditions, invalid paths, invalid versions, and replay
    metadata mismatches are explicit validation outcomes.
  - Updated the immediate-save predicate so policy/review gates must pass before
    the fast path can become canonical.
  - Taught the docs checker to skip code blocks nested inside list items while
    still checking normal list-continuation prose.
  - Updated the Current PR Snapshot to point at the newest pass state.
  - Extended native-filesystem status projections to include `conflict`,
    `idempotency-expired`, and canonical status mapping alongside other
    `WriteResult.kind` outcomes.
  - Added the forged actor/workspace/version bridge-auth negative test directly
    to P0R, P0F, and P0G test gates.
  - Clarified that the Phase 0 shared-substrate baseline is provisional and
    Phase 0-owned, while PR 01 remains the final schema source with an explicit
    migration/backfill boundary.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-fifth pass:

- Fixed CodeRabbit's five follow-up findings:
  - Named `Phase0SharedSubstrateBaseline` as the single provisional Phase 0
    source of truth for shared substrate shapes, and pointed P0D, P0E, and PR 01
    to that owner.
  - Made Think Bigger cohort metadata discovery tolerate the current cohort name
    and a `dohc`-prefixed variant while retaining manifest validation.
  - Replaced the mutable Current PR Snapshot status bullets with a pointer to
    the newest owning PR00 pass entry.
  - Standardized chat activity identity on `activityId` in both append-only log
    prose and `ThreadActivityBase`.
  - Clarified DM participant canonicalization so client-supplied self entries
    are stripped before duplicate checks, while duplicate non-self participants
    still fail closed.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-sixth pass:

- CodeRabbit rerun emitted two findings, then exceeded the healthy no-output
  window and was stopped before a complete event. The emitted findings were
  treated as actionable and fixed:
  - Required `retryable-failure` write results to durably persist the
    idempotency result state before acknowledgement.
  - Made the docs checker reject literal empty Markdown link destinations like
    `[label]()` while preserving normal `#anchor` links.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-seventh pass:

- Fixed CodeRabbit's two follow-up findings:
  - Made `canonical` a required status projection once a captured write has
    promoted into history.
  - Aligned the PR00 plan with the workflow's path-filtered trigger model and
    broadened the workflow filter to `docs/superpowers/**` so superpowers doc
    renames and linked-target moves run the manifest-backed checker.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-eighth pass:

- Fixed CodeRabbit's seven follow-up findings:
  - Made the docs checker ignore Markdown footnote definitions and references
    instead of treating them as file reference links.
  - Extended inline-link parsing to accept one level of balanced parentheses in
    destinations.
  - Removed the recorded outcome from the `retryable-failure.commitState`
    semantics and clarified that a later recorded proof returns a canonical or
    durable result instead.
  - Added an explicit visibility-denied propagation note tying
    `visibility_denied` to `quarantined_visibility`.
  - Widened `Phase0SharedSubstrateBaseline` ownership to every later Phase 0
    lane after P0A/P0R.
  - Restored a concise self-contained Current PR Snapshot while keeping the
    newest pass entries as the audit trail.
  - Split the original command evidence block into Setup, Initial Validation,
    Remote PR/review, and Node 24 validation subsections.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-fifty-ninth pass:

- Fixed CodeRabbit's four follow-up findings:
  - Added provenance, attribution, and proof to holding-area replay
    revalidation and durable outcome classification.
  - Updated the Current PR Snapshot to the latest four-finding review batch.
  - Strengthened `Phase0SharedSubstrateBaseline` gating so P0B-P0G cannot start
    implementation branches until the provisional baseline is finalized.
  - Made DM duplicate handling explicit: all client-supplied self entries are
    stripped before duplicate checks, while duplicates among non-self requested
    participants fail closed.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixtieth pass:

- Fixed CodeRabbit's five follow-up findings:
  - Made docs discovery include manifest-listed source specs directly while
    retaining cohort-metadata discovery for new specs.
  - Updated the Current PR Snapshot to the latest five-finding review batch.
  - Normalized native filesystem expiry wording to `idempotency-expired`.
  - Aligned the roadmap milestone so the provisional baseline freeze blocks
    P0B, P0C, P0D, P0E, P0F, and P0G until the shared substrate baseline lands.
  - Added `(workspaceId, threadId)` to tuple-mode reaction idempotency keys.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-first pass:

- Fixed CodeRabbit's seven follow-up findings:
  - Separated API write preconditions from engine-owned filesystem
    capture/replay tokens.
  - Added provenance, attribution, and proof denial/quarantine coverage to the
    first-proof E2E checklist.
  - Clarified that chat `messageId` values are opaque exact persisted strings
    and must not be Unicode-normalized as text.
  - Separated mention notification aggregate `notificationId` from per-activity
    `activityId` lifecycle entries.
  - Removed manual reconciliation as a native filesystem result state and mapped
    manual follow-up to metadata on `conflict` or `quarantined`.
  - Clarified explicit user override precedence in policy resolution.
  - Extended docs anchor slug normalization to strip common Unicode punctuation
    ranges.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-second pass:

- Fixed CodeRabbit's six follow-up findings:
  - Added explicit holding-record deadline precedence for replay, pending
    canonicalization, operator disposition, and recoverable payload retention.
  - Defined clean Markdown/Y.Doc projection round-trip criteria and semantic
    conflict handling.
  - Clarified chat body hash normalization so opaque IDs hash exactly as stored.
  - Required ThreadLink tombstones to release or supersede active-link
    reservations so future relinks can succeed.
  - Made cross-mount `rename(...)` and `move(...)` fail closed without copy/delete
    fallback.
  - Added `Override approval reference` to the execution-log CodeRabbit template.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-third pass:

- Fixed CodeRabbit's eight follow-up findings:
  - Clarified one API precondition per guarded operand for multi-operand writes.
  - Removed the impossible `canonical_commit_recorded` retryable commit state.
  - Generalized Think Bigger docs discovery to future dated plan filenames and
    the current shared cohort label.
  - Normalized retired-namespace retry wording to `idempotency-expired`.
  - Changed the Current PR Snapshot to derive mutable fields from the newest pass
    entry instead of embedding a stale finding count.
  - Made Phase 0 chat-schema ownership and the Phase 0 -> PR 01 -> PR 12
    migration handoff explicit.
  - Converted PR00 artifact references to Markdown links so the docs checker
    validates them.
  - Scoped mention notification resolve dedupe by lifecycle event rather than
    suppressing resolve by the enqueue aggregate `notificationId`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-fourth pass:

- Fixed CodeRabbit's six follow-up findings:
  - Added first-save bootstrap semantics for engine-owned filesystem
    capture/replay tokens.
  - Centralized Phase 0 substrate ownership in `Phase0SharedSubstrateBaseline`
    and made P0D/P0E/PR01 consume it instead of redefining symbols.
  - Expanded the PR00 Files Changed inventory to include the manifest, checker,
    and workflow.
  - Clarified PR 01's canonical core IDL authority versus the provisional chat
    overlay.
  - Updated docs checker list parsing to track the actual content column after
    list markers.
  - Made chat-link cycle checks traverse only active links where `deletedAt` is
    absent.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-fifth pass:

- Fixed CodeRabbit's three follow-up findings:
  - Made DM participant canonicalization normalize IDs before stripping
    authenticated self entries and enforcing duplicate/size rules.
  - Split ThreadLink write requests from persisted ThreadLink rows and made
    `shareGrantId`/`visibilityScope` server-populated only.
  - Wrapped Think Bigger manifest read/parse failures with an actionable checker
    error.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-sixth pass:

- Fixed CodeRabbit's two follow-up findings:
  - Made the docs checker skip self-closing HTML tags such as `<br/>`, `<hr/>`,
    and `<wbr/>` during autolink scanning.
  - Clarified that the newest PR00 pass entry owns live status while Current PR
    Snapshot is a derived summary.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-seventh pass:

- Fixed CodeRabbit's two follow-up findings:
  - Tightened Think Bigger cohort discovery to lowercase dohc-branded headers and
    updated the three source spec cohort markers.
  - Narrowed Phase 0 CodeRabbit override wording to documented non-critical
    documentation-only exceptions.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-eighth pass:

- Fixed CodeRabbit's three follow-up findings:
  - Clarified `retryable-failure` commit state semantics for guaranteed no-op
    versus commit-unknown retry handling.
  - Added the `dohc Workspace Engine Docs, Specs, and CI` cohort alias to docs
    discovery.
  - Redacted protected, secret-backed, and engine-managed paths during first
    open/import metadata storage.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-sixty-ninth pass:

- Fixed CodeRabbit's four follow-up findings:
  - Cited the specific PR00 pass that owns the live Current PR Snapshot state.
  - Made Think Bigger docs manifest access null-safe before validating the
    `thinkBiggerDocs` array.
  - Preserved deleted-message `bodyHash` as non-renderable verification metadata
    across authorized legal erasure and made tombstone verification depend on the
    previous body hash rather than re-reading erased body payloads.
  - Aligned reaction API idempotency and lookup with stable reaction identity,
    without coupling add/remove behavior to message or reaction-set revisions.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventieth pass:

- Fixed CodeRabbit's five follow-up findings:
  - Added explicit `quarantined_authorization` durable state mapping for
    replayed or post-acceptance `not_authorized` failures.
  - Made docs-link fence detection list-indent aware so fenced code blocks nested
    under list items are ignored consistently.
  - Scoped filesystem `contentHash` metadata to non-secret or explicitly
    materialized entries, with secret-backed paths returning no hash or an opaque
    authorized hash handle.
  - Split chat link create/export version refs by target kind so versioned links
    require the identifiers needed for their target.
  - Defined the canonical `reactionKey` form used by reaction idempotency,
    replay, export, and import.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-first pass:

- Fixed CodeRabbit's eight follow-up findings:
  - Added deterministic first-match replay precedence for holding-area retry
    failures.
  - Included versions in the Foundation Alpha effective-policy gate evidence.
  - Clarified deterministic agent-run surrogate keys and fail-closed backfill
    behavior.
  - Made link display labels policy-gated/redacted so stored titles and paths do
    not leak hidden targets.
  - Derived `CanonicalThreadLinkKey` server-side for `link_chat_to_work` before
    idempotency reservation.
  - Made DM participant canonicalization reject client-supplied self entries and
    duplicate requested participants consistently.
  - Routed unprovable rename/move/replace topology cases to quarantine or
    validation errors instead of `conflict`.
  - Required `replace(...)` source and destination to stay on the same underlying
    filesystem or mount projection.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-second pass:

- Fixed CodeRabbit's six follow-up findings:
  - Included provenance, attribution, and proof in the headline write-path deny
    gate list.
  - Adjusted docs-link slug whitespace handling to remove non-space whitespace
    instead of hyphenating it.
  - Added a decision-note / unresolved-blocker slot for storage, filesystem,
    secret, merge, and async-gating decisions in the execution-log template.
  - Kept rename/move topology failures inside shared `WriteResult.kind` outcomes
    by routing them through `rejected` or `quarantined`.
  - Extended chat idempotency retention to cover downstream worker recovery and
    durable ledger replay windows.
  - Removed JS-Date-specific timestamp bounds from the shared chat schema.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-third pass:

- Live PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Added the current `Think Bigger dohc Workspace Engine` cohort alias to docs
    discovery.
  - Collapsed duplicated mutable PR00 status into this canonical live-status
    block, leaving the header and unresolved-findings section as pointers only.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-fourth pass:

- Live PR00 status:
  - CodeRabbit status: nine follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's nine follow-up findings:
  - Added `operatorDispositionDueAt` to quarantined write results.
  - Ignored HTML comments in docs-link content scanning.
  - Captured both inner image and outer link destinations for nested image links,
    with in-script fixtures covering comments and nested links.
  - Updated the historical PR00 status note to reference the Current PR Pointer.
  - Made PR 01 the single canonical schema owner for chat/workspace substrate
    symbols, with Phase 0 as provisional fixtures and PR 12 as schema-versioned
    chat extensions.
  - Preserved policy source ordinal and rule index through filesystem export and
    re-import.
  - Clarified that version write access does not bypass path-level policy gates.
  - Moved shares/exports with explicit grants into the current chat link target
    scope.
  - Required shared-channel/shared-grant reauthorization before read-state CAS or
    message existence lookup.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-fifth pass:

- Live PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Made accepted holding payload-retention expiry deterministically transition
    to `terminal-retired` before `replayUntil`, with `idempotency-expired` only
    after `replayUntil`.
  - Made PR 12 the single final owner for `ChatThread`, `ThreadMessage`, and chat
    `ThreadLink`, with PR 01 limited to core substrate plus a provisional bridge.
  - Softened the historical PR00 P0A-P0G stack entry so it is clearly a
    then-current provisional snapshot, not the live status table.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-sixth pass:

- Live PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Clarified that Phase 0 lanes must import provisional baseline symbols from
    the shared substrate package, and that the baseline becomes historical-only
    after PR 01 lands.
  - Prohibited hardlinks in writable/materialized workspace projections so shared
    inodes cannot break path-centric object identity.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-seventh pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Restricted docs-link external scheme bypass to `http`, `https`, `mailto`, and
    `app`, rejecting disallowed schemes.
  - Resolved leading-slash markdown links relative to the repository root rather
    than the host filesystem root.
  - Updated the PR lane inventory note to point at the canonical live-status
    block in the latest PR00 pass.
  - Added `WorkspaceEvent`, `DurabilityEvent`, and `HistoryMoment` to the
    provisional baseline and PR 01 canonical core substrate handoff.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-eighth pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Distinguished durable recording from canonical acceptance in the versioned
    workspace intro.
  - Tightened accepted holding-record retention so payload bytes are not
    compacted/moved at canonicalization deadline, only derived metadata is.
  - Added the `Architecture specs and mega-plan` cohort alias to docs discovery.
  - Replaced repeated schema ownership prose with a single Phase 0 / PR 01 /
    PR 12 ownership matrix and made PR 01/PR 12 entries reference it.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-seventy-ninth pass:

- Live PR00 status:
  - CodeRabbit status: one follow-up finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one follow-up finding:
  - Added explicit replay mapping for protected-path failures:
    `protected_path` externally and `quarantined_protection` internally.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eightieth pass:

- Live PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Added the `Design specs and mega plan` cohort alias to docs discovery.
  - Added `policy` to replay first-match precedence.
  - Split holding-area replay E2E wording for stale CAS conflicts versus invalid
    workspace/version binding validation failures.
  - Changed public export guidance for secret-backed files like `.env` to omit
    them by default or use a non-secret placeholder such as `.env.example`.
  - Broadened chat renderer workspace-token guards to presence, typing,
    read-state, and notification surfaces.
  - Expanded bridge-auth negative tests to cover missing or wrong authenticated
    local-channel binding.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-first pass:

- Live PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Made the Current PR Pointer static so future pass-log updates do not require
    header edits.
  - Reordered replay precedence so auth/visibility/policy gates precede causal
    conflict classification.
  - Added secret-backed discovery redaction for `read`, `stat`, `list`, and
    `search` response contracts.
  - Added `secretProjection: 'none'` for non-secret file policy serialization.
  - Deduped collected doc links before validation.
  - Adjusted slug generation so each remaining space becomes one GitHub-style
    hyphen.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-second pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Moved historical Node 24 validation evidence before remote push/PR/review
    commands.
  - Clarified that generic materialized workspace tree walkers skip `.versions/**`
    by default and only engine-managed version mounts may enter those roots.
  - Distinguished managed engine-owned `.dohc/**` state from foreign
    out-of-contract `.dohc/**` material in reserved-namespace quarantine rules.
  - Broadened shared-channel redaction to thread titles, participant lists,
    inbox/side-rail entries, activity feeds, unread badges, messages, links, and
    references.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script comment/nested-link fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-third pass:

- Live PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Made `retryAfterMs` non-optional for retryable write failures and required
    callers to respect the minimum delay for same-key retries.
  - Added the missing replay mapping from `policy` failures to
    `policy_denied` / `quarantined_policy`.
  - Assigned PR 01 as the single AgentRun identity and replay/backfill contract
    owner, with the stable surrogate key repeated in the ownership matrix.
  - Normalized managed-version path vocabulary to
    `~/dohc/<workspace>/.versions/<version>/` and `.versions/**`.
  - Updated the Think Bigger docs link checker so bracket-index notation such as
    `M[i][j]` or `[1][2]` is not reported as an unresolved reference link while
    real missing reference-style links still fail.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-fourth pass:

- Live PR00 status:
  - CodeRabbit status: one remaining cross-device/cross-projection filesystem
    mutation finding fixed; committed review rerun is required after this pass
    is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's remaining filesystem mutation finding:
  - Documented engine-atomic cross-projection rebind for `rename(...)` and
    `move(...)`, preserving `sourceObjectId`, freshness preconditions,
    idempotency, history, and destination absence without delete-plus-create
    semantics.
  - Documented engine-atomic cross-projection replace for temp-file saves,
    preserving `destinationObjectId`, using `sourceObjectId` as provenance for
    incoming bytes, durably ingesting source content before acknowledgement, and
    replaying idempotent retries without duplicate objects.
  - Kept hard failure only for cases where identity, freshness, source bytes,
    workspace/version binding, or durability cannot be proven.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-fifth pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Kept PR P0C tests scoped to the chosen Phase 0 watcher-backed/direct
    filesystem surface instead of requiring API parity before the API surface is
    explicitly in scope.
  - Added `review_gate_denied` / `quarantined_review_gate` and wired
    ownership/review-gate checks into replay revalidation, first-match ordering,
    durable denial/quarantine mapping, summary text, and E2E criteria.
  - Defined visibility conflict resolution as an intersection across workspace,
    version, path/folder, object, projection, moment/change, and shared-export
    scopes, with `redacted` and active `embargoed` acting as hard caps.
  - Removed the fixed twelve-line scan cap from Think Bigger cohort metadata
    discovery so valid specs with later metadata are still discovered.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-sixth pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Clarified that accepted holding payloads remain reconstructible until
    canonicalization, explicit disposition, or the finite
    `maxRecoverableHoldingPayloadMs` hard cap, and that hard-cap expiry
    transitions to `terminal-retired` with non-reconstructible evidence.
  - Separated holding-record retries from terminal idempotency replay:
    `holdingRecordId` is required only for real holding records, while
    canonical, retryable-failure, and conflict records replay through
    `idempotencyResultId` / `idempotencyReplayToken`.
  - Added the missing `Architecture specifications and mega-plan` cohort-label
    variant to the Think Bigger docs discovery matcher.
  - Preserved generic code-span text such as `WriteResult<T>` in generated
    heading anchors and added a checker fixture for that case.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

Hundred-eighty-seventh pass:

- Live PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Clarified that missing or ambiguous filesystem capture tokens fail closed as
    retryable capture failure or pre-persistence validation error before any
    holding/quarantine/canonical record is allocated; stale well-formed tokens
    remain deterministic conflicts.
  - Made the Think Bigger cohort label matcher case-insensitive while preserving
    the anchored `Cohort:` metadata line.
  - Added server-owned `ThreadReadState.readStateRevision` as the explicit CAS
    token source for read-state idempotency and stale-write detection.
  - Made decision/task chat links stable-object links with
    `targetVersionRef: null` across create requests, stored links, canonical key
    parts, resolver behavior, and link activity payloads.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Overrides:

- None approved. The PR00 docs-only local-agent-CLI exception remains pending
  human approval before completion or merge-readiness.

### Unresolved Findings

This section is a historical category index only. Live unresolved blockers and
decisions are not restated here; read the canonical live-status block in the
latest PR00 pass above.

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
- P0 lanes are provisionally assigned, but final staffing/approval and
  lane-specific CodeRabbit reruns are still pending.

### Follow-Up / Deletion Conditions

- Keep this log until the Think Bigger initiative is complete or superseded.

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
- [ ] File/API writes durably capture immediately and produce recoverable
      history, with canonical promotion gated by validation.
- [ ] Server/engine-derived actor identity is enforced for write paths; callers
      cannot assert trusted user identity.
- [ ] Every atom, folder, entity, file, version, chat, thread, message, link,
      read state, notification, activity, share, capture, event, search result,
      projection, holding record, durability-log entry, and idempotency tombstone
      is workspace-scoped.
- [ ] Agent writes respect user locks, protected paths, atom/folder/file access,
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
- [ ] Local agent CLI QA passes with the configured `DOHC_TEST_AGENT_CLI`.
- [ ] Alternative local agent CLI compatibility is run or unavailable status is
      recorded.
- [ ] Local agent file edits are captured without requiring agent-specific file
      attribution.
- [ ] Agent chat replies display as `<User Name>'s agent`.
- [ ] CodeRabbit approved every Phase 0 PR or user approved documented
      non-critical documentation-only exceptions.
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
- [ ] Effective policy resolver covers files, versions, search, and export
      substrate.
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
- 21R
- 22

Gate evidence:

- [ ] External/shared channels are explicit and revocable.
- [ ] Versioned workspace UX feels integrated.
- [ ] Agent file edit plus chat reply loop works.
- [ ] Migration path proven with rollback.
- [ ] Full QA hardening complete.
- [ ] No skipped critical E2E.
- [ ] No unresolved P0/P1 findings.
