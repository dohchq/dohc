# Think Bigger dohc Workspace Engine Execution Log

Status: see Current PR Snapshot below.
Created: 2026-06-23

Plan:

- `docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md`

Source specs:

- `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-chats-design.md`

## Current PR Snapshot

This block is the canonical live status for PR00 and the provisional Phase 0
lane stack. The PR status table is lane inventory, and the pass log below is
append-only history.

- **Last updated:** 2026-06-29 PR00 review loop.
- **PR00:** draft PR on `codex/think-bigger-00-readiness-scaffold` at
  https://github.com/dohc-ai/dohc/pull/46.
- **PR00 CodeRabbit:** pending rerun after the latest follow-up fixes.
- **PR00 tests:** docs sanity plus `@dohc/web` brand guard.
- **Open PR00 items:** docs-only local-agent-CLI exception needs human approval;
  CodeRabbit rerun must complete cleanly before completion or merge-readiness.
- **P0D-P0G lane state:** current provisional stack after P0C/P0D/P0E/P0F,
  respectively; lane PRs are pending/opened, not approved, and have not run
  lane-specific CodeRabbit. P0G local validation has passed on the provisional
  integrated stack.

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
in Current PR Snapshot above. This table records static lane ownership, branch,
worktree, and planned validation shape.

| PR ID | Title | Branch | Worktree | Implementation Workstream | Planned Tests | Static Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0A | Current System Inventory And Decisions | codex/think-bigger-p0a-inventory | provisional sibling worktree | TBD lane PR workstream | docs + focused package tests | Provisional lane. |
| P0R | Rust Workspace Kernel Spike | codex/think-bigger-p0r-rust-kernel | provisional sibling worktree | TBD lane PR workstream | cargo test + perf | Provisional lane. |
| P0B | Minimal Versioned Text Store | codex/think-bigger-p0b-versioned-store | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0C | File/API Write Capture And History | codex/think-bigger-p0c-file-history | provisional sibling worktree | TBD lane PR workstream | workspace-engine/history/mcp/desktop + feasible matrix | Provisional lane. |
| P0D | Compare, Clean Merge, Conflict Preservation | codex/think-bigger-p0d-merge-conflicts | provisional sibling worktree | TBD lane PR workstream | workspace-engine + workspace-history + typecheck | Provisional lane. |
| P0E | Minimal Chat Linked To File | codex/think-bigger-p0e-linked-chat | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0F | Search And Policy Smoke | codex/think-bigger-p0f-search-policy | provisional sibling worktree | TBD lane PR workstream | workspace-engine + typecheck | Provisional lane. |
| P0G | Proof Arc QA And CodeRabbit Hardening | codex/think-bigger-p0g-proof-qa | provisional sibling worktree | TBD lane PR workstream | workspace-engine + history + typechecks + local agent smoke | Provisional lane. |
| 00 | Mega Plan And Readiness Scaffold | codex/think-bigger-00-readiness-scaffold | `<current checkout>` | main | docs sanity + brand guard | Scaffold lane. |
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

> Historical entry; see Current PR Snapshot above for live status.

Status: draft PR
Branch: codex/think-bigger-00-readiness-scaffold
Worktree: `<current checkout>`
Implementation workstream, if used: main orchestration workstream
PR Link: https://github.com/dohc-ai/dohc/pull/46
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
gh pr create --draft --base main --head codex/think-bigger-00-readiness-scaffold --title "Add dohc Think Bigger workspace engine plan"
coderabbit review --agent -t committed -c AGENTS.md
rg -n "<workspace-root>|\| PR \||Ice's agent|server/engine-derived actor|secret-backed conflicts|workspace/request token|HTML atoms|Canonical Y.Doc" docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md docs/superpowers/specs/2026-06-23-dohc-chats-design.md
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
env "PATH=/tmp/dohc-node-v24.18.0-linux-x64/bin:$PATH" node <<'NODE'
const fs = require('fs')
const path = require('path')
const files = [
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md',
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md',
  'docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-chats-design.md',
]
const slug = (s) => s.trim().toLowerCase().replace(/`([^`]*)`/g, '$1').replace(/<[^>]+>/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
const failures = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const re = /!?\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of text.matchAll(re)) {
    const raw = match[1]
    if (/^(https?:|mailto:|app:|#)/.test(raw)) continue
    const [targetRaw, anchorRaw] = raw.split('#')
    const targetPath = path.normalize(path.resolve(path.dirname(file), decodeURIComponent(targetRaw || file)))
    if (!fs.existsSync(targetPath)) {
      failures.push(`${file}: missing link target ${raw}`)
      continue
    }
    if (anchorRaw) {
      const targetText = fs.readFileSync(targetPath, 'utf8')
      const anchors = new Set([...targetText.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) => slug(h[1])))
      if (!anchors.has(anchorRaw.toLowerCase())) failures.push(`${file}: missing anchor ${raw}`)
    }
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`docs link/anchor check passed for ${files.length} files`)
NODE
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
- Docs link/anchor checker passed over the five PR00 plan/spec docs with result:
  `docs link/anchor check passed for 5 files`.

### Local Agent CLI QA

- `DOHC_TEST_AGENT_CLI`: not applicable for docs-only scaffold.
- Docs-only exception approval: pending human approval before PR00 is marked
  complete or merge-ready.
- Current implementation evidence exists in P0G, where the local agent CLI smoke
  passed with a real Codex child process in a disposable workspace using
  `DOHC_CODEX_SANDBOX=danger-full-access` as a one-off temporary QA exception.
  This unsafe sandbox mode is not baseline behavior; the default Codex safe
  sandbox remains the intended path.
- Open follow-up: restore default safe-sandbox validation when `bubblewrap` or
  Codex's bundled sandbox helper is available locally.
- Local agent result: not run for PR00 docs-only scaffold; exception pending.
- Claude result, if available: not run for PR00 docs-only scaffold; exception
  pending.
- Transcript/artifact path: not applicable.
- Secret redaction notes: not applicable.

### CodeRabbit

- Status: latest follow-up fixes pending rerun.
- Current findings: latest CodeRabbit pass reported 3 issues; local fixes are
  applied below and need a clean rerun. Current live review state is tracked in
  Current PR Snapshot.
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

Fifty-fifth pass:

- Updated the PR00 status table to reflect the current pushed P0A-P0G stack:
  P0D-P0G are now restacked on the latest P0C line, and P0G local validation
  passed on the integrated proof arc.
- Recorded the current local-agent evidence boundary: PR00 remains docs-only,
  while P0G proves the real Codex child-process file edit in a disposable
  workspace using `DOHC_CODEX_SANDBOX=danger-full-access` as a one-off temporary
  QA exception. Default safe-sandbox validation remains the intended path and is
  blocked locally by the missing sandbox helper.

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
    explicit approval requirements for user-visible Codex chats.
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

### Unresolved Findings

Mutable active blockers live only in Current PR Snapshot. This section is an
append-only derived summary for historical unresolved-finding categories; there
are no additional historical categories beyond the pass log above.

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
      search result, projection, holding record, durability-log entry, and
      idempotency tombstone is workspace-scoped.
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
