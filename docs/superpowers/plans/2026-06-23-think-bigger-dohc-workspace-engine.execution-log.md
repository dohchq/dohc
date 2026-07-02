# Think Bigger dohc Workspace Engine Execution Log

Read-only summary: current state derives from the single mutable
`LivePR00Status` block under the `Live PR00 Status` heading below.
Created: 2026-06-23

Plan:

- [Think Bigger dohc Workspace Engine](./2026-06-23-think-bigger-dohc-workspace-engine.md)

Source specs:

- [dohc Versioned Workspace Design](../specs/2026-06-22-dohc-versioned-workspace-design.md)
- [dohc Native Filesystem Design](../specs/2026-06-23-dohc-native-filesystem-design.md)
- [dohc Chats Design](../specs/2026-06-23-dohc-chats-design.md)

## Current PR Pointer

- **Single mutable status block:** only the newest PR00 pass's
  `LivePR00Status` block under the `Live PR00 Status` heading owns CodeRabbit
  status, test evidence, open overrides, and completion state.
- **Derived summaries:** this header and any other summaries are
  read-only pointers to that newest live-status block.
- **Archive boundary:** earlier `Historical PR00 status` entries under
  `Archived PR00 Pass History` are append-only background.

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

## Phase 0 Decision Note

Phase 0 decision-note entries are recorded in the PR00 pass history below. This
heading is the stable machine-checkable anchor for specs that cite the execution
log as the decision-note source of truth.

## PR Lane Inventory

P0A and P0R are provisional throughput work started after user approval for
unattended Phase 0 execution on 2026-06-24; P0B-P0G remain queued behind the
shared-substrate baseline freeze. Current live state is recorded only in the
canonical live-status block in the latest PR00 pass below. This table records
static lane ownership, branch, worktree, and planned validation shape. The
Phase 0 Baseline Freeze and PR 01 Canonical Adoption Handoff are schema
milestones, not standalone lane rows.

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

Use the compact pass template for iterative PR00 CodeRabbit passes. Use the full
implementation template for new implementation PR entries.

```md
<pass-label>:

- Historical PR00 status:
  - CodeRabbit status:
  - Test evidence:
  - Open overrides:
  - Unresolved findings:
  - Completion state:
- Fixed CodeRabbit findings:
  - ...
- Validation:
  - `git diff --check`:
  - `node scripts/check-think-bigger-doc-links.mjs`:
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`:
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`:
- Unresolved findings:
  - ...
- Overrides:
  - ...
```

Copy this section for each implementation PR.

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

### Phase 0 Decision Note Entry Template

- Storage baseline:
- Filesystem interposition:
- Secret boundary:
- Merge scope:
- Chat/file philosophy:
- Rust kernel boundary:
- Async workspace/request-token gating:
- Unresolved blockers:
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

### Live Blockers And Overrides

- Current unresolved blockers:
- Pending non-blocker overrides:
- Approved override references:

### Subagent Reviews

- Architecture:
- Security:
- QA:
- Accessibility:
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

## Archived PR00 Pass History

The PR00 pass entries below are an append-only archive. Treat older pass blocks
as read-only background; do not edit them to express current state. The current
state is only the newest PR00 pass's `LivePR00Status` block, as referenced by
the Current PR Pointer above.

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

- Recorded docs-checker fixture coverage for HTML
  comment stripping, nested image links, generic code-span heading anchors,
  bracket-index notation, missing reference links, and blockquote fenced-code
  parsing.
- Recorded the Think Bigger docs workflow so CI runs the manifest/link/anchor
  checker when covered docs, the checker, or the workflow change.
- Planning/docs-only validation runs are recorded below.

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
    canonical automated review loop.
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
  - Replaced the duplicate PR loop with a reference to the canonical automated review
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

- Fixed automated review follow-up findings:
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
  - Consolidated duplicate automated review loop language and made auth, ownership,
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

- Fixed automated review follow-up findings:
  - Removed external product comparison language from the chats and native
    filesystem specs while preserving the dohc-native product intent.
  - Tightened PR completion rules so critical E2E, unresolved P0/P1,
    automated review, performance, authorization, ownership, workspace-scope,
    secret-handling, data-loss, and review-gate blockers are non-overridable.
  - Added the missing `### Unresolved Findings` section to the live PR 00
    execution-log entry and marked it as none after fixes.

Fourteenth pass:

- Fixed automated review follow-up findings:
  - Updated the duplicate automated review-loop pointer to reference the actual
    `automated review Loop` section under `Agent And Review Workflow`.
  - Clarified that importers evaluate allowlisted `.dohc/*` policy inputs
    before quarantining reserved `.dohc/**` namespace content.
  - Required atomic conditional upsert/CAS semantics for `lastReadCursor`
    advancement so stale concurrent reads cannot regress read state.
  - Required a unique `(workspaceId, threadId, threadSequence)` constraint and
    transactional or serialized sequence allocation for chat messages.

Fifteenth pass:

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up findings:
  - Replaced legacy chats wording with dohc Chats terminology.
  - Cleaned the denied/quarantined ingest holding-area grammar in the execution
    log while preserving the secret-safe durability requirement.

Seventeenth pass:

- Fixed automated review follow-up findings:
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
    exact secret-safe wording automated review requested.

Eighteenth pass:

- Fixed automated review follow-up findings:
  - Changed the live PR 00 `Unresolved Findings` section from final
    no-open-items wording to provisional rerun-pending wording.
  - Clarified that `.dohc/files.toml` and `.dohc/visibility.toml` live under
    `.dohc/`, while optional `.dohcignore` is a workspace-root policy file.

Nineteenth pass:

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up findings:
  - Reworded the denied/quarantined ingest holding-area grammar in the Twelfth
    pass entry.
  - Added TOCTOU-safe descriptor/handle continuity requirements after
    filesystem path canonicalization.
  - Clarified that `ThreadLink` cross-workspace exceptions are allowed only for
    explicit shared-channel grants and must be re-authorized on every use.
  - Added a strict 16-participant cap for DM-backed threads and early rejection
    of oversized raw or canonical participant lists.

Twenty-second pass:

- Fixed automated review follow-up findings:
  - Added an explicit Overrides entry instead of leaving the field blank.
  - Rephrased the Twelfth-pass denied/quarantined ingest holding-area sentence.
  - Required shared-channel grant revoke/expiry cleanup to purge or reindex
    derived chat projections, search snippets, notification payloads, and export
    artifacts.
  - Defined deterministic DM participant canonicalization: persisted actor-id
    form, exact dedupe, and bytewise ascending sort before key generation.

Twenty-third pass:

- Historical outcome: automated review approved that committed diff with 0 findings.
- Updated PR00 status, automated review status, and unresolved findings to reflect the
  then-current approved review.

Twenty-fourth pass:

- Fixed automated review follow-up finding:
  - Aligned execution-log table titles for PR IDs 13-15 with the canonical mega
    plan entries.

Twenty-fifth pass:

- Fixed automated review follow-up findings:
  - Added canonical decimal-string encodings for chat sequence and timestamp
    fields, with BigInt/64-bit-safe comparison requirements.
  - Marked `ChatThread.title` and user/agent-authored thread metadata as
    untrusted text requiring escaping or sanitization across UI, search,
    notifications, projections, summaries, and exports.

Twenty-sixth pass:

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up findings:
  - Removed stable object ids from causal write precondition unions; object ids
    are now optional targeting metadata and must be paired with freshness
    tokens such as base version, etag, content hash, or absence assertion.
  - Added chat links to the first-slice workspace-scoping E2E checklist.
  - Replaced placeholder brand-guard command text with the exact Node 24.18.0
    setup and test command executed, while recording Node and pnpm environment
    details separately.

Twenty-eighth pass:

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up finding:
  - Added repo-mandated `apps/app/AGENTS.md` and
    `apps/app/convex/_generated/ai/guidelines.md` kickoff checks alongside the
    existing `apps/web/AGENTS.md` check, with execution-log recording required.

Thirtieth pass:

- Fixed automated review follow-up findings:
  - Normalized the versioned workspace write precondition to the shared
    `expectedBaseVersion` schema name used by the native filesystem API.
  - Clarified that `.dohc/files.toml` is a source-backed policy entry while
    `.dohc/status.json`, `.dohc/conflicts/**`, and `.dohc/chats/**` are
    internal projections/reserved state unless a purpose-built export policy
    explicitly includes redacted derived state.

Thirty-first pass:

- Fixed automated review follow-up findings:
  - Reworded versioned workspace examples to use auto-save/automatic-history
    language instead of implying manual save.
  - Added first-slice E2E coverage for missing or incompatible causal
    preconditions on `write(...)`, `merge(...)`, and `restore(...)`.
  - Restored the missing PR00 table cell so automated review, Tests, and Notes remain
    aligned.
  - Required DM participant sorting to use bytewise ascending UTF-8 encoding of
    the canonical persisted actor id.
  - Added TOCTOU-safe, no-symlink chat projection write requirements.

Thirty-second pass:

- Fixed automated review follow-up finding:
  - Removed the host-specific pnpm path from the Node 24 brand-guard command
    and replaced it with the portable Node v24.18.0 Corepack invocation that
    resolves `pnpm@10.24.0` from the repo package manager field.

Thirty-third pass:

- Historical outcome: automated review approved that committed diff with 0 findings after the
  portable Node 24 test command fix.
- Updated PR00 status, automated review status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Thirty-fourth pass:

- Fixed automated review follow-up finding:
  - Aligned the mega-plan `.dohc/` source-backed policy allowlist with the
    native filesystem spec by adding `.dohc/visibility.toml` and optional
    workspace-root `.dohcignore`.

Thirty-fifth pass:

- automated review approved the latest committed diff with 0 findings after the
  `.dohc` allowlist fix.
- Updated PR00 status, automated review status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Thirty-sixth pass:

- Fixed automated review follow-up findings:
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

- Fixed automated review follow-up findings:
  - Required idempotency keys and deterministic duplicate-delivery behavior for
    `write(...)`, `merge(...)`, and `restore(...)`, including filesystem-captured
    saves.
  - Required chat read-state writes to derive `actorId` from authenticated
    server/engine identity rather than caller payloads.
  - Made DM participant sets immutable after creation; membership changes create
    or resolve a new canonical DM-backed `ChatThread` and link from the prior
    thread.

Thirty-eighth pass:

- Fixed automated review follow-up finding:
  - Marked P0A-P0G lane branches as provisional, not approved, and blocked on
    PR00 approval, stack reconciliation, lane PRs, tests, and automated review.
  - Added the 2026-06-24 user-approved unattended execution note that explains
    why provisional Phase 0 branches exist before PR00 is merge-ready.

Thirty-ninth pass:

- Fixed automated review follow-up findings:
  - Made native filesystem `write(...)`, `merge(...)`, and `restore(...)`
    require `idempotencyKey`, matching the versioned workspace contract.
  - Normalized historical Node test evidence to Linux Node 24.18.0, matching
    the executed brand-guard command.

Fortieth pass:

- automated review approved the latest committed diff with 0 findings after the
  native idempotency/Node evidence fix.
- Updated PR00 status, automated review status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval before completion or merge-readiness.

Forty-first pass:

- Fixed automated review follow-up findings:
  - Added SHA256 manifest verification before extracting or executing the Node
    v24.18.0 tarball used for the brand guard.
  - Changed native filesystem async payload sequence to a BigInt-safe decimal
    string ordering guard.
  - Required deterministic collision-proof quarantine rename destinations that
    never overwrite existing user content.
  - Required chat read-state authorization to happen before tuple-to-message
    existence checks so failures do not become existence oracles.

Forty-second pass:

- Fixed automated review follow-up findings:
  - Required overwrite calls to include `targetObjectId` plus exactly one causal
    freshness precondition, while create-only `expectedAbsent` calls omit
    `targetObjectId`.
  - Clarified that native filesystem conflict responses return secret-safe
    opaque handles, hashes, redacted previews, policy decisions, and metadata by
    default, with raw bytes materialized only through explicit server-side
    authorization.

Forty-third pass:

- Fixed automated review follow-up finding:
  - Aligned the versioned workspace `write(...)` contract with the native
    filesystem overwrite rule: overwrite requires `targetObjectId` plus exactly
    one causal freshness precondition, while create-only `expectedAbsent` omits
    `targetObjectId`.
  - Added secret-safe conflict envelope wording to the versioned workspace API
    contract.

Forty-fourth pass:

- Fixed automated review follow-up finding:
  - Defined the exact `.dohc/chats/**` projection filename algorithm:
    SHA-256 over `v1\0workspaceId\0threadId\0projectionKind`, lowercase
    RFC 4648 base32 without padding, and `v1-<digest>.md`.

Forty-fifth pass:

- Fixed automated review follow-up findings:
  - Added first-class `delete(...)`, `rename(...)`, and `move(...)` operations
    to the versioned workspace and native filesystem API surfaces.
  - Required source object identity, source freshness preconditions, destination
    absence guards for rename/move, and idempotency keys for those mutations.
  - Reworded `.dohc/chats/**` as a reserved internal projection scope, not an
    allowlisted user-content path.

Forty-sixth pass:

- automated review approved the latest committed diff with 0 issues after the
  mutation API parity and reserved chat projection scope fixes.
- Updated PR00 status, automated review status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.

Forty-seventh pass:

- Fixed automated review follow-up finding:
  - Replaced the remaining legacy thread-id-shaped projection examples with the
    canonical deterministic `.dohc/chats/v1-<digest>.md` path shape and
    clarified that raw thread ids are not projection filenames.

Forty-eighth pass:

- Fixed automated review follow-up finding:
  - Added `stat(...)` and `watch(...)` to the versioned workspace API list so it
    matches the native filesystem API surface.
  - Clarified that `read(...)`, `list(...)`, `stat(...)`, `search(...)`,
    `watch(...)`, `snapshot(...)`, and `diff(...)` are read-only scoped views.

Forty-ninth pass:

- Fixed automated review follow-up finding:
  - Defined the string-to-bytes rule for chat projection filename hashes:
    normalize `workspaceId`, `threadId`, and `projectionKind` to Unicode NFC,
    encode them as UTF-8 bytes, then hash the framed byte sequence.

Fiftieth pass:

- Fixed automated review follow-up findings:
  - Required safe-rename destinations to be atomically reserved with
    create-if-absent/`O_EXCL`-equivalent semantics before activation.
  - Added a minimum 24-hour idempotency replay window and explicit expired-key
    fail-closed behavior to both native filesystem and versioned workspace
    write-producing operation contracts.

Fifty-first pass:

- Fixed automated review follow-up findings:
  - Required versioned async reads and `watch(...)` events to carry
    workspace/version/request-token binding plus abort or stale-response
    semantics.
  - Clarified that passive ordinary OS file edits may stay actor-neutral, but
    dohc-controlled agent/tool/skill-turn ingest cannot downgrade missing turn
    proof into unverified local provenance.

Fifty-second pass:

- automated review approved the latest committed diff with 0 issues after the
  versioned async/provenance fixes.
- Updated PR00 status, automated review status, and unresolved findings to record the
  clean review while leaving the docs-only local-agent-CLI exception pending
  human approval.

Fifty-third pass:

- Fixed automated review follow-up finding:
  - Replaced the stale thread-shaped chat projection plan example with the
    canonical deterministic `.dohc/chats/v1-<digest>.md` projection path.

Fifty-fourth pass:

- automated review approved the latest committed diff with 0 issues after the plan
  chat projection path fix.
- Updated PR00 status, automated review status, and unresolved findings to record the
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
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")` passed
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
  - Clarified that the newest PR00 pass entry's `Live PR00 status` block owns
    live status while the rest of the log is read-only history.
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

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

- Historical PR00 status:
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

Hundred-eighty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Added a canonical precondition guard vocabulary table for object freshness,
    path absence, merge source/target freshness, and restore freshness aliases.
  - Added the current `Think Bigger dohc Workspace Engine Documentation and CI`
    cohort-label variant and realpath/stat validation before reading candidate
    spec metadata in the Think Bigger docs checker.
  - Consolidated `.dohcignore` precedence by making the Policy Files section the
    canonical source and having effective-policy resolution refer back to it.
  - Clarified PR P0R bridge identity scope: identity resolves only from the
    authenticated local-channel binding plus server/engine context, and forged
    client-supplied actor/workspace/version metadata fails before scan/hash work.
  - Clarified that Think Bigger docs workflow path filters trigger CI only; the
    manifest-backed checker is the fail-closed enforcement point.
  - Kept all validation evidence in this pass.
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

Hundred-eighty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Added `ThreadReadState`, read cursor tuple, `readStateRevision`, and
    unread/read-state projections to the schema ownership matrix with PR 12 as
    final owner for cursor semantics, migration/backfill, and projection rebuild.
  - Taught the Think Bigger docs checker to recognize blockquote-prefixed fenced
    code blocks without scanning quoted fence contents as prose.
  - Restored the full actor-neutral write-gate checklist for version access,
    provenance, attribution, and proof requirements.
  - Required native filesystem idempotency identities to use the operation
    operand tuple after workspace path canonicalization and equivalence
    normalization.
  - Clarified that cross-projection `replace(...)` fallback commits ingestion,
    destination update, temp-source retirement/quarantine, history, and
    idempotency as one all-or-nothing durable unit.
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

Hundred-ninetieth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Clarified that Think Bigger docs workflow path filters only trigger the CI
    job; checker enforcement is manifest-backed and runs only when a covered
    change triggers the workflow.
  - Added `Async workspace/request-token gating` to the Phase 0 Decision Note
    copy/paste template.
  - Clarified that `ThreadLink` changes are tombstone plus recreate, never
    in-place persisted row mutation.
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

Hundred-ninety-first pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun
    is required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Added `cross_workspace_reference` to `PublicValidationErrorCode` and wired
    it into cross-workspace binding validation.
  - Aligned filesystem capture-token failures with the existing
    `retryable-failure` result instead of implying a separate retryable capture
    result kind.
  - Replaced reserved-namespace prose with a decision table for allowlisted
    policy inputs, engine-owned `.dohc/**`, foreign `.dohc/**`, managed
    `.versions/**`, unmanaged `.versions/**`, and ordinary safe-rename cases.
  - Added fail-closed handling for distinct native paths that normalize to the
    same canonical workspace path after NFC/case/equivalence normalization.
  - Made workspace-root `.dohcignore` a fixed lower-precedence sub-band before
    `.dohc/files.toml` instead of relying on path-order ties.
  - Added provisional Phase 0 chat/link/projection policy resolver hooks before
    P0F search consumes linked chat surfaces.
  - Added PR 01 schema bootstrap requirements for IDL/schema location,
    generator/conformance command, TypeScript entrypoint, and Rust crate or
    blocking Rust conformance fixture.
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

Hundred-ninety-second pass:

- Historical PR00 status:
  - CodeRabbit status: one follow-up finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's remaining Scenario C finding:
  - Clarified that named-version compare shows file/data differences plus
    version-linked chat projections, while Chats remain live workspace objects
    and are not restored or compared as versioned chat history.
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

Hundred-ninety-third pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Branded `UnixMsDecimalString` and `UInt64DecimalString` in the versioned
    workspace spec so canonical decimal strings are machine-checkable.
  - Added precondition validation-code comments for omitted guards and multiple
    aliases for one guard.
  - Added the explicit P0S shared-substrate freeze gate, owner, acceptance
    symbols, and consumer-import requirement before P0B-P0G proceed.
  - Required durability capture/restart reconciliation to persist and match an
    immutable `versionId`, never infer version binding from remapped mounts.
  - Updated execution-log testing notes for checker fixtures and workflow
    coverage.
  - Added `threadSequence` and `bodyRevision` to `MessageCreateThreadActivity`
    plus replay/export guidance for deterministic ordering and body identity.
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

Hundred-ninety-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Removed the unmodeled `manual-only` lifecycle term from replay binding
    handling so outcomes remain `PublicValidationErrorCode` or quarantine.
  - Required export/re-import metadata to carry the workspace path-equivalence
    profile and fail closed if the profile is missing or incompatible.
  - Updated local agent CLI testing docs to use neutral dohc-branded driver
    names and keep vendor-specific driver mappings in non-shipping QA notes.
  - Replaced plain deterministic deleted-body hashes with keyed digest/MAC
    evidence verified through authorized replay/export/audit paths.
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

Hundred-ninety-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Clarified pre-persistence binding validation versus post-acceptance
    quarantine for malformed, cross-workspace, unresolved, and replayed binding
    evidence.
  - Added the named PR01 Schema Promotion Checkpoint so downstream code knows
    when to stop importing `Phase0SharedSubstrateBaseline`.
  - Added a PR 01 schema-drift test requirement for checked-in canonical schema
    parity with generated or conformance-tested TypeScript/Rust consumers.
  - Clarified that async `requestToken` values are opaque server/engine-minted
    request-stream tokens echoed by watch/status/snapshot/list/search/filesystem
    loading payloads for stale-response checks.
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

Hundred-ninety-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Removed public current/incoming content hashes from conflict envelopes,
    kept diagnostics behind the authorized `conflictId`/`conflictReplayToken`
    path, and stated that diagnostics may expose hashes only for
    non-secret-backed objects after authorization.
  - Added `capture_token_invalid` to `PublicValidationErrorCode` and mapped
    deterministic filesystem capture-token failures to that outcome while
    keeping indeterminate infrastructure proof failures retryable.
  - Assigned `ThreadReadState`, `readStateRevision`, and unread/read-state
    bridge ownership to PR 01 from the Schema Promotion Checkpoint through PR 12
    with schema version `chat-read-state-bridge-v0`.
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

Hundred-ninety-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Made filesystem safe rename proposals ordinary non-secret content only;
    secret-backed or secret-eligible inputs stay quarantine/manual-resolution
    unless an explicit authorization flow emits a fully opaque replacement label.
  - Required ThreadLink idempotent uniqueness-conflict handling to re-run the
    same authorization, visibility, share-grant, and policy checks before
    reading or returning an existing active link.
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

Hundred-ninety-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: one minor and two trivial follow-up findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Tightened the accessibility gate to require WCAG 2.2 AA for shipped
    surfaces, with any exception recorded explicitly in the execution log.
  - Documented and wired the Think Bigger docs workflow for manual and scheduled
    manifest-drift checks while keeping pull-request/push path filters.
  - Replaced the checker's hand-rolled heading slug construction with
    `github-slugger` and added whitespace/emoji fixture coverage.
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

Hundred-ninety-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Added `package.json` and `pnpm-lock.yaml` to both Think Bigger docs workflow
    path-filter sets so dependency wiring changes run the checker.
  - Suppressed ordinary blockquote prose/headings in the docs checker while
    preserving quoted fenced-code detection, with fixtures for quoted links and
    headings.
  - Reworded cross-projection rename/move/replace as staged canonical mutations
    with compensating projection cleanup instead of distributed atomic file
    transactions.
  - Extended shared-channel grant revocation to derived fanout/replay
    materializations, immutable outbox/ledger revalidation,
    audit/history/export emission, and notification materialized context.
  - Extended shared-channel redaction to presence, typing indicators, and
    read/seen state before rendering, search, projection, notifications, or
    export.
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

Two-hundredth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Restricted `expectedContentHash` to non-secret-backed object operands and
    required secret-backed writes/deletes/renames/replaces to use non-hash
    freshness guards.
  - Added query stripping for local link target resolution while preserving
    fragments, plus fixture coverage.
  - Narrowed markdown autolink collection to supported URI schemes only.
  - Clarified shared-channel revocation so durable outbox/ledger rows remain
    immutable and are revalidated at replay/consumption time instead of
    invalidated as derived caches.
  - Split native capture `terminal-retired` lifecycle status from
    `idempotency-expired` retry-horizon outcomes.
  - Required cross-projection replace staging, rollback, quarantine, and cleanup
    artifacts to keep secret-backed inputs encrypted or redacted.
  - Added a PR 01 mechanical lint/test gate for the
    `Phase0SharedSubstrateBaseline` cutoff after the Schema Promotion Checkpoint.
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

Two-hundred-first pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings handled; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed or resolved CodeRabbit's six follow-up findings:
  - Verified the `github-slugger` lockfile finding as stale: current
    `pnpm-lock.yaml` already contains the root importer, package, and snapshot
    entries for `github-slugger@2.0.0`.
  - Added the current `Think Bigger dohc Workspace Engine docs and CI
    enforcement` cohort alias to the docs checker.
  - Changed blockquote handling so visible quoted prose/headings are validated
    after stripping `>`, while quoted fenced and indented code remain excluded.
  - Marked native API `expectedContentHash` operands as non-secret only and
    tightened the `write(...)` prose for secret-backed protected paths.
  - Consolidated P0S under the single PR01 Schema Promotion Checkpoint ownership
    handoff.
  - Renamed the reusable execution-log blocker template heading to
    `Live Blockers And Overrides` so it is distinct from the historical
    `Unresolved Findings` category index.
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

Two-hundred-second pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added a uniqueness check for the checked-in Think Bigger docs manifest.
  - Expanded the Phase 0 roadmap milestone into an explicit **P0S - Shared
    Substrate Freeze** entry with owner, shared symbols, and exit criteria.
  - Added an `Archived PR00 Pass History` boundary and clarified that only the
    newest PR00 pass's `Live PR00 status` block is mutable current state.
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

Two-hundred-third pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Added `--ignore-scripts` to the Think Bigger docs workflow dependency install.
  - Preserved per-link target and source line metadata in the docs checker and
    surfaced line numbers in link/anchor failure messages.
  - Tightened repository boundary checks to exact parent traversal or
    separator-prefixed parent traversal instead of broad `..` prefix checks.
  - Removed `idempotency-expired` from persistent filesystem status projections
    and kept it scoped to operation results and retry flows.
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

Two-hundred-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Replaced legacy collaborative document editor references with neutral
    collaborative-editor
    language in the versioned workspace and chats specs.
  - Changed URI autolink extraction to collect all angle-bracketed URI schemes so
    disallowed schemes still reach the validator.
  - Added the `Architecture Specifications` cohort label to discovery.
  - Made the Think Bigger docs workflow always-on for PRs and pushes, and updated
    the plan to describe the checker as the enforcement point rather than path
    filters.
  - Clarified known engine-owned `.dohc/**` internals are silently skipped while
    foreign/unmanaged reserved namespaces are quarantined or manually resolved.
  - Repeated the non-secret-only `expectedContentHash` restriction directly in
    the native `write(...)` overwrite guidance.
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

Two-hundred-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Added line numbers to unresolved reference reports in the docs checker.
  - Added the `Core Architecture Specs` cohort alias to discovery.
  - Completed replay-time denial/quarantine reason mapping for lock,
    version-access, skill-turn, provenance, attribution, and proof failures.
  - Made `targetType: 'share'` ThreadLink create requests shared-only.
  - Narrowed the docs checker gate wording to docs inventory/link/anchor drift.
  - Split safe-rename reservation collisions from retryable mount/storage
    reservation failures.
  - Required default export to fail closed when the selected scope has
    unresolved durable-pending, quarantine, or conflict records.
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

Two-hundred-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Updated the Think Bigger docs workflow to Node 24-compatible v5 action pins
    and enabled setup-node pnpm caching.
  - Removed the empty `Milestone Gates` heading from the execution log outline.
  - Replaced the misleading live-looking unresolved-findings category with this
    live pass status and the historical index below.
  - Added the first-class `Channel` schema, slug stability, ACL/visibility, and
    create/get-or-create lifecycle contract to the chats spec.
  - Added `send_channel_message` to the chat action/idempotency model.
  - Required the first channel message to atomically create/resolve the
    channel-backed `ChatThread` and persist the initial `ThreadMessage`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Added the `Think Bigger documentation suite` cohort alias to the docs
    checker discovery regex.
  - Changed local fragment validation to check Markdown heading anchors only for
    Markdown targets, with an asset-fragment fixture.
  - Moved pnpm setup before setup-node caching and bumped the workflow Node
    version to 24.14.1.
  - Pinned chat `reactionKey` emoji validation to Unicode 15.1.0/UAX #29 and
    Unicode Emoji 15.1 RGI tables.
  - Clarified that `durable-pending` is only the non-canonical holding-record
    `WriteResult` arm, not a canonical write waiting for read visibility.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Added the `Design specs for versioning, chats, and filesystem` cohort alias
    to the docs checker discovery regex.
  - Added P0S to the live PR lane inventory and Phase 0 Proof Arc PR list.
  - Tightened native filesystem idempotency wording so secret-backed operands
    use server-scoped opaque fingerprints that are never returned to clients.
  - Normalized chat channel `linkedTargets` as a sorted/deduped canonical set
    and made `linked_work` channel conversations use exactly one canonical
    target discriminator.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: one follow-up finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's follow-up finding:
  - Restored the explicit `### Unresolved Findings` slot in the reusable
    execution-log template between CodeRabbit evidence and live blockers.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-tenth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Added path filters to the Think Bigger docs workflow for docs, checker,
    package manifest, and workflow changes while leaving scheduled runs intact.
  - Moved setup-node before Corepack/pnpm activation so pnpm is prepared under
    the selected Node 24.14.1 runtime.
  - Required reconciliation to enumerate active engine-bound `.versions/<version>/`
    mounts for the current workspace before entering them through the resolver.
  - Clarified that OS session binding is only an input to server/engine principal
    derivation and cannot lift quarantine without explicit validation and policy
    checks.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eleventh pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings handled; committed review rerun
    is required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Handled CodeRabbit's four follow-up findings:
  - Restored always-on pull-request and push triggers for the Think Bigger docs
    workflow by removing path filters again.
  - Verified the `github-slugger` lockfile finding as stale:
    `pnpm install --lockfile-only --ignore-scripts` completed with no lockfile
    diff, and `pnpm-lock.yaml` already records the root importer and package
    entries.
  - Deferred workspace-root `.dohcignore` from live allowlisted policy input,
    source-order, import, and export semantics for this phase.
  - Narrowed the first filesystem proof slice to `.env` exclusion/redaction
    smoke rather than tracked-as-secret-backed/private `.env` behavior.
- Validation:
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm install --lockfile-only --ignore-scripts`
    completed with no lockfile diff.
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twelfth pass:

- Historical PR00 status:
  - CodeRabbit status: eight follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's eight follow-up findings:
  - Added the execution log to the mega plan's Source Specs inventory.
  - Split `ProjectionValidation` expectations between writable,
    `readOnly`, and `internalOnly` projections.
  - Clarified Phase 0/PR01/PR12 chat schema ownership so Phase 0 owns only
    ephemeral/provisional fixtures and PR12 owns durable chat persistence.
  - Replaced manual Corepack setup with pinned `pnpm/action-setup` before
    setup-node so setup-node pnpm caching has pnpm on PATH.
  - Clarified unmanaged `.versions/**` paths fail closed into quarantine/manual
    resolution instead of being silently skipped or promoted.
  - Made secret-backed freshness guards server-minted opaque tokens, never
    client-provided content hashes.
  - Added one non-`.env` secret-backed proof fixture while keeping `.env` scoped
    to exclusion/redaction smoke.
  - Changed accepted holding lifecycle so reconstructible accepted payload bytes
    remain until canonicalization or explicit operator disposition.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirteenth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Prevented duplicate reference-link extraction in the docs checker and added
    a fixture for definition, shortcut, and full reference links.
  - Modeled mention notification activity as a kind-discriminated union.
  - Softened the versioned-workspace user-facing retention sentence to match
    bounded audit/recovery policy.
  - Added secret-safe output rules for `watch`, `snapshot`, and `diff`.
  - Reserved `conflict` for true base/current/incoming divergence in replace
    fallback handling.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fourteenth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Added the `Think Bigger documentation and tooling` cohort alias to docs
    discovery.
  - Rejected root-relative Markdown links instead of resolving them as
    repo-relative paths.
  - Moved the execution log out of the mega plan Source Specs list into the
    audit/history artifact bucket.
  - Removed P0S from the PR lane inventory and documented it as a PR01 checkpoint
    rather than a standalone lane row.
  - Added `ThreadReadState` and `AgentRun` to PR01 shared-schema handoff scope.
  - Added a normative gate/retry matrix to the versioned workspace spec.
  - Added cross-workspace/shared-scope metadata and re-authorization rules to
    `ChannelLinkedTargetRef`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifteenth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added the `Think Bigger dohc documentation and link-check tooling` cohort
    alias to docs discovery.
  - Collapsed the roadmap P0S milestone into a pointer to the canonical PR01
    Schema Promotion Checkpoint definition.
  - Expanded the native filesystem status checklist to include `rejected`,
    `retryable-failure`, and `terminal-retired`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixteenth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Renamed archived pass status labels from `Live PR00 status` to
    `Historical PR00 status`.
  - Made P0S a checkpoint entry in the Phase 0 Proof Arc, not a PR lane.
  - Normalized accepted non-canonical write prose around the canonical
    `durable-pending holding record` term.
  - Clarified `durable-pending` and `retryable-failure` as mutually exclusive
    outcomes in the gate/retry matrix.
  - Converted `ChannelLinkedTargetRef` to a `scopeKind` discriminated union so
    shared targets require `shareGrantId` and `visibilityScope`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventeenth pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Updated the checkout action pin to the v5.0.0 release SHA.
  - Required `.versions/**` reserved-namespace classification before generic
    walker skip behavior.
  - Added `chat_created` activity provenance for `ChatThread` creation.
  - Made channel-level linked targets derive from `ChannelTargetActivity` while
    thread-level linked work remains owned by `ThreadLink`.
  - Expanded the durable-pending `pendingState` lifecycle note to include
    `pending_protection` and `pending_review`.
  - Added watch streams and projection caches to secret non-leakage rules.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighteenth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Restored workflow path filters using the current manifest/docs/checker input
    set.
  - Assigned P0E provisional proof-slice ownership for persisted linked chat
    thread/message/link rows while keeping PR12 as the final owner.
  - Changed code-span stripping to preserve token separators and added a fixture
    for adjacent Markdown tokens.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-nineteenth pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Scoped the workflow install to the root `dohc` package.
  - Made `replayUntil` the single replay-expiry term for holding-record retries.
  - Mapped mandatory review to `durable-pending holding record` with
    `pending_review`.
  - Removed `exports` from the Phase 0 chat link target list.
  - Split malformed precondition validation errors from stale-state conflicts.
  - Chose `idempotency-expired` as the single retired-namespace retry outcome.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twentieth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Unified the schema-promotion section around the single
    **PR01 Schema Promotion Checkpoint** name, keeping `P0S` only as a brief
    alias for the pre-PR01 freeze work inside that checkpoint.
  - Updated the Markdown checker so blockquote marker stripping applies only to
    actual quoted prose and not indented code that starts with `>`.
  - Required filesystem status surfaces to report materialization,
    file-policy, write-state, secret/export, and conflict axes using
    `WriteResult.kind` terminology.
  - Added an explicit `.env` secret-backed read/write/status/conflict/export
    proof slice.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-first pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Renamed remaining archived PR00 pass headings from `Live PR00 status` to
    `Historical PR00 status`.
  - Folded the `P0S` roadmap entry into a pointer-only reference to the canonical
    **PR01 Schema Promotion Checkpoint**.
  - Removed duplicated PR01 chat-schema ownership rules and pointed PR01 scope
    back to the single schema ownership matrix.
  - Required first channel sends to persist the matching `chat_created`
    `ThreadActivity` with the initial `ThreadMessage`.
  - Added `recordKind: 'accepted_holding_record'` to the public
    `durable-pending` `WriteResult` arm.
  - Restricted accepted holding-record retries to canonical, durable-pending,
    quarantined, terminal-retired, or expired outcomes, reserving
    `rejected_record` for pre-acceptance rejection records.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-second pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Clarified PR 01 owns only the chat read-state compatibility bridge, while
    PR 12 owns the authoritative `ThreadReadState` schema.
  - Restricted `create_chat` to DM creation and kept channel-backed thread
    creation inside `send_channel_message`.
  - Added `channel-target-ledger-sync` so channel-backed `ThreadLink` mutations
    append matching `ChannelTargetActivity` rows before fanout.
  - Added explicit validation-error rows for `invalid_request`/request-shape
    failures, `capture_token_invalid`, and `replay_metadata_mismatch` to the
    normative gate/retry matrix.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-third pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Added the Think Bigger docs workflow file to its own path filters.
  - Added raw HTML `<a href>`, `<a id>`, and `<a name>` handling plus fixtures to
    the Think Bigger link checker.
  - Added `replayUntil` to the public `terminal-retired` write result payload.
  - Moved visibility before policy in replay first-match evaluation.
  - Reused the canonical `local` vs `virtual` materialization model in native
    filesystem status projections.
  - Marked channel `displayName` and `description` as untrusted text for
    rendering/search/export.
  - Required `send_channel_message` and thread/conversation reads to return the
    server-issued `channelConversationId` for deterministic reuse.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Removed the lingering `ThreadReadState` canonical-schema claim from PR 01
    scope and reserved the authoritative schema for PR 12.
  - Added a compact PR00 pass template to prevent execution-log copy/paste drift.
  - Defined retained, tokenized, and redacted actor/device/session provenance for
    filesystem durability logs and exports.
  - Made `ChannelLinkedTargetRef` mirror `ThreadLink` versioned/non-versioned
    target semantics.
  - Required `linked_work` channel conversations to name exactly one canonical
    selected target before deriving `channelConversationId`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Updated the link checker so footnote definition bodies are scanned for visible
    links while footnote labels stay out of reference-definition handling.
  - Standardized `ChatThreadBase` on `threadId` instead of competing `id` and
    `threadId` names.
  - Replaced reusable raw content hashes for protected/secret-backed filesystem
    entries with keyed commitments or opaque authorized hash handles.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added root `package.json` and `pnpm-lock.yaml` to Think Bigger docs workflow
    path filters.
  - Froze the current PR pointer header so PR metadata lives only in the latest
    live pass block.
  - Legacy-history note: required `secretProjection` to remain explicit in
    status/API/UI serialization, preserving the current `local` materialization
    state with `secretProjection: 'protectedLocal'` versus
    `secretProjection: 'plaintextLocal'`; these are not third materialization
    states.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Made channel first-send `chat_created` provenance exactly-once by binding it
    to the unique `ChatThread` reservation winner.
  - Required `chat_thread` cycle validation to read canonical active
    `ThreadLink` records under the link write guard.
  - Clarified public `recordKind` ownership in `WriteResult` and kept
    canonical/retryable/conflict record classifications internal.
  - Removed `idempotency-expired` from canonical-visibility outcomes.
  - Separated retry-only `idempotency-expired` from persisted native filesystem
    status surfaces.
  - Required startup reconciliation to hash ambiguous candidates unless the
    filesystem proves content stability.
  - Replaced the conflict winner fallback with a single total order and metadata
    recording rule.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: nine follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's nine follow-up findings:
  - Consolidated the PR00 docs-checker contract into one canonical Tests entry.
  - Pointed PR 01 schema ownership back to the single ownership matrix instead
    of restating symbol ownership in PR scope.
  - Tightened raw HTML attribute parsing so `data-href`/`data-id` do not count as
    real anchors or links.
  - Moved visibility before authorization/permission in replay first-match
    ordering.
  - Separated per-path capture/replay tokens from deduplication fingerprints.
  - Made `Channel.linkedTargets` explicitly ledger-derived from
    `ChannelTargetActivity`.
  - Required channel-backed `ThreadLink` idempotent success to verify or repair
    the matching channel-target ledger entry.
  - Constrained secret-backed file policies to non-searchable, redacted/excluded
    export-safe settings.
  - Required policy builders to reject inconsistent `secretProjection` and
    `materialized` combinations before status/export/access serialization.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-twenty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added `Think Bigger planning and design documentation` to Think Bigger cohort
    discovery.
  - Added `retentionUntil` to the public `durable-pending` `WriteResult` payload
    and aligned the nearby prose.
  - Scoped filesystem capture/replay tokens to `(workspaceId, versionId, path)`
    and separated them from deduplication fingerprints.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirtieth pass:

- Historical PR00 status:
  - CodeRabbit status: nine follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's nine follow-up findings:
  - Added an explicit file-history/timeline render performance budget.
  - Updated raw HTML link checking to validate empty `href` targets.
  - Ignored raw HTML anchors inside inline code spans.
  - Split `rejected_record` retry expiry out of the holding-state expiry union.
  - Clarified `terminal-retired` correlation through `holdingRecordId`.
  - Added `status(...)` to the native filesystem API list.
  - Added `WorkspaceStatusPayload` freshness fields and status update guards.
  - Renamed thread-created activity types so `create_chat` and
    `send_channel_message` creation provenance are distinct.
  - Reworded channel/thread linked-work ownership so ledgers are authoritative and
    projections are read-only caches.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-first pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Replaced duplicated P0E/PR 12 chat schema ownership text with references to
    the canonical Phase 0 / PR 01 / PR 12 Schema Ownership Matrix.
  - Added tracked/versioned/synced, export-state, and conflict-location fields to
    `WorkspaceStatusPayload`.
  - Replaced brittle Think Bigger spec discovery cohort matching with a stable
    `Think Bigger Spec: true` marker.
  - Clarified the PR lane inventory so only P0A and P0R are marked as started;
    P0B-P0G remain queued behind the shared-substrate baseline freeze.
  - Added persisted channel conversation provenance to `ChannelChatThread` and
    channel thread-created activity records.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-second pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Clarified that browse-only reads and materialization do not mint durable
    capture/replay tokens; tokens are minted or refreshed only when a
    workspace/version/path becomes edit-capable or receives a first
    write/create/import attempt.
  - Split capture-token outcomes so invalid tokens map to
    `capture_token_invalid`, indeterminate infrastructure maps to
    `retryable-failure`, and well-formed stale tokens map to write conflict.
  - Tightened native filesystem capture so raw local writes must resolve
    workspace, immutable version, effective policy, and server/engine-derived
    principal before entering workspace durability state; unbound events remain
    isolated local spool/quarantine material.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-third pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Expanded the PR 01 schema-drift gate to cover the full Phase 0 / PR 01 /
    PR 12 ownership-matrix symbol set across generated or conformance-tested
    TypeScript and Rust consumers.
  - Made the workflow path-filter description explicitly include source specs,
    execution log, Think Bigger plan docs, manifest, checker script, workflow
    file, and dependency manifests.
  - Split immediate denial responses from durable `rejected_record` lifecycle
    state so `rejected` is consistently addressable by `holdingRecordId`,
    `rejectedAt`, retention, and replay/idempotency metadata.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: nine follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's nine follow-up findings:
  - Added Performance and Migration reviewers to the P0G hardening scope.
  - Added explicit PR 01 wire-format contract requirements for casing, enum
    encoding, nullability, unknown fields, and schema versioning across
    TypeScript and Rust consumers.
  - Limited Think Bigger spec marker discovery to header metadata instead of
    scanning arbitrary body text.
  - Preserved first reference-definition targets in the docs checker when later
    duplicate labels appear.
  - Split retired-record status/lookup semantics from write-time retry expiry:
    `terminal-retired` remains the retained status, while `idempotency-expired`
    is a write replay outcome after the replay horizon.
  - Replaced transient actor/session idempotency binding with stable actor
    identity plus policy-required session-equivalence handling.
  - Required secret-safe operand fingerprints and capture dedup commitments for
    secret-backed writes instead of reusable raw payload hashes.
  - Normalized native filesystem outcome names to the canonical
    `WriteResult.kind` values.
  - Added an in-script checker fixture for duplicate reference definitions.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Bound filesystem capture/replay tokens to
    `(workspaceId, versionId, path, targetObjectId | expectedAbsent)` so
    delete/recreate substitution becomes a conflict instead of an overwrite.
  - Clarified capture/replay tokens are engine-issued and stable across auth
    refreshes, editor restarts, and session rotation.
  - Required read/stat responses for secret-backed paths to omit reusable raw
    `contentHash` values and use opaque authorized hash handles when needed.
  - Made `ChatThreadProjection.linkedWork` a readonly derived cache.
  - Added shared `ThreadLinkCreateRequest` variants for atom/file/folder,
    version, and history-moment links so cross-workspace linked work matches the
    authorization model.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Removed the redundant explicit manifest path from the Think Bigger docs
    workflow path filters; `docs/superpowers/**` already covers it.
  - Made spec discovery depend on the `Think Bigger Spec: true` header marker
    rather than manifest-listed spec paths.
  - Masked inline Markdown links before reference-style scanning and added an
    in-script fixture for link titles containing reference-looking text.
  - Added the `expectedAuthorizedHashHandle` precondition for secret/protected
    freshness in write/delete/rename/move/replace API shapes and aligned the
    secret-backed precondition prose.
  - Removed client-supplied `includeInternal` from status API shape and made
    internal status fields server-derived owner/admin/audit-only data.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Made agent-run state explicitly workspace-scoped in the plan inventory.
  - Clarified that canonical Y.Doc state is the only rich-document write source
    and `atoms.body`/Markdown body caches are read-through derived caches.
  - Added an HTML atom sandbox/sanitization security regression case.
  - Aligned native filesystem write precondition prose with the API shape by
    allowing `expectedAuthorizedHashHandle` for secret/protected freshness.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Added shared `ThreadLinkCreateRequest` support for decision/task targets so
    shared channels can use the same shared-grant/redaction flow.
  - Added API-native `hydrate(...)` and `setPinned(...)` control-plane operations
    for browser/runtime/sandbox clients, preserving `virtual` as the canonical
    non-materialized label and `pinned` as an orthogonal boolean.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-thirty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Updated the Think Bigger docs workflow to the current `pnpm/action-setup`
    v6 commit while keeping the existing pnpm version and install settings.
  - Reworded the early execution-log validation section so it records validation
    evidence instead of implying new tests were added.
  - Added `materializationPresentation` to `WorkspaceStatusPayload` so status can
    distinguish hydrated bytes/projections from placeholders without inventing a
    third persisted materialization state.
  - Scoped `targetObjectId` lookup guidance to overwrite-oriented flows and
    clarified that create-only writes with `expectedAbsent` omit it.
  - Removed `ThreadReadState.readStateRevision` from read-state idempotency
    identity and kept it as a server-owned CAS/stale-write token only.
  - Added a real `Phase 0 Decision Note` execution-log anchor and linked the
    versioned workspace spec to it.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fortieth pass:

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Standardized expired API idempotency retries on
    `kind: 'idempotency-expired'`.
  - Removed deterministic conflict as an allowed outcome for expired idempotency
    keys after `replayUntil`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-first pass:

- Historical PR00 status:
  - CodeRabbit status: eight follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's eight follow-up findings:
  - Removed the empty historical-findings placeholder section from this execution
    log.
  - Added `threadId` to `ChannelTargetActivity` and made channel target
    synchronization authoritative for each `(channelId, threadId)` pair.
  - Extended authorized legal erasure to user-authored `deleteReason` values as
    well as original message bodies.
  - Separated review-required pending states from review-gate denial outcomes.
  - Clarified that capture/replay tokens are opaque, engine-owned guards, with
    client-visible freshness evidence mapped into them by the engine.
  - Split `retentionUntil` semantics by rejected, quarantined, and accepted
    holding record kind.
  - Defined same-path `rename(...)` and `move(...)` as verified no-ops instead
    of delete-plus-create history.
  - Split export verification material between non-secret hashes and
    secret-backed opaque commitments or authorized handles.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-second pass:

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Defined deterministic server normalization for
    `namedSubconversationKey`, including Unicode normalization, trimming,
    casing, validation, and length bounds.
  - Added a pre-opt-in migration path for existing `.versions/**` content, tied
    to the reserved-namespace scan, materialized workspace walker, and
    workspace/version mount resolver.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-third pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Persisted `versionsNamespaceMode` in workspace status and carried it through
    export/re-import so `.versions/**` classification is stable across machines.
  - Clarified replay evaluation as deterministic per attempt while allowing later
    authoritative outcomes to change after durable review, policy, protection, or
    causal-base state changes.
  - Defined entry and exit conditions for `pending_protection`,
    `pending_review`, `pending_canonicalization`, and `overdue_disposition`.
  - Added `ChannelConversationCreateRequest` and
    `SendChannelMessageConversationSelector` so the `named_subconversation` path
    has a raw `namedSubconversationName` input before server normalization.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: two follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two follow-up findings:
  - Made active `ThreadLink` rows the sole canonical source for linked work and
    defined `ChannelTargetActivity`, `Channel.linkedTargets`, and
    `ChatThreadProjection.linkedWork` as derived repair/projection outputs.
  - Removed `retentionUntil` from the `accepted_holding_record` durable-pending
    wire arm and reserved it for `rejected` and `quarantined` retention semantics,
    with `operatorDispositionDueAt` carrying accepted-holding status escalation.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: eight follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's eight follow-up findings:
  - Updated the docs-link checker so HTML comment delimiters inside inline code
    do not hide visible links, and added in-script fixtures for that case.
  - Made the content-driver contract conditional on driver capability, including
    reduced `readOnly` and `internalOnly` surfaces.
  - Added PR 21R as an explicit sync/offline-rejoin milestone with its own
    acceptance gate between PR 21 migration and PR 22 hardening.
  - Persisted `namedSubconversationKeyVersion` alongside
    `namedSubconversationKey` and required retries to compare the stored pair.
  - Added `channelId` to both `SendChannelMessageConversationSelector` branches.
  - Clarified replay identity to hash/compare normalized guard class and value
    instead of raw precondition alias names.
  - Renamed the execution-log template heading to avoid duplicating the stable
    `Phase 0 Decision Note` anchor.
  - Split P0S out of the Phase 0 proof-arc PR lane list into a checkpoint
    subsection.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Tracked whether a fenced code block opened inside a blockquote so
    blockquote-looking fence markers inside normal fences stay code, with an
    in-script fixture.
  - Clarified that legacy unmanaged `.versions/**` entries must be moved,
    reclassified, or preserved outside the skipped namespace before managed
    namespace opt-in finalizes.
  - Added `replayUntil` to `rejected` and `quarantined` write-result arms and
    aligned the surrounding rejection/quarantine prose.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Clarified that holding-area replay metadata uses non-secret content hashes
    only for non-secret-backed objects, and secret-backed objects use secret-safe
    surrogates, keyed commitments, opaque handles, or non-hash CAS tokens.
  - Split capture-token routing so malformed, missing, ambiguous, or wrongly
    scoped tokens use `capture_token_invalid`, while well-formed stale/mismatched
    tokens route to deterministic `conflict`.
  - Moved `linkedTargets` out of the persisted `Channel` shape into
    `ChannelProjection`.
  - Added `dm_thread_relinked` as the concrete activity for immutable DM
    membership transitions, with replay/export continuity rules.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Made the PR 01 baseline-import gate symbol-specific and kept chat bridge
    symbols exempt until the PR 12 ownership boundary.
  - Added an `Unresolved blockers` slot to the Phase 0 decision-note entry
    template.
  - Added history moments to the Phase 0 workspace-scope checklist.
  - Clarified the two-phase write lifecycle for durable recording versus
    canonical acceptance and the pending protection/review/canonicalization
    states.
  - Required holding records and idempotency result metadata to commit in the same
    durability boundary before any replayable non-canonical `WriteResult` is
    acknowledged.
  - Added originating `ThreadLink` identity and server-owned fields to
    `ChannelTargetActivity`.
  - Tightened channel-target retry repair so it verifies exact linked-target
    state and source `ThreadLink` identity before returning an idempotent result.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-forty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added PR13 large chat/channel list performance smoke coverage with
    virtualization/list-windowing expectations.
  - Added PR13 keyboard navigation, focus handling, and screen-reader
    accessibility acceptance gates.
  - Made message create reserve or replay the server-assigned `ThreadMessage.id`
    before parent validation, self-parent checks, and ancestry cycle detection.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fiftieth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Split capture-token validation so syntactically invalid or unparseably scoped
    tokens use `capture_token_invalid`, while valid cross-workspace tokens use
    `cross_workspace_reference`.
  - Added all-or-nothing managed `.versions/**` namespace cutover semantics.
  - Made `requestToken` a declared server-issued echo token across native status,
    hydrate, set-pinned, and async payload shapes.
  - Replaced vague status idempotency wording with
    `idempotencyResultId`/`idempotencyReplayToken`.
  - Required legacy delete activities to carry delete hashes, with
    `legacyHashSource` distinguishing imported-body from redacted-fallback
    evidence.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-first pass:

- Historical PR00 status:
  - CodeRabbit status: one follow-up finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one follow-up finding:
  - Added the public `read_channel_conversation` action as the named recovery
    surface for channel conversation ids, including actor/workspace enforcement,
    recovery of `channelConversationId` together with `threadId`, and a strict
    no-create behavior when no channel thread exists yet.
  - Tied `send_channel_message` to the same canonical resolver while preserving
    first-send creation and exactly-once `chat_created` semantics.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-second pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Kept the Phase 0 watcher-backed normal-folder path directly exercisable while
    leaving later implementation slices behind alpha/non-default/internal paths.
  - Split persisted `WorkspaceStatusPayload` from request-stream freshness
    metadata and added `WorkspaceStatusTransportPayload` for async status
    delivery.
  - Rewrote the historical local-agent CLI log note with neutral dohc-branded
    driver wording.
  - Clarified that idempotency acknowledgement waits for the canonical mutation
    plus durable side-effect ledger/outbox records, while derived side effects
    execute asynchronously.
  - Narrowed `ShareChannelLinkedTargetRef` to shared-scope targets only.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-third pass:

- Historical PR00 status:
  - CodeRabbit status: six follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six follow-up findings:
  - Added a request-only `ChannelLinkedTargetRequestHandle` for linked-work
    channel conversation creation so clients do not submit server-managed share
    grant metadata.
  - Stored `namedSubconversationDisplayLabel` beside the normalized
    named-subconversation key/version for UI, export, rename, and history
    surfaces.
  - Added idempotency requirements for API-originated `hydrate(...)` and
    `setPinned(...)` control-plane writes.
  - Annotated `replace(...)` source and destination `expectedContentHash`
    preconditions as non-secret-backed only.
  - Removed the unnecessary `pnpm --filter dohc` install scope from the Think
    Bigger docs workflow.
  - Replaced the reusable execution-log template pass label with a neutral
    placeholder.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three follow-up findings:
  - Added a durable workspace-wide `versionsNamespaceActivationFence` for
    `.versions/**` activation so scan/move/reclassify cutover cannot be
    half-applied across restart or concurrent writes.
  - Added shared `agent_run`/`chat_thread` create branches to keep
    `ThreadLinkCreateRequest` aligned with the shared target model.
  - Updated the Think Bigger docs link checker to recognize reference-style empty
    angle targets like `[ref]: <>` and report them through the normal empty link
    target validation path.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Broadened the Phase 0 E2E workspace-scope proof to include holding records,
    conflict envelopes, idempotency results/tombstones, and durability-log
    entries.
  - Split chat linked-work read projections into redacted shapes while keeping
    full `ChannelLinkedTargetRef` and `ActiveThreadLink` records internal to
    re-authorized mutation, repair, audit, and replay paths.
  - Made `ThreadLink` the only authoritative repair source for linked-work
    rebuilds; `ChannelTargetActivity` and projections are regenerated output.
  - Converted the secret-backed policy example to TOML to match the
    `.dohc/files.toml` policy section.
  - Expanded `hydrate(...)`/`setPinned(...)` idempotency to bind the full
    operation tuple plus server-derived actor/session identity.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `node <repo-root>/scripts/check-think-bigger-doc-links.mjs` passed
    for 5 discovered Think Bigger docs and the in-script fixtures from `/tmp`.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four follow-up findings:
  - Updated the Think Bigger docs workflow to the `actions/setup-node` v6 pinned
    release.
  - Defined `rename_channel_conversation_label` and
    `NamedSubconversationLabelRenamedThreadActivity` as the canonical
    named-subconversation display-label rename/history path.
  - Added immutable `parentMessageId` to `MessageCreateThreadActivity` so replay
    can reconstruct reply topology.
  - Replaced non-copy-pasteable execution-log template validation commands with
    repo-relative commands.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: eight follow-up findings fixed and one lockfile finding
    verified already satisfied; committed review rerun is required after this
    pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed or verified CodeRabbit's nine follow-up findings:
  - Verified `github-slugger` is already present in `pnpm-lock.yaml` with importer,
    package, and snapshot entries; `pnpm install --lockfile-only --ignore-scripts`
    produced no lockfile diff, aside from the local Node engine warning.
  - Mapped the PR01 Schema Promotion Checkpoint's schema-baseline responsibility
    to P0B and made `Phase0SharedSubstrateBaseline` ownership explicit.
  - Assigned P0E as the single Phase 0 provisional writer for chat thread,
    message, link, and read-state rows, with PR 01 bridge versions and PR 12 final
    ownership boundaries.
  - Made canonical wire-format unknown-field behavior strict: unknown fields are
    rejected unless carried in a declared `extensions` map preserved by the TS and
    Rust conformance paths.
  - Updated the Think Bigger docs checker to ignore backslash-escaped Markdown
    links, autolinks, and raw HTML anchors/links, with regression fixtures.
  - Clarified holding-area replay changes require a durable replay-state mutation
    or attached validation evidence; changing server-side facts alone does not
    alter the replay result.
  - Replaced the undefined native filesystem `deterministic validation` result
    wording with concrete `rejected`, `quarantined`, or `retryable-failure`
    outcomes.
  - Added `namedSubconversationLabelRevision` to named-subconversation provenance
    and rename activities so rename CAS and retries are deterministic.
  - Added a concrete presence/typing signal contract with TTL, refresh, expiry,
    redaction, shared-channel reauthorization, and ThreadMessage tombstone/edit
    degradation rules.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: five follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five follow-up findings:
  - Increased the Think Bigger docs workflow timeout to cover cold install paths.
  - Expanded PR12 `ThreadLink` requirements to retain source/owning workspace ID,
    source thread ID, policy-gated display path/title capture, redacted labels,
    and ACL/degraded-render behavior.
  - Made active `embargoed` visibility a true audience cap for all readers until
    expiry or condition clearance.
  - Required first channel sends to persist the initial `ThreadMessage`,
    `message_created` activity, and `chat_created` provenance in the same
    serialized unit.
  - Reworded the historical `secretProjection` note to use current `local` /
    `virtual` materialization vocabulary and mark the old phrasing as legacy
    history.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-fifty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: seven follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven follow-up findings:
  - Preserved list indentation across list-item indented code blocks in the
    Think Bigger docs checker and added a regression fixture.
  - Added `status`, `hydrate`, and `setPinned` to single-version
    workspace/version filesystem binding examples.
  - Required active `versionsNamespaceActivationFence` state to fail closed for
    default ownership export, with operator migration export/import handling as
    engine-managed migration state.
  - Explicitly mapped secret-broker/declassification gate failures to
    `quarantined_protection` across pending write states.
  - Expanded review approval canonicalization to require the full enforcement
    matrix before commit.
  - Added `nextBodyRevision` to `MessageEditThreadActivity` so replay/export can
    reconstruct post-edit message revision without mutable row state.
  - Made chat presence and typing display labels optional/redactable and
    server-owned.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixtieth pass:

- Historical PR00 status:
  - CodeRabbit status: nine follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's eight major findings and one trivial finding:
  - Updated the Think Bigger docs workflow Node pin to `24.18.0`.
  - Made `VersionRef` a tagged/discriminated reference for versions, fork
    points, and history moments.
  - Centralized the common link dereference payload as `WorkspaceLinkRef` and
    separated chat-only `ThreadLink` storage fields.
  - Clarified that channels/DMs/shared channels own membership and visibility
    while `ChatThread` owns durable message streams.
  - Defined `create_chat` DM participant input through
    `canonicalizeDmParticipantIds` and the 2-16 participant invariant.
  - Required first channel sends to persist both `chat_created` and canonical
    `message_created` activity exactly once with the initial `ThreadMessage`.
  - Replaced silent `.dohc/**` skipping with reserved-internal disposition or
    engine-specific recovery handling.
  - Added `secretProjection` and materialization state to export policy
    envelopes.
  - Added deterministic first-match write-path precedence for authorization,
    visibility, conflict, review, and canonical save outcomes.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-first pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and one trivial finding:
  - Scoped the Think Bigger test matrix to the PR's changed or shipped surface so
    docs-only and unrelated infra PRs are not blocked by future product E2E
    lanes.
  - Added `searchable`, `visibility`, and `agentAccess` to
    `WorkspaceStatusPayload` and required status/export/import to preserve the
    full resolved `FilePolicyBase` tuple.
  - Split `MessageDeleteLegacyThreadActivity` into a tagged shape where
    `imported_body` requires `previousBody` and `redacted_fallback` may omit it.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-second pass:

- Historical PR00 status:
  - CodeRabbit status: four follow-up findings handled; three fixed and one
    lockfile warning verified stale. A committed review rerun is required after
    this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three still-valid major findings:
  - Replaced the fixed 12-line Think Bigger spec metadata scan with a complete
    metadata-header parser that reads fenced front matter or the full initial
    metadata block.
  - Made post-opt-in unmanaged `.versions/**` entries discoverable through the
    reserved-namespace scan/watcher and workspace/version mount resolver failure
    path before quarantine/manual resolution.
  - Added `secretProjection` to the export/re-import resolved policy tuple and
    made missing/incompatible tuple data fail closed.
- Verified stale CodeRabbit finding:
  - `package.json` and `pnpm-lock.yaml` are already synchronized for
    `github-slugger`; `pnpm install --lockfile-only --ignore-scripts` produced no
    package or lockfile diff.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --lockfile-only --ignore-scripts`
    passed with no package or lockfile diff.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-third pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three major findings:
  - Made `retryable-failure` table rows explicitly require a durable retryable
    idempotency result and aligned them with `commitState` semantics.
  - Split malformed/cross-scope binding validation from well-formed stale or
    object-mismatched capture-token conflicts.
  - Routed legacy chat-delete redacted fallback evidence through the server-held
    keyed digest/MAC service instead of a deterministic plaintext hash.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: three follow-up findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three major findings:
  - Replaced regex-only inline Markdown link/image extraction with a balanced
    bracket scanner and added nested-label fixture coverage.
  - Added explicit retirement/retry rules for `rejected_record` and
    `quarantined_record` transitions into `terminal-retired`.
  - Required chat message mutations to resolve messages by
    `(workspaceId, threadId, messageId)` instead of `messageId` alone.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: two trivial findings and one minor finding fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two trivial findings and one minor finding:
  - Updated the Think Bigger docs workflow checkout pin to
    `actions/checkout` v6.0.3.
  - Consolidated native-filesystem status write state through
    `WorkspaceWriteState`, a durable subset derived from the canonical
    write-result vocabulary.
  - Extended request-token/workspace/version stale-response guards to delayed
    write-producing acknowledgements for `write(...)`, `merge(...)`, and
    `restore(...)`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: one major finding and one minor finding fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one major finding and one minor finding:
  - Added `recursive` to the `hydrate(...)` idempotency operation tuple while
    keeping `pinned` scoped only to `setPinned(...)`.
  - Named the complete `FilePolicyBase` export policy tuple up front, including
    materialization, secret-backed status, `secretProjection`, source ordinal,
    and rule index.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: one major finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one major finding:
  - Added policy-denial handling to the immediate-write first-match decision
    order before content comparison, conflict, review, or clean-write handling.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings and three minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings and three minor findings:
  - Consolidated the PR01 Schema Promotion Checkpoint handoff into one canonical
    checkpoint narrative for `Phase0SharedSubstrateBaseline`.
  - Extended the schema-drift gate to cover `WorkspaceLinkRef`, projection
    writeability/validation, and effective-policy boundary contracts.
  - Added `retention_expired` to `TerminalRetirementReason`.
  - Removed watcher/session/process identity from filesystem dedupe identity,
    keeping the engine-owned opaque capture/replay token authoritative.
  - Recognized same-line list fenced-code blocks in the Think Bigger docs
    checker and added a fixture.
  - Renamed the export/re-import policy envelope wording from `FilePolicyBase`
    to the full resolved policy tuple when `secretProjection` is included.
  - Replaced branded `WorkspaceWriteState` with an explicit durable status union
    that excludes `idempotency-expired`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-sixty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: eight follow-up findings handled; seven fixed and one
    lockfile warning verified stale. A committed review rerun is required after
    this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's seven still-valid findings:
  - Made forged actor/workspace/version metadata a hard bridge reject in the
    Phase 0 search/policy tests.
  - Updated inline-link extraction to ignore link-like text inside already
    parsed link titles and added fixture coverage.
  - Removed watcher/session ids from filesystem-captured save dedupe identity.
  - Split `hydrate(...)`/`setPinned(...)` idempotency identity from server-issued
    `requestToken` transport correlation.
  - Added async transport wrappers for list/search/snapshot/watch payloads using
    `WorkspaceAsyncPayload`.
  - Made absent, unauthorized, revoked, and ambiguous channel conversation reads
    share the same observable `needs_first_send`/`not_found` outcome.
  - Required `createdBy` and `actorDisplayLabel` identity labels to be treated as
    untrusted text across rendering, projection, notification, and export.
- Verified stale CodeRabbit finding:
  - `package.json` and `pnpm-lock.yaml` remain synchronized for `github-slugger`;
    `pnpm install --lockfile-only --ignore-scripts` produced no package or
    lockfile diff.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --lockfile-only --ignore-scripts`
    passed with no package or lockfile diff.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventieth pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and two minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and two minor findings:
  - Preserved empty Markdown link destinations so later validation can flag empty
    targets.
  - Excluded root-level indented code that looks like a Markdown list from link
    extraction, with fixture coverage.
  - Added the Phase0SharedSubstrateBaseline / P0S prerequisite to the Phase 0
    gate checklist and clarified promotion is gated by policy, review, and
    validation.
  - Added the concrete `ReadChannelConversationResult` response union.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd /tmp && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-first pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and one trivial finding fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and one trivial finding:
  - Moved HTML-comment stripping behind indented-code detection in the Think
    Bigger docs checker and added fixture coverage for indented code containing
    an unclosed `<!--` marker.
  - Centralized schema ownership wording so later sections reference the
    ownership matrix for adoption, bridge, and migration/backfill rules instead
    of restating ownership locally.
  - Updated the execution-log validation template to use `${TMPDIR:-/tmp}` for
    the run-from-another-cwd docs-link check.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-second pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings, two minor findings, and one trivial
    finding fixed; committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings, two minor findings, and one trivial
  finding:
  - Clarified that PR 01 is the sole `chat-read-state-bridge-v0`
    read-state bridge owner before the PR 12 handoff, while PR 12 owns only the
    final post-handoff read-state lifecycle.
  - Broadened raw HTML anchor collection so non-`a` start tags with `id`
    attributes produce local anchors, while `name` remains `a`-tag-only.
  - Added `restoreReason` text-safety rules matching the existing
    `deleteReason` escape/sanitize/redact contract.
  - Split ownership denial from review-gate denial so `review_gate_denied` is
    reserved for actual review-gate failures.
  - Refactored the `WriteResult` contract around shared workspace/version and
    idempotency envelopes to reduce drift across union arms.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-third pass:

- Historical PR00 status:
  - CodeRabbit status: one trivial finding and three minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one trivial finding and three minor findings:
  - Reused one YAML-anchored docs path list for both pull request and push
    triggers in the Think Bigger docs workflow.
  - Required the Think Bigger docs manifest to contain at least one unique
    string entry.
  - Replaced the historical placeholder docs-link validation command with the
    exact runnable `REPO_ROOT=...` form.
  - Simplified the PR00 pointer label to avoid a duplicated "PR" token.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and two minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and two minor findings:
  - Added explicit secret-broker/declassification denial and quarantine mapping
    to replay ordering, pending-state transitions, and public denial codes.
  - Made `read_channel_conversation` return one opaque
    `conversation_unavailable` result for unauthorized, revoked, absent, and
    ambiguous lookups, with `needs_first_send` kept internal to send flow.
  - Hardened Markdown destination parsing and normalization for escaped
    punctuation such as `\)`, with inline and reference fixtures.
  - Restricted heading HTML stripping to actual raw HTML tags so literal
    comparison text such as `A < B > C` survives slug generation.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings and one minor finding fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings and one minor finding:
  - Split PR 01 into separate reviewable slices for canonical schema/IDL, wire
    format/runtime conformance, link/projection contracts, and core effective
    policy.
  - Defined one shared first-match gate order for fresh writes and replay
    attempts.
  - Clarified `expectedAbsent` / `path_absence` as create/destination absence
    semantics rather than an object freshness proof.
  - Required shared chat target shapes to serialize absent `targetVersionRef` as
    explicit `null`.
  - Added `nextPageToken` to list/search transport payloads so clients can
    resume the same authorized snapshot.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: five major findings, one minor finding, and one trivial
    finding fixed; committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five major findings, one minor finding, and one trivial
  finding:
  - Clarified retryable-failure taxonomy for evaluator/service failures,
    unknown acknowledgement state, and conflict-envelope persistence failures.
  - Added persisted `versionsNamespaceActivationFence` status for `.versions/**`
    cutovers.
  - Made the execution-log header point to a single mutable live-status block
    and marked other summaries as derived/read-only.
  - Marked Rust benchmark and bridge recommendation evidence as intentionally
    deferred to P0R until recorded or explicitly deferred by the user.
  - Hardened docs-link parsing so destinations are extracted from the raw
    code-span-stripped line while escaped openers remain filtered.
  - Required every non-versioned link activity target to serialize
    `targetVersionRef: null`.
  - Split public `read_channel_conversation` provenance from internal
    `ChannelConversationProvenance`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: three major findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three major findings:
  - Added migration generation, activation decision, and planned legacy-path
    outcomes to `VersionsNamespaceActivationFence`.
  - Clarified that failed persistence of retryable-failure idempotency state
    must surface as a non-acknowledged transport/timeout failure, not a
    replayable `WriteResult`.
  - Aligned `share` link request, shared-target, stored-link, and activity
    handling around `targetVersionRef: null`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: one major finding and two minor findings fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one major finding and two minor findings:
  - Removed the execution-log pointer to an undefined `Current PR Snapshot`.
  - Made the docs-link checker skip top-of-file front matter before body
    link/anchor collection, with fixtures for hidden front matter links and
    setext-like text.
  - Changed `plannedLegacyPathOutcomes` to canonical `pathToken` entries and
    documented path-normalized serialization/deserialization behavior.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-seventy-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and one minor finding fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and one minor finding:
  - Made `ChannelTargetActivity` a derived repair/output ledger behind
    authoritative `ThreadLink` durability, so derived-ledger outages cannot
    block valid link mutations or idempotent retries.
  - Added explicit `synced` and `pinned` fields to the later secret-backed `.env`
    policy example.
  - Distinguished immutable accepted-holding replay metadata from compactable
    derived retry/index state until the record is no longer replayable.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eightieth pass:

- Historical PR00 status:
  - CodeRabbit status: five major findings, one minor finding, and one trivial
    finding fixed; committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five major findings, one minor finding, and one trivial
  finding:
  - Marked the shared substrate projection/link vocabulary as provisional until
    PR 01C adopts or replaces it canonically.
  - Aligned the P0F provisional effective-policy hook with the PR 04 resolver
    surface names for file, thread-link, chat-projection, and search indexing.
  - Made `VersionsNamespaceActivationFence` a stricter discriminated union and
    added the missing `UnixMsDecimalString` alias.
  - Replaced vague subagent review notes with dated, traceable artifact
    references.
  - Removed a stale historical `Current PR Snapshot` reference.
  - Refactored `ThreadMessage` into strict live/deleted row unions for
    tombstone-field consistency.
  - Added `create_channel` and `get_or_create_channel` to the chat action
    inventory.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-first pass:

- Historical PR00 status:
  - CodeRabbit status: three major findings and one minor finding fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three major findings and one minor finding:
  - Moved `materialized` out of durable `FilePolicyBase` and policy
    export/import tuples, leaving it as runtime status hydration state.
  - Clarified watch/snapshot/diff secret-safe projection defaults while allowing
    authorized plaintext materialization through the secret-aware server path.
  - Replaced an archived legacy brand mention with neutral collaborative-editor
    wording.
  - Added `namedSubconversationKeyVersion` to the deterministic
    `channelConversationId` identity tuple.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-second pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings, one minor finding, and two trivial
    findings fixed; committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings, one minor finding, and two trivial
  findings:
  - Erased autolink spans before reference-link parsing in the docs checker.
  - Added a native filesystem write/status lifecycle transition table.
  - Added `WorkspaceDiffTransportPayload` and aligned `diff(...)` with
    secret-safe async transport freshness semantics.
  - Clarified that immediate file saves become canonical only after synchronous
    gates pass, while async review/canonicalization may return `durable-pending`.
  - Added rename/move guard coverage to the versioned-workspace E2E proof slice.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-third pass:

- Historical PR00 status:
  - CodeRabbit status: three minor findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three minor findings:
  - Replaced the stale `actions/checkout` version note in the Think Bigger docs
    workflow with a neutral pinned-SHA note.
  - Marked `ThreadReadState` workspace/thread/actor identity fields as
    `readonly`.
  - Marked immutable `ThreadMessageBase` message identity, ancestry, sequence,
    and creation timestamp fields as `readonly`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: five major findings, one minor finding, and one trivial
    finding fixed; committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five major findings, one minor finding, and one trivial
  finding:
  - Added execution-log structure validation to the Think Bigger docs checker and
    PR00 checker contract.
  - Moved Think Bigger spec-marker file reads into the guarded discovery block.
  - Required retained idempotency expiry sentinels or namespace watermarks before
    compacting terminal tombstones.
  - Clarified deferred-review holding records versus immediate-save eligibility.
  - Added public `namedSubconversationLabelRevision` provenance for safe channel
    conversation label renames.
  - Added optional `parentMessageId` targeting to `reply_to_chat`.
  - Reworded derived status summaries so `Live PR00 status` is the only writable
    status source of truth.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings and one trivial finding fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings and one trivial finding:
  - Bounded execution-log structure checks to the intended `Current PR Pointer`,
    `How To Use This Log`, and PR00 section slices.
  - Added source mount binding to native file-watch capture deduplication.
  - Split `write(...)` request preconditions into mutually exclusive create and
    overwrite variants.
  - Added conflict-envelope persistence retry handling to the normative
    gate/retry matrix.
  - Restored the `actions/checkout` `v6.0.3` comment after verifying the pinned
    SHA resolves to `refs/tags/v6.0.3^{}`.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-sixth pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and three minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and three minor findings:
  - Collapsed the live roadmap/checkpoint wording onto the single
    **PR01 Schema Promotion Checkpoint** name.
  - Changed `WriteResultEnvelope` to carry `requestedVersionIds` and documented
    full-version-set acknowledgement correlation.
  - Added checker guards and fixtures for list-item setext false positives.
  - Added odd/even backslash escape handling and fixtures for inline links, raw
    HTML links, and autolinks.
  - Added `diffStreamId` to diff transport payloads and async stale-response
    checks.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-seventh pass:

- Historical PR00 status:
  - CodeRabbit status: five major findings and two minor findings fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's five major findings and two minor findings:
  - Added `Accessibility` to the reusable subagent-review template.
  - Added `agent_run` to the workspace-scope proof checklist.
  - Replaced the non-symbol stable-object-id matrix entry with explicit prose and
    added the Phase 0 effective-policy symbols/surface hooks to the ownership
    matrix.
  - Clarified that PR 12 read-state storage/API ownership starts only after the
    explicit `chat-read-state-bridge-v0` handoff from PR 01.
  - Aligned `hydrate(...)` and `setPinned(...)` replay identity with the later
    stable actor/runtime/mount/session-equivalence rule.
  - Replaced raw HTML attribute matching with a quoted-value-safe scanner and
    added fixtures for `href`/`id` text inside data attributes.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-eighth pass:

- Historical PR00 status:
  - CodeRabbit status: six major findings and one minor finding fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's six major findings and one minor finding:
  - Split diff async payload validation from generic `WorkspaceAsyncPayload`
    validation and required `diffStreamId`, version pair, request token, and
    sequence freshness.
  - Tightened malformed inline/reference link-title parsing and added regression
    fixtures.
  - Clarified deterministic capture-token invalidity versus transient proof gaps
    that return `retryable-failure`.
  - Added shared-channel presence/typing redaction for `actorId`, `sessionId`,
    display labels, and parent-message identity.
  - Added reactions and reaction actor details to shared-channel
    re-authorization/redaction rules.
  - Added the missing `Accessibility` entry to the live PR00 subagent review
    summary.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-eighty-ninth pass:

- Historical PR00 status:
  - CodeRabbit status: two major findings and two minor findings fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's two major findings and two minor findings:
  - Clarified that P0B/main are interim stewards of the provisional baseline and
    PR 01 is sole canonical owner after the Schema Promotion Checkpoint handoff.
  - Split `WorkspacePagedAsyncPayload` from the shared async payload so only
    paginated list/search flows carry cursor metadata.
  - Mapped missing overwrite `targetObjectId` to `missing_precondition` or
    `invalid_request`, leaving `capture_token_invalid` for malformed capture
    tokens.
  - Changed aggregate docs-checker failure reporting to set `process.exitCode`
    after printing all failures so CI stderr can flush.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninetieth pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings and two minor findings fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings and two minor findings:
  - Clarified that `Phase0SharedSubstrateBaseline` is authoritative only
    pre-adoption and per-symbol until PR 01 migrates each symbol.
  - Added lockfiles to the Think Bigger docs workflow trigger description.
  - Added `requestedVersionIds` and canonical version binding to the immutable
    accepted-holding replay tuple.
  - Expanded durable-pending denial mappings for policy, visibility, provenance,
    attribution, proof, lock, version-access, and skill-turn gates.
  - Added `shareGrantHandle` to share-target request handles while keeping stored
    `shareGrantId` server-derived.
  - Reworded `reactionKey` as canonical reaction text instead of a Unicode scalar
    string.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-first pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings and two minor findings fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings and two minor findings:
  - Renamed the live handoff to **Phase 0 Schema Promotion Checkpoint** so it is
    distinct from PR 01.
  - Added PR 01C ownership for `WorkspaceLinkRef` and projection
    writeability/validation values.
  - Added PR 01D ownership for the core effective-policy boundary.
  - Expanded status/export policy preservation to the full `FilePolicy` shape,
    including `encrypted` and `secretProjection`.
  - Expanded quarantined-record metadata to include `operatorDispositionDueAt`,
    `retentionUntil`, and `quarantineState`.
  - Clarified malformed capture tokens versus well-formed stale capture-token
    conflicts.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-second pass:

- Historical PR00 status:
  - CodeRabbit status: one major finding and one minor finding addressed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Addressed CodeRabbit's one major finding and one minor finding:
  - Verified `github-slugger@^2.0.0` is reflected in `pnpm-lock.yaml` root
    importer, package snapshot, and resolution snapshot; rerunning
    `pnpm install --lockfile-only --ignore-scripts` produced no additional
    lockfile diff.
  - Renamed the public durable-pending holding-record state field from
    `pendingState` to `lifecycleState` so `overdue_disposition` is expressed as
    part of the accepted holding record lifecycle instead of a pending-only
    state.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-third pass:

- Historical PR00 status:
  - CodeRabbit status: three major findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's three major findings:
  - Split the durable-pending taxonomy into explicit `kind`, `recordKind`, and
    `lifecycleState` axes and mapped retired holding records to
    `terminal-retired`/`idempotency-expired` handling.
  - Defined exact `requestedVersionIds` role ordering for single-version,
    replace, restore, merge, and future multi-source operation fingerprints.
  - Added `shareGrantHandle` to thread-link share creation requests and required
    fail-closed server resolution before creating links, fanout, projections,
    search edges, or export references.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-fourth pass:

- Historical PR00 status:
  - CodeRabbit status: one major finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's one major finding:
  - Aligned restore replay identity with the API sketch by keeping
    `requestedVersionIds` limited to the restore target version and binding the
    stable `checkpointId` in the operation operand tuple instead of using a
    `restoredFromVersionId` alias.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-fifth pass:

- Historical PR00 status:
  - CodeRabbit status: four major findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.
- Fixed CodeRabbit's four major findings:
  - Scoped the no-time-only-retirement guarantee to still-`durable-pending`
    accepted holding records while preserving retention-expiry retirement for
    rejected and quarantined records.
  - Replaced mixed merge/restore replay wording with one API-derived stable
    operand tuple per operation before validation.
  - Added definitive captured-write rejection transitions to the native
    filesystem lifecycle table and kept `idempotency-expired` as retry-only.
  - Split redacted linked-work projections from internal/audit projections so
    shared/public channel and thread reads expose only opaque handles.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-sixth pass:

<a id="historical-pr00-status-296"></a>

### Historical PR00 Status - Pass 296

Historical status snapshot.

- Historical PR00 status:
  - CodeRabbit status: three major findings and three minor findings fixed;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's three major findings and three minor findings:
  - Split the Phase 0 baseline freeze from the PR 01 canonical adoption handoff
    and updated related schema-ownership references.
  - Made PR 01B Rust wire-format ownership conditional on the Rust crate landing;
    otherwise the Rust symbols remain inert conformance-fixture names.
  - Split versions-namespace activation fences into explicit real transitions so
    no-op `fromMode`/`toMode` pairs are unrepresentable.
  - Moved secret-backed `secretProjection`/`materialized` consistency checks to
    WorkspaceStatusPayload assembly or status-side validation, leaving policy
    import/export builders independent of runtime materialization.
  - Scoped Phase 0 performance measurement checklist items to P0R and later
    implementation lanes so PR00 remains a docs-only deferral.
  - Promoted the current mutable PR00 status to this dedicated heading and
    `LivePR00Status` symbol.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-seventh pass:

### Historical PR00 Status - Pass 297

Historical status snapshot.

- Historical PR00 status:
  - CodeRabbit status: six major findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's six major findings:
  - Separated pre-auth local spool/quarantine metadata from workspace durability
    capture in the native filesystem spec.
  - Tightened versions-namespace activation fence variants so activate and
    rollback states cannot carry the wrong transition.
  - Hardened the Think Bigger docs checker to locate execution-log contract
    markers through anchored heading and line-boundary matching.
  - Defined `channel-slug-v1` normalization, uniqueness, collision, and redirect
    behavior for channel lookup aliases.
  - Separated pre-persistence immediate denials from post-acceptance durable
    `rejected`/`quarantined_*` outcomes in the versioned write flow.
  - Defined `channel-conversation-id-v1` deterministic serialization and hashing
    for default, linked-work, and named-subconversation channel threads.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-eighth pass:

### Historical PR00 Status - Pass 298

Historical status snapshot.

- Historical PR00 status:
  - CodeRabbit status: one major finding and three minor findings fixed; the
    parser-backed checker rewrite suggestion was narrowed by routing
    execution-log contract checks through prose-aware `contentLines()`;
    committed review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's one major finding and three minor findings:
  - Made `retryable-failure` persistence rules consistent: returned retryable
    failures are durable idempotency results, otherwise callers see transport
    failure/timeout and retry the same key.
  - Replaced ambiguous `targetVersionId: versionId` replay labels for
    single-version `replace` and `restore` operations with `[versionId]`.
  - Removed the explicit live-status HTML anchor so the `Live PR00 Status`
    heading owns the generated fragment.
  - Routed execution-log contract checks through prose-aware `contentLines()`
    before anchored marker/heading matching, avoiding fenced-code/comment
    false positives without replacing the whole link checker.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Two-hundred-ninety-ninth pass:

### Historical PR00 Status - Pass 299

Historical status snapshot.

- Historical PR00 status:
  - CodeRabbit status: one major finding and one trivial finding fixed; committed
    review rerun is required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's one major finding and one trivial finding:
  - Mapped known engine-owned `.dohc/**` reserved namespace material to existing
    `quarantined`/`quarantined_protection` write-state handling with explicit
    `reservedNamespaceReason` status metadata.
  - Split the dense `ThreadReadState` ownership matrix row into separate
    read-state and projection rows that distinguish P0E provisional fixtures,
    PR 01 `chat-read-state-bridge-v0` responsibility, and PR 12 final ownership.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Three-hundredth pass:

### Historical PR00 Status - Pass 300

Historical status snapshot.

- Historical PR00 status:
  - CodeRabbit status: two minor findings fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's two minor findings:
  - Made archived historical-status headings unique by pass number to avoid
    duplicate generated anchors.
  - Reworded mandatory-review pending writes to say no canonical
    workspace/object state is mutated before review approval.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Three-hundred-first pass:

### Historical PR00 Status - Pass 301

Mutable status symbol: `LivePR00Status`.

- Historical PR00 status:
  - CodeRabbit status: one major finding fixed; committed review rerun is
    required after this pass is pushed.
  - Test evidence: validation block below passed for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: CodeRabbit committed review rerun remains pending; the
    PR00 docs-only local-agent-CLI exception remains pending human approval.
  - Completion state: not complete or merge-ready until CodeRabbit is clean and
    the docs-only local-agent-CLI exception is approved.

- Fixed CodeRabbit's one major finding:
  - Added authorization and ownership to durable-pending `lifecycleState`
    evaluator entry/exit coverage with explicit `quarantined_authorization` and
    `quarantined_ownership` mappings.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - CodeRabbit committed review rerun remains pending.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Three-hundred-second pass:

### Historical PR00 Status - Pass 302

Mutable status symbol: `LivePR00Status`.

- Historical PR00 status:
  - CodeRabbit status: per 2026-06-29 user direction, CodeRabbit is now a
    major-gate reviewer rather than a per-fix rerun. The in-flight committed
    review was cancelled after a prior rate-limit wait; the next CodeRabbit run
    is deferred until PR00 final readiness or another material risk gate.
  - Test evidence: validation block below must pass for this patch set before
    commit.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: no new CodeRabbit findings are being solicited for
    this narrow policy/log patch; the PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Completion state: not complete or merge-ready until the required major-gate
    review/approval policy is satisfied and the docs-only local-agent-CLI
    exception is approved.

- Updated review policy:
  - Changed the mega plan from per-fix/per-PR CodeRabbit reruns to local
    validation on every meaningful change plus CodeRabbit at major readiness,
    security, architecture, data-loss, and final merge gates.
  - Recorded that CodeRabbit rate limits should not stall useful local progress
    at non-final checkpoints.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Three-hundred-third pass:

### Historical PR00 Status - Pass 303

- Historical mutable status symbol: `LivePR00Status`.

- Historical PR00 status:
  - CodeRabbit status: PR00 and P0A-P0G draft PR checks currently pass; future
    manual CodeRabbit reruns remain deferred to major readiness/material-risk
    gates under the 2026-06-29 user-directed review policy.
  - Test evidence: PR00 docs-only local validation remains green; the pushed
    P0A-P0G proof stack is locally validated through
    `codex/think-bigger-p0g-proof-qa` at commit `090702d7`. GitHub Actions did
    not start runners because the GitHub billing/spending limit gate blocked
    jobs before any workflow step ran.
  - Open overrides: none approved. The PR00 docs-only local-agent-CLI exception
    remains pending human approval.
  - Unresolved findings: GitHub Actions billing/spending-limit blocker prevents
    fresh remote CI; the PR00 docs-only local-agent-CLI exception remains
    pending human approval.
  - Completion state: not complete or merge-ready until remote CI can run or the
    user explicitly accepts the external CI blocker for PR00, the required
    major-gate review policy is satisfied, the P0A-P0G draft lane PRs are
    approved or explicitly accepted, and the docs-only local-agent-CLI exception
    is approved.

- CI investigation:
  - `gh run view 28526764674 --verbose` for `Think Bigger Docs / Link And Anchor Check`
    reported: "The job was not started because recent account payments have
    failed or your spending limit needs to be increased."
  - `gh run view 28526764899 --verbose` for `Desktop Release / Preflight`
    reported the same GitHub Actions billing/spending-limit annotation.
  - Latest PR00 reruns `28529507112` (`Think Bigger Docs / Link And Anchor Check`)
    and `28529507111` (`Desktop Release / Preflight`) reported the same
    GitHub Actions billing/spending-limit annotation on 2026-07-01.
  - Both failed jobs had empty step lists and no runner assignment, so no
    repository code or workflow command executed before failure.
- Validation:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- P0 proof stack status:
  - P0A, P0R, P0B, P0C, P0D, P0E, P0F, and P0G branches are pushed and
    stacked in order through `codex/think-bigger-p0g-proof-qa` commit
    `090702d7`.
  - Draft stacked lane PRs are open:
    P0A [#47](https://github.com/dohc-ai/dohc/pull/47),
    P0R [#48](https://github.com/dohc-ai/dohc/pull/48),
    P0B [#49](https://github.com/dohc-ai/dohc/pull/49),
    P0C [#50](https://github.com/dohc-ai/dohc/pull/50),
    P0D [#51](https://github.com/dohc-ai/dohc/pull/51),
    P0E [#52](https://github.com/dohc-ai/dohc/pull/52),
    P0F [#53](https://github.com/dohc-ai/dohc/pull/53), and
    P0G [#54](https://github.com/dohc-ai/dohc/pull/54).
  - `gh pr checks` reports CodeRabbit passing on PR00 [#46] and all draft lane
    PRs [#47-#54]. No manual per-fix CodeRabbit rerun was invoked.
  - Latest P0G local validation passed: docs link checks, workspace-engine
    177 tests, workspace-history 47 tests, workspace-fs 40 tests,
    workspace-core 108 tests, MCP 58 tests, workspace-api share-revocation
    18 tests, workspace-postgres schema 2 tests, Rust fmt/test/bench smoke,
    package typechecks, Codex local-agent smoke, and Claude Sonnet local-agent
    compatibility smoke.
  - Live-pg `shares.test.ts` remains externally blocked in this local WSL
    environment by `ECONNREFUSED 127.0.0.1:54329`; Docker is not installed in
    the distro, so the local Postgres service cannot be started here.
- Unresolved findings:
  - External GitHub Actions billing/spending-limit blocker prevents remote CI.
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - None approved.

Three-hundred-fourth pass:

### Live PR00 Status

Mutable status symbol: `LivePR00Status`.

- Live PR00 status:
  - CodeRabbit status: PR00 and P0A-P0G draft PR checks currently pass. Future
    manual CodeRabbit reruns remain deferred to major readiness/material-risk
    gates under the 2026-06-29 user-directed review policy.
  - Test evidence: PR00 docs-only local validation remains green; the pushed
    P0A-P0G proof stack is locally validated through
    `codex/think-bigger-p0g-proof-qa` at commit `090702d7`. GitHub Actions are
    disabled/skipped as of the 2026-07-02 user direction, so old red PR Action
    statuses are not blockers for this initiative while Actions remain disabled.
  - Open overrides: the user explicitly approved skipping GitHub PR Actions
    from now on and disabling GitHub Actions for now. The PR00 docs-only
    local-agent-CLI exception remains pending human approval.
  - Unresolved findings: the PR00 docs-only local-agent-CLI exception remains
    pending human approval.
  - Completion state: not complete or merge-ready until the required
    major-gate review policy is satisfied, the P0A-P0G draft lane PRs are
    approved or explicitly accepted, and the docs-only local-agent-CLI
    exception is approved. Remote GitHub Actions are not a completion blocker
    while disabled by user direction.

- GitHub Actions policy update:
  - `gh workflow disable 299787992` disabled `Desktop Release`.
  - `gh workflow disable 304500458` disabled `Think Bigger Docs`.
  - `gh workflow list --all` confirmed both workflows as `disabled_manually`.
  - `gh pr checks 46 --required` reported no required checks.
  - `gh pr checks 46` still shows the historical red `Link And Anchor Check`
    and `Preflight` runs, but those are old pre-run billing-limit failures and
    no longer gate progress under the 2026-07-02 user direction.
- Validation for this policy/log patch:
  - `git diff --check` passed.
  - `node scripts/check-think-bigger-doc-links.mjs` passed for 5 discovered
    Think Bigger docs and the in-script fixtures.
  - `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
    passed for 5 discovered Think Bigger docs and the in-script fixtures.
  - `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/web test src/__tests__/brandNoLegacy.test.ts`
    passed with 1 file and 2 tests.
- Unresolved findings:
  - The PR00 docs-only local-agent-CLI exception remains pending human approval
    before completion or merge-readiness.
- Overrides:
  - User approved skipping GitHub PR Actions from now on and disabling GitHub
    Actions for now on 2026-07-02.

### Unresolved Findings

- GitHub Actions are intentionally disabled/skipped by 2026-07-02 user
  direction and are not an active blocker while disabled.
- CodeRabbit checks currently pass on PR00 and P0A-P0G draft lane PRs; manual
  reruns remain deferred to the next major readiness/material-risk gate under
  the updated review policy.
- The PR00 docs-only local-agent-CLI exception remains pending human approval
  before completion or merge-readiness.

### Subagent Reviews

- Architecture: 2026-06-23 PR00 architecture review incorporated into
  `2026-06-23-think-bigger-dohc-workspace-engine.md` Phase 0 PR lanes and PR 01
  split sections.
- Security: 2026-06-23 PR00 security review incorporated into the versioned,
  native-filesystem, and chats specs' authorization, policy, secret, and
  visibility-gate contracts.
- QA: 2026-06-23 PR00 QA review incorporated into this execution log's
  validation template, Phase 0 gate checklist, and CodeRabbit major-gate
  evidence blocks.
- Accessibility: N/A for PR00 docs-only scaffold beyond the accessibility gate,
  reviewer slot, and future evidence template already added to the plan/log.
- Other: 2026-06-23 external architecture review incorporated into the Rust
  kernel boundary questions and the Phase 0/P0R deferral evidence.

### Security / Privacy Notes

- No production code or permission behavior changed.

### Performance Notes

- Budget areas touched: planning only.
- Metrics: runtime metrics are intentionally deferred for PR00. P0R must record
  Rust vs TypeScript scan/reconcile/hash baseline numbers before the Phase 0
  proof arc can satisfy the Rust performance gate.
- Cold/warm distinction: not applicable.
- Workspace/file/chat sizes: not applicable.
- Machine/CI context: not applicable.
- Budget pass/fail: not applicable.
- Jank/blocking notes: not applicable.
- Regression risk: none for runtime.
- Follow-up required: P0R must record the Rust bridge, packaging, CI, crash
  recovery, logging, and upgrade recommendation or document an explicit user
  deferral before Phase 0 completion.
- Follow-up required: implementation PRs must record measurements.

### Migration Notes

- No migrations.

### Remaining Risk

- Phase 0 scope is large and should still be reviewed as stacked lane PRs
  before merge.
- P0A-P0G branches are pushed, draft lane PRs are open, and the stack is locally
  validated through P0G, but final lane PR approval and CodeRabbit major-gate
  reviews are still pending.

### Follow-Up / Deletion Conditions

- Keep this log until the Think Bigger initiative is complete or superseded.

## PR P0A - Current System Inventory And Decisions

Status: restacked on current PR00; not approved
Branch: codex/think-bigger-p0a-inventory
Worktree: `/home/ice/dev/dohc-p0a-inventory`
Implementation chat/thread: main orchestration thread + explorer subagents
PR Link: [#47](https://github.com/dohc-ai/dohc/pull/47)
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
      automated review.
- [x] Wire share revocation to configured Hocuspocus admin
      disconnect-by-workspace-user hook after CodeRabbit review.
- [ ] Open the P0A lane PR only after PR00 external CI/docs-only exception
      handling and final approval clear; after that approval, use either the
      normal base or a stacked PR target according to the stack state, and do
      not merge P0A until its tests and required CodeRabbit major gate clear.

### Files Changed

- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
- docs/superpowers/plans/2026-06-23-think-bigger-docs.manifest.json
- docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md
- packages/workspace-fs/src/scan.ts
- packages/workspace-fs/src/scan.test.ts
- packages/workspace-postgres/src/db/migrations/0007_share_revocation_retry_events.sql
- packages/workspace-postgres/src/db/migrations/0008_share_revocation_claimed_retry_events.sql
- packages/workspace-postgres/src/db/schema.ts
- packages/workspace-postgres/src/db/schema.test.ts
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
P0A_WORKTREE=/path/to/dohc-p0a-inventory
git worktree add -b codex/think-bigger-p0a-inventory "$P0A_WORKTREE" HEAD
git status --short --branch
find apps -maxdepth 3 -name AGENTS.md -print
sed -n '1,260p' apps/web/AGENTS.md
rg --files -g 'package.json' -g 'pnpm-lock.yaml' -g 'turbo.json' -g 'vite.config.*' -g 'playwright.config.*' -g 'convex.json' -g 'schema.ts' -g '*.config.ts'
find packages/workspace-contracts packages/workspace-core packages/workspace-fs packages/workspace-history packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop/src/workspaces apps/desktop/src/agents apps/desktop/e2e -maxdepth 2 -type f \( -name '*.ts' -o -name '*.tsx' \) | sort
git diff --check
rg -n "Subagent evidence|Postgres|atoms.body|write-policy parity|scanWorkspaceFiles|Startup reconciliation|MCP direct-history|ChatThread|Channel|DM|ThreadMessage|read-state|Phase 0 Decisions|P0R|DOHC_TEST_AGENT_CLI" docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md
rg -n '\[[^\]\[]+\]\([^)]+\)' docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md || true
git rebase codex/think-bigger-00-readiness-scaffold
git merge origin/codex/think-bigger-00-readiness-scaffold
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --frozen-lockfile --ignore-scripts
git diff --check
node scripts/check-think-bigger-doc-links.mjs
REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/shares.test.ts
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm install --frozen-lockfile
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-fs test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-fs typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-api test src/routes/shares.test.ts
docker compose -f docker-compose.dev.yml up -d postgres
```

Latest stack-refresh validation on 2026-07-01:

- `git diff --check` passed.
- `node scripts/check-think-bigger-doc-links.mjs` passed for 6 discovered
  Think Bigger docs and the in-script fixtures.
- `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
  passed for 6 discovered Think Bigger docs and the in-script fixtures.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test`
  passed with 6 files and 40 tests.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck`
  passed.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts`
  passed with 1 file and 15 tests.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck`
  passed.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts`
  passed with 1 file and 2 tests.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/shares.test.ts`
  failed because live Postgres at `127.0.0.1:54329` refused connections.
- `docker compose -f docker-compose.dev.yml up -d postgres` failed because
  Docker is not installed/enabled in this WSL distro.

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

### automated review

- Status: deferred until the P0A major readiness/material-risk gate under the
  2026-06-29 user-directed review policy; no per-fix rerun is required for the
  PR00 stack-refresh merge.
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
- Fixes: latest historical CodeRabbit findings are fixed in the P0A diff; the
  next CodeRabbit run is reserved for P0A major readiness or material risk.
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
- Adds two Postgres migration files for share-revocation retry indexes on
  `workspace_events` pending and claimed disconnect events.
- Operators that want immediate Hocuspocus disconnects on share revocation must
  configure `HOCUSPOCUS_ADMIN_URL` and `HOCUSPOCUS_ADMIN_TOKEN` for
  `workspace-api`.

### Remaining Risk

- PR00 docs-only local-agent-CLI exception still needs explicit human approval
  before PR00 is marked complete or merge-ready.
- P0A is restacked on PR00 because it depends on the plan/log files introduced
  there.
- P0A still needs its own lane PR, required CodeRabbit major-gate review, and
  final approval before it can be considered complete.

### Follow-Up / Deletion Conditions

- Keep this note until Phase 0 decisions are either implemented or superseded
  by a later architecture decision record.

## PR P0R - Rust Workspace Kernel Spike

Status: restacked on P0A; not approved
Branch: codex/think-bigger-p0r-rust-kernel
Worktree: `/home/ice/dev/dohc-p0r-rust-kernel`
Implementation workstream, if used: main orchestration thread
PR Link: [#48](https://github.com/dohc-ai/dohc/pull/48)
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
- [ ] Open PR after PR00 external CI/docs-only exception handling and P0A lane
      PR decision are settled, or use a stacked PR target. Do not merge P0R
      until its tests and required CodeRabbit major gate clear.

### Files Changed

- crates/workspace-kernel-spike/Cargo.toml
- crates/workspace-kernel-spike/Cargo.lock
- crates/workspace-kernel-spike/src/main.rs
- scripts/workspace-kernel-spike/ts-scan.ts
- scripts/workspace-kernel-spike/bench.mjs
- .gitignore
- docs/superpowers/plans/2026-06-23-think-bigger-docs.manifest.json
- docs/superpowers/plans/2026-06-24-think-bigger-p0r-rust-kernel-spike.md
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md

### Tests Added Or Updated

- Rust unit tests inside `crates/workspace-kernel-spike/src/main.rs`.
- Benchmark harness for generated fixture comparison.

### Commands Run

```bash
REPO_PARENT=/path/to/repo-parent
git worktree add -b codex/think-bigger-p0r-rust-kernel "$REPO_PARENT/dohc-p0r-rust-kernel" HEAD
rustc --version
cargo --version
pnpm install --filter @dohc/workspace-fs --frozen-lockfile
pnpm install --filter @dohc/workspace-core --filter @dohc/workspace-contracts --frozen-lockfile
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
git rebase codex/think-bigger-p0a-inventory
git merge origin/codex/think-bigger-p0a-inventory
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --frozen-lockfile --ignore-scripts
git diff --check
node scripts/check-think-bigger-doc-links.mjs
REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml -- --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/scan.test.ts
```

Latest stack-refresh validation on 2026-07-01:

- `git diff --check` passed.
- `node scripts/check-think-bigger-doc-links.mjs` passed for 7 discovered
  Think Bigger docs and the in-script fixtures.
- `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
  passed for 7 discovered Think Bigger docs and the in-script fixtures.
- `cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml -- --check`
  passed.
- `cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml` passed
  with 3 tests.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/scan.test.ts`
  passed with 1 file and 1 test.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3`
  passed.

### E2E / Visual / Manual QA

- Not applicable yet. P0R is a kernel spike, not UI.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for this spike unless later wired into
  P0G.
- Codex result: not run.
- Claude result, if available: not run.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### automated review

- Status: deferred until the P0R major readiness/material-risk gate under the
  2026-06-29 user-directed review policy; no per-fix rerun is required for the
  P0A stack-refresh merge.
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
  - Rust spike: min 6.78ms, max 8.49ms, average 7.50ms.
  - Current TypeScript baseline: min 336.92ms, max 341.06ms, average
    338.58ms.
- Workspace/file/chat sizes: generated 1,000-file fixture, 1,024 bytes per
  file, three iterations.
- Machine/CI context: local Codex machine; latest rerun happened after the P0A
  stack refresh and used Node v24.18.0 and Cargo 1.82.0.
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
- The Rust scanner and current TypeScript `scanWorkspaceFiles` now share the
  same `.dohc`, `.git`, and `node_modules` ignored-segment policy after P0A.
- PR00 docs-only local-agent-CLI exception and P0A lane PR approval remain
  upstream gates before P0R can be marked complete.

### Follow-Up / Deletion Conditions

- Delete once a production Rust kernel lane supersedes the spike, or keep as a
  benchmark fixture until cross-language contract tests replace it.

## PR P0B - Minimal Versioned Text Store

Status: restacked on P0R; not approved
Branch: codex/think-bigger-p0b-versioned-store
Worktree: `/home/ice/dev/dohc-p0b-versioned-store`
Implementation workstream, if used: main orchestration thread
PR Link: [#49](https://github.com/dohc-ai/dohc/pull/49)
Date started: 2026-06-24
Date completed:

### Scope

- [x] Create dedicated P0B worktree stacked after P0R.
- [x] Add a focused `@dohc/workspace-engine` package.
- [x] Add a minimal durable versioned text store for ordinary text/file
      content.
- [x] Add stable `WorkspaceObjectId` records for file objects.
- [x] Add Main plus named versions with fork-point metadata.
- [x] Preserve object identity across supported renames.
- [x] Store actor-neutral write metadata without claiming human/agent identity.
- [x] Deny invalid, reserved, traversal, and wrong-workspace/version writes.
- [x] Add tests for version isolation, stable object ID, rename, wrong
      workspace denial, path denial, persistence, and corrupt-state fail-closed
      behavior.
- [ ] Open PR only after PR00 external CI/docs-only exception handling, final
      approval, and P0A/P0R lane PR decisions are settled; keep this lane
      stacked on P0R until then. Do not merge P0B until its tests and required
      CodeRabbit major gate clear.

### Files Changed

- packages/workspace-engine/package.json
- packages/workspace-engine/tsconfig.json
- packages/workspace-engine/src/index.ts
- packages/workspace-engine/src/versionedTextStore.ts
- packages/workspace-engine/src/versionedTextStore.test.ts
- pnpm-lock.yaml
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md

### Tests Added Or Updated

- `packages/workspace-engine/src/versionedTextStore.test.ts`
  - Main plus named version isolation for one file.
  - rename preserves stable object ID where supported.
  - wrong workspace/version writes are denied.
  - reserved/traversal/absolute paths are denied through `validateUserWritePath`.
  - durable JSON store reloads.
  - corrupt persisted state fails closed.
  - malformed persisted JSON maps to `state-corrupt`.
  - malformed nested workspace state maps to `state-corrupt`.
  - failed persistence does not leak unpersisted writes through the in-memory
    cache.
  - path aliases stay isolated per version after renames.
  - concurrent writes through separate store instances preserve both changes.

### Commands Run

```bash
REPO_PARENT=/path/to/repo-parent
git worktree add -b codex/think-bigger-p0b-versioned-store "$REPO_PARENT/dohc-p0b-versioned-store" codex/think-bigger-p0r-rust-kernel
pnpm install --filter @dohc/workspace-engine
pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm install --filter @dohc/workspace-engine --filter @dohc/workspace-core --filter @dohc/workspace-contracts
pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/workspace-core typecheck
git rebase --onto codex/think-bigger-p0r-rust-kernel b9e804b codex/think-bigger-p0b-versioned-store
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-engine test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-core typecheck
git merge origin/codex/think-bigger-p0r-rust-kernel
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --frozen-lockfile --ignore-scripts
git diff --check
node scripts/check-think-bigger-doc-links.mjs
REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
```

Latest stack-refresh validation on 2026-07-01:

- `git diff --check` passed.
- `node scripts/check-think-bigger-doc-links.mjs` passed for 7 discovered
  Think Bigger docs and the in-script fixtures.
- `REPO_ROOT="$(git rev-parse --show-toplevel)" && (cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs")`
  passed for 7 discovered Think Bigger docs and the in-script fixtures.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test`
  passed with 1 file and 45 tests.
- `env "PATH=/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck`
  passed.

### E2E / Visual / Manual QA

- Not applicable yet. P0B is a package-level engine proof, not a UI or desktop
  integration PR.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable until P0G wires the local agent loop
  against the proof arc.
- Codex result: not run.
- Claude result, if available: not run.
- Transcript/artifact path: not applicable.
- Secret redaction notes: no secrets touched; `.dohc` paths are denied.

### Automated Review

- Status: deferred until the P0B major readiness/material-risk gate under the
  2026-06-29 user-directed review policy; no per-fix rerun is required for the
  P0R stack-refresh merge.
- Findings fixed in this P0B loop:
  - Major: cached state could be mutated before durable persistence completed.
  - Major: path aliases were workspace-global instead of version-scoped.
  - Major: malformed JSON escaped as a raw `SyntaxError`.
  - Critical: same-root store instances could overwrite each other because
    writes were only serialized per instance.
  - Major: `getObject()` exposed a shared `lastKnownPath` that became
    misleading when branches diverged.
  - Major: nested corrupt state could escape the store error contract.
  - Major: P0B open-PR gate wording implied a stacked-target bypass.
  - Minor: failed-persistence regression used a loose rejection assertion.
  - Critical: stale-lock recovery could delete a live replacement lock.
  - Major: heartbeat writes could finish after lock release.
  - Major: public clone helpers could leak unknown persisted properties.
  - Major: version `kind` and `forkPoint` consistency was not enforced.
  - Major: lock owner initialization failure could leave an empty lock dir.
  - Major: warm cache reads hashed the full state file.
  - Major: lock health checks could leak raw fs errors when owner metadata
    disappeared.
  - Major: atomic replacements lacked temp-file and parent-directory fsyncs.
  - Major: rename invalid-path coverage was missing.
  - Minor: lock serialization waits used exact counter equality.
- Fixes applied:
  - Added copy-on-write mutation flow and only assign `cachedState` after
    `writeFileAtomic` succeeds.
  - Moved path aliases under `VersionId` and copied aliases when forking named
    versions.
  - Wrapped JSON parse syntax failures as `VersionedTextStoreError` with
    `state-corrupt`.
  - Added a global per-store-path write chain and reload writable state from
    disk before each serialized mutation.
  - Removed shared `lastKnownPath`; version paths live on snapshots.
  - Added nested state validation and precise failed-persist regression
    coverage.
  - Tightened the P0B PR gate wording to remain blocked on PR00 and upstream
    lane decisions.
- Remaining verification:
  - Run the required CodeRabbit major gate when P0B reaches readiness or a
    material risk decision point.
- Overrides:

### Subagent Reviews

- Package-pattern explorer: complete.
  - Confirmed `packages/workspace-engine` fits `packages/*`.
  - Confirmed raw TS package exports, local Vitest tests, and simple tsconfig
    shape.
  - Warned to keep Node/fs APIs split from browser-safe surfaces and avoid
    canonical `atoms.body` assumptions.
- Architecture: pending.
- Security: pending.
- QA: pending.

### Security / Privacy Notes

- The store refuses reserved `.dohc`, traversal, absolute, and invalid paths
  through the existing core path guard.
- The store scopes every version, object, snapshot, and moment by workspace ID.
- Writes carry actor-neutral metadata only; this intentionally avoids guessing
  whether a local file write came from a human or an agent.
- Corrupt persisted state fails closed.
- No rich-doc/Y.Doc or `atoms.body` behavior is introduced.

### Performance Notes

- Budget areas touched: package-level local metadata store only.
- Metrics: focused Vitest suite completed in 3.08s locally after the P0R stack
  refresh.
- Workspace/file/chat sizes: unit fixtures cover one-file version isolation.
- Machine/CI context: local Codex machine; latest rerun used Node v24.18.0 and
  pnpm 10.24.0.
- Budget pass/fail: no UI/startup/watch budget applies yet.
- Jank/blocking notes: no renderer integration or long-running scan is added.

### Migration Notes

- Adds a new package and lockfile entry.
- Store path is `.dohc/engine/versioned-text-store.json`, but no production
  app path reads or writes it yet.
- Existing history, sync, atoms, Y.Doc, and desktop behavior are untouched.

### Remaining Risk

- This is an intentionally narrow durable JSON proof, not the final
  concurrent/multi-process storage engine.
- No production write path is integrated yet; P0C owns file/API write capture
  and history.
- No merge/conflict behavior is included; P0D owns compare, clean merge, and
  conflict preservation.
- PR00 docs-only local-agent-CLI exception and upstream lane PR approvals remain
  gates before P0B can be marked complete.
- Required CodeRabbit major-gate review and stacked PR review are still pending.

### Follow-Up / Deletion Conditions

- Promote this package into the Phase 0 file/API loop in P0C, or delete it if
  P0C chooses a different minimal engine substrate.

## PR P0C - File/API Write Capture And History

Status: restacked on P0B; not approved
Branch: codex/think-bigger-p0c-file-history
Worktree: `/home/ice/dev/dohc-p0c-file-history`
Implementation workstream, if used: main orchestration thread
PR Link: [#50](https://github.com/dohc-ai/dohc/pull/50)
Date started: 2026-06-24
Date completed:

### Scope

- [x] Create dedicated P0C worktree stacked after P0B.
- [x] Add package-level file API for ordinary text files:
      write/read/list/stat/restore.
- [x] Make writes land in the normal filesystem first, preserving the "just
      files" promise.
- [x] Mirror managed writes into the P0B versioned text store.
- [x] Record one inspectable `.dohc/history` entry with before/after snapshots.
- [x] Restore one file from a previous text snapshot.
- [x] Refuse stale restores when the live file no longer matches the expected
      current side of the history entry.
- [x] Add actor-neutral local-file attribution instead of labeling unknown
      external edits as a human or agent.
- [x] Tighten scan inclusion parity for `.git`, `node_modules`, nested `.dohc`,
      and SQLite sidecars.
- [ ] Open PR after PR00 docs-only exception approval and upstream lane PR
      decisions are settled, or use a stacked PR target.

### Files Changed

- packages/workspace-engine/package.json
- packages/workspace-engine/src/index.ts
- packages/workspace-engine/src/versionedTextStore.ts
- packages/workspace-engine/src/versionedTextStore.test.ts
- packages/workspace-engine/src/versionedFileWorkspace.ts
- packages/workspace-engine/src/versionedFileWorkspace.test.ts
- packages/workspace-core/src/changeSet.ts
- packages/workspace-core/src/paths.ts
- packages/workspace-core/src/paths.test.ts
- packages/workspace-fs/src/scan.ts
- packages/workspace-fs/src/scan.test.ts
- packages/workspace-fs/src/watchEvents.test.ts
- packages/workspace-history/src/changeSetStore.ts
- packages/workspace-history/src/changeSetStore.test.ts
- packages/mcp/src/tools.ts
- packages/mcp/src/tools.test.ts
- .github/workflows/desktop-release.yml
- crates/workspace-kernel-spike/src/main.rs
- scripts/workspace-kernel-spike/bench.mjs
- services/workspace-api/src/main.ts
- services/workspace-api/src/routes/shares.ts
- services/workspace-api/src/routes/sharesRevocation.test.ts
- packages/workspace-postgres/src/db/schema.ts
- packages/workspace-postgres/src/db/migrations/0009_share_revocation_completed_cleanup_events.sql
- packages/workspace-postgres/src/db/migrations/0010_share_revocation_active_backlog_events.sql
- docs/superpowers/plans/2026-06-24-think-bigger-p0r-rust-kernel-spike.md
- docs/superpowers/plans/2026-06-24-think-bigger-phase-0a-current-system-inventory.md
- docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md
- docs/superpowers/specs/2026-06-23-dohc-chats-design.md
- docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md
- apps/desktop/src/ipc/bridgeContract.ts
- apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
- apps/desktop/src/workspaces/workspaceActivity.test.ts
- apps/desktop/src/workspaces/workspaceActivity.ts
- apps/desktop/src/workspaces/workspaceWatcher.ts
- apps/desktop/src/workspaces/workspaceUiState.test.ts
- pnpm-lock.yaml
- docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md

### Tests Added Or Updated

- `packages/workspace-engine/src/versionedFileWorkspace.test.ts`
  - managed write updates disk, P0B version snapshot, and history once.
  - workspace construction fail-closes on unsupported platforms.
  - read/list/stat use normal files.
  - restore one file from history.
  - stale restore is refused.
  - reserved path writes do not touch disk/history.
  - failed version writes roll back the normal file.
  - pending write journals roll disk and version state back after restart.
  - raw disk backups restore byte-for-byte without UTF-8 re-encoding.
  - delete rollback recreates files with the observed pre-delete mode bits.
  - delete rollback clears pending mutation journals.
  - reclaimed file mutation lock ownership fences writes before disk/version/history mutation.
  - symlinked file mutation lock paths are rejected before stale-lock reclaim.
  - pre-existing internal directories are repaired to exact owner-only `0700`
    permissions before writes.
  - pending delete journals restore disk and version state on restart.
  - stale file mutation locks are reclaimed before the next workspace write.
  - active file mutation lock owners are allowed to keep heartbeating without
    being misclassified as timed-out stale locks.
  - concurrent writes from separate workspace instances serialize through the
    shared filesystem lock.
  - missing read-only calls do not create `.dohc/engine` mutation state.
  - read-only calls wait behind a filesystem-level mutation lock before reading.
  - read-only filesystem lock waits and in-process queued reads use explicit
    test signals instead of timeout races.
  - oversized text reads fail before buffering the whole file.
  - invalid UTF-8 preimages are rejected before replacing or deleting text
    files, including large preimages validated through streaming.
  - history blobs above the text restore cap fail before buffering.
  - oversized incoming writes fail before creating files or serializing
    mutation work.
  - oversized live text preimages fail before backup, snapshot, history, or
    temp-space work begins.
  - workspace mutation lock release errors are attached or suppressed when a
    primary task error already exists, preserving the real failing operation.
  - pending journals cannot delete backup paths outside the workspace.
  - pending journals reject malformed preimage snapshots during recovery.
  - pending write recovery restores an empty text preimage without treating it as
    malformed.
  - pending journals for another workspace are ignored during recovery.
  - created-file journal recovery succeeds when the parent directory is already
    gone and the target preimage is missing.
  - unreadable history state preserves pending write/delete journals instead of
    bypassing the committed-history guard.
  - deferred delete rollback keeps raw backup mode bits for later recovery.
  - concurrent text-path mutations assert the final version-store snapshot
    matches the live file text, with a test-only lock barrier proving the
    second write waits while the first mutation is paused inside the critical
    section.
  - pending journal restart recovery asserts no compensating history entries are
    synthesized while disk/version state is repaired.
  - redo restores assert the history summary says "Redid restore".
  - missing restore target reports a typed error.
  - non-round-trippable UTF-8 strings are rejected before text writes touch
    disk, version state, or history.
  - pending mutation entry reads are sorted for deterministic assertions.
  - unsafe read/stat paths reject with `invalid-path`, matching write/delete/
    restore path validation.
  - invalid restore directions reject before reading history state.
  - restore attempts through symlinks that escape the workspace root are denied.
  - symlink workspace roots are pinned to the real directory, and replaced root
    paths fail closed before creating replacement-root metadata.
  - cross-workspace version-store reads return no snapshot for the other
    workspace's version/path pair.
  - failed large write rollback removes newly created unreferenced history
    blobs while preserving pre-existing shared blobs.
  - hard-linked regular files are rejected before read/stat/list/write/delete
    processing, and oversized stat calls fail before hashing.
  - invalid restore directions have a dedicated typed error code.
  - invalid workspace ids reject before file/history storage setup.
  - pending journals reject snapshots that mix unavailable state with actual
    text content.
  - traversal-sentinel tests use a unique parent directory owned by each test.
  - symlinked file-mutation lock owner files are ignored without following the
    symlink before stale-lock reclamation.
  - pending journals allow unavailable snapshots to retain hash/size metadata
    while still rejecting unavailable snapshots that include text.
  - live-but-unreleased file mutation locks time out instead of waiting forever.
  - read-only workspace operations recheck lock ownership after the read before
    returning data.
  - list/stat text classification validates opened file bytes as UTF-8, excluding
    invalid text-looking files from folder listings and rejecting direct stats.
  - pending file-mutation journals persist created history-blob paths before
    blob side effects and recovery removes those unreferenced blobs on rollback.
  - live write/delete disk mutation preserves the current target into internal
    temp, validates the preserved preimage, and only then publishes or deletes.
  - history blobs are scoped to the workspace history namespace before persist,
    restore, and rollback cleanup.
  - pending recovery can use an inline text preimage when a referenced backup
    file is already missing.
  - pending recovery rejects invalid disk backup chmod modes.
  - pending recovery rejects expected change sets whose file path, operation,
    preimage, or postimage does not match the journal.
  - disk-mutating recovery only restores when the live file reached the expected
    postimage; divergent live files become recovery conflicts.
  - text writes whose snapshots expand heavily under JSON escaping still journal
    and recover under the pending journal size cap.
  - invalid configured authors leave no user file, history record, or pending
    mutation journal.
- `packages/workspace-engine/src/versionedTextStore.test.ts`
  - rollback refuses to remove a moment still referenced by another mutation's
    stored preimage.
  - rollback refuses to remove an ancestor moment that a descendant version only
    inherits, without relying on a descendant rewrite.
  - stale single-file store lock owners are reclaimed before the next write.
  - unreadable stale store lock owners fail through the typed `persist-failed`
    envelope while preserving the lock directory.
  - rollback tests reopen the store after rollback and assert persisted disk
    state matches the repaired version graph.
  - reclaimer-age tests set explicit stale thresholds so freshness assertions do
    not inherit production defaults.
  - lock replacement tests assert both that the write stays unpublished and
    that the replacement lock directory remains intact.
  - oversized and non-round-trippable text is rejected before version moments
    are persisted.
  - invalid text rejection verifies no path, file list entry, or moment is
    persisted after each rejected write.
  - failed fenced publishes assert the live store instance and a reloaded store
    both see no rejected path.
  - oversized write rejection derives its payload from
    `MAX_VERSIONED_TEXT_FILE_BYTES`.
  - persisted snapshot and moment text is revalidated for size and UTF-8
    round-tripping during state load.
  - moment corruption coverage keeps the current snapshot valid while corrupting
    `before.text`.
- `packages/workspace-history/src/changeSetStore.test.ts`
  - future-dated filesystem history lock heartbeats are treated as invalid/stale
    while live owner PIDs still prevent unsafe stale-lock reclamation.
- `apps/desktop/src/renderer/DesktopWorkspaceShell.test.tsx`
  - history rendering still passes with exhaustive author icon handling for
    user, local-file, and agent authors.
- `apps/desktop/src/workspaces/workspaceActivity.test.ts`
  - unsupported-platform history reads merge durable disk records with
    same-process ephemeral watcher records for list and detail views.
- `apps/desktop/src/workspaces/workspaceUiState.test.ts`
  - unsupported-platform watcher coverage observes a local edit, calls the
    post-record hook, and does not fabricate a durable history row.
  - unsupported-platform durable-store assertions use the explicit
    `ephemeralIfUnsupported` option instead of relying on platform defaults.
  - unsupported-platform process mocks restore the original descriptor, and the
    watcher handle stops from a `finally` block.
- `packages/mcp/src/tools.test.ts`
  - MCP mutators fail before disk changes when durable history recording is
    unsupported.
  - MCP write, directory create, site create, and data import return explicit
    retained-mutation failures when history recording fails after the visible
    mutation, avoiding a non-atomic rollback that could clobber concurrent
    work.
  - import targets publish through atomic no-overwrite semantics and preserve
    existing visible databases on `EEXIST`.
  - visible file overwrites preserve mode bits and refuse symlink targets.
  - unsupported-platform preflight assertions cover write, directory, site, and
    import targets before any visible artifact is created.
  - process platform mocks restore the original descriptor.
  - visible write-phase failures return ordinary tool failures instead of
    claiming a retained mutation.
  - move/delete history assertions check the expected record summaries and file
    counts without assuming timestamp-tie ordering.
  - file and import writes stage bytes through same-directory temp files before
    atomic rename, avoiding partial direct-write results.
  - concurrent MCP writes under a frozen wall clock still produce distinct
    monotonic history timestamps.
- `packages/workspace-fs/src/scan.test.ts`
  - scan skips `.dohc`, `.git`, `node_modules`, nested `.dohc`, and SQLite
    sidecars while preserving the visible base SQLite file.
  - executable shell-script-looking files are classified as visible text.
- `packages/workspace-core/src/paths.test.ts`
  - shared ignored-segment coverage reserves `.dohc` and `.git`
    case-insensitively while preserving case-insensitive `node_modules`
    ignores.
- `packages/workspace-fs/src/watchEvents.test.ts`
  - watcher ignore coverage matches the portable reserved-name rule for
    uppercase `.DOHC` paths.
- `packages/workspace-history/src/changeSetStore.test.ts`
  - local-file authors summarize without claiming a human or agent.
  - workspace-authored restores do not claim "You" attribution.
  - separate history store instances serialize concurrent records for the same
    root.
  - caller-owned ChangeSets are snapshotted before queued filesystem writes.
  - caller-owned ChangeSet snapshots are protected from in-place nested file
    mutation as well as array replacement.
  - duplicate history IDs are rejected without appending another timeline entry.
  - stale token-scoped filesystem history locks are reclaimed before the next
    record.
  - active history-lock waits tolerate lock-removal races without false
    path-escape errors.
  - summaries are checked for diff3 conflict markers as well as standard git
    conflict markers.
  - stale history locks owned by a still-live PID are not reclaimed until the
    lock disappears.
  - symlinked `.dohc` or `.dohc/history` paths escaping the workspace are
    rejected before history storage can write through them.
  - unsupported platforms can still read persisted disk-backed history while
    durable recording fails closed.
  - explicit unsupported-platform ephemeral fallbacks remain in-memory only.
  - max recorded timestamps are read from the durable index without loading full
    records.
  - active filesystem lock waits are asserted through lock files, without
    spying on global timer primitives.
  - single-file local edit summaries preserve the changed path.
  - stale history-lock recovery uses a deterministic non-live PID fixture.
  - history summaries from local edits, restores, and redos are covered by the
    conflict-marker guard.
  - namespaced history storage rejects symlink escapes under
    `.dohc/history/namespaces/<namespace>`.
  - stale or equal recorded timestamps are rejected after the durable index
    advances.
  - persisted index entries with unsafe timestamps are skipped before filenames,
    cursor reads, or max timestamp calculations consume them.
  - ephemeral fallback history rejects equal or stale timestamps using the same
    cursor-ordering invariant as durable history.
  - impossible future-dated history lock heartbeats are reclaimed instead of
    making dead locks look fresh forever.
- `services/workspace-api/src/routes/sharesRevocation.test.ts`
  - terminal completed disconnect-event cleanup excludes active pending/claimed
    rows while backlog stats remain available for alerting.
  - stale completed-event cleanup binds the UTC regex and format as SQL
    parameters instead of interpolating them into the query text.
  - share revocation backlog stats age claimed events by valid `claimedAt`
    values with `created_at` fallback.
  - malformed revocation payload recovery still validates recipient lookup from
    the revoked share row once a row is selected.
  - revoke-share results keep the share revoked while distinguishing completed
    admin disconnects from deferred queued/requeued disconnects.
  - the retry worker selector uses index-aligned pending/claimed timestamp
    branches for the main backlog path.
- `packages/workspace-postgres/src/db/schema.test.ts`
  - schema metadata includes the pending and claimed share-revocation retry
    expression indexes already present in migrations `0007` and `0008`.
- `crates/workspace-kernel-spike/src/main.rs`
  - scanner fixtures cover SQLite `-journal` sidecars in addition to existing
    internal-file skips.
  - scanner fixtures keep extensionless SQLite-looking `cache-wal` files visible
    while skipping `.db`/`.sqlite*` sidecars by path, matching production scan
    rules.
  - scanner fixtures prove `.DOHC` and `.GIT` are ignored under the same
    portable reserved-name contract as the TypeScript scanner.
- `scripts/workspace-kernel-spike/bench.mjs`
  - benchmark CLI refuses unbounded `--files`, `--bytes-per-file`, and
    `--iterations` values before fixture creation.
- `docs/superpowers/*`
  - docs-only fixes bind replace idempotency to canonical endpoints, scope
    chat derived artifacts to live grants, persist database-object lane
    decisions, and make command examples copy-paste safe.
  - P0A ledger flow now requires a deterministic pre-mint claim/tie-breaker for
    external write observations.
  - P0A pre-mint claim-key docs keep mtime/ctime as correlation metadata and
    derive the stable claim key only from workspace/path/content/size/file
    identity inputs.
  - Versioned workspace docs clarify that merge and restore share validation
    and scoping rules with writes without inheriting the exact single-version
    write shape.
  - P0A inventory wording now uses dohc-native filesystem terminology instead
    of legacy filesystem-sync phrasing.
- `.github/workflows/desktop-release.yml`
  - Linux preflight now runs `pnpm --filter @dohc/workspace-engine test` so
    anchored filesystem coverage is exercised in CI.

### Commands Run

```bash
REPO_PARENT=/path/to/repo-parent
git worktree add -b codex/think-bigger-p0c-file-history "$REPO_PARENT/dohc-p0c-file-history" codex/think-bigger-p0b-versioned-store
pnpm install --filter @dohc/workspace-engine --filter @dohc/workspace-fs --filter @dohc/workspace-history --filter @dohc/workspace-core --filter @dohc/workspace-contracts
pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-core typecheck
pnpm --filter @dohc/workspace-fs typecheck
pnpm install --filter @dohc/workspace-engine --filter @dohc/workspace-fs --filter @dohc/workspace-history --filter @dohc/workspace-core --filter @dohc/workspace-contracts --filter @dohc/workspace-api --filter @dohc/hocuspocus
pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-core typecheck
pnpm --filter @dohc/workspace-fs typecheck
pnpm install --filter @dohc/workspace-sync --filter @dohc/workspace-core --filter @dohc/workspace-fs --filter @dohc/workspace-contracts --filter @dohc/desktop
pnpm --filter @dohc/workspace-sync typecheck
pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/workspace-core test
git rebase --onto codex/think-bigger-p0b-versioned-store 7feacf0 codex/think-bigger-p0c-file-history
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-engine test
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-engine typecheck
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-fs test
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-history test
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-core typecheck
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-fs typecheck
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-sync typecheck
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/desktop typecheck
PATH="$DOHC_NODE24/bin:$PATH" "$DOHC_NODE24/bin/corepack" pnpm --filter @dohc/workspace-core test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-engine test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-history test
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" /tmp/dohc-node-v24.18.0-linux-x64/bin/corepack pnpm --filter @dohc/desktop typecheck
git diff --check
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/workspace-contracts typecheck
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 16 --iterations 1
node scripts/workspace-kernel-spike/bench.mjs --files # expected failure: --files requires a value
git diff --check
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
git diff --check
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/workspace-contracts typecheck
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 16 --iterations 1
node scripts/workspace-kernel-spike/bench.mjs --files 1.5 # expected failure: --files must be an integer >= 1
git diff --check
# automated review rerun: base commit e18bb96 with AGENTS.md context
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
git diff --check
# automated review rerun: base commit e18bb96 with AGENTS.md context
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review rerun: base commit e18bb96 with AGENTS.md context
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/workspace-postgres typecheck
git diff --check
# automated review rerun: base commit e18bb96 with AGENTS.md context
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 16 --iterations 1
node scripts/workspace-kernel-spike/bench.mjs --files 9007199254740992 # expected failure: --files must be <= Number.MAX_SAFE_INTEGER
pnpm --filter @dohc/workspace-postgres typecheck
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
# automated review rerun: base commit e18bb96 with AGENTS.md context
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
# automated review rerun: base commit e18bb96 with AGENTS.md context
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-fs typecheck
git diff --check
# automated review follow-up fixes against b0bd099
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
git diff --check
# automated review follow-up fixes against 8d7c5af
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against 844325d
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
git diff --check
# automated review follow-up fixes against 5eb8b99
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against d484b0d
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against f393907
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against aa9b935
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against dad74de
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against d9dab71
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-fs typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
git diff --check
# automated review follow-up fixes against 78fc516
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against 4fd2b10
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against c1a8f17
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against 829ab37
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against 6157665
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/workspace-history typecheck
git diff --check
# automated review follow-up fixes against f7e8113
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
git diff --check
# automated review follow-up fixes against 3a3607d
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
git diff --check
# automated review follow-up fixes against e294e04
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
# automated review follow-up fixes against 6e62637
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against fde5ad9
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
git diff --check
# automated review follow-up fixes against e83f64e
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/mcp typecheck # initial local-link failure before filtered install
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm install --filter @dohc/mcp --filter @dohc/workspace-core --filter @dohc/workspace-history --filter @dohc/workspace-sync --filter @dohc/sqlite-worker
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/mcp typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against 2110225
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/desktop typecheck
pnpm --filter @dohc/mcp typecheck
git diff --check
rg -n "Canonical Y\\.Doc|Benchmark launcher|workspace-scoped observation token|Grant revoke/expiry is transactional|claimExpiresAt|OPEN_READ_NOFOLLOW_FLAGS|historyRecordFromChangeSet\\(set, opts\\)" docs packages services apps
# automated review follow-up fixes against 286a72a
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
! rg -n "expectedDestinationObjectVersion|Extended journal version rollback recovery|target-path-exists|state-corrupt outcomes|disconnect_pending.*cleanup|disconnect_claimed.*cleanup" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md docs/superpowers/specs # expected no stale references
# automated review follow-up fixes against d34aa9d
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
rg -n "SHARE_REVOCATION_PENDING_RETENTION_SECONDS|quarantine-only|sourceObjectId, destinationObjectId|describeAnchoredHistory|cloneHistoryRecord" services packages docs
# automated review follow-up fixes against e3a5912
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against f81b96f
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against ecb3a78
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres test # unavailable locally: no Postgres on 127.0.0.1:54329
git diff --check
# automated review follow-up fixes against b1721ee
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
git diff --check
# automated review follow-up fixes against 53cbfa0
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against 0eaff21
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against d9b830e
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against 485e638
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test # initial run exposed raw EISDIR before typed lock-error wrapping
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
git diff --check
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
# automated review follow-up fixes against 1cc19c1
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
pnpm --filter @dohc/desktop typecheck
git diff --check
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against 08470b3
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
git diff --check
# automated review follow-up fixes against 29c5257
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
git diff --check
# automated review follow-up fixes against 76aabef
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against 08a6984
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against dbfa784
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 3938653
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 72563e7
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts src/versionedFileWorkspace.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against b24ab5c
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 193fa89
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts src/versionedFileWorkspace.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against d0eaaa1
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/workspace-history typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 8a8ea55
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against a6a42cf
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/mcp typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
git diff --check
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 8e1fa68
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 28e093d
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 1c49720
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts
pnpm --filter @dohc/workspace-core typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/scan.test.ts
pnpm --filter @dohc/workspace-fs typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
pnpm --filter @dohc/workspace-postgres typecheck
pnpm --filter @dohc/mcp typecheck
pnpm --filter @dohc/desktop typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-fs typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against dd77390
TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/scan.test.ts src/watchEvents.test.ts
TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
pnpm --filter @dohc/workspace-engine typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
pnpm --filter @dohc/workspace-history typecheck
TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node -v
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --version
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-fs test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-fs typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-core test src/paths.test.ts
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 112a935
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-fs test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-fs typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
# automated review follow-up fixes against 4b91836
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-fs test src/scan.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 16 --iterations 1
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --files 100001 # expected failure: --files must be <= 100000
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --bytes-per-file 1048577 # expected failure: --bytes-per-file must be <= 1048576
# targeted stale-placeholder scan passed for active P0 command examples
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-fs test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-fs typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api test # blocked locally without Postgres on 127.0.0.1:54329
docker compose -f docker-compose.dev.yml up -d postgres # blocked locally: docker unavailable in this WSL distro
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm install --frozen-lockfile
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync typecheck
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 36aa361
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
git diff --check
# targeted stale-placeholder scan passed for active P0 command examples
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 4288332
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
git diff --check
# targeted stale-placeholder scan passed for active P0 command examples
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 16362a9
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-fs test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-sync test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-fs typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml --check
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 16 --iterations 1
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --files 100001 # expected failure: --files must be <= 100000
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH node scripts/workspace-kernel-spike/bench.mjs --bytes-per-file 1048577 # expected failure: --bytes-per-file must be <= 1048576
git diff --check
# targeted stale-placeholder scan passed for active P0 command examples
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against f57278b
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test src/renderer/DesktopWorkspaceShell.test.tsx
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/desktop test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-fs typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-postgres typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp corepack pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH corepack pnpm --filter @dohc/workspace-sync typecheck
# automated review follow-up fixes against d4d734a
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
git diff --check
# targeted placeholder scan found only existing execution-log wording
# automated review follow-up fixes against db9d04a
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/changeSet.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts src/changeSet.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop test
git diff --check
# targeted stale-comment and placeholder scans passed for active P0 files
# automated review follow-up fixes against 3b3b575
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck # initial fixture failed before provenance fix
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts # initial fixture failed before provenance fix
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-core test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
git diff --check
# targeted stale-code scan passed for active P0 files
# automated review follow-up fixes against d37c106
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
git diff --check
# targeted leftover-helper scan found only unrelated assertions/file-lock logic
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck # after proactive file-mutation stale-PID fix
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test # first rerun exposed a 5s restore-test timeout
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
# automated review follow-up fixes against fa05e4f
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck # first run exposed a missing file-workspace invalid-input error code
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts # first run exposed a persisted snapshot text validator gap
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-api test # blocked locally without Postgres on 127.0.0.1:54329
git diff --check
which docker
pg_isready -h 127.0.0.1 -p 54329 # no response
docker info # blocked locally: Docker Desktop WSL integration is unavailable
# automated review follow-up fixes against db2c93e
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts # first run exposed stale fixtures before updates
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts # first run exposed write pre-read failure propagation and brittle move/delete ordering
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test # first full run exposed a lock disappearance containment race
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
git diff --check
# automated review follow-up fixes against 7bfd8e6
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts # first run exposed missing EEXIST wording after explicit import target check
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/home/ice/.local/share/nvm/v22.13.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
git diff --check
# automated review follow-up fixes against 8fe4727
pnpm --filter @dohc/workspace-engine typecheck # unsupported local Node v18 run passed typecheck but failed filesystem/SQLite tests; final evidence uses captured Node v24.18.0 below
pnpm --filter @dohc/workspace-history typecheck # unsupported local Node v18 run passed typecheck
pnpm --filter @dohc/mcp typecheck # unsupported local Node v18 run passed typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
git diff --check
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
git diff --check
automated-review review --agent --base-commit e18bb96 -c AGENTS.md
# automated review follow-up fixes against 52e9a9c
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts # first run exposed non-regular target error-code regression
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test # first run exposed mocked-platform descriptor cache issue
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test # first run exposed mocked-platform descriptor cache issue
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp test
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH=/tmp/dohc-node-v24.18.0/bin:$PATH TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
git diff --check
# automated review follow-up fixes against bfc0ccc
# First parallel focused-test launch used an unquoted PATH assignment and failed before tests because the inherited PATH contains a Windows path segment with a space.
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts # first run exposed expected ctid->id assertion update
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
# automated review follow-up fixes against 5805eae
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
# automated review follow-up fixes against 5d097ed
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
# automated review follow-up fixes against a8ba2a3
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
git diff --check
# automated review follow-up fixes against f156b22
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceActivity.test.ts src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against 97529b0
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceActivity.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes after timed-out e268a03 review attempt streamed 5 issues
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against 8cf9bc5 completed review pass
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/watchEvents.test.ts src/scan.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceActivity.test.ts src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
git diff --check
# automated review follow-up fixes against a935e96 completed review pass
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedTextStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test src/changeSetStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test src/tools.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceActivity.test.ts src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/watchEvents.test.ts src/scan.test.ts
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp node scripts/workspace-kernel-spike/bench.mjs --files 2 --iterations 1
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
git diff --check
# automated review reruns after 1f39e60 pushed
coderabbit review --agent -t committed -c AGENTS.md
# timed out/hung after sandbox setup with no findings or complete event
coderabbit review --agent -t committed -c AGENTS.md
# timed out/hung again after sandbox setup with no findings or complete event
coderabbit review --agent --base-commit a935e96 -c AGENTS.md
# reproduced the same no-output hang on the narrow latest-fix diff
# 2026-06-29 P0B stack refresh / major-gate review policy validation
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" pnpm install --frozen-lockfile --ignore-scripts
git diff --check
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" node scripts/check-think-bigger-doc-links.mjs
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" REPO_ROOT="$(git rev-parse --show-toplevel)" sh -c 'cd "${TMPDIR:-/tmp}" && node "$REPO_ROOT/scripts/check-think-bigger-doc-links.mjs"'
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine test src/versionedFileWorkspace.test.ts src/versionedTextStore.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history test
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp test
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop test src/workspaces/workspaceActivity.test.ts src/workspaces/workspaceUiState.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-engine typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-history typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/mcp typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/desktop typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core test src/paths.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs test src/watchEvents.test.ts src/scan.test.ts
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/sharesRevocation.test.ts
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-core typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-fs typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres typecheck
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-postgres test src/db/schema.test.ts
cargo fmt --manifest-path crates/workspace-kernel-spike/Cargo.toml -- --check
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" node scripts/workspace-kernel-spike/bench.mjs --files 2 --bytes-per-file 1024 --iterations 1
PATH="/tmp/dohc-node-v24.18.0/bin:$PATH" TMPDIR=/tmp pnpm --filter @dohc/workspace-api test src/routes/shares.test.ts # blocked locally: ECONNREFUSED 127.0.0.1:54329
pg_isready -h 127.0.0.1 -p 54329 # no response
docker ps # blocked locally: Docker is not installed in this WSL distro
```

### E2E / Visual / Manual QA

- No desktop E2E yet. P0C intentionally adds a package-level proof and a
  desktop-compatible author schema change only.
- Full desktop Vitest suite passed after a frozen install repaired a missing
  Tailwind optional native package in local `node_modules`.
- Live-pg workspace-api and workspace-postgres suites remain unavailable in this
  WSL environment because Docker Desktop is not integrated with this WSL distro
  and `pg_isready -h 127.0.0.1 -p 54329` reports no response; DB-free
  `sharesRevocation` and schema tests passed.
- Latest P0B stack-refresh probe confirmed the same live-pg blocker:
  `shares.test.ts` failed all 8 tests at setup with
  `ECONNREFUSED 127.0.0.1:54329`, `pg_isready` reported no response, and
  `docker ps` failed because Docker is not installed in this WSL distro.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable until P0G wires the local agent loop
  against the proof arc.
- Codex result: not run.
- Claude result, if available: not run.
- Transcript/artifact path: not applicable.
- Secret redaction notes: reserved `.dohc` paths are denied; secret-backed
  files remain out of scope.

### Automated Review

- Status: deferred until the P0C major readiness/material-risk gate under the
  2026-06-29 user-directed review policy; no per-fix rerun is required for the
  P0B stack-refresh merge.
- Findings: the latest completed historical review against commit `a935e96`
  raised 17 issues. Sixteen produced local fixes here; one duplicated desktop
  fallback-instance concern was verified already satisfied by the root-keyed
  ephemeral store, with the related unguarded fallback read path fixed. Earlier
  completed/timed-out review findings listed below are historical and fixed in
  this lane.
- Next review gate: run CodeRabbit only when P0C reaches major readiness, gains
  a material-risk change, or enters the final P0G proof-arc hardening gate.
- Latest fixes after completed review pass against commit `a935e96`:
  - Hocuspocus admin disconnect now propagates caller abort reasons separately
    from internal timeout aborts.
  - Share revocation completion keeps `disconnect_completed` rows for the
    retention cleanup window instead of deleting them inline.
  - History lock owners now store a Linux process-start identity when available,
    so a reused live PID does not keep a stale lock unreclaimable.
  - Desktop history reads soften fallback read failures too; the repeated
    fallback-instance finding was verified already satisfied by the shared
    root-keyed ephemeral store.
  - Desktop release preflight now runs `@dohc/workspace-engine typecheck`.
  - MCP optimistic `expectedSha256` checks now run inside the atomic publish
    precondition immediately before rename/link.
  - Rust and TypeScript scan/bench paths now share the `.dohc-write-*` ignore
    contract, and the bench fixture writes exact `bytesPerFile` totals.
  - Versioned persisted-state loading allows legacy ignored-segment paths while
    new mutations still reject them.
  - Share revocation UTC regex no longer accepts year `0000`, avoiding invalid
    PostgreSQL timestamp casts in backlog stats.
  - Versioned file listing tolerates files deleted between `readdir` and open.
  - Store-lock stale checks prefer owner-file mtime over serialized heartbeat.
  - Open-file UTF-8 checks and history snapshots are bounded; oversized live
    preimages derive restorable blob hashes from verified backups.
  - Versioned write metadata now caps persisted summary/correlation id strings.
  - Share revocation tests distinguish retention cleanup deletes from
    event-specific update/delete queries.
- Previous fixes after completed review pass against commit `8cf9bc5`:
  - Share revocation retry selection now validates UTC timestamp strings inside
    each index-aligned branch, treats malformed/missing timestamps as due, and
    keeps the regex parameterized.
  - Desktop activity history reads reuse a single ephemeral fallback store per
    root so watcher-written in-memory history remains visible to list/get calls.
  - MCP visible-directory atomic staging files use the reserved `.dohc-write-*`
    prefix, and the shared scanner/watcher ignore predicate now excludes that
    prefix everywhere.
  - MCP write/import failures after parent directory creation now report the
    retained visible mutation instead of presenting the operation as fully
    rolled back.
  - History lock owner reads cap the file-handle read to
    `HISTORY_LOCK_OWNER_MAX_BYTES + 1` and reject oversized owners before
    parsing.
- Previous pass fixes after timed-out review attempt against commit `e268a03`:
  - P0A ledger docs now consistently define the pre-mint claim key as a
    deterministic workspace/object identity fingerprint; UUIDs/sequences apply
    only to the minted durable `writeObservationId`.
  - MCP history writes retry stale timestamp races with a fresh durable max
    timestamp and stable record id.
  - History lock age handling treats impossible future heartbeats as stale while
    still tolerating small clock skew and live owner PIDs.
  - Ephemeral history fallback recording now rejects equal or stale timestamps,
    matching durable store cursor ordering.
  - Share revocation worker selection now uses index-aligned pending/claimed
    timestamp branches instead of hot-path regex/nullable OR fallback predicates.
- Previous pass fixes against commit `97529b0`:
  - Share revocation results keep `revoked: true` for the persisted soft-delete
    and expose deferred live disconnects via `disconnectDeferred: true`.
  - MCP and desktop merged history readers tolerate durable read failures and
    still serve ephemeral records.
  - Desktop activity platform mocking keeps `process.platform` configurable so
    the original descriptor can be restored.
  - Exclusive copy recovery marks a target committed only after the parent
    directory sync completes.
  - `disk-mutating` recovery now conflicts instead of restoring over a live file
    that is neither the preimage nor the expected postimage.
- Previous pass fixes against commit `f156b22`:
  - Desktop watcher and MCP history writers now derive `recordedAtMs` from the
    durable max plus a per-process high-water mark before calling the strict
    monotonic history store.
  - MCP site creation marks newly created parent directories as retained visible
    mutations if a later file publish fails.
  - Desktop activity history reads merge durable disk records with
    unsupported-platform ephemeral watcher records, matching MCP read behavior.
  - Share revocation returns an explicit deferred-disconnect result when admin
    disconnect is unavailable, already claimed, or requeued after failure.
  - Pending mutation journal size is enforced before writing and raised to match
    worst-case JSON expansion of duplicated text snapshots.
  - Versioned text store corruption coverage keeps the current snapshot valid
    while corrupting `before.text`.
  - Versioned file workspace invalid-author coverage now asserts no user file or
    pending journal is left behind.
  - History lock tests share a fake owner fixture helper for future lock-schema
    changes.
- Previous pass fixes against commit `a8ba2a3`:
  - Desktop unsupported-history readback coverage now imports and uses the
    watcher-owned `DESKTOP_HISTORY_STORE_OPTIONS`.
  - Persisted history index entries validate safe `recordedAtMs` values before
    filenames, ordering, cursors, or max timestamp reads can consume them.
  - History `record()` rechecks the durable max timestamp under the history
    lock and rejects equal or stale timestamps before writing the record file.
  - Pending file-mutation recovery falls back to inline text preimages when a
    referenced disk backup file is missing, while unsafe paths and unavailable
    preimages still fail closed.
  - Pending disk backup modes must be integer chmod values in `0o000..0o777`.
  - Pending expected change sets are verified against the journal path,
    operation, preimage, and postimage before recovery can use them.
- Previous pass fixes against commit `5d097ed`:
  - Exported `VersionedFileWorkspaceError` from the workspace-engine root entry.
  - Share revocation backlog stats test now covers claimed-event fallback from
    invalid/missing `claimedAt` to `created_at`.
  - History `recordedAtMs` validation now rejects `Number.MAX_SAFE_INTEGER`,
    keeping one safe increment of headroom for max+1 timestamp generation.
  - The symlink-owner history lock test now awaits the pending record promise in
    cleanup.
  - MCP existing-database import failure coverage is gated on durable history
    support.
  - P0A inventory ledger wording now separates the pre-mint claim key from the
    durable `writeObservationId`.
  - Versioned-text quarantine mismatch handling restores the exact moved
    directory only after rechecking that quarantine identity and target absence.
  - Preserved-preimage restore copies through a single exclusive no-follow target
    file descriptor and syncs that fd instead of reopening after `copyFile`.
  - File mutation lock reclaim treats future-heartbeat locks with live owner PIDs
    as active rather than reclaimable.
- Previous pass fixes against commit `5805eae`:
  - File mutation lock ownership checks now guard missing owner metadata instead
    of dereferencing null, and release cleanup reuses the no-follow bounded owner
    reader.
  - Versioned text store quarantine restore paths only rename a quarantined lock
    or reclaimer back if the quarantine still has the observed identity.
  - MCP atomic file publish now carries workspace context and re-runs
    `safeResolve` before lstat and final publish.
  - History file persistence derives the filename from the validated record, not
    the caller-owned options object.
  - MCP directory creation returns `unchanged` without writing history when the
    target directory already exists.
  - Desktop unsupported-history watcher coverage now reads back the ephemeral
    fallback history entry, not only the watcher callback.
  - Durable-history MCP retention tests are gated consistently across
    write/create/import and move/delete cases.
  - The stale symlink-owner history lock test backdates both the lock root and
    owner token directory while leaving the symlink target fresh.
  - Removed the unused deferred-rollback test helper from
    `versionedFileWorkspace.test.ts`.
- Previous pass fixes against commit `bfc0ccc`:
  - Versioned file workspace validates configured authors at first durable
    mutation, before journaling, rather than requiring construction to throw.
  - History lock age handling treats future timestamps as fresh locks, while
    invalid timestamps remain stale/reclaimable.
  - History records reject non-safe or negative `recordedAtMs` values before
    they can become filenames or index entries.
  - Incomplete `disk-mutating` journals now roll back from their verified backup
    without requiring the crashed postimage to be present.
  - Versioned file workspace construction now fails closed when `/proc/self/fd`
    is missing or inaccessible, even on Linux.
  - MCP durable-history tests that depend on recordable writes are gated on
    durable history support.
  - Share revocation completed-event cleanup deletes by stable event `id`
    instead of `ctid`.
  - Preserved live preimages are restored with no-clobber semantics and are not
    renamed over a recreated target.
  - Versioned file publish no longer creates a hard-link temp path, so a crash
    after publish cannot leave the live file with an extra link count.
  - Focused tests now cover disk-mutating rollback, invalid-author mutation
    rejection, safe history timestamps, future-dated lock waiting, stable-id
    cleanup SQL, and no extra hard link after overwrite.
- Previous pass fixes against commit `52e9a9c`:
  - Removed Node/Linux-only versioned-file-workspace value exports from the root
    package barrel and exposed the runtime file workspace through an explicit
    subpath export.
  - P0A database-object cutover docs now require lease generation, heartbeat,
    TTL expiry, and stale-claim reclaim while preserving the selector decision.
  - History descriptor `/proc/self/fd` probing is memoized per platform, keeping
    fail-closed behavior and mocked-platform tests intact.
  - MCP writes refuse symlink overwrites, preserve existing file modes, create
    sites with atomic no-overwrite publication, and mark a newly created site
    root as a retained visible mutation.
  - Versioned file workspace live writes/deletes preserve the current target into
    internal temp, validate that preserved preimage, then publish/delete.
  - File mutation stale-lock reclaim no longer treats a live reused PID alone as
    an active owner; freshness remains tied to owner token and heartbeat.
  - History blobs are stored, restored, and discarded under the workspace history
    namespace.
- Previous pass fixes against commit `8fe4727`:
  - P0R benchmark docs now state that the recorded Rust/TypeScript numbers are
    comparable only under the captured Node v24.18.0/Corepack toolchain.
  - Future-dated filesystem history lock timestamps were temporarily treated as
    invalid/stale while live owner PIDs still prevented unsafe reclaim; the
    later `bfc0ccc` follow-up corrected future timestamps to remain fresh.
  - Persisted versioned-text snapshots and moments again enforce the versioned
    text size cap as well as UTF-8 round-trip safety.
  - MCP `create_site` reports retained visible mutations after any file publish,
    and `import_data` publishes with atomic no-overwrite hard-link semantics.
  - File-mutation pending journals are created before history blobs; each new
    blob path is persisted into the journal immediately and cleaned on rollback.
  - `listTextFiles` and `statTextFile` validate opened file bytes as UTF-8 before
    classifying path/media matches as text.
  - P0A/P0C docs keep dohc-native filesystem terminology instead of legacy
    filesystem-sync wording.
- Previous pass fixes against commit `7bfd8e6`:
  - Conflict-marker summary guard now also covers diff3 `|||||||` markers.
  - History stale-lock reclaim checks owner PID liveness and fails closed while
    the recorded process may still be alive.
  - MCP visible file/import writes stage to temp files and publish by atomic
    rename so failed direct writes cannot leave partial visible files.
  - P0A inventory wording now uses dohc-native filesystem language.
  - File mutation lock waits enforce the timeout even when the lock is still
    actively heartbeating.
  - Read-only versioned file workspace operations recheck lock ownership before
    returning results.
- Previous pass fixes against commit `db2c93e`:
  - Store-lock reclaimer freshness tests now give the owner heartbeat a
    deterministic margin over `lockStaleMs`.
  - History lock acquisition returns a lease with `assertStillOwnsLock`, and
    record publishing rechecks ownership before the record file and before the
    index write.
  - Persisted versioned-text state validates UTF-8 round-trip safety without
    applying the new-write size cap to legacy snapshots.
  - Stale versioned-text lock inspection treats unreadable owner metadata as a
    missing owner while preserving owner mtime freshness fencing.
  - Linux CI preflight now runs the workspace-engine package test script so
    anchored filesystem coverage is not skipped behind desktop tests.
  - MCP write, directory create, site create, and import flows separate visible
    mutation failures from post-mutation history-record failures.
  - File-mutation lock owner reads use bounded no-follow opens with file
    identity checks before parsing owner metadata.
  - Pending file mutation snapshots allow unavailable hash/size metadata and
    only reject unavailable snapshots that also include text.
- Previous pass fixes against commit `fa05e4f`:
  - Native filesystem design now states delete APIs require an idempotency key
    alongside target-object and freshness preconditions.
  - Pending file mutation snapshots reject unavailable state mixed with
    content, hash, or size fields, including preimage and postimage recovery
    fixtures.
  - Versioned file workspace ids are validated at public construction and
    recovered pending-journal boundaries before storage setup.
  - File-mutation lock takeover now refuses any live foreign owner PID even if
    its heartbeat is stale, missing, or in the future.
  - History summary conflict-marker coverage includes local edit summaries and
    restore/redo summaries.
  - Namespaced history storage rejects symlink escapes below
    `.dohc/history/namespaces/<namespace>`.
  - Versioned file workspace traversal-sentinel tests use unique parent
    directories owned by each test.
  - Share revocation claimed backlog age uses validated `claimedAt` with
    `created_at` fallback.
  - Share revocation claim ordering normalizes malformed retry/claim timestamps
    so malformed payloads sort as immediately due.
  - Versioned text persisted snapshot and moment text is revalidated for size
    and UTF-8 round-tripping during state load.
- Previous pass fixes against commit `d37c106`:
  - Desktop unsupported-history assertion now verifies `ENOENT` for the absent
    durable history index instead of accepting any thrown read failure.
  - MCP write, directory create, and site create keep the visible filesystem
    mutation and history record in one retained-mutation failure envelope.
  - Impossible pending write/delete journal tests now exercise each malformed
    journal independently.
  - Unsafe path coverage includes top-level lowercase `.git` and
    `node_modules` entries in addition to uppercase and nested variants.
  - Stale history index locks can be reclaimed even when the stale owner PID has
    been reused by a live process; fresh heartbeats still block takeover.
  - Versioned file read handles now compare the opened inode with the current
    workspace path before returning.
  - Internal engine JSON/blob writes, backup blob copies, and internal file
    removals now operate through verified descriptor-relative parent handles.
  - The sibling file-mutation lock stale-heartbeat path now also ignores reused
    live PIDs, with regression coverage.
  - The multi-restore regression test has an explicit 10s timeout after
    descriptor-verified writes made the default 5s timeout flaky in full-suite
    runs.
- Previous pass fixes against commit `3b3b575`:
  - Nested `.dohc`, `.git`, and `node_modules` unsafe path variants now exercise
    read/stat/write/delete/restore rejection in the versioned file workspace.
  - Delete-journal recovery tests now verify executable mode restoration, and
    the pending-journal fixture records the backup mode like production.
  - Pending file mutation recovery rejects symlinks, directories, swapped files,
    and oversized journal files before JSON parsing by using `lstat`, bounded
    reads, and `O_NOFOLLOW`.
  - Workspace text scanning recurses through anchored directory handles instead
    of path-only `readdir` traversal.
  - MCP history reads use an ephemeral-capable read store on unsupported
    platforms while durable writes stay fail-closed.
  - Versioned workspace and native filesystem specs bind merge idempotency to
    both `sourceVersionId` and `targetVersionId`.
- Previous pass fixes against commit `db9d04a`:
  - Quarantined versioned-text stale lock and reclaimer cleanup paths with a
    rename-before-delete flow so a replaced directory is never removed after the
    identity check.
  - Protected rollback targets when a child version forks exactly at the target
    moment, even if the child later mutates a different file.
  - Restore-from-backup rejects hard-linked regular files before replacing the
    live target, with regression coverage for `restoreTextFile`.
  - Versioned file reads re-check the pinned root identity inside the serialized
    workspace lock before and after pending-journal recovery and task work.
  - Exported the versioned file history/version reader facade types from
    `@dohc/workspace-engine`.
  - MCP `writeWorkspaceFile` and `createSite` return structured retained-mutation
    failures for visible filesystem errors instead of leaking raw exceptions.
  - `createChangeSet` validates and normalizes authors through
    `parseChangeAuthor` before storing them.
  - Desktop platform override tests now restore `process.platform` from a
    `finally` block.
  - The shared path validator rejects `.git`, `node_modules`, and other ignored
    workspace internals case-insensitively, with search-layer backstop comments
    updated to match.
  - Versioned workspace and native filesystem specs bind create-only idempotency
    to canonical paths plus `expectedAbsent`.
  - MCP retained move/delete assertions now target the exact missing-path error
    instead of any throw.
  - Unsafe path coverage includes uppercase `.DOHC` and `.GIT` variants.
- Previous pass fixes against commit `d4d734a`:
  - Fenced versioned-text store lock and reclaimer owner publication with captured
    directory identity checks before/after owner writes, heartbeats, trust, and
    cleanup.
  - Deferred legacy rollback text validation so modern mutation rollback ignores
    unused fallback payloads while legacy fallback still validates before use.
  - Kept file-mutation lock waits alive when the current owner is still actively
    heartbeating.
  - Skipped oversized text-like files during workspace text listing before hashing.
  - Returned structured `import_data` failures for existing database targets
    without replacing canonical bytes.
  - Extended unsupported-platform MCP mutation gates to move/delete paths and
    tightened no-mutation assertions to specific `ENOENT` checks.
  - Renamed the large-file hash regression to match the actual stale-live hash
    validation behavior.
  - Added recovery coverage proving workspace-B committed pending journals are
    resolved against workspace-B history while workspace-A remains unchanged.
  - Added pending-journal disk-target validation and mismatch coverage that fails
    closed without touching crafted target paths.
  - Versioned file reads, stats, list results, writes, and deletes reject
    hard-linked regular files before processing or hashing content.
  - `statTextFile` applies the text-size cap before hashing oversized files.
  - Invalid restore directions now return `invalid-restore-direction`.
  - Desktop history author icons use an exhaustive author-kind switch with an
    explicit unknown-author fallback.
  - Versioned text oversized-write tests use the exported byte-limit constant.
  - The share-revocation pending/claimed retry expression indexes are mirrored
    in schema metadata, matching migrations `0007` and `0008`.
  - The versioned workspace spec clarifies that merge/restore share scoping and
    validation rules without inheriting `write(...)`'s exact single-version
    shape.
  - The history store removed a duplicate descriptor-support check from the hot
    `pathInOpenDirectory` helper.
- Previous pass fixes against commit `16362a9`:
  - Versioned file workspaces now canonicalize the root once, pin its
    device/inode identity, use that pinned root for version/history stores, and
    fail closed if the path is replaced.
  - Versioned file mutation timestamps now use `history.maxRecordedAtMs()`,
    which reads only the history index instead of loading full history records.
  - Failed file mutations clean up newly created, unreferenced history blobs on
    rollback while leaving pre-existing shared blobs intact.
  - The history store durable-support gate now verifies `/proc/self/fd` is an
    accessible directory, not just that `process.platform` is Linux.
  - Versioned text write validation measures UTF-8 byte length before allocating
    the full buffer.
  - Fenced versioned-text persist tests assert rejected paths are absent on the
    live store instance and after reload.
  - The history lock-wait test now observes real lock files and always drains
    the pending record promise during cleanup.
  - Workspace version-store scoping, malformed journal wording, API SQL
    parameterization, P0A stable claim-key docs, and automated-review command
    terminology were tightened.
- Previous pass fixes against commit `4288332`:
  - MCP post-mutation history failures now retain the visible mutation and
    return an explicit failure reason because rollback cannot be made atomic;
    unsupported-platform preflight still fails before visible artifacts are
    created.
  - MCP history reads use the durable store on unsupported platforms so
    persisted history remains visible, while writes fail closed.
  - The history store constructor supports durable read-only access on
    unsupported platforms, and the explicit `ephemeralIfUnsupported` mode
    remains in-memory only.
  - Versioned text invalid-write tests assert no file path, list entry, or
    moment is persisted after each oversized or non-round-trippable rejection.
  - Versioned file restore validates `direction` before reading history state.
  - Versioned file symlink-escape coverage now includes restore.
  - API share-revocation stale-cleanup SQL false-positive suppressions are
    attached at the query site.
  - P0R markdownlint spacing around the fenced command block is fixed.
- Previous pass fixes against commit `36aa361`:
  - Test platform mocks restore the original `process.platform` property
    descriptor, and the desktop watcher handle is stopped from a `finally`
    block.
  - Desktop unsupported-history warnings are emitted at most once per watcher,
    while the `ephemeralIfUnsupported` store option now returns a true
    in-memory fallback.
  - P0A docs now require a deterministic pre-mint claim/tie-breaker so
    concurrent external write observers reserve one `writeObservationId`.
  - MCP rollback cleanup re-reads visible files and only removes/restores files
    whose bytes still match the mutation's expected postimage; concurrent edits
    cause an explicit rollback-skipped failure.
  - Versioned text invalid-write tests assert no paths, file list entries, or
    moments are persisted before rejection.
  - P0R scan command docs split `WORKSPACE_ROOT` assignment from command
    invocation so shell expansion is correct.
  - Pending file mutation probes validate existing internal directories segment
    by segment and fail closed on symlink/non-directory state.
  - Versioned file writes/deletes/restores revalidate the live preimage
    immediately before final disk mutation.
  - Versioned file read/stat surfaces now share invalid-path coverage with
    write/delete/restore.
- Previous pass fixes against commit `4b91836`:
  - Desktop IPC now parses change authors through the shared
    `parseChangeAuthor` boundary parser instead of accepting a looser
    bridge-local schema.
  - Benchmark CLI options have hard upper bounds for files, bytes per file, and
    iterations.
  - Workspace scan coverage asserts executable shell-script-looking files stay
    visible as text.
  - MCP rollback coverage now uses nested write/import targets and asserts
    created parent directories are removed after failed history recording.
  - MCP rollback pruning tracks only newly created directories, prunes only
    empty directories, and never walks past the workspace root.
  - Versioned text writes reject oversized or non-round-trippable UTF-8 text at
    the store boundary before moments are persisted.
  - Unsupported-platform desktop durable-store assertions opt into ephemeral
    fallback explicitly.
  - Pending mutation entry reads are deterministic.
  - Live foreign history-lock owners are never reclaimed merely because their
    heartbeat is old; only dead owners can be reclaimed.
  - Native-filesystem replace idempotency docs bind replay to canonical
    `fromPath` and `toPath`.
  - Chat derived artifacts are grant/visibility scoped, or transactionally
    invalidated when grants revoke.
  - Database-object upgrade in-flight claims persist the chosen lane and
    selector decision so scanners/watchers do not reclassify mid-upgrade.
  - Shell examples in active plan docs avoid angle-bracket placeholders where
    copy-paste commands are expected.
  - File mutation lock ownership checks use `lstat`, reject symlink/non-dir
    owner paths, and preserve shared mutation-lock parent directories.
  - Versioned file writes reject non-round-trippable UTF-8 strings before
    touching disk, version state, or history.
- Previous pass fixes against commit `112a935`:
  - Desktop watcher keeps observing local edits on unsupported platforms:
    durable local history recording is skipped with a warning, but the
    post-observation hook still updates status and queues sync work.
  - MCP mutators fail before disk changes when durable history recording is
    unsupported, and write/directory/site/import paths now roll back visible
    disk changes if history recording fails after mutation.
  - Sync cloud pull/push-pull preflights durable local history before allowing
    local pull mutations; push-only can still read existing disk-backed history.
  - Versioned text lock-replacement tests now assert both unpublished writes
    and preserved replacement lock directories.
  - Stale history-lock tests use a deterministic non-live PID.
  - Share revocation timestamp predicates now use a stricter UTC instant regex
    with leap-day and time-range validation.
  - File mutation lock waits now honor timeout even when the current owner is
    actively heartbeating.
  - Versioned file workspace internal directory creation/repair now uses
    no-follow opened parent/directory handles before child creation or chmod.
  - Pending file mutation journal normalization rejects impossible write/delete
    snapshot combinations before recovery proceeds.
- Previous pass fixes against commit `dd77390`:
  - Kept `.dohc` and `.git` reserved case-insensitively across core path
    validation, filesystem scan/watch, and the Rust scanner so internal state
    stays hidden on case-insensitive filesystems; `node_modules` remains
    case-insensitive as before.
  - Reverted active pending/claimed share-revocation disconnect retention:
    cleanup now deletes completed terminal events only, and the test proves
    pending/claimed jobs are excluded while backlog stats remain the alert path.
  - Added explicit stale thresholds to versioned-text-store reclaimer-age tests.
  - Added persisted reload assertions after versioned-text rollback repairs.
  - Revalidated descriptor-open parent directories before final rename/remove
    mutations.
  - Rejected oversized incoming text writes before file creation or serialized
    mutation work, while preserving oversized-preimage rejection before backup
    and history work.
  - Kept disk-backed history reads available on unsupported platforms while
    failing durable history recording closed.
  - Preserved the single-file path in local edit history summaries.
  - Updated MCP comments to match the unsupported-platform read/write split.
- Previous pass fixes against commit `28e093d`:
  - Made the inherited rollback dependency test use a clean descendant that only
    reads the ancestor object mutation.
  - Added an ungated unsupported-platform constructor regression for the
    versioned file workspace.
  - Replaced file-workspace read-lock timeout races with explicit filesystem
    lock-wait and in-process queue signals.
  - Unrefed history and file-mutation lock heartbeat intervals.
  - Mutated nested file-change data in the ChangeSet snapshot regression.
  - Added durable benchmark replay provenance to the Rust kernel spike plan.
  - Bound native-filesystem self-replace idempotency to validated auth context,
    workspace/version, operation type, object/path, both causal preconditions,
    and payload digest.
  - Rejected invalid UTF-8 text preimages before write/delete mutation,
    including large preimages through streaming validation.
  - Tightened real-root containment so valid in-root names like `..data` are not
    treated as traversal.
  - Rejected oversized history blobs before restore can buffer them.
- Previous pass fixes against commit `8e1fa68`:
  - Aligned the Rust workspace-kernel SQLite sidecar classifier with the
    TypeScript filename-only rule by removing the extensionless SQLite-header
    fallback.
  - Made the history lock-wait test hold a real token-scoped owner generation
    and assert an observed wait instead of a hard-coded retry delay.
  - Chose unused PIDs dynamically for stale file-mutation lock fixtures.
  - Snapshotted caller-owned ChangeSets before queuing durable history writes.
  - Rejected duplicate history IDs in both durable and ephemeral history stores.
  - Bound native-filesystem `replace(...)` idempotency to canonical `fromPath`
    and `toPath`.
  - Removed the direct-fork rollback dependency shortcut so direct fork readers
    still require independent object mutation evidence.
  - Repaired pre-existing internal directories to exact owner-only `0700`
    permissions.
  - Rejected symlinked or non-directory file-mutation lock paths and owner
    directories before stale-lock reclaim.
- Previous pass fixes against commit `a6a42cf`:
  - Exported and reused the core local-author-label parser in the desktop IPC
    bridge so local author payloads validate at the boundary.
  - Bound self-replace idempotency to the replacement payload digest in the
    versioned workspace spec.
  - Bounded the history lock-wait probe and used a valid positive stale-owner
    PID fixture.
  - Reopened the versioned text store before asserting fenced-publish state.
  - Reused the canonical Postgres UTC timestamp regex for completed
    share-revocation cleanup.
  - Stopped file-mutation lock release from deleting shared mutation-lock parent
    directories.
  - Made file-history timestamp allocation fail closed when persisted history
    indexes cannot be read, and kept unreadable-history writes/deletes from
    starting disk/version/history mutation.
- Previous pass fixes against commit `8a8ea55`:
  - Added a runtime type guard before local-author labels are trimmed.
  - Cleared the timeout fallback in the history symlink-owner lock-race test.
  - Asserted that missing-admin cleanup is attempted before the share-revocation
    route reports `failed-precondition`.
  - Updated the MCP history-store comment to match the unsupported-platform
    in-memory fallback.
  - Added export paths to chat workspace-scoped keying requirements.
  - Bound versioned-workspace `replace(...)` replay/dedupe to canonical
    `fromPath` and `toPath` in addition to object IDs, freshness guards, and
    payload digest.
  - Moved history-blob persistence inside the write/delete rollback cleanup flow.
  - Added file-mutation lock ownership fencing before durable disk, version,
    history, journal, recovery, and cleanup mutation phases, with coverage that a
    reclaimed lock stops a write before it commits.
- Previous pass fixes against commit `d0eaaa1`:
  - Added claimed-age assertion coverage for share-revocation backlog stats.
  - Bound versioned-workspace `replace(...)` idempotency envelopes to canonical
    normalized `fromPath` and `toPath` endpoints.
  - Replaced the timing-based history-lock wait assertion with an observable
    lock-wait delay signal before releasing the filesystem lock.
  - Derived versioned text store lock and reclaimer heartbeat cadence from the
    configured stale threshold instead of a hard-coded five seconds.
  - Added hash-addressed internal history blobs for oversized text snapshots and
    used them to restore large text writes/deletes when inline snapshot text is
    intentionally unavailable.
  - Bounded completed share-revocation cleanup deletes and added an active
    backlog partial index for pending/claimed revocation scans; the later
    `bfc0ccc` follow-up switched the bounded cleanup selector from `ctid` to
    stable event `id`.
  - Changed pending file-mutation recovery to sweep the root journal directory
    and dispatch each journal to its owning workspace history namespace.
  - Validated configured workspace authors before durable mutation so malformed
    author shapes cannot enter ChangeSets or pending journals.
- Previous pass fixes against commit `193fa89`:
  - Made store-lock reclaimer owner metadata best-effort for lease inspection so
    malformed or unreadable `.reclaimer/owner.json` is treated as no parsed
    owner while owner-file mtime still contributes to freshness; added stale
    unreadable-owner coverage.
  - Revalidated the current workspace path identity after preimage backup
    capture so a path replacement between the opened handle and the live path
    aborts before journaling or mutation.
  - Replaced an unbounded recovery-path `readFile("utf8")` comparison with
    `snapshotForOpenFile(...)` plus `snapshotsMatch(...)`.
  - Filtered `listTextFiles()` through `validateUserWritePath(...)` before
    returning scanned files so internal `.dohc` state and other reserved paths
    cannot appear as user files.
  - Corrected the descendant rollback regression to roll back the ancestor
    version's own write moment, proving the inherited-dependent guard.
  - Tied shared-channel delivery to live grant revalidation for message bodies,
    links, snippets, notifications, exports, attachments, previews, and related
    payloads before any external content is computed or returned.
  - Marked the write-observation ledger and shared principal-envelope policy as
    pending implementation in the P0A inventory, noting current reliance on
    local generated record IDs and userId-centered shared route checks.
- Previous pass fixes against commit `b24ab5c`:
  - Changed persisted `user` and `agent` author IDs to fail parsing when their
    stored values are not already canonical, while preserving trim-normalization
    only for local human-readable author labels.
  - Made share-revocation retry selection treat missing or malformed
    `retryAfter`, `claimExpiresAt`, and legacy `claimedAt` timestamp text as due
    for retry, with query-shape coverage for the malformed timestamp branches.
  - Removed the stale reviewer-brand token from the PR00 evidence scan and
    historical notes, keeping generic automated-review wording in the execution
    log.
- Previous pass fixes against commit `72563e7`:
  - Added a runtime `parseChangeAuthor(...)` contract in `workspace-core` and
    used it when rehydrating pending-journal expected change sets so persisted
    author data cannot bypass the local-author non-empty label invariant.
  - Scoped pending journal reads before full normalization by peeking at the raw
    `workspaceId`, with regression coverage that a malformed workspace-B journal
    cannot break workspace-A recovery.
  - Guarded the Rust SQLite sidecar header probe with `symlink_metadata` and a
    non-symlink regular-file check before opening the companion path.
  - Added successful write rollback coverage for created and overwritten text
    files, including assertions that rollback removes the mutation moment instead
    of recording an extra one.
  - Clarified that versioned-workspace `replace(...)` destination preconditions
    deliberately include `expectedBaseVersion` for self-replace and
    version-guarded replacements.
- Previous pass fixes against commit `3938653`:
  - Added an explicit `database-object-upgrade-in-flight` state to the raw
    database artifact cutover plan so scanners/watchers resume the claimed
    upgrade instead of reclassifying during a crash window.
  - Tightened the write-observation ledger plan so dohc-controlled writes reserve
    or claim a pending `(workspaceId, writeObservationId)` row before committing
    the disk mutation, while external writes claim before history emission and
    never mint a post-write fallback token.
  - Updated the Rust kernel spike sidecar classifier to skip SQLite sidecars for
    extensionless database companions by checking the companion SQLite header,
    while preserving ordinary files such as `notes/draft-wal`.
  - Made desktop history store fallback platform-aware: Linux keeps durable
    anchored history, while unsupported desktop platforms use the explicit
    ephemeral fallback until a native anchored writer exists.
  - Changed `pendingMutationStateExists()` to require actual pending `.json`
    journals instead of treating an empty pending directory as recovery work.
  - Restored descriptor-anchored final rename/remove for symlink-swap resistance
    while retaining pre-mutation containment checks on the verified parent handle.
  - Standardized the execution-log review command wording to the automated-review
    term used elsewhere in the plan.
  - Clarified native-filesystem `replace(...)` history behavior so only
    non-self replacements emit a history/provenance event; self-replace validates
    and returns existing state without a new event.
  - Normalized versioned-workspace `replace(...)` auth context wording to
    `validated server-derived auth context`.
  - Previous pass result against commit `8a9c573`:
  - automated review approved that committed diff with 0 issues after the
    dbfa784 follow-up fixes.
  - Previous pass fixes against commit `dbfa784`:
  - Inlined share-revocation retry scan JSON expressions so the query shape
    matches the pending/claimed partial retry indexes directly.
  - Removed descriptor-path mutation for anchored write/delete and now performs
    the final rename/remove against the canonical target path after parent
    identity revalidation, avoiding mutation through a directory fd that may have
    been moved out of the workspace.
  - Propagated file-mutation lock release failures after successful tasks while
    preserving suppressed cleanup attachment for primary task failures.
  - Preserved pending journals when prepared-journal backup validation/removal
    fails, and added assertions for unsafe backup, malformed preimage, and
    malformed journal recovery-failure cases.
  - Added read coverage for symlinked directory escapes alongside stat,
    write/delete, restore, history, and version checks.
  - Previous pass fixes against commit `08a6984`:
  - Made `replace(...)` destination preconditions symmetric with source
    preconditions in both versioned-workspace and native-filesystem specs,
    including `expectedBaseVersion` for self-replace/version-guarded flows.
  - Scoped pending file mutation recovery to the owning workspace only; a
    workspace A startup now preserves workspace B journals until workspace B
    opens and recovers them.
  - Threaded the configured store-lock stale window through reclaimer freshness
    checks instead of using a hardcoded reclaimer stale threshold.
  - Preserved successful file-mutation task results when lock-release cleanup
    fails, while still attaching cleanup failures to primary task errors.
  - Held the workspace file mutation lock across read tasks for cross-process
    read consistency, while cleaning empty mutation-lock parent directories after
    release so pure read-only calls do not leave engine state behind.
  - Clarified `replace(...)` idempotency text to bind the replacement payload
    digest and symmetric causal guard tuple.
  - Previous pass fixes against commit `76aabef`:
  - Moved the neutral local-file `humanSummary` assertion into the ungated
    summary block while keeping persistence-backed history tests Linux-gated.
  - Made the external mutation-lock test owner use one captured timestamp for
    token, creation time, and heartbeat time.
  - Added `getShareRevocationDisconnectBacklogStats()` and test coverage so
    pending/claimed share-revocation disconnect queue count and age are
    monitorable when Hocuspocus admin disconnect is not configured.
  - Fenced versioned-text atomic publish with the active store-lock lease
    immediately before rename, with regression coverage for lock replacement
    after temp-file write.
  - Allocated file-history `recordedAtMs` as a monotonic value from wall clock,
    local max, and persisted history max while preserving journal-first
    rollback when history storage is unreadable.
  - Stored the expected change set in pending file mutation journals and only
    treated an existing history ID as committed when the stored record matches
    the exact change content and timestamp.
  - Restored file-mutation release failure propagation when the protected task
    succeeds, while still attaching release cleanup failures to primary task
    errors.
  - Replaced unbounded `readTextFile()` buffering with the capped open-file
    reader and an after-open truncation check.
  - Tightened native filesystem `replace(...)` idempotency-key binding to
    include server-derived auth context, actor/session, source/destination
    identity, both causal preconditions, and the replacement payload digest.
  - Previous pass fixes against commit `29c5257`:
  - Added rollback/retry semantics to the database-object single-claim cutover
    plan so failed tombstone/quarantine, binding, or lane-exposure steps cannot
    leave paths half-applied or invisible.
  - Tightened write-observation recovery guidance so late observers reattach to
    existing pending rows by durable `(workspaceId, writeObservationId)` state
    instead of deriving identity from path/digest/size/timestamps.
  - Made the malformed fresh store-lock owner test use a clearly fresh mtime.
  - Re-aligned the Rust kernel spike sidecar classifier with the production
    path-based `.db`/`.sqlite*` sidecar rule and removed the sibling-header
    probe from sidecar classification.
  - Added a typed size guard for `readTextFile` before buffering file contents.
  - Validated recovered history records against the attempted change set before
    accepting an existing history ID as committed.
  - Previous pass fixes against commit `08470b3`:
  - Changed the Rust kernel spike sidecar classifier to require a SQLite file
    header instead of trusting `.db`/`.sqlite*` extensions, with a regression
    for non-SQLite `.db-journal` files.
  - Documented that MCP intentionally uses ephemeral history on unsupported
    platforms while desktop fails closed for durable history.
  - Added reclaimer-lease health checks so stale store-lock recovery verifies
    reclaimer identity and owner token before quarantine and removal.
  - Updated the execution-log evidence command to include `apps/web/AGENTS.md`.
  - Made the neutral local-file `humanSummary` test construct a `HistoryRecord`
    directly instead of exercising Linux-gated persistence.
  - Added a non-mutating filesystem-level read barrier and regression coverage
    so readers wait behind existing cross-process mutation locks without
    creating engine state themselves.
  - Mirrored `replace(...)` self-replace semantics into the native filesystem
    spec.
  - Verified disk preimage backups against `journal.before` before treating a
    matching live target and backup as successful recovery evidence.
  - Previous pass fixes against commit `1cc19c1`:
  - Changed desktop history store setup to fail closed instead of falling back
    to ephemeral history when durable `.dohc/history` persistence is
    unsupported.
  - Routed file/history/version read APIs through non-mutating in-memory
    coordination, only entering the mutation/recovery path when pending
    mutation state already exists and recovery writes are actually needed.
  - Suppressed file-mutation lock release failures after a successful task so a
    committed write/read result is not converted into a cleanup failure.
  - Previous pass fixes against commit `485e638`:
  - Exported the desktop history store options from `workspaceWatcher` and
    reused that constant from `workspaceActivity`, keeping desktop history
    reader and writer fallback behavior in lockstep.
  - Cleared blocked-test timers and ran read/history blocked assertions in
    parallel so the test is deterministic without serial idle waits.
  - Switched completed share-revocation cleanup to the immutable
    `payload.completedAt` UTC ISO text key, aligned the query with the partial
    index, and used `now()` for a stable cutoff expression.
  - Clarified `replace(...)` self-replace semantics, including provenance,
    destination preconditions, and idempotency-key binding.
  - Tightened database-object cutover guidance so raw database artifacts move
    through a single-claim atomic transition before the database-object lane is
    visible.
  - Made unreadable versioned-text lock owners fail through the typed
    `persist-failed` envelope while preserving the lock directory.
  - Clarified shared-channel revocation so cleanup starts after the
    authoritative tombstone/version commit, while readers, watches, exports,
    and caches consult committed revoke/expiry state directly.
  - Replaced the completed share-revocation cleanup migration/schema expression
    with an immutable `completedAt` text index instead of casting JSON text to
    `timestamptz`.
  - Preserved primary workspace mutation failures when file-mutation lock
    release also fails by attaching/suppressing the release failure.
  - Changed file-mutation lock wait logic so an actively heartbeating owner is
    not treated as a stale timed-out lock.
  - Previous pass fixes against commit `d9b830e`:
  - Hardened completed share-revocation cleanup timestamp expressions against
    malformed `payload.completedAt` values in both the query and partial index.
  - Removed completed-event retention cleanup from the synchronous
    `revokeShare` request path; retry/background cleanup remains responsible
    for retention sweeps.
  - Clarified that Phase 0's descriptor-relative history writer supports Linux
    only and macOS remains fail-closed until a correct `/dev/fd` path exists.
  - Updated stale execution-log security notes for non-Linux fail-closed
    construction and root-scoped journal recovery by recorded workspace.
  - Previous pass fixes against commit `0eaff21`:
  - Removed the stale reviewer-brand token from the execution-log evidence scan
    and kept generic automated-review wording as the canonical docs language.
  - Tightened ThreadLink docs so visibility scope is derived server-side from
    authoritative target identity before grant validation.
  - Clarified external shared-channel policy to distinguish visible
    message-level thread metadata from hidden non-shared resource metadata.
  - Clarified write-observation recovery reattachment to an existing pending
    `(workspaceId, writeObservationId)` row before minting any new token.
  - Split authenticated actor identity from delegated grant/resource scope in
    the effective-policy resolver guidance.
  - Changed root-scoped pending file mutation recovery to process all journals
    with the journal workspace's history namespace.
  - Previous pass fixes against commit `53cbfa0`:
  - Stopped treating non-`ENOENT` file-mutation lock owner read failures as
    missing owners, so unreadable owners prevent unsafe reclaim.
  - Captured file-mutation owner-directory identity on acquisition and checked
    it before release cleanup or stale reclaim deletion.
  - Changed completed share-revocation cleanup retention to age from
    `payload.completedAt`, falling back to `created_at` for legacy rows, and
    aligned the partial cleanup index to that expression.
  - Disabled anchored history mutations on macOS until a correct non-`/dev/fd`
    implementation exists.
  - Previous pass fixes against commit `b1721ee`:
  - Replaced unbounded `snapshotForOpenFile()` reads with capped reads that fall
    back to streaming SHA-256 snapshots when the cap is exceeded.
  - Treated malformed but present versioned-text lock owner files as fresh based
    on owner-file mtime, with regression coverage.
  - Ignored pending file mutation journals belonging to other workspaces during
    workspace-specific recovery so one workspace cannot block another.
  - Previous pass fixes against commit `ecb3a78`:
  - Made the file-mutation future-heartbeat test deterministic against the
    injected test clock and removed an unused versioned-text moment helper.
  - Loosened the unreadable versioned-text lock-owner test so it asserts failure
    and preservation without pinning to one platform errno.
  - Extended Rust kernel SQLite sidecar detection to extensionless SQLite base
    files by sniffing the base file header, while preserving non-sidecar
    `*-wal` files whose base is not SQLite.
  - Documented the missing-admin share revocation pending event as the durable
    retry queue.
  - Guarded the versioned-text lock cleanup branch that backs out after a
    reclaimer appears with the acquired directory identity.
  - Added a partial Postgres index for completed share-revocation disconnect
    cleanup and covered it in schema tests.
  - Revalidated captured disk preimage backups before journaling by checking the
    backup against the snapshot and the live open file against the copied
    backup's snapshot.
  - Previous pass fixes against commit `f81b96f`:
  - Captured the versioned-text store lock directory identity at acquisition and
    verified it before `assertHealthy()` and release removal, so stale holders
    cannot delete a replaced/reused lock directory.
  - Moved retry-batch share-revocation terminal cleanup out of the per-row loop
    so completed-event retention cleanup runs once after the worker batch.
  - Previous pass fixes against commit `e3a5912`:
  - Clarified deterministic raw database artifact cutover before database-object
    routing enables scan/watch classification.
  - Made the write-observation ledger handoff explicit: the durable
    `writeObservationId` is persisted once, pending rows have recoverable state
    and exclusive claims, and later owners resume/finalize the same claim.
  - Clarified canonical server-authenticated principal mapping for user
    sessions, service accounts, share-link requests, and other non-browser
    callers across Hocuspocus ACL, workspace-postgres write policy, and
    workspace-api shared routes.
  - Ran share-revocation completed-event cleanup in the common retry path before
    the admin-disconnect guard and after successful completion cleanup attempts.
  - Made version rollback dependency checks evaluate independent object
    mutations across the candidate version lineage, with descendant coverage.
  - Added reclaimer-owner freshness checks and a heartbeat for active
    store-lock reclaimers so long-running stale-lock cleanup is not quarantined
    as stale.
  - Reordered pending file mutation recovery so disk preimage/postimage
    validation happens before version rollback, preserving recovery conflicts
    without mutating version state.
  - Previous pass fixes against commit `d34aa9d`:
  - Renamed share-revocation retention to completed/terminal cleanup semantics.
  - Clarified native-filesystem fallback history recording as quarantine-only or
    descriptor/handle-bound before durable mutation.
  - Bound `replace(...)` idempotency conflicts to `sourceObjectId` and
    `destinationObjectId`.
  - Cloned ephemeral history records at the fallback store boundary for
    record/list/listSince/get.
  - Gated durable history-store test suites to anchored filesystem mutation
    platforms, while preserving Linux-only symlink-owner coverage.
  - Previous pass fixes against commit `286a72a`:
  - Made the P0R benchmark launcher environment-agnostic while keeping Node
    v24/Corepack provenance in the toolchain details.
  - Added explicit server-side owning-workspace authorization requirements for
    `ThreadLink` shared-channel writes; client-provided identity is not trusted.
  - Added the `apps/app/AGENTS.md` and Convex AI guidelines context files to the
    recorded kickoff review command.
  - Rejected existing non-regular text targets before atomic write/restore
    rename, with directory-target regression coverage.
  - Preserved future-dated file mutation locks when the current owner is a live
    foreign process.
  - Narrowed journal rollback tolerance back to benign missing-file/version
    cases so unsafe rollback validation errors fail closed.
  - Changed share-revocation cleanup to garbage-collect only terminal completed
    disconnect records, preserving pending/claimed retries until successful
    disconnect handling.
  - Removed the undefined destination object-version precondition from
    `replace(...)` docs and aligned versioned/native specs on
    etag/content-hash destination freshness.
  - Previous pass fixes against commit `2110225`:
  - Added `O_NONBLOCK` to versioned-file read opens while preserving
    `O_NOFOLLOW`, so FIFO targets cannot block read/stat/snapshot flows.
  - Routed durable history records through `historyRecordFromChangeSet()` before
    filename creation so record IDs are validated consistently.
  - Preserved active share-revocation claimed disconnect leases during stale
    cleanup by keeping rows whose `claimExpiresAt` is still in the future.
  - Added the exact Node v24 benchmark launcher provenance to the P0R plan.
  - Escaped the literal `Y\.Doc` evidence grep in the execution log.
  - Clarified shared-channel grant revocation as commit-tombstone-first before
    watch/search/export cleanup fanout.
  - Clarified that raw filesystem saves use an engine-minted workspace-scoped
    observation token, while HTTP/MCP/agent-tool writes use API idempotency
    keys.
  - Previous pass fixes against commit `e83f64e`:
  - Persisted the intended pending file mutation postimage and added
    `recovery-conflict` preservation when live disk diverges from that
    postimage before restart recovery.
  - Added operation-time verified-directory descriptor containment checks before
    rename/delete side effects.
  - Made desktop watcher/activity and MCP history surfaces explicitly opt into
    the in-process unsupported-platform fallback while keeping durable history
    fail-closed by default.
  - Reviewed journal version rollback recovery error handling; a later pass
    narrows unsafe rollback validation errors back to fail closed.
  - Added named-version assertions to rollback-dependency coverage.
  - Made missing-admin share revocation cleanup non-fatal so callers reliably
    receive `failed-precondition`, with route coverage for cleanup failure.
  - Renamed the file-workspace test gate to the anchored descriptor filesystem
    implementation it exercises; off-platform runtime callers use the explicit
    fallback above rather than this low-level anchored writer.
  - Previous pass fixes against commit `fde5ad9`:
  - Strengthened unreadable stale versioned-text lock owner coverage to assert
    the unreadable owner path itself remains a directory.
  - Removed host-specific machine naming from P0R benchmark provenance.
  - Made backup-copy temp files writable during durability sync before applying
    the final chmod/mode.
  - Previous pass fixes against commit `6e62637`:
  - Made `ephemeralIfUnsupported` an explicit opt-in for the history store
    fallback; default persistent history still fails closed without anchored
    mutation support.
  - Added committed-history recovery around versioned file history writes so a
    committed record that throws during cleanup is returned from `history.get`
    instead of forcing rollback.
  - Enforced file mutation lock timeout unconditionally once the wait budget is
    exhausted.
  - Strengthened redo provenance coverage to assert the returned change-set
    shape.
  - Fixed stale-lock fixture timestamps and renamed the symlink-owner target for
    clarity.
  - Clarified P0R benchmark fixture bytes by accounting for prefix and newline
    overhead.
  - Documented local-disk heartbeat assumptions in the versioned text store.
  - Superseded by the `dd77390` follow-up: an earlier attempt added
    pending/claimed share-revocation cleanup when the Hocuspocus admin
    disconnect worker was not configured, but current code preserves active
    pending/claimed jobs and only cleans completed terminal events.
  - Previous pass fixes against commit `e294e04`:
  - Strengthened the read-lock regression so `readTextFile()` and
    `history.list()` are each independently raced against the workspace mutation
    lock timeout.
  - Added an explicit in-process fallback history store for platforms without
    descriptor-relative filesystem mutation support, so desktop/watch/MCP
    surfaces can continue operating while durable history recording is gated.
  - Updated the native filesystem spec note to describe durable history gating
    and the temporary in-process fallback for unsupported platforms.
  - Previous pass fixes against commit `3a3607d`:
  - Clarified that raw filesystem provisional captures stay quarantined/hidden
    until fail-closed policy and lock revalidation pass.
  - Split raw filesystem observation-token dedupe from API idempotency-key
    retry semantics in the native filesystem spec.
  - Added the temporary TypeScript history-writer platform note:
    descriptor-relative Linux/macOS only until the native kernel provides a
    Windows equivalent.
  - Added `O_NOFOLLOW` to versioned-file directory-handle opens.
  - Treated future-dated file mutation heartbeats as active only when the owner
    PID is alive; dead/unreachable owners remain reclaimable.
  - Isolated namespaced history under `.dohc/history/namespaces/<namespace>` and
    added coverage for default-lock basename collisions.
  - Re-read lock owner generations after publishing a history lock owner and
    enter the critical section only when the current token is the sole valid
    owner.
  - Previous pass fixes against commit `f7e8113`:
  - Narrowed history-store test gating so only the symlink lock-owner case stays
    Linux-gated; persistence, concurrency, namespace, summary, and cursor tests
    run in normal suites.
  - Added an exclusive recovery owner/lease requirement for pending
    `writeObservationId` ledger rows before replaying history emission.
  - Added shared core coverage that `restoreDirection: "redo"` is accepted by
    the provenance contract.
  - Derived the desktop history author filter from
    `ChangeSetRecord["author"]["kind"]`.
  - Made future-heartbeat and unreadable-stale-owner lock tests deterministic by
    using the injected test clock or explicit old mtimes.
  - Updated the replace idempotency example to include server-side auth context
    plus actor/session in the bound scope.
  - Rejected empty history namespaces explicitly instead of falling back to the
    unscoped history directory.
  - Routed public history reads through the workspace recovery/read lock and
    extended read-lock coverage to `history.list()`.
  - Fixed restore preimage backup cleanup ownership so failed delegated
    write/delete restores still clean temporary backups.
  - Streamed backup size/hash verification and only buffered backup bytes for
    text comparison.
  - Derived history directory creation suffixes from the configured root path so
    symlinked workspace roots do not produce false escaped-path failures.
  - Previous pass fixes against commit `6157665`:
  - Expanded the P0R benchmark provenance to the full commit SHA.
  - Kept the PR00 evidence command focused on product and architecture
    terminology while preserving the updated path coverage.
  - Added `watch` to the workspace-scoped chat primitive key guidance.
  - Created history lock directories and owner directories through verified
    parent directory handles instead of raw path `mkdir`.
  - Replaced the hard Linux-only history mutation guard with descriptor-relative
    support detection: Linux uses `/proc/self/fd`, macOS uses `/dev/fd`, and
    unsupported platforms fail with an explicit restricted-caller error.
  - Changed the versioned-file-workspace test suite to use a normal outer
    `describe` with Linux-gated integration cases.
  - Split pure `humanSummary` assertions into platform-independent fixtures and
    kept storage/concurrency cases Linux-gated.
  - Previous pass fixes against commit `829ab37`:
  - Added an explicit `failed`/`abandoned` terminal state to the
    `writeObservationId` ledger plan so unrecoverable claims do not remain in
    limbo.
  - Changed history directory creation to create each segment through a verified
    parent directory handle instead of path-based recursive `mkdir`.
  - Changed empty history-lock cleanup to remove through a verified parent
    directory handle instead of raw `rmdir(lockDir)`.
  - Made history lock containment fail fast when the existing lock path is not a
    directory.
  - Linux-gated the history mutation test suites because the hardened history
    writer intentionally fails closed without Linux descriptor-relative support.
  - Reopened pending rollback backups with `O_NOFOLLOW`, verified the open
    handle against the journal preimage, and copied from the same verified
    handle; added corrupt-backup regression coverage.
  - Added best-effort cleanup when this process creates a versioned-text
    reclaimer directory but fails before writing or syncing its owner marker.
  - Previous pass fixes against commit `c1a8f17`:
  - Replaced the previous portable non-Linux history mutation fallback with an
    explicit fail-closed guard for writes and verified cleanup when
    descriptor-relative mutation support is unavailable.
  - Added an owner marker to versioned-text store reclaimer leases and made
    release cleanup verify both directory identity and owner token before
    removing the reclaimer.
  - Kept stale reclaimer cleanup conservative: if stale removal cannot prove it
    removed the observed reclaimer, the active-lock check treats the reclaimer
    as still present.
  - Made public read recovery fail closed for unreadable history storage instead
    of continuing with unresolved pending journals.
  - Made rollback restoration throw when a journal has no backup and its
    preimage snapshot is unavailable, preserving the journal for later
    recovery; added regression coverage for this case.
  - Previous pass fixes against commit `4fd2b10`:
  - Clarified cross-workspace `ThreadLink` ownership so the link row belongs to
    the authoring workspace while the target workspace/resource/scope drives
    grant validation.
  - Bound the public version reader facade to the workspace captured at
    construction time so callers cannot inject another `workspaceId`.
  - Made the versioned-file-workspace test suite skip at the `describe` level
    on non-Linux platforms.
  - Documented that only the first observer of a durable write mints a
    `writeObservationId`; later observers must reuse the existing workspace
    write token.
  - Restored a non-Linux portable history atomic-write fallback while keeping
    the Linux descriptor-relative write path; this was superseded by the
    fail-closed guard above after the next automated review.
  - Reworked history-lock owner cleanup so acquisition and release delete owner
    directories only after lock/owner identity rechecks.
  - Widened the symlink-owner reclaim timeout budget to reduce CI flake risk.
  - Previous pass fixes against commit `78fc516`:
  - Strengthened the versioned-text-store lock-dir assertion to verify
    `Stats.isDirectory()` returns true.
  - Made workspace-history non-Linux atomic writes fail closed instead of using
    the unsafe portable path.
  - Added the shared-chat requirement that exposed HTML atoms, embedded app
    views, rich previews, and active rich payloads are sanitized and sandboxed.
  - Added a construction-time platform guard for versioned file workspaces so
    unsupported filesystems fail immediately with `unsupported-filesystem`.
  - Previous pass fixes against commit `d9dab71`:
  - Pinned bare `finance/cache-wal` scan behavior as a normal visible file, not
    a SQLite sidecar.
  - Added `.sh` to the shared core `mediaTypeForPath` table as `text/plain`,
    with core path coverage.
  - Treated future-dated file mutation lock heartbeats as corrupt/stale instead
    of active, with reclaim coverage.
  - Restored workspace-lock coverage over public read paths and read-only
    version facades; read-path recovery remains best-effort only for unreadable
    history storage so pending journals are preserved.
  - Hardened existing internal `.dohc` directory reuse by requiring real
    directories inside the root and tightening permissive modes to owner-only.
  - Changed stale versioned-text lock reclaimer cleanup to quarantine, verify
    identity, then delete instead of recursively removing the live path.
  - Previous pass fixes against commit `dad74de`:
  - Added direct file-workspace invalid-path coverage for reserved paths,
    `..` traversal, normalized traversal, and absolute filenames across write,
    delete, and restore.
  - Fixed versioned-text stale-lock owner reads so only `ENOENT` counts as a
    missing owner; non-`ENOENT` read/stat errors now throw, and quarantine
    verification restores the original lock path before rethrowing.
  - Rejected `.` and `..` history namespaces, with regression coverage.
  - Replaced public mutable `history` and `versions` stores on
    `VersionedFileWorkspace` with read-only facades; raw stores are available
    only through test-only `unsafeInternals`.
  - Made file-mutation lock timeouts account for active lock owner heartbeat and
    bounded live-PID liveness before throwing.
  - Previous pass fixes against commit `aa9b935`:
  - Tightened chat `ThreadLink` shared-grant validation so a grant id must match
    the owning workspace, target resource identity, and visibility scope before
    accepting a link.
  - Extended shared-chat redaction policy to attachments, inline media,
    embedded binaries, and other non-text payloads.
  - Changed the Phase 0A effective-policy inventory language from guidance to a
    hard requirement for server-authenticated identity and workspace-scoped
    lock/share decisions.
  - Returned the Rust kernel spike to the same path-only SQLite sidecar contract
    used by the shared scanner, leaving extensionless `cache-wal` style files
    visible until the shared contract changes.
  - Namespaced versioned-file history by `workspaceId` through the history
    store, with regression coverage for list/restore isolation.
  - Moved delete version lookup into the rollback-protected block and added
    coverage for cleanup of preimage backups after version lookup failure.
  - Removed the non-Linux raw-path fallback from versioned file read/rename/rm
    helpers; this proof now fails closed when anchored directory handles are
    unavailable.
  - Reworked stale history lock cleanup to rename stale directories into a
    verified tombstone under the checked parent before recursive removal.
  - Previous pass fixes against commit `f393907`:
  - Clarified the native filesystem workspace-scoping contract so
    `replace(...)` validates `workspaceId`/`versionId`, source/destination
    object ids, and both causal preconditions against one workspace/version
    before storage access.
  - Increased the read-only paused-write regression timeout to a named 500 ms
    bound.
  - Hardened history lock owner reads behind a bounded helper that rejects
    symlinks, non-regular files, and oversized owner files before parsing; added
    symlink-owner reclaim coverage.
  - Preserve leading UTF-8 BOM bytes in `readTextFile` and history snapshot
    decoding, with regression coverage.
  - Previous pass fixes against commit `d484b0d`:
  - Refined Rust SQLite sidecar detection to skip extensionless sidecars only
    when the sibling database has a SQLite header, while keeping non-SQLite
    `*-wal` files visible.
  - Returned `versionedFileWorkspace.test.ts` to a normal cross-platform
    `describe`, keeping `itLinux` only for mode/symlink-specific cases.
  - Made the read-only paused-write regression release its writer in a
    `finally` block.
  - Reworked file-workspace preimage handling so write, delete, and restore use
    one captured file state and one rollback backup from a single open handle.
  - Narrowed `readTextFile` UTF-8 error mapping so I/O errors propagate normally
    and only decode failures become `not-text`.
  - Allowed stale incomplete history lock directories to be reclaimed after the
    verified identity check instead of failing on `ENOTEMPTY`.
  - Previous pass fixes against commit `5eb8b99`:
  - Updated the Rust workspace-kernel scanner to skip extensionless SQLite
    sidecars ending in `-wal`, `-shm`, or `-journal`, with fixture coverage.
  - Added CPU, core count, OS/kernel, filesystem, and toolchain provenance to
    the Rust spike benchmark report.
  - Added a `pending` -> `emitted` recovery-state requirement to the Phase 0A
    write-observation ledger so claimed writes cannot strand missing history
    entries after a crash.
  - Clarified execution-log machine context across earlier Node v24.18.0
    compatibility reruns and latest Node v18.19.1 / pnpm 10.24.0 follow-ups.
  - Changed file-workspace tests to be Linux-scoped, matching the current
    descriptor-relative mutation contract.
  - Changed `readTextFile` to fatal-decode UTF-8 and reject invalid text bytes,
    with regression coverage.
  - Rechecked history lock and owner directory identities immediately before
    stale-lock cleanup removes owner or lock paths.
  - Previous pass fixes against commit `844325d`:
  - Renamed the desktop watcher fallback attribution constant from
    `LOCAL_USER` to `LOCAL_AUTHOR`.
  - Changed history temp-file writes to exclusive no-follow creation and added a
    bounded stale-heartbeat fallback so a live reused PID cannot pin a stale
    history lock forever.
  - Threaded the caller's lock deadline into the versioned-text-store reclaimer
    path so reclaimer waits cannot exceed `lockTimeoutMs`.
  - Moved file-workspace read/list/stat onto a read-only path that only takes
    the mutation lock when pending recovery journals actually exist.
  - Added regression coverage proving read-only calls do not block behind a
    paused unrelated write when no recovery is pending.
  - Reworked the share-revocation worker query to reuse extracted retry keys and
    compare/order on the same text-key shape as the retry indexes.
  - Previous pass fixes against commit `8d7c5af`:
  - Separated delete precondition wording from rename/move source preconditions
    in the versioned-workspace and native-filesystem specs.
  - Renamed the ambiguous destination replace guard in both specs; a later pass
    simplifies the destination precondition vocabulary to etag/content-hash.
  - Kept Linux descriptor-relative history writes while adding a contained
    portable non-Linux atomic write path for `workspace-history`.
  - Changed file-write history to record `after` from the mutation text instead
    of re-reading live disk after the write, with drift regression coverage.
  - Changed disk history snapshot capture to decode small files with fatal
    UTF-8 and mark invalid byte sequences unreadable instead of mangling them.
  - Preserved `undo` provenance when restoring the `before` snapshot of a prior
    `history-restore` record.
  - Added store-lock reclaimer lease checks before and after canonical lock
    acquisition, plus stale reclaimer expiry before timeout.
  - Added regression coverage for fresh/stale reclaimer leases.
  - Previous pass fixes against commit `b0bd099`:
  - Changed `.dohc/history` record files, `index.json`, and lock-owner
    heartbeats to write through verified descriptor-relative parent directory
    handles instead of reopening string paths after containment checks.
  - Replaced skipped Windows symlink-escape history coverage with a portable
    directory-link fixture that uses junctions on Windows and directory symlinks
    elsewhere.
  - Clarified shared-channel revocation semantics: server-held export artifacts
    and future access are revoked, but bytes already downloaded by a client
    cannot be clawed back and must be handled through audit/provenance.
  - Mirrored the versioned-workspace `replace(...)` API and idempotency replay
    fence in the native filesystem design spec.
  - Aligned the `replace(...)` API table with the full idempotency replay fence:
    validated auth context, workspace/version, operation type, both object ids,
    both causal preconditions, and payload digest.
  - Required cross-workspace `ThreadLink` create/update to validate the
    share/grant server-side before storage and reject forged, stale, revoked,
    expired, or ambiguous grants.
  - Changed pending journals for a different workspace in the same root to fail
    closed instead of being silently ignored.
  - Made the file workspace constructor enforce the current Linux-only
    descriptor-relative mutation contract up front.
  - Added workspace-fs scan coverage for SQLite `-journal` sidecars.
  - Validated `.dohc/history/index.json` containment directly before reading the
    history index.
  - Added a versioned-text-store reclaimer mutex and re-stat check before stale
    lock quarantine so only the observed stale lock identity can be displaced.
  - Previous pass fixes against commit `c9aa8a6`:
  - Tightened shared-channel grant revocation ordering so the authoritative
    grant is tombstoned or version-bumped before cleanup starts, and extended
    external-viewer filtering to thread titles, link previews, exports, and
    exposed metadata.
  - Extended symlink escape coverage to `statTextFile(...)` and
    `listTextFiles()`.
  - Changed versioned-text heartbeat refresh to update owner-file timestamps
    after token verification instead of rewriting `owner.json`, keeping the
    owner file parseable during refresh.
  - Added SHA-256 metadata to truncated large-file snapshots and regression
    coverage proving a large unchanged created file can restore to deletion.
  - Removed non-Linux path-based mutation fallbacks from descriptor-relative
    rename/remove helpers; non-Linux mutation attempts now fail closed.
  - Previous pass fixes against commit `84a912d`:
  - Rejected unsafe integer bench options above `Number.MAX_SAFE_INTEGER`.
  - Changed versioned-text store heartbeat refresh to open the current owner
    file, verify the token, and write through that handle so an old reclaimed
    owner cannot overwrite a newly acquired owner path.
  - Removed the redundant `kind` key column from share-revocation retry indexes
    while keeping the partial `kind` filters.
  - Tightened the same-path serialization test so the queued second write must
    win and history must show `null -> one` followed by `one -> two`.
  - Removed remaining legacy automated-review command terminology from the P0C
    command block.
  - Wrapped unreadable or malformed pending-journal JSON in typed
    `recovery-failed` errors and added regression coverage.
  - Previous pass fixes against commit `d0c8d5f`:
  - Added `.sh` scanner fixture coverage in the Rust workspace-kernel spike so
    the `text/plain` shell-script media mapping is asserted.
  - Added `kind` to the share-revocation pending/claimed retry indexes so the
    migration indexes match the worker's kind-filtered scan and order key.
  - Changed versioned-text stale-lock quarantine recovery so no-longer-stale
    quarantined locks are restored only if the live lock path has not already
    been recreated; otherwise the quarantine is left alone instead of deleting
    or clobbering.
  - Labeled the remaining review CLI provenance in the execution log as
    automated-review reruns without legacy command terminology.
  - Added a Local author filter bucket in desktop history so
    `{ kind: "local" }` change records are selectable without using All/search.
  - Validated history `index.json.lock` paths before stale lock recovery or
    owner cleanup, reject symlinked lock directories, and added symlink-lock
    regression coverage.
  - Previous pass fixes against commit `459d834`:
  - Removed the same-path serialization test's real-time sleep; the second
    workspace now signals deterministically when it queues behind the first
    paused workspace mutation.
  - Changed versioned-text stale lock reclaim so validation-failure branches
    delete the quarantined stale directory instead of renaming it back over a
    possibly fresh `lockDirPath`.
  - Made history lock acquisition retry `ENOENT` interruptions during owner
    directory setup and outer acquisition, while preserving the existing lock
    timeout.
  - Opened workspace read handles through the verified parent directory handle
    on Linux before running the existing post-open path and identity checks.
  - Marked `FileHandle.createReadStream(...)` calls as `autoClose: false` when
    hashing or copying borrowed handles, so caller cleanup remains authoritative.
  - Previous pass fixes against commit `b5fe843`:
  - Added a test-only file-workspace hook so the same-path concurrency test
    pauses the first write after the workspace mutation lock is acquired, starts
    the second write while the first remains blocked, asserts the second write
    is still pending, then releases and verifies disk, version, and history
    state.
  - Added restart recovery history assertions across pending write/delete,
    version-recording, already-restored, created-file, other-workspace, and
    post-commit journal cases so recovery cannot synthesize compensating history
    entries silently.
  - Fixed restore redo summaries by using the shared `defaultSummary` logic for
    restore provenance, and added redo-summary assertions for file and delete
    restore paths.
  - Tightened shared-channel revoke/expiry cleanup wording so live watches and
    subscriptions terminate, delivered export artifacts are deleted outright,
    and search snippets/indexes may only be rebuilt if the revoked grant is
    excluded.
  - Tightened the versioned-workspace idempotency contract so write-producing
    retries bind validated server-side auth context, request payload digest,
    source/destination object ids for `replace(...)`, both sides' freshness
    guards, and transport-independent validated write intent.
  - Previous pass fixes against commit `0ecad2b`:
  - Validated Rust-bench numeric CLI flags during parse as positive integers,
    with invalid decimals failing before any fixture work starts.
  - Relaxed the rollback history test that overfit exact moment-log shape.
  - Added concurrent file-mutation coverage proving the version-store final
    snapshot matches the live disk text.
  - Added pending-journal recovery coverage proving another workspace's journal
    is ignored and left in place.
  - Hardened `.dohc/history` storage against symlink escapes using realpath
    containment checks before history reads, creation, lock acquisition, and
    writes.
  - Restored post-rename parent directory sync failure propagation in the
    history atomic writer.
  - Split history restore summaries so redo says "redid restore" rather than
    reusing undo wording.
  - Made share-revocation timestamp validation leap-year aware while still
    rejecting invalid dates.
  - Extended the Rust scanner fixture with a SQLite `-journal` sidecar.
  - Clarified shared-channel revocation cleanup so active watch streams and
    subscriptions terminate immediately and derived artifacts are purged or
    reindexed.
  - Strengthened the Phase 0 mutation-ledger design so dedupe identity is the
    per-write observation token `(workspaceId, writeObservationId)`, not
    path/digest/timestamp correlation fields.
  - Reworked stale versioned-text-store lock reclaim to quarantine the observed
    stale directory by rename and verify file identity before deletion.
  - Split file-workspace restore summaries so undo and redo produce distinct
    prose.
  - Stopped treating thrown history lookups as safe-to-skip rollback checks;
    unreadable history now preserves pending journals for later recovery.
  - Fixed created-file rollback preimage checks so a missing preimage does not
    count as complete when the target file currently exists.
  - Previous pass fixes against commit `c21f1df`:
  - Bound native-filesystem write/save idempotency to the request payload digest
    so a reused key with different bytes fails closed.
  - Bound `replace(...)` idempotency to both `sourceObjectId` and
    `destinationObjectId`.
  - Renamed the stale P0B `AI Review` heading to `Automated Review`.
  - Made history `writeFileAtomic` treat parent-directory sync after a successful
    rename as best-effort, so a post-visibility sync failure does not make
    `record()` report failure after `index.json` is already replaced.
  - Changed the history stale-lock fixture to use a deterministic non-live PID.
  - Clarified chats channel identity as the composite key
    `(workspaceId, channelId)` with slug/name as metadata only.
  - Allowed pending file-mutation preimage text to be the empty string and added
    empty-preimage recovery coverage.
  - Changed share-revocation retry eligibility to compare safely parsed
    `timestamptz` values and treat malformed/out-of-range timestamp payloads as
    due instead of lexically stuck.
  - Previous pass fixes against commit `10793bf`:
  - Removed duplicate Rust spike validation text from the P0R plan.
  - Made stale file-mutation lock recovery tests assert the stale owner is
    actually removed.
  - Classified Rust spike media types by basename and added `.sh` as text/plain.
  - Tightened the Rust bench CLI parser so missing/unknown flags fail loudly.
  - Updated chats specs to store immutable `channelId` references and to
    policy-filter shared-channel message bodies, search snippets, and
    notifications.
  - Updated native-filesystem specs so each API request resolves inside one
    workspace, while diff/merge can reference multiple versions in that
    workspace, and idempotency namespaces are server-derived.
  - Added explicit atomic `replace(...)` semantics to the versioned workspace
    spec instead of overloading rename/move overwrite behavior.
  - Clarified that the effective policy resolver derives identity server-side
    only.
  - Made share revocation persist the soft delete and pending disconnect event
    even when inline Hocuspocus admin disconnect is unavailable; retry scanning
    now treats malformed retry/claim timestamps as due instead of stuck forever.
  - Validated pending file-mutation `before` snapshots field-by-field instead
    of trusting arbitrary journal JSON.
  - Made missing/null snapshot recovery treat a missing parent directory as an
    idempotent no-op.
  - Reclaimed stale versioned-text-store lock directories before retrying the
    write instead of failing closed forever.
  - Changed the P0B JSON store save path to validate and clone only the touched
    workspace instead of deep-normalizing every workspace on every write.
  - Hardened final local file writes/deletes on Linux by opening the parent
    directory and addressing the final child path through
    `/proc/self/fd/<dirfd>/<basename>`; non-Linux keeps the checked path fallback
    until the Rust kernel lane owns portable descriptor-relative ops.
  - Tighten disk preimage journal backup validation so backup paths must resolve
    inside `.dohc/tmp` before stat, hashing, restore, or cleanup; add coverage
    for a malicious in-workspace backup path outside engine temp.
  - Sync parent directory entries after managed workspace/internal directory
    creation and fix the parent escape check so names like `..notes` are not
    rejected as traversal.
  - Keep restore temp files writable until after durability sync, then apply the
    final target mode.
  - Fence stale history/file lock takeover with token, heartbeat, and live-process
    checks, while still allowing this process to clean up its own stale test
    generations.
  - Add a branded non-empty local author label constructor in
    `@dohc/workspace-core`, and use it from desktop watcher, file workspace, and
    tests so the shared type matches the desktop IPC contract.
  - Use the local author label in history-restore summaries instead of the
    generic "Workspace" fallback.
  - Add version-store invalid-envelope and workspace-mismatch coverage for
    `deleteTextFile` and `rollbackTextFileMutation`.
  - Extend scanner coverage and the Rust kernel spike scanner to skip SQLite
    `-shm` sidecars as well as `-wal` sidecars.
  - Assert pending share revocation disconnect retries use the recovered
    recipient from the share row.
  - Redact host-specific worktree paths in shared execution notes and add
    reproducibility metadata to the Rust spike benchmark record.
  - Clarify the P0A database lane selector, mutation-ledger atomic claim,
    native-filesystem precondition shape, provisional raw-local-write handling,
    and shared-channel watch cleanup docs.
  - Make file mutation lock owner heartbeat writes atomic and keep malformed
    generation cleanup from deleting a recently updated lock directory.
  - Re-run pending mutation recovery before restore stale-file checks.
  - Check for an already committed history record before write/delete rollback
    after `history.record` failure; the latest pass tightened unreadable history
    storage to preserve the journal instead of bypassing the guard.
  - Add recovery coverage proving a pending post-commit journal is cleaned
    without rolling back the committed disk/version/history state.
  - Validate explicit `before: null` write moments against inherited fork history
    so persisted state cannot erase an ancestor preimage.
  - Let legacy rollback fallback restore fork mutations from inherited ancestor
    snapshots, with regression coverage for inherited legacy rollback.
  - Keep pending journal assertions on the shared helper instead of raw internal
    directory reads.
  - Handle restore provenance directions exhaustively in file-workspace restore
    summaries.
  - Remove duplicate pending-mutation recovery from the restore path and rely
    on the shared write/delete helpers.
  - Tighten persisted version moment validation so explicit `null` preimages
    are rejected for rename/delete and for overwrites; only `undefined` remains
    the legacy escape hatch.
  - Add delete-history redo restore coverage.
  - Use the deterministic test clock for stale file-mutation lock fixtures.
  - Replace the old review-tool execution-log command with the documented
    automated-review command form.
  - Make history lock owner heartbeats atomic through temp-file-plus-rename
    writes.
  - Return a string fallback for unknown persisted history author variants in
    the desktop renderer.
  - Treat `version-recording` journals as requiring version rollback; missing
    or already-rolled-back version moments are still considered recovered.
  - Stream raw backup creation/restoration, backup comparison, and stat hashing
    instead of loading whole files into memory.
  - Keep disk preimage backups until after the pending journal is removed, so a
    crash after disk restore can retry idempotently.
  - Add recovery-window tests for write/delete journals stuck at
    `version-recording`, plus a journal left behind after rollback already
    restored disk/version state.
  - Added redo restore coverage while retaining old `undo` records.
  - Log release-lock failures that happen alongside a primary commit failure
    instead of dropping them.
  - Reclaim stale malformed lock directories that have no valid token-scoped
    owner generation.
  - Keep lock release errors out of `finally` throw paths; the primary commit
    error still wins over cleanup errors.
  - Add explicit `disk-mutating` and `version-recording` journal phases so
    recovery can distinguish in-progress side effects from completed disk or
    version mutations.
  - During recovery, only roll back version state after a completed version
    mutation marker, and only restore disk for completed disk mutations or
    in-flight disk mutations whose live file no longer matches the preimage.
  - Use `redo` provenance for forward/post-change restores while keeping
    existing `restore` and `undo` records valid.
  - Make missing-restore tests assert one rejected promise instead of invoking
    restore twice.
  - Make fork dependency checks fail closed for local mutations that lack a
    validated rollback preimage chain.
  - Move file mutation and history index locks to token-scoped owner
    directories so stale owners cannot heartbeat into, release, or recursively
    delete a newer lock generation.
  - Preserve the primary history record/index write error when lock cleanup also
    fails.
  - Write each pretty history record durably before updating `index.json`.
  - Keep successful history writes successful when post-commit lock cleanup
    fails; cleanup failures are logged after durable record/index writes.
  - Hold the workspace file mutation lock for full read/list/stat filesystem
    operations, not only for recovery.
  - Create workspace parent directories segment-by-segment with realpath
    containment checks instead of recursive mkdir.
  - Use no-follow file handles for snapshot reads, plain reads, stat reads, and
    raw preimage backup reads.
  - Re-check snapshot byte size after `readFile` before storing history text.
  - Fsync temp files and raw backup files, then sync parent directories before
    rename/delete cleanup phases advance.
  - Sync parent directories after workspace deletes and backup cleanup removes.
  - Keep delete moments strict about persisted preimages while preserving a
    legacy rollback fallback for non-delete moments with journal-provided text.
  - Restore legacy rename rollbacks to the previous path, not the current path.
  - Require non-empty local-author labels at the desktop IPC contract boundary.
  - Export file read/list result types from the workspace-engine package root.
  - Assert delete rollback clears pending mutation journals.
  - Add restart recovery coverage for crashed delete journals.
  - Add stale-lock reclaim tests for history and file mutation locks.
  - Previous P0C review loops also fixed local-author rendering, strict path
    validation, guarded raw-byte restore, typed history-record failures,
    pending mutation journaling, version preimage validation, scan-policy
    parity, and serialized history index writes.
- Overrides:

### Subagent Reviews

- File-history explorer: complete.
  - Recommended a package-level coordinator composing filesystem IO, P0B
    version snapshots, and `.dohc/history`.
  - Warned that duplicate history is the main trap.
  - Recommended `validateUserWritePath` as the single write-path validator.
- Architecture: pending.
- Security: pending.
- QA: pending.

### Security / Privacy Notes

- The managed file wrapper validates paths through `validateUserWritePath`.
- Unknown local file edits use `{ kind: "local", label: "Local file edit" }`
  instead of pretending to know a human or agent identity.
- Restore refuses to clobber if the live file no longer matches the history
  entry's expected current side.
- Version-store rollback derives the preimage from the recorded mutation moment
  instead of trusting caller-supplied snapshot data.
- Disk preimage rollback restores through the guarded atomic writer rather than
  copying directly onto the target path.
- Pending file writes/deletes record a durable JSON journal before mutating disk
  and recover pending disk/version/history state before later workspace reads or
  writes.
- File workspace mutations use an on-disk workspace lock so separate processes
  cannot interleave recovery, disk, version, and history writes; lock owners are
  isolated in token-scoped directories so stale reclaim cannot clobber a fresh
  owner.
- Workspace file writes create parent directories one segment at a time with
  containment checks, and workspace reads/stat/snapshot/preimage backup paths
  use no-follow file handles before reading bytes.
- Pending journals store raw backup mode bits and preallocated version mutation
  ids before irreversible disk/version steps.
- Pending journals use pre-side-effect and post-side-effect phases so restart
  recovery can tell in-progress disk/version work from completed mutations.
- Pending journals validate stored preimage snapshots during recovery.
- Linux local file writes/deletes pin the verified parent directory and perform
  final child mutation through that directory fd; non-Linux construction fails
  closed for this anchored writer pending the Rust kernel lane.
- Pending file mutation journals are root-scoped recovery artifacts. Recovery
  processes each journal under its recorded workspace/history namespace, so
  active-workspace mismatches no longer block cleanup for the shared root.
- History writes use an on-disk lock per root so separate MCP, workspace, or
  process-local callers cannot clobber `.dohc/history/index.json`; lock owners
  are isolated in token-scoped directories and each record file is durable
  before the index can point at it.
- History record filenames are generated from the validated record body.
- History storage rejects `.dohc` or `.dohc/history` symlinks that resolve
  outside the workspace before creating, locking, reading, or writing history.
- If history storage is unreadable while deciding whether a pending mutation's
  history record committed, the file workspace preserves the pending journal
  instead of rolling back under uncertainty.
- Restart recovery now has explicit assertions that it repairs disk/version
  state without synthesizing extra history entries.
- Workspace reads on Linux now open files through a verified parent directory
  handle before post-open identity checks, reducing parent-symlink race exposure.
- Stale store-lock recovery no longer restores quarantined directories over the
  live lock path after validation failure.
- Desktop history exposes local edits as their own author filter bucket.
- History lock cleanup validates `index.json.lock` containment and rejects
  symlinked lock paths before stale recovery.
- Versioned-text lock heartbeat refresh is token-checked through the currently
  opened owner file before writing.
- Versioned-text quarantined lock/reclaimer restore is identity-fenced before
  renaming a quarantine back into the live lock path.
- Versioned-text quarantine mismatch restore now rechecks the moved quarantine
  identity so a raced live lock is restored without trusting a replaced
  quarantine path.
- Malformed pending journal JSON is reported as a typed recovery failure.
- Shared-channel specs now require authoritative revocation before cleanup and
  access-safe placeholders across bodies, titles, previews, exports, and
  metadata.
- Large truncated history snapshots carry SHA-256 metadata for stale-live
  validation without storing full text.
- Root-scoped pending journals now fail closed when the stored workspace does
  not match the active workspace.
- File workspace creation is explicitly Linux-only until the Rust kernel lane
  provides portable descriptor-relative mutation support.
- File workspace creation now also verifies that `/proc/self/fd` exists and is
  accessible before enabling anchored descriptor-relative mutation.
- File mutation locks with future heartbeats and live owner PIDs are treated as
  active, preventing clock rollback from making an active lock reclaimable.
- MCP file publish revalidates the workspace-contained path before final publish
  and unchanged directory creates do not synthesize history records.
- Preserved file preimage restore copies and syncs through one exclusive
  no-follow target descriptor instead of reopening the target after copy.
- File write publish now creates the target with exclusive no-follow open under
  a verified parent fd instead of linking a temp file into place; completed
  writes do not leave an extra hard link to the live file.
- Preserved live preimage restore copies back only when the target path is still
  absent, so a concurrently recreated file is not clobbered during rollback.
- Incomplete `disk-mutating` recovery rolls back from the verified preimage
  backup without requiring a completed postimage.
- History index reads validate `index.json` containment, not only the parent
  history directory.
- Scan no longer treats `.git`, `node_modules`, nested `.dohc`, or SQLite
  sidecars as standalone workspace files.
- No HTTP/cloud write path is changed in this PR.

### Performance Notes

- Budget areas touched: package-level local file write/list/stat/restore and
  scan inclusion filtering.
- Metrics:
  - workspace-engine tests: 87 tests in 12.90s locally with `TMPDIR=/tmp`.
  - workspace-engine typecheck: passed locally.
  - workspace-fs tests: 40 tests in 2.92s locally with `TMPDIR=/tmp`.
  - workspace-history tests: 33 tests in 6.87s locally with `TMPDIR=/tmp`.
  - workspace-core tests: 105 tests in 1.10s locally with `TMPDIR=/tmp`.
  - workspace-api share revocation tests: 15 tests in 0.618s locally with
    `TMPDIR=/tmp`.
  - Rust workspace-kernel spike tests: 3 tests passed locally.
  - Rust/TS bench smoke: 2 files, 1 iteration passed locally; invalid
    `--files 1.5` fails during parse with `--files must be an integer >= 1`;
    unsafe `--files 9007199254740992` fails with
    `--files must be <= 9007199254740991`.
  - workspace-api, workspace-history, workspace-fs, workspace-core,
    workspace-contracts, and desktop typechecks: passed locally.
  - workspace-postgres typecheck: passed locally after share-revocation retry
    index updates.
  - Latest `bfc0ccc` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-history `changeSetStore.test.ts` 35 tests in
    12.22s; workspace-engine `versionedFileWorkspace.test.ts` 78 tests in
    34.31s; MCP `tools.test.ts` 48 tests in 6.97s; workspace-api
    `sharesRevocation.test.ts` 18 tests in 0.573s after updating the expected
    cleanup query from `ctid` to stable `id`.
  - Latest `bfc0ccc` follow-up typechecks passed for workspace-engine,
    workspace-history, workspace-api, and MCP.
  - Latest `5805eae` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-engine `versionedFileWorkspace.test.ts` 78 tests
    in 31.52s; workspace-engine `versionedTextStore.test.ts` 66 tests in
    11.94s; workspace-history `changeSetStore.test.ts` 35 tests in 12.47s; MCP
    `tools.test.ts` 49 tests in 6.74s; desktop `workspaceUiState.test.ts` 10
    tests in 2.58s.
  - Latest `5805eae` follow-up typechecks passed for workspace-engine,
    workspace-history, MCP, and desktop.
  - Latest `5d097ed` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-engine `versionedFileWorkspace.test.ts` 78 tests
    in 32.15s; workspace-engine `versionedTextStore.test.ts` 66 tests in
    12.16s; workspace-history `changeSetStore.test.ts` 35 tests in 12.48s; MCP
    `tools.test.ts` 49 tests in 6.71s; workspace-api `sharesRevocation.test.ts`
    18 tests in 1.23s.
  - Latest `5d097ed` follow-up typechecks passed for workspace-engine,
    workspace-history, MCP, and workspace-api.
  - Latest `a8ba2a3` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-history `changeSetStore.test.ts` 37 tests in
    10.41s; workspace-engine `versionedFileWorkspace.test.ts` 81 tests in
    26.72s; desktop `workspaceUiState.test.ts` 10 tests in 1.78s.
  - Latest `a8ba2a3` follow-up typechecks passed for workspace-history,
    workspace-engine, and desktop; `git diff --check` also passed.
  - Latest `f156b22` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-history `changeSetStore.test.ts` 37 tests in
    12.20s; workspace-engine `versionedFileWorkspace.test.ts` 82 tests in
    30.93s; workspace-engine `versionedTextStore.test.ts` 66 tests in 11.68s;
    MCP `tools.test.ts` 49 tests in 5.77s; desktop `workspaceActivity.test.ts`
    and `workspaceUiState.test.ts` 13 tests in 2.55s; workspace-api
    `sharesRevocation.test.ts` 18 tests in 1.14s.
  - Latest `f156b22` follow-up typechecks passed for workspace-history,
    workspace-engine, MCP, desktop, and workspace-api; `git diff --check` also
    passed.
  - Latest `97529b0` follow-up focused reruns with Node v24.18.0 and
    `TMPDIR=/tmp`: workspace-engine `versionedFileWorkspace.test.ts` 83 tests
    in 32.85s; MCP `tools.test.ts` 49 tests in 5.84s; desktop
    `workspaceActivity.test.ts` 3 tests in 1.76s; workspace-api
    `sharesRevocation.test.ts` 18 tests in 1.09s.
  - Latest `97529b0` follow-up typechecks passed for workspace-engine, MCP,
    desktop, and workspace-api; `git diff --check` also passed.
  - Latest timed-out `e268a03` review follow-up focused reruns with Node v24.18.0
    and `TMPDIR=/tmp`: workspace-history `changeSetStore.test.ts` 37 tests in
    8.22s; MCP `tools.test.ts` 50 tests in 4.74s; workspace-api
    `sharesRevocation.test.ts` 18 tests in 0.360s after updating selector
    assertions.
  - Latest timed-out `e268a03` review follow-up typechecks passed for
    workspace-history, MCP, and workspace-api; `git diff --check` also passed.
  - Latest completed `8cf9bc5` review follow-up focused reruns with Node
    v24.18.0 and `TMPDIR=/tmp`: workspace-core `paths.test.ts` 44 tests in
    22ms; workspace-fs `watchEvents.test.ts` and `scan.test.ts` 27 tests in
    2.28s; workspace-history `changeSetStore.test.ts` 38 tests in 7.62s; MCP
    `tools.test.ts` 50 tests in 4.67s; workspace-api
    `sharesRevocation.test.ts` 18 tests in 21ms; desktop
    `workspaceActivity.test.ts` and `workspaceUiState.test.ts` 13 tests in
    1.72s.
  - Latest completed `8cf9bc5` review follow-up typechecks passed for
    workspace-core, workspace-fs, workspace-history, MCP, desktop, and
    workspace-api; `git diff --check` also passed.
  - Latest completed `a935e96` review follow-up focused reruns with Node
    v24.18.0 and `TMPDIR=/tmp`: workspace-api `sharesRevocation.test.ts` 18
    tests in 14ms; workspace-engine `versionedTextStore.test.ts` 67 tests in
    9.95s; workspace-engine `versionedFileWorkspace.test.ts` 83 tests in
    25.30s; workspace-history `changeSetStore.test.ts` 39 tests in 10.91s; MCP
    `tools.test.ts` 50 tests in 4.57s; desktop `workspaceActivity.test.ts` and
    `workspaceUiState.test.ts` 13 tests in 1.67s; workspace-core
    `paths.test.ts` 44 tests in 13ms; workspace-fs `watchEvents.test.ts` and
    `scan.test.ts` 27 tests in 2.25s.
  - Latest completed `a935e96` review follow-up Rust checks passed:
    `cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml` 3
    tests passed, and the Rust/TS bench smoke with 2 files / 1 iteration
    reported exact 2048 bytes on both implementations.
  - Latest completed `a935e96` review follow-up typechecks passed for
    workspace-api, workspace-engine, workspace-history, MCP, desktop,
    workspace-core, and workspace-fs; `git diff --check` also passed.
  - Latest 2026-06-29 P0B stack refresh checks passed with Node v24.18.0 and
    `TMPDIR=/tmp`: docs link/anchor checks in repo and from `/tmp` passed for
    7 files; workspace-engine `versionedFileWorkspace.test.ts` and
    `versionedTextStore.test.ts` passed 150 tests in 31.49s;
    workspace-history passed 47 tests in 11.89s; MCP passed 58 tests in 5.79s;
    desktop `workspaceActivity.test.ts` and `workspaceUiState.test.ts` passed
    13 tests in 2.04s; workspace-core `paths.test.ts` passed 44 tests in
    522ms; workspace-fs `watchEvents.test.ts` and `scan.test.ts` passed 27
    tests in 2.81s; workspace-api `sharesRevocation.test.ts` passed 18 tests
    in 447ms; workspace-postgres `schema.test.ts` passed 2 tests in 473ms.
  - Latest 2026-06-29 P0B stack refresh typechecks passed for
    workspace-engine, workspace-history, MCP, desktop, workspace-core,
    workspace-fs, workspace-api, and workspace-postgres; `cargo fmt --check`
    and `cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml`
    also passed.
  - Latest 2026-06-29 Rust/TypeScript bench smoke with 2 files at 1024 bytes
    each reported exact 2048 bytes on both implementations, with Rust avg
    0.09ms and TypeScript avg 7.96ms.
- Machine/CI context: local Codex machine. Earlier compatibility reruns used
  downloaded Node v24.18.0 with Corepack; the latest follow-up reruns used the
  same local Node v24.18.0 toolchain with pnpm. Filesystem-heavy engine tests used
  `TMPDIR=/tmp` to avoid the Windows mount temp path.
- Budget pass/fail: no renderer/startup/watch budget applies yet.
- Jank/blocking notes: no renderer integration or watcher loop changes ship in
  this PR.

### Migration Notes

- Adds new package dependencies from `@dohc/workspace-engine` to
  `@dohc/workspace-fs` and `@dohc/workspace-history`.
- Extends the persisted history author union with a new `local` author kind.
- Existing `user` and `agent` history records remain valid.
- No production migration is required for P0C.

### Remaining Risk

- Desktop watcher integration is intentionally not wired here. When it is wired,
  managed writes must be registered as expected events or the watcher will
  duplicate the history entry.
- Restore currently supports small text snapshots only.
- No HTTP API adapter is included yet.
- PR00 docs-only local-agent-CLI exception and upstream lane PR approvals remain
  gates before P0C can be marked complete.
- Required CodeRabbit major-gate review and stacked PR review are still pending.

### Follow-Up / Deletion Conditions

- P0D should build compare/merge/conflict behavior on top of the same small
  text/file driver.
- P0G must add local agent CLI QA against this file loop.

### Phase 0 Proof Arc

PR00 remains a docs-only orchestration PR. The checked proof items below refer
to the pushed P0A-P0G lane branches, not to implementation code merged into
PR00 itself.

PR lanes:

- P0A
- P0R
- P0B
- P0C
- P0D
- P0E
- P0F
- P0G

Schema milestones:

- Phase 0 Baseline Freeze, not a standalone lane.
- PR 01 Canonical Adoption Handoff, not a standalone lane.

Gate evidence:

- [x] Current codebase inventory and storage/interposition decisions are
      recorded.
- [x] Phase 0 branch/worktree/chat ownership is recorded for each PR lane.
- [x] Rust workspace kernel spike completed or explicitly deferred by user.
- [x] Rust vs TypeScript scan/reconcile/hash benchmark numbers are recorded by
      P0R, or explicitly deferred by user with a dated note.
- [x] Rust bridge/packaging/CI recommendation is recorded by P0R, or explicitly
      deferred by user with a dated note.
- [x] Main plus one named version works for one text/file driver.
- [ ] `Phase0SharedSubstrateBaseline` is finalized before P0B-P0G start.
- [x] File/API writes durably capture immediately and produce recoverable
      history, with canonical promotion gated by policy, review, and validation.
- [ ] Server/engine-derived actor identity is enforced for write paths; callers
      cannot assert trusted user identity.
- [ ] Every atom, folder, entity, file, version, chat, thread, message, link,
      read state, notification, activity, share, capture, agent_run, event,
      history moment, search result, projection, holding record, durability-log
      entry, and idempotency tombstone is workspace-scoped.
- [ ] Agent writes respect user locks, protected paths, atom/folder/file access,
      sharing boundaries, and skill-turn gates.
- [ ] HTML atoms remain sandboxed and sanitized.
- [ ] Canonical Y.Doc state takes precedence over derived Markdown/body caches
      where rich docs are involved.
- [ ] External editor/process edits are detected while dohc is running.
- [ ] External editor/process edits made while dohc is stopped reconcile on
      next launch.
- [x] Restore works.
- [x] Clean merge works.
- [x] Conflict preserves base/current/incoming.
- [ ] One chat can link to a file and appear beside the file.
- [x] Chat projection is read-only.
- [x] Search returns linked chat/file context without policy leaks.
- [x] `.env` is excluded/redacted/ignored until secret-backed files exist.
- [ ] Workspace-switch async race E2E passes.
- [ ] P0R and later implementation lanes record performance measurements for
      startup, reconciliation, watcher capture, history restore, search, and
      linked chat UI.
- [ ] Phase 0 implementation performance budgets pass or budget misses have
      explicit user approval and follow-up.
- [ ] No renderer-blocking whole-workspace scan ships in Phase 0.
- [x] Local agent CLI QA passes with the configured `DOHC_TEST_AGENT_CLI`.
- [x] Alternative local agent CLI compatibility is run or unavailable status is
      recorded.
- [x] Local agent file edits are captured without requiring agent-specific file
      attribution.
- [ ] Agent chat replies display as `<User Name>'s agent`.
- [ ] Required Phase 0 CodeRabbit major gates are complete or user approved
      documented non-critical documentation-only exceptions.
- [x] Architecture/security/QA subagent reviews complete.
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
- [ ] Required CodeRabbit major gates are complete or user approved documented
      non-sensitive non-blocker overrides.
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
