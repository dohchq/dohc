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
  to R02's local runner scripts.
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

### MCP transport to the daemon — OPEN
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

### Key-envelope custody over RPC — OPEN
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

