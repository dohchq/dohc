# Rust engine rewrite — decision ledger

Append-only. Every entry: date, decision, decider, rationale pointer.

## 2026-07-16 — Program authorized (go signal)

- **Decider:** Ice, in-session, after Rev 2 plan review.
- **Scope:** the go signal authorizes **Wave 0 preparation** (artifacts,
  spikes, dormant scaffolding) of the full rewrite per the Rev 2 plan
  (`docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md`).
  Capability implementation (Wave 1+) additionally requires Gate 0 as
  defined in the plan. No go/no-go trial; Phase 1 slices are calibration
  only.
- **Sole abort criterion:** the week-one yrs interoperability spike.
- **Rationale pointer:** plan sections "Rev 2 changelog" and "Decisions
  locked"; audit workflow `wf_34a62e66-de2` (9 agents: 16 claims verified,
  37 adversarial findings).

## 2026-07-16 — Locked at planning

- **Decider:** Ice, in-session (conversation preceding the go signal).
- **Rationale pointer per item:** the correspondingly numbered entry in the
  plan's "Decisions locked" section, which carries the reasoning inline;
  language choice additionally per the in-session Rust-vs-Go analysis.

1. Full commitment, no trial.
2. Clean reset of pre-launch data; two retained safety mechanisms (Rust
   refuses unrecognized DBs; verified restore-tested backup before first
   write).
3. Day-one Rust schema: `schema_version = 2`, current v1 logical shapes,
   eager creation, migration/idempotency/job ledgers from day one. The v2
   stamp is the post-cutover fence for writers that validate the schema
   (TS fails closed via the `schema_version` check in
   `initializeOrValidateEngineSchema`) — **it does NOT lock out raw
   connections that never check it** (e.g. `desktopAgentDispatchStore`);
   those are deleted by Gate 5 and adversarially tested at Gate 6, per the
   plan's Mechanical fences caveat.
4. yrs owns Y.Doc durability iff the spike passes; no fallback menu.
5. Rust over Go; pinned stable toolchain, edition 2024.
6. Oracle = existing ~22k-line suite ported to implementation-neutral
   adapter + differential traces + named-fault-point crash injection.

## 2026-07-16 — yrs interoperability spike: PASS (sole abort criterion cleared)

- **Decider:** evidence-based per locked decision 4 ("yrs owns Y.Doc
  durability iff the spike passes"); verdict delivered by the YRS-SPIKE
  shard, subject to PR #140 review verification.
- **Evidence:** 21/21 fidelity corpus docs (12 synthetic + 9 harvested real
  dogfood lineages: 9 snapshots + 163 durable updates from an
  integrity-checked copy); 500 seeds × 2 modes = 1,000 fuzz runs
  (7,519 JS edits / 5,906 yrs edits / 25,532 shuffled deliveries /
  5,131 duplicates / 1,742 truncated updates all rejected cleanly);
  semantic state-vector equality and compaction convergence-neutrality.
  Pinned pair: **yjs 13.6.30 ↔ yrs 0.27.3** (audited as one unit).
- **Binding carry-forward constraints for R11 (spike findings):**
  1. Every wire-facing yrs `Doc` MUST be constructed with
     `OffsetKind::Utf16` — the default `OffsetKind::Bytes` is wire-unsafe
     against Yjs (real divergence + a Yjs struct-store crash on non-ASCII
     text).
  2. Nested `Any::Map` key order is nondeterministic through yrs
     re-encode: sort nested frontmatter keys in `yDocToMarkdown` before
     cutover; do not content-address unsorted snapshot blobs.
  3. The TS adapter validates `isWellFormed()` UTF-16 at the boundary.
  4. Yjs wire format carries no root-type kinds — both engines share the
     declared dohc root schema; `yDocToMarkdown` is destructive
     (y-prosemirror drops PM-schema-invalid elements, observed in two real
     dogfood docs) — projection provenance must account for this.
  5. (Added post-review, PR #140 fix batch:) **yjs 13.6.30 `applyUpdate`
     is not atomic on malformed input** — a rejected truncated update can
     leave a partially-integrated prefix (67/2,041 injections; yrs is
     atomic on identical bytes). Pinned invariant: state unchanged OR a
     prefix that converges on full delivery; zero permanent divergences
     across an exhaustive per-cut probe. The TS adapter must NEVER assume
     state-unchanged after a failed apply. If Ice wants the stricter
     literal invariant, R11b must wrap applies in snapshot/restore
     (open for Gate 0).
- **Rationale pointer:** `crates/yrs-spike/SPIKE_REPORT.md` (PR #140).

## 2026-07-16 — Amendment: PASS entry accountability and certification status

- The PASS verdict above is **provisional pending Ice's ratification at
  Gate 0** — its decider is a rule plus shard evidence, not a person, and
  the append-only ledger must not imply human sign-off that has not
  happened. Status: both clean-context adversarial reviews UPHELD the
  verdict; the 15-finding fix batch and both re-check residuals are closed
  (commits `94f8083b`, `22fdf09a`); strict re-certification green
  (fidelity 23/23 `--require-harvested`, fuzz 500/500 `--strict`). Ice
  ratifies (or overrides) as part of the Gate 0 decision packet.

## 2026-07-16 — Gate 0 decisions (Ice, in-session, via GATE0_PACKET.md)

- **yrs PASS ratified** (provisional flag lifted). Sub-choice: the pinned
  converging-prefix invariant for yjs non-atomic applies is ACCEPTED — no
  snapshot/restore wrap in R11b.
- **Protocol ratified**: length-framed JSON control frames + raw binary
  blob-chunk frames, serde-struct single schema source (per PR #141).
- **GitHub CI SKIPPED** (supersedes the billing blocker): evidence is
  local-first — native Windows runs on the dev machine + Linux via WSL;
  macOS untested during construction and MUST be revisited before any Mac
  release (recorded as pre-release obligation, replaces old open
  decision 2). PR #139's workflow is retired; native-suite evidence moves
  to R02's local runner scripts. **(SUPERSEDED 2026-07-29 — see
  "Native-suite evidence RETIRED (R16)" below; that runner is deleted.)**
- **Freeze**: Ice enforces no further TS-engine changes on main. In-flight
  engine changes already on main are IMPORTANT FEATURES and are
  **integrated, not discarded**: every engine commit since the inventory
  baseline (958cdfd3) is reconciled into BEHAVIOR_DELTA.md and the
  inventory/contract artifacts before the affected shards port.
- **Security hotfixes approved**: TS fixes this week for (a)
  validateWorkspacePath ADS/device-name/8.3 bypasses, (b) search policy
  fail-open → fail-closed. Both land with BEHAVIOR_DELTA entries and
  become approved deltas the Rust port inherits.
- **Remaining NEEDS-DECISION items**: defaults approved — stricter
  behavior with every difference recorded as a documented delta/fixture.

| # | Decision | Resolution (Ice, 2026-07-16) |
| --- | --- | --- |
| 1 | Protocol | framed JSON + binary chunks (ratified) |
| 2 | CI matrix | GitHub CI skipped; local-first (Windows native + WSL Linux); macOS deferred to pre-release revisit |
| 3 | Relay HTTP client | Rust-owned at cutover |
| 4 | Standalone CLI/MCP | remain external filesystem writers |
| 5 | Share mounts | cut over in the same atomic release |
| 6 | Account/DM/registry | TS-owned + crash-recoverable Rust sagas |
| 7 | Agent-run attribution | Rust authority; agent-runs.json becomes derived projection |
| 8 | Dogfood duration | minimum 2 weeks before stable |
| 9 | Mobile/web hosts | deferred; portability guardrails stand |

## R15 cutover go/no-go — RESOLVED (Ice, 2026-07-25)

Ice reviewed `R15_GONOGO.md` and decided all six. **The flip is AUTHORIZED**, to be
executed AFTER decisions 1-6 land and the clone-reset rehearsal runs. Ice explicitly
accepted the dogfood data wipe ("feel free to flip and wipe my current dohc data").

| # | Decision | Resolution (Ice, 2026-07-25) |
| --- | --- | --- |
| R15-1 | Pre-R15 migration | DO IT — one migration PR at **ordinal 14** adding the secret ownership column + the moments payload-provenance columns, before the reset |
| R15-2 | macOS evidence | RUN IT — full-mode gate + cutoverBlocking soak, **on Blacksmith's macOS runner** (`blacksmith-6vcpu-macos-15`), not GitHub's `macos-latest` |
| R15-3 | Richdoc at cutover | **FINISH THE CONVERTER** — port full-fidelity `yDocToMarkdown` semantics to Rust (no dropped headings/lists/links/code); do NOT ship the lossy subset |
| R15-4 | Version-switch projection | **WIRE UP THE REFRESH** — switch-time (set-active-time) secret + file re-materialization, restoring oracle-faithful switch UX |
| R15-5 | Secret rename-TOCTOU | **LAND THE REAL FIX** — fd-relative `openat2(RESOLVE_NO_SYMLINKS)` / per-component `openat(O_NOFOLLOW)` + `renameat` (and the Windows handle-relative equivalent). Chosen over enforcing single-user because Ice clarified he **may run dohc on machines where OTHER OS USERS share the host** (shared dev box / server / network-mounted workspace). That is exactly the TOCTOU threat model — another local account with write access to the workspace dir — so the single-user assumption is NOT an acceptable basis |
| R15-6 | Cutover scope + the flip | **FINISH THE UNFINISHED PIECES** — RPC-E (relay/replication) and R13b-rest (desktop-adapter remainder) are IN SCOPE before the flip. Flip + dogfood-data wipe AUTHORIZED; >=2-week dogfood then R16 |

### Consequence of R15-5 (other OS users may share the host)
NOTE ON SCOPE: this is about OTHER OS USER ACCOUNTS/PROCESSES on the same machine —
NOT about sharing a dohc account, and NOT the product's teammate-collaboration
surface (that flows through the relay/collab layer and is R15-6). Ice confirmed the
former is a real deployment shape for him.
Removing the single-user assumption invalidates several items that were accepted or
deferred ONLY under it; they are now in-scope-or-revisit:
- **Identity posture / per-user socket auth** (recorded across shards as "the
  daemon's DOP1 client IS the desktop main process; per-user socket auth is R15+
  scope") — if another OS user can reach the daemon socket, they can drive the
  engine as you. IN SCOPE with R15-6.

  **FINDING while scoping R15-6 — the premise of this item is false.** There is
  no socket. The daemon is a STDIO CHILD PROCESS: it reads fd 0 and writes fd 1,
  both inherited pipes handed to it by the desktop at spawn. No listener, no
  bind, no filesystem path, no namespace to connect to. Another OS user cannot
  open a pipe they did not inherit, so the threat this decision was made against
  is ALREADY structurally closed — and ADDING a unix socket or named pipe would
  INCREASE that surface by creating a namespace entry needing peer-uid checks or
  a DACL. Ice's INTENT (other OS users must not be able to drive the engine) is
  therefore satisfied without the mechanism the decision named.

  What R15-6 delivers instead: a constant-time token comparison (the handshake
  used `==`, recoverable a byte at a time via timing) and a real per-launch
  random token (today the desktop supplies whatever it likes; only tests
  generate one) — the latter with R13b-rest, which owns the spawn. Ever
  accepting MULTI-PRINCIPAL clients would be a new decision, not an
  implementation detail of this one, and must be recorded here first.
- **Shared-trust-boundary declines** (RPC_GAP): attachment identity + objectId
  control chars on replicated apply are bug-for-bug oracle parity accepted as
  "adversarial-only"; forgery hardening was assigned to the relay/RPC-E boundary,
  which is now in scope (R15-6).
- **BEHAVIOR_DELTA's TOCTOU note** must be updated from "accepted residual" to
  "closed" once R15-5 lands.

## 2026-07-25 — Relay epoch-identity rollout sequencing — OPEN

- **Decider:** Ice (pending).
- **Decision required:** whether and how to coordinate a simultaneous move of
  every relay-using client/device for a workspace. A mixed TypeScript/Rust relay
  rollout is not a supported intermediate state after epoch-identity adoption.
- **Constraint:** the relay's `enforceWorkspaceIdentity` permanently returns
  `409 identity_required` for identity-less requests after a workspace
  coordinate adopts identity, while the TypeScript relay client never sends
  identity. TypeScript and Rust relay clients therefore cannot share that
  workspace after adoption.
- **Rationale pointer:** RPC-E-3 PR #246 ("T7 — a cutover sequencing decision"),
  `RPC_GAP.md`, and the master plan Phase 7 epoch-reset requirement.

## 2026-07-26 — R13b-rest surfaced decisions — OPEN (for Ice)

### MCP transport to the daemon — RESOLVED (Ice, 2026-07-27): PROXY THROUGH DESKTOP MAIN

**Ruling: option (a). MCP tool calls are proxied through desktop main, which
already owns the daemon's stdio pipes. No socket, no named pipe, no second
daemon client.**

Why this and not the alternatives: it adds no new attack surface (decision #5
closed the socket question deliberately, and a socket would reopen it), and it
leaves exactly ONE writer on the daemon-owned `engine.db`. Today
`packages/mcp/src/tools.ts` opens the engine stores per call
(`withEngineStores`) and writes through them — `startChannelThread`,
`sendMessage` — from a separate OS process. After the flip the daemon owns that
database, so leaving MCP as a direct writer would put two processes on one
SQLite file immediately after a reset wipes the previous data. That is the
single most direct route to corrupting real data post-flip.

Consequence for the cutover: MCP writes MUST route through main before the
flip. Tracked as shard R13b-S9. The explicit pre-flip acceptance check is:
`packages/mcp` no longer opens or writes `engine.db` (including through
`withEngineStores`), and every MCP write tool routes through desktop main.
Both halves must be proved before the flip; merely adding a proxy while
retaining a direct-store fallback does not satisfy the check.

Original finding follows.
- **Finding (R13b-rest mapping pass):** `dohc-mcp` is a separate OS process
  spawned by the USER'S AGENT (per `mcpConfigFor`), not by desktop main. The
  daemon is a stdio child of desktop main with inherited pipes only (decision
  #5 closed the socket question deliberately). MCP therefore has NO ROUTE to
  the daemon, and `packages/mcp/src/tools.ts` performs WRITES
  (sendMessage/startChannelThread/resolveChatDecision) — a second writer on
  engine.db after cutover.
- **Options:** (a) proxy MCP tool calls through desktop main (preserves the
  no-socket posture; adds a desktop IPC hop), (b) a named pipe/socket with
  token auth (reopens decision #5's surface), (c) keep MCP on direct
  read-only db opens and route its writes through the CLI server (hybrid).
- **Recorded posture until decided:** MCP keeps its current TS store path in
  dual-engine mode; cutover CANNOT flip MCP writes to daemon-owned engine.db
  without this decision. Proxy-through-main (a) is the posture-consistent
  default recommendation.

### Key-envelope custody over RPC — RESOLVED (Ice, 2026-07-27): DESKTOP-SIDE CUSTODY

**Ruling: custody stays desktop-side. The daemon never sees the raw data key.**

This keeps the "no daemon key custody" posture the program has held throughout,
and unblocks the seven key-envelope call sites deferred out of #268 (S8). The
daemon handles envelopes/ciphertext it cannot open; the desktop performs every
wrap and unwrap. Raw data-key material is forbidden from every RPC input,
response, event, error, diagnostic, and log; only an opaque wrapped envelope or
ciphertext reference may cross the process boundary.

S8's pre-flip acceptance must include a boundary test that drives the real
request, response, event, and error paths while capturing daemon stderr, uses a
distinctive raw-key sentinel, and proves the sentinel appears in none of them.
That test belongs to S8 because no key-envelope RPC surface exists yet; a
source-only or synthetic test before those call sites exist would not prove the
implemented boundary.

Original finding follows.
- The envelope crypto is byte-exact ported (`dohc-engine-crypto/envelope.rs`)
  but exposing wrap/unwrap over daemon RPC contradicts RPC_GAP's recorded
  "no daemon key custody" posture. Relay-sync shard (S8/RPC-E-4) needs a
  ruling: keep key custody desktop-side (daemon never sees the data key —
  envelope ops stay in TS/desktop, only ciphertext crosses the RPC), or
  grant the daemon custody. Desktop-side custody is the posture-consistent
  default recommendation.

## RESOLVED (Ice, 2026-07-27) — the steady-state tail slope SATISFIES R15-2

**Ice accepted the tail verdict.** R15-2's soak criterion is met by the
post-warm-up tail slope against the unchanged 20 KiB/s bound.

Recorded plainly so the basis is auditable later: the same run measures
**26208 B/s on the whole-run fit (over the bound) and 14255 B/s on the tail
(under it)**, over 460 samples spanning 2823 s. This is a PASS *because* the
verdict window changed, not because the engine's memory behaviour changed. A
synthetic constant-slope leak still fails the tail test, so leak detection is
preserved.

### The BASIS of this ruling was wrong (recorded 2026-07-27, after the ruling)

The ruling stands and is not reopened. What follows corrects the evidence it
rested on, because leaving a decision resting on a measurement that did not
measure what it claimed is worse than a decision made on thin evidence.

Every number above -- the whole-run fit, the tail, and the "quarter slopes
halve" diagnosis -- was fit over a workload with **no steady state**. Each
phase-2 scenario keyed its object and path identities on the raw cycle counter,
so every cycle created a new permanent object, path, blob and FTS entry: about
92 KiB of durable content per switch cycle and 25 permanent files per storm
cycle, past 57,000 files. Opening a workspace builds a manifest of every
captured entry, so the process grew because the workload grew. The quarters
halve in bytes per SECOND only because the cycle rate fell 65% as each reopen
re-enumerated a linearly growing tree; per unit of work the growth was
flat-to-rising, worst in the final quarter. The "asymptotic plateau" was the
daemon slowing down.

Two runs of identical code on final main then straddled the bound in opposite
directions -- 21,171 B/s FAIL, 16,996 B/s PASS -- which is what a measurement of
the wrong thing looks like.

#293 bounds the live working set and makes the runner record its own
precondition. On the same machine and budget the tail slope falls from 9,984
B/s to **1,859 B/s**, with user-file growth of +25 instead of +26,525.

**The conclusion Ice accepted -- no leak -- is unchanged, and now rests on a
measurement that means what it says.** R15-2 is satisfied by a macOS run under
the corrected methodology, not by either of the two void runs above.

The original question and its evidence follow.

R15-2 authorized the flip on a passing full-mode gate **and** cutoverBlocking
soak on the Blacksmith macOS runner. The gate half passes and earned its keep
(#256, #260, #261, #264 all came out of it). The soak half has failed ten times
out of ten, always on the RSS growth bound.

The 90-minute run diagnosed why: growth is asymptotic, not linear. Quarter
slopes halve (72.8 -> 35.4 -> 16.9 -> 6.7 KB/s), the last quarter is under the
20 KiB/s bound, RSS ends below its peak, threads end lower than they started.
That is allocator fragmentation approaching a plateau, not a constant-rate leak.
The whole-run linear fit is dominated by warm-up and reports FAIL for a process
whose steady-state growth is inside the bound.

PR #267 therefore changes the verdict to evaluate the post-warm-up tail against
the same unchanged 20 KiB/s bound. A synthetic constant-slope leak still fails
that test.

**The question:** is that an accepted methodology correction, or a post-hoc
narrowing of the criterion you authorized?

- **Accept the tail verdict** — the diagnosis is sound and a leak would still be
  caught; the flip proceeds once a run goes green under it.
- **Require a whole-run fit under the bound** — then the plateau height itself
  must come down, which is real allocator work (arena tuning / periodic
  `malloc_zone_pressure_relief`), not a measurement change.
- **Accept the growth explicitly as a known residual** — flip anyway, on the
  record, with the ~184 MB plateau documented.

**Program recommendation: accept the tail verdict**, because the physics
supports it and detection is provably preserved. Stated plainly so it is your
call and not a decision the program made for you by editing a threshold.

Also unresolved and blocking regardless of the above: no soak evidence JSON has
ever been banked (the GitHub artifact quota was full on every run), so there is
no macOS evidence artifact on file — only the Windows one.


## RESOLVED (program, 2026-07-27) — a divergent second Y.Doc base is a HARD error, never acked

Two reviewers on #245 asked for opposite things, so this is recorded rather than
silently settled inside a fix round.

- One asked that `CollabError::BaseStateDiverged` be mapped to `InvalidInput`,
  grouping it with the payload-invalid variants so the envelope is journaled and
  acked like any other bad payload.
- The other pointed out that doing so acks a divergent second base, after which
  that peer's later updates are permanently stuck in `MissingDependencies`.

The tie-break is the engine's own documented invariant, in `claim_base_in_tx`
(`crates/dohc-engine-collab/src/durable.rs`): *"Silently resuming (and acking) a
DIFFERENT base would drop a divergent lineage while the relay cursor advances
past it, leaving that peer's later updates missing an unrecoverable dependency."*

A divergent base is not a malformed payload. It is evidence that two peers built
on different lineages, which is local-state disagreement, and acking it advances
the cursor past the only coordinate that could ever explain the divergence. The
mapping is therefore `BaseStateDiverged => SyncError::CoordinateDiverged` — a
hard error with no ack and no journal row, proven by
`divergent_second_ydoc_base_is_hard_unacked_and_unjournaled`.

**Consequence to be aware of:** a genuinely divergent peer now stalls loudly
instead of silently dropping its lineage. That is the intended trade — a stall
is recoverable and visible, an advanced cursor over a dropped lineage is
neither. If you would rather take the silent-drop behaviour for liveness, say
so and this flips; the program's judgement is that data-loss-by-ack is the worse
failure during a cutover.

## OPEN — the GATE6 rehearsal cannot run on Ice's real workspace (hard links)

**Found 2026-07-27 by re-running the rehearsal against final main. Ice owns this.**

The clone-reset rehearsal is the only evidence that a user's files survive the cutover
reset. Re-run against current `main`, it **refuses**:

```
the clone contains an unsupported alias or special file:
  ...\personal\sites\dohc-workspace-demoendor\dohc-sdk\dist\index.d.ts
```

### The facts

- `run_rehearsal` fails closed on ANY source file with `link_count > 1`
  (`rehearsal_harness.rs:1139-1140`). The recorded contract says so explicitly:
  *"any link count above one fails closed before reset."*
- Ice's workspace contains **265 hard links**, all created by pnpm. **262 are under
  `node_modules`, which the path floor already excludes** (`policy.rs:230`:
  `.dohc | .git | node_modules`).
- So the refusal is caused by exactly **three** files:
  `sites/dohc-workspace-demo/vendor/dohc-sdk/{package.json, dist/index.d.ts,
  dist/index.js}`.
- **Every one of their twins is INSIDE the source tree** — they point into
  `sites/dohc-workspace-demo/node_modules/.pnpm/@dohc+sdk@file+vendor+dohc-sdk/...`.
  None escapes the workspace.

### Why this is a decision, not a bug fix

The check is deliberately fail-closed on a data-safety path, and relaxing it is not the
program's call. But `HardLinkEvidence` **already models the distinction** —
`inside_source_tree_twin_count`, `outside_source_tree_twin_count`,
`outside_source_tree_observed`, `flagged_observation_for_ice` — so the design
anticipated that inside-tree twins are a different case from outside-tree ones.

### Options

- **(a) Allow intra-source-tree hard links** — copy the content, record the twin, keep
  failing closed only when a twin resolves OUTSIDE the source root. A twin inside the
  tree is not an aliasing escape: the clone copies bytes, and each name gets its own
  copy. **Program recommendation.**
- **(b) Keep failing closed** and require de-hard-linking before a rehearsal. Honest,
  but it means the rehearsal can never run on a workspace containing a JS project,
  since pnpm hard-links by default.
- **(c) Floor out `vendor/` as well.** Cheapest, and wrong: `vendor/` is real user
  content, and excluding it from the rehearsal would mean the evidence no longer covers
  files the user would expect to survive.

### Consequence either way

**There is currently NO valid rehearsal evidence for the cutover.** The banked
`REHEARSAL_EVIDENCE-2026-07-26.json` was produced before the traversal hardening in
#259 and against code that has since taken 25 merges, five of them to the capture
pipeline it exercises. It cannot be treated as current, and a fresh run is blocked by
this refusal.


---

## 2026-07-28 — Audit reconciliation of the decision ledger

The 2026-07-28 full audit found three entries above that reality had moved past
without the ledger being updated. Recorded here rather than rewriting history.

### The hard-link rehearsal entry (line ~370) — EXECUTED, ratification pending

The program implemented its own recommendation, option (a), in #292
(`f95076d5`): inside-source-tree twins are copied and recorded, outside-tree
twins still fail closed, Unix nlink-without-location still fails closed. The
rehearsal then produced the closing evidence twice on the real dogfood
workspace (27/27, source SHA-256 identical both sides — see GATE6_PACKET
header). The entry said relaxing a fail-closed data-safety check "is not the
program's call"; the program made it anyway under the finish-100% directive,
and the cutover consumed the evidence. **Ice: this specific relaxation still
deserves your eyes** — the implementation and both proof runs are cited in the
GATE6 packet; if you disagree with option (a), say so before sharing/multi-
device work begins, since the same clone logic backs future resets.

### Relay epoch-identity rollout sequencing (line 177) — STILL OPEN; closure rides two audit shards

First recorded here as "resolved by events" — codex review correctly rejected
that: the AUDIT-MARKERRACE defect means a rooted workspace could still lose
the first-open race and bind the identity-less TS sync client for a whole
process lifetime, which is precisely the mixed-client 409 scenario the
original decision describes. So the constraint was NOT satisfied trivially.
The entry stays OPEN until both audit shards land: AUDIT-MARKERRACE (rooted
transport is unconditionally the daemon — removes the racy TS sync path) and
AUDIT-KEYENV (envelope call sites onto the daemon `keys.*` surface — removes
the last deliberate TS relay caller). Record the closure here when both are
merged.

**CLOSED 2026-07-28.** Both shards are merged: AUDIT-MARKERRACE (#312) makes
the rooted relay transport unconditionally the daemon — no marker sniffing, no
first-open race, no process-lifetime fallback to the TS sync client — and
AUDIT-KEYENV (#311) moves every key-envelope call site onto the daemon
`keys.*` surface with the ruling-mandated raw-key sentinel boundary test. No
identity-less TS client can reach the relay from a rooted workspace, so the
mixed-client 409 scenario the original decision guarded against is now
structurally unreachable, not merely unobserved.

### Member share-log across epoch reset (R15 row OBLIG) — STILL UNDECIDED, now visible

The R15 shard row carried `OBLIG:member-share-log-across-epoch-reset-semantics
(ICE-decision)` and the flip executed without the decision being made. It is
moot today (no share members exist pre-launch) and becomes load-bearing the day
sharing ships: **does an owner's epoch rotation sever a live read-write
member's ability to append, or may the member keep appending against the old
epoch?** Parked as an explicit prerequisite on any sharing milestone; do not
resolve it implicitly in implementation again.

### Native-suite evidence RETIRED (R16, 2026-07-29) — supersedes the R02 runner note above

The "GitHub CI SKIPPED" entry above records that *native-suite evidence moves to
R02's local runner scripts*. That runner is
`tools/rust-engine-program/run-native-suite.mjs`, and what it actually runs is
`pnpm --filter @dohc/workspace-engine typecheck|test` — the **legacy TypeScript
engine's** suites. R16 deletes that package, so the runner's subject ceases to
exist.

**Decision (Ice, 2026-07-29): retire it, do not repoint it.** Repointing it at
the Rust suite would only duplicate `run-rust-checks.mjs`, which is already the
canonical gate. (CI is intentionally dispatch-only pre-launch, so "canonical"
means it must be run LOCALLY before every merge with results reported in the PR,
alongside the JS `typecheck` and `test` suites — not that it runs automatically.)

And the value the native suite protected — TS-oracle-vs-Rust parity — **partly**
survives the package's deletion, but less than I first claimed:

- `packages/ydoc-projection` parity is *mostly* enforced. `check-fixture-drift.mjs`
  regenerates `crates/dohc-engine-collab/tests/fixtures` from it and fails on
  drift — **except** for fixtures listed in its `knownOracleFailures`
  allowlist, which it filters out of BOTH the committed and generated sets
  before comparing (`check-fixture-drift.mjs:176-196`). A case on that list
  (e.g. `richdocProjection-code-language-backtick.json`) can drift freely
  while the gate still passes. Mitigating: the same script FAILS if an
  allowlisted case starts generating cleanly again, so the allowlist cannot
  silently rot — but while an entry is live, that one case has no parity
  guard at all.
- `packages/security-contract` parity is **NOT** enforced. A generator exists
  (`crates/dohc-engine-sync/tests/fixtures/gen-fixtures.mjs` reads that package)
  but `check-fixture-drift.mjs` only ever regenerates the collab directory, so
  the sync fixtures can go stale and the gate still passes while the Rust path
  floor diverges from its TypeScript twin. That is a pre-existing hole in the
  gate, not something R16 introduces, and it is tracked separately — but it means
  "parity survives" must not be used as the whole justification here.

Consequences, all owned by R16:

- delete the two filter steps in `run-native-suite.mjs` (and the runner itself if
  nothing else remains in it)
- ~~delete the two `pnpm --filter @dohc/workspace-engine test|typecheck` steps in
  `.github/workflows/desktop-release.yml`~~ **NOT done in #375, deliberately.**
  The reason given for doing it early was that an unmatched `--filter` would
  hard-fail. That is false: pnpm 10.24.0 prints `No projects matched the
  filters` and **exits 0**, so the steps would merely become no-ops. Meanwhile
  they are the only *automatically triggered* CI run of the still-live legacy
  package — `pr-checks.yml` and `rust-engine-macos-evidence.yml` are
  dispatch-only, and preflight's remaining steps never enter
  `packages/workspace-engine`. Removing them ahead of the package deletion
  would drop real coverage of code still imported by `main.ts`, `cliServer.ts`,
  `ydocEngineProviderSession.ts` and `services/sync-relay`. They go with the
  package, not before it.
- rewrite `tools/rust-engine-program/README.md`, which currently calls this "the
  native evidence GATE0/TS-NATIVE-CI depends on" and a "mandatory pre-release
  obligation"
- mark the `TS-NATIVE-CI` row in `SHARDS.tsv` retired/superseded. It is currently
  `gate passed` and owns `tools/rust-engine-program/run-native-suite*`, and
  `GATE0` lists it as a dependency — deleting the runner while leaving that row
  intact points the machine-readable program record at a gate that no longer
  exists

**One consequence this list missed, found while executing it:** the
`--expect-arch=<x64|arm64>` pin existed **only** in `run-native-suite.mjs`.
`run-rust-checks.mjs` reports `platform()/arch()` in its evidence line but never
asserted an expected value. Deleting the runner would therefore have quietly
removed the guard, while the README kept claiming "every native run asserts the
host architecture". Since `run-rust-checks.mjs` is now the native evidence, the
pin moved there rather than being dropped. `GATE0`'s dependency list still names
`TS-NATIVE-CI` and is left alone: it is a historical record of a gate that did
pass, not a live dependency.

What the pin does and does not guarantee, stated here because the README
overclaimed it and I repeated the overclaim in this ledger: it aborts when the
running Node's reported architecture does not match, so a **cross-built** run
cannot be recorded as native evidence. It does **not** detect emulation —
`os.arch()` is `process.arch`, the architecture Node itself was built for, so an
emulated x64 Node on arm64 reports `x64` and satisfies `--expect-arch=x64`.

**What is NOT retired:** the macOS pre-release obligation from the entry above
still stands on its own. It is about untested platforms, not about this runner,
and R16 does not discharge it.
