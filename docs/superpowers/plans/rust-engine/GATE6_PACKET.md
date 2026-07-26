# GATE 6 — release-candidate evidence packet

**Status: PACKET ASSEMBLED 2026-07-24 — GATE NOT YET CLOSED.** GATE6 is the
release-CANDIDATE gate. Ice explicitly authorized the cutover on 2026-07-25
(`DECISIONS.md`, R15 go/no-go), so one criterion remains: an end-to-end
**clone-reset rehearsal on REAL dogfood workspace byte-clones**. The machinery is
built + gate-verified by its rehearsal-on-clones test suite, but it has NOT been
run against Ice's real data. Do NOT treat `SHARDS.tsv`/this packet as gate-closed
until that rehearsal is recorded.

**WHAT GATE6 ASSERTS:** NO GATE6-BLOCKING IMPLEMENTATION SHARD REMAINS, and the
engine is EVIDENCED (gate/soak/differential green, every claim below carrying its
evidence and limitations). Every dependency (R14 robustness, R10b relay-epoch,
R15-REHEARSE, and all RPC shards A/B/C/D/B2/D2) is `gate passed` / `done`.
This is NOT "code-complete": cutover implementation remains in flight
(R13b-rest, RPC-E, switch-time re-materialization wiring, richdoc full-fidelity
projection) — see §0.

**WHAT GATE6 DOES NOT ASSERT: cutover-READINESS.** The items in §6.CUTOVER-GATING
below are real, not "non-blocking limitations." Ice resolved their policy choices
at the R15 go/no-go, but their implementations are not closed until the
corresponding review shards land.

This packet is the evidence + the current execution state. Section 7 records the
six resolved R15 decisions and the new open relay sequencing decision.

---

## 0. Completeness — no original GATE6-blocking shard remains (cutover work listed)

| shard | PR | status |
|---|---|---|
| Wave 0-5 core (R00-R14, CAL, R10b, BINCONFLICT, YRS-ABORT-SAFETY, R15-REHEARSE) | through #216 | gate passed |
| RPC-A (read surface) | #217 | done |
| RPC-B (chats, 23 methods) | #218 | done |
| RPC-C (live Y.Doc sessions) | #220 | done |
| RPC-D (mutating text/version/secret surface) | #223 | done |
| RPC-B2 (production chat follow-ups, 40 behaviors) | #225 | done |
| RPC-D2 (blob egress + secret-aware disk executor + slash norm) | #227 | done |
| Integrator passes | #219/#221/#224/#226/#228 | merged |
| R15-1a (secret capture ownership; migration 14) | #233 | gate passed / merged |
| R15-1b (moment payload provenance; migration 15) | #236 | in review |
| R15-2 / R15-3 / R15-4 / R15-5 | #235/#238/#239/#237 | in review |
| Y.Doc serializer delimiter exception / daemon auth hardening | #240/#241 | in review |
| RPC-E-1 / RPC-E-2 / RPC-E-3 | #242/#243/#246 | in review (stacked) |
| RPC-E-4 (daemon RPC surface) | no PR yet | in progress |
| Chat replication validation / refusal disposition | #244/#245 | in review; not merged |

No **GATE6-blocking** implementation shard remained in the packet's original
scope. Ice subsequently brought the cutover work into scope; do NOT read this
table as "code-complete, skip the cutover wiring":
- **R13b-rest** — authorized for the remaining desktop-adapter surfaces
  (main.ts / cli / mcp / shared-view + capture wiring); not yet landed.
- **RPC-E** (replication/relay cutover scope) — parts 1-3 are in review
  (#242/#243/#246), part 4 is in progress, and #244/#245 are unmerged review
  adjuncts.
- **Switch-time secret+file re-materialization** — implementation is in review
  in #239, with two upper-layer R13b deferrals recorded in §6.
- **Richdoc full-fidelity projection** — implementation is in review in #238;
  the deliberate live-TS serializer fix #240 is separately in review.
R16 (legacy deletion) is POST-cutover by design.

## 1. Soak (cutoverBlocking tier) — PASS
- Banked artifact: `tools/rust-engine-program/soak-evidence/2026-07-21-cutoverBlocking.json`,
  self-describing (recorded tolerances handleSlack 48 / threadSlack 8 /
  maxRssSlope 20 KiB/s / trend >=24 samples over >=900s; tri-state rssDisposition;
  cyclesRequested vs cyclesCompleted; cleanShutdown).
- Verdict: **PASS** — rssDisposition PASS, cyclesCompleted 5564, cleanShutdown true.
- **LIMITATION (flag, not a gate-fail):** memory was MONITORED through the dogfood
  window; this is not an unconditional leak-freedom proof. Real dogfood usage is
  orders of magnitude quieter than the soak's cycle rate. v1/v2 artifacts withdrawn
  (vacuous slope / pre-self-describing-format); v3 is the banked evidence.
- **PLATFORM CALIBRATION LIMIT:** `handleSlack=48` and `threadSlack=8` were
  calibrated on Windows only. The WSL-Linux soak evidence reports against those
  Windows-derived bounds; a Linux or macOS run landing inside them does NOT make
  its resource-leak verdict bankable. Bankable per-platform handle/thread
  conclusions require bounds calibrated on that platform. The existing
  WSL-Linux result remains scenario/portability evidence under this caveat.

## 2. Differential (TS-vs-Rust capture parity) — PASS
- 10/10 scenarios green on BOTH engines; goldens committed
  (capture-fixtures.json / capture-goldens.json); tamper-check proves the compare
  is real (#215). TS emitter: `captureOracleGoldens.test.ts`; Rust replay:
  `tests/capture_differential.rs`.

## 3. Gate discipline — PASS
- Full-workspace gate (fmt / clippy -D warnings / build / test --workspace /
  cargo-deny; cargo-audit SKIP where not installed) on EVERY pushed head across the
  program; PASS verdict line pasted per shard in EXECUTION_LOG.
- **Canonical GATE6 gate on main (19fc994b):**
  `2026-07-24T14:02:58Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS
  clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS
  cargo-deny=PASS cargo-audit=SKIP` (clean-worktree full rebuild from origin/main).
- R15-REHEARSE machinery re-verified continuously: its lib tests run in every gate's
  `cargo test --workspace`; the canonical main gate above is the freshest citation.

## 4. Migration ledger — ordinals 0-15 consumed/reserved; **NEXT ORDINAL = 16**
| ordinal | id |
|---|---|
| 0 | baseline |
| 1 | v1-secrets |
| 2 | v1-ydoc |
| 3 | v1-chats |
| 4 | v1-search |
| 5 | v1-moment-before-link |
| 6 | v1-sync |
| 7 | v1-conflicts |
| 8 | v1-shadow-clone |
| 9 | v1-binary-conflict-sides |
| 10 | v1-binary-head |
| 11 | v1-path-aliases-object-index |
| 12 | v1-ydoc-deferred-updates |
| 13 | v1-engine-request-kind (RPC-D; kind-scoped ledger purge, every writer stamped) |
| 14 | v1-secret-capture-ownership (R15-1a; #233 merged) |
| 15 | v1-moment-payload-provenance (R15-1b; #236 in review, ordinal reserved/consumed) |

RPC-B2 and RPC-D2 added NO new migrations (domain/logic only).

Ordinal 14 is consumed by #233, ordinal 15 by #236, and ordinal 16 by
RPC-E-1 / #242 (replication_pending_resolves). **The next schema-touching
shard MUST use ordinal 17.** Schema-touching shards run ONE AT A
TIME through the append-only migration ledger: rebase on the latest migration,
append exactly one ordinal, update both ledger-length assertions, and only then
open the next schema shard. Two shards nearly collided by treating the same next
ordinal as available.

REPRODUCE THIS CLAIM (do it before authoring the migration; do not trust this table
alone — it is a snapshot):
```
rg -n 'MIGRATION_ID: &str|BASELINE_MIGRATIONS' crates/dohc-engine-storage/src/migration.rs
cargo test -p dohc-engine-storage migration   # the ledger's own ordinal/monotonicity tests
```
Run these on top of the latest schema shard (#236 while it is open, then `main`
after it merges). `BASELINE_MIGRATIONS` is the frozen ordered list; its length is
the next ordinal.

## 5. Review rigor
- ~50 merged PRs across the program; the RPC shards alone drew a very high review
  volume (CodeRabbit + codex bots on every PR + local claude/opus adversarial
  passes). Highest-scrutiny shards: R01-ORACLE, R13, R07/R08, and — in the RPC
  wave — **RPC-D (16 codex + 7 CR + 4 claude rounds)** and **RPC-D2 (8 codex build/
  fix rounds + 4 adversarial pre-review passes + orchestrator mutation-verification;
  the most heavily-reviewed shard of the program).**
- Every supervision-grade guard across the program carries a named MUTATION test;
  the orchestrator mutation-verified the critical ones per shard by restoring each
  bug and watching the named test fail.
- Per-PR review-event table: `scratchpad/gate6-review-stats.tsv` (through #214;
  the RPC wave since is documented per-shard in EXECUTION_LOG).

## 6. RPC surface — cross-engine deltas & accepted residuals (all recorded in RPC_GAP.md)
These are the KNOWN, DELIBERATE divergences and residuals. None blocks the gate;
each is either bug-for-bug oracle parity, a stricter-than-oracle fail-closed choice,
or an accepted residual with a tracked closure path. Adversarial-only items are moot
post-R15 (the reset wipes pre-existing rows).
- **Structural-timestamp safe-integer apply bounds** (B2): imported chat cell/
  structural timestamps bounded to the DOP1 wire range on apply (stricter than the
  oracle's isFinite-only apply; matches wire representability).
- **Linked-thread timestamp REJECT-ON-APPLY** (B2): a half-linked chat.thread.create
  is refused, deliberately stricter than the oracle's accept-then-brick.
- **Mention-handle read validation** (B2): Rust accepts handles the scanner indexes
  that the oracle's narrower validator refuses (oracle-bug-fix delta).
- **Attachment identity + objectId control chars** (B2): shared trust boundary — both
  engines trust a peer attachmentId / accept control-char objectId on replicated
  apply; adversarial-only; forgery hardening = relay/RPC-E.
- **Bookmark-requeue timestamp** (B2): trigger createdAtMs used verbatim (safe
  negatives), matching the oracle; no read-corrupt gap.
- **Secret path SLASH-SPELLING — RESOLVED by RPC-D2 SF3**: secret keys now normalize
  to the oracle canonical form (was a Rust-verbatim divergence + clobber hazard).
- **Secret open-replay PER-JOB failure tolerance** (D2): disk anomalies match the
  oracle's per-file skip; decrypt/key failures are tolerated (skip, leave pending)
  — deliberately broader than the oracle (open-replay is crash-recovery, not a user
  action), while KEEPING fail-closed (no plaintext from unauthenticated bytes).
- **Secret rename-TOCTOU — ACCEPTED RESIDUAL, ENFORCEMENT CUTOVER-GATING** (D2,
  BEHAVIOR_DELTA.md): path-based ancestor checks are not fd-relative; a potential
  secret-disclosure/overwrite risk accepted ONLY under the single-user/local-first/
  owner-only/no-sharing assumption. That assumption must be ENFORCED, not just
  documented: sharing/multi-user secret access must stay OFF while the residual is
  open. RESOLUTION REQUIRED at R15: either land the dirfd/openat2 + renameat closure
  before the cutover, OR confirm + enforce (in code/config, not prose) that no
  shared/ACL-partitioned secret path is reachable.
  TRANSPORT CORRECTION (this PR): the "per-user socket auth" clause that used to
  ride along with this item is WITHDRAWN, not deferred — there is no socket. The
  daemon reads inherited stdio pipes, which another OS user cannot open, so a
  socket ACL was never the control protecting this boundary (RPC_GAP.md). The
  TOCTOU half of this item is UNCHANGED and STILL GATING here; R15-5 (#237) owns
  its closure and owns flipping this entry when that lands. Closure is REQUIRED before any
  shared-secret model ships regardless.
- **Secret re-materialization on mid-session version SWITCH — CUTOVER-GATING gap**
  (D2, RPC_GAP): the daemon lacks the oracle's switch-time secret rebuild
  (SetActiveVersion is DB-only; only open-replay materializes). Open-time projection
  is correct, but a mid-session switch leaves the on-disk secrets STALE — i.e.
  potentially the WRONG version's `.env` on disk — until the next open. This is a
  real correctness defect for a faithful switch UX, NOT a non-blocking limitation.
  RESOLUTION REQUIRED at R15 (composition-layer scope, not the executor): either
  wire a switch-time (set-active-time) secret+file re-materialization pass, or
  explicitly accept + surface the stale-until-reopen behavior. Non-secret files
  share the same switch-materialization dependency on the desktop/daemon layer, so
  this is a general version-switch-projection obligation, tracked cutover-gating.
- **Identity posture** (recorded across shards): the daemon's DOP1 client IS the
  desktop main process; per-user socket auth is R15+ scope. CORRECTED at
  R15-6: the transport is STDIO (inherited pipes), not a socket — see the
  transport correction in RPC_GAP.md. Another OS user cannot reach an
  inherited pipe, so the honest hardening is a constant-time token compare
  (landed) plus a real per-launch token, not a socket ACL.

### 6.CUTOVER-GATING — must be resolved at the R15 go/no-go (NOT closed by GATE6)
These are correctness/security items, not accepted flags. GATE6 surfaces them; the
R15 go/no-go decides each:
1. **Version-switch secret+file re-materialization** — stale/wrong disk secrets
   after a mid-session switch until reopen (wire it, or explicitly accept+surface).
2. **Richdoc→markdown fidelity** — the paragraphs+bold/italic subset DROPS
   unsupported richdoc content (data loss on projection); land full-fidelity
   projection or disable richdoc editing at cutover.
3. **Secret rename-TOCTOU assumption enforcement** — STILL GATING: enforce
   owner-only/no-sharing while the residual is open, OR land the dirfd/openat2
   closure. R15-5 (#237) owns that closure and owns flipping this entry once it
   merges; nothing in THIS PR closes it. The former "per-user socket auth OFF"
   half of this item is withdrawn — the transport is stdio, not a socket
   (RPC_GAP.md transport correction), so it was never the control here.
4. **Pre-R15 migration** (secret-ownership column + moments payload-provenance) —
   cheap before the reset, expensive after.
Accepted flags (NOT gating): soak monitored-not-proven; the 3 marginal RPC-D2 P2
declines; BINHEAD (discharged). See §8.

## 7. R15 decisions — six resolved; relay epoch sequencing remains OPEN
Ice resolved items 1-6 on 2026-07-25 (`DECISIONS.md`). Their implementation is
tracked in the R15 shard rows and remains mostly in review. Item 7 is a new
cutover sequencing decision exposed by RPC-E-3 and remains for Ice.

1. **Pre-R15 migration PR (secret ownership column + moments payload-provenance).**
   Ice chose DO IT. It was split for review: secret ownership ordinal 14 landed
   in #233; moment payload provenance ordinal 15 is in review in #236.
2. **macOS evidence path** — Ice chose Blacksmith
   (`blacksmith-6vcpu-macos-15`). The tooling change is #235 in review; the
   final full evidence run has not yet been banked. The two tools are the
   dispatchable CI workflow `.github/workflows/rust-engine-macos-evidence.yml`
   (quick|full input) and the local `tools/rust-engine-program/
   macos-evidence.sh` (run on a Mac). Each reproduces the full-workspace gate +
   the cutoverBlocking soak and emits the verdict logs + soak-evidence JSON.
   Both DEFAULT TO `full` (the bankable 30-60min soak); `quick` is explicitly
   NON-GATING (the runner exits 0 with PASS-SCENARIOS-ONLY(trend-not-evaluated),
   which CANNOT satisfy this packet's soak evidence). Both install cargo-deny and
   FAIL on a `cargo-deny=SKIP` gate line, and both build the daemon + runner
   release binaries (the soak resolves the daemon as a sibling). The local script
   refuses non-Darwin hosts so a Linux/WSL run cannot masquerade as macOS proof.
   EXECUTION requires a Mac (a macOS CI runner or Ice's machine) — the Windows dev
   box cannot produce it. Dispatch the CI workflow in `full` mode after the
   final pre-cutover code lands. (This is a green-path confidence
   check, not expected to surface engine issues; the code is platform-portable
   Rust and the unix materialize/symlink paths already have `#[cfg(unix)]` tests.)
3. **RPC-E scope for cutover** — IN SCOPE. Parts 1-3 are in review, part 4 is
   in progress, and #244/#245 remain unmerged adjuncts.
4. **Richdoc at cutover** — Ice chose full-fidelity `yDocToMarkdown`; #238 and
   #240 are in review.
5. **Secret rename-TOCTOU closure timing** — Ice chose the real pre-cutover fix;
   #237 is in review.
6. **The R15 go/no-go itself** — the flip/data wipe is authorized after the
   chosen work lands and the real dogfood byte-clone rehearsal passes; the
   >=2-week dogfood requirement remains before R16.
7. **Relay epoch-identity adoption sequencing — OPEN FOR ICE.** TypeScript and
   Rust relay clients CANNOT share a workspace after identity adoption. The
   relay's `enforceWorkspaceIdentity` permanently returns
   `409 identity_required` for identity-less requests after a coordinate adopts
   identity, and the TypeScript relay client never sends identity. Therefore
   every relay-using client/device for a workspace must move together in the
   epoch-identity cutover; a mixed TS/Rust rollout is not a valid intermediate
   state. This is a sequencing choice for Ice, not an implementation default.

## 8. Flagged items — ACCEPTED FLAGS only (the CUTOVER-GATING items are in §6.CUTOVER-GATING)
These do NOT gate the cutover; they are honestly-recorded residuals/flags:
- Soak memory: PASS with the monitored-not-proven flag (§1) — not an unconditional
  leak-freedom proof.
- BINHEAD discharged (#194); binary heads have real in-DB representation.
- 3 marginal RPC-D2 P2 declines recorded in RPC_GAP (stale-plaintext-on-decrypt,
  single-client id-reservation, tests-only in-process egress).
- Adversarial-only cross-engine deltas (§6): moot post-R15 (the reset wipes
  pre-existing rows); differential/parity suites expect them.

The CUTOVER-GATING items (switch materialization, richdoc fidelity, TOCTOU
closure, pre-R15 migration) are NOT here — they are in §6.CUTOVER-GATING. Ice
selected their resolutions; their open review shards still must land before the
flip.
