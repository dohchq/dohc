# GATE 6 — release-candidate evidence packet

**Status: PACKET ASSEMBLED 2026-07-24 — GATE NOT YET CLOSED.** GATE6 is the
release-CANDIDATE gate. This packet is the EVIDENCE; the gate itself stays PENDING
until BOTH remaining criteria are recorded:
1. an end-to-end **clone-reset rehearsal on REAL dogfood workspace byte-clones**
   (the machinery is built + gate-verified by its rehearsal-on-clones test suite,
   but it has NOT been run against Ice's real data — that needs Ice's machine), and
2. **explicit Ice authorization** at the R15 go/no-go.
Do NOT treat `SHARDS.tsv`/this packet as gate-closed before both land.

**WHAT GATE6 ASSERTS:** NO GATE6-BLOCKING IMPLEMENTATION SHARD REMAINS, and the
engine is EVIDENCED (gate/soak/differential green, every claim below carrying its
evidence and limitations). Every dependency (R14 robustness, R10b relay-epoch,
R15-REHEARSE, and all RPC shards A/B/C/D/B2/D2) is `gate passed` / `done`.
This is NOT "code-complete": deferred implementation remains (R13b-rest, RPC-E,
switch-time re-materialization wiring, richdoc full-fidelity projection) — see §0.

**WHAT GATE6 DOES NOT ASSERT: cutover-READINESS.** The items in §6.CUTOVER-GATING
below are real, not "non-blocking limitations," and MUST be resolved at the R15
go/no-go (the ICE STOP) before the cutover flips — they are not closed here.

This packet is the evidence + the decision inputs; the R15 go/no-go package consumes
the CUTOVER-GATING items and the "open decisions" (§7).

---

## 0. Completeness — no GATE6-BLOCKING implementation shard remains (deferred work listed)

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

No **GATE6-blocking** implementation shard remains. Implementation that is
DEFERRED (not done, deliberately out of GATE6 scope) — do NOT read this table as
"code-complete, skip the cutover wiring":
- **R13b-rest** — REST DEFERRED in SHARDS: remaining desktop-adapter surfaces
  (main.ts / cli / mcp / shared-view + capture wiring). Scope decision at R15.
- **RPC-E** (replication/relay cutover scope) — scoped at R15, not built.
- **Switch-time secret+file re-materialization** — §6.CUTOVER-GATING item 1,
  composition-layer wiring, not built.
- **Richdoc full-fidelity projection** — §6.CUTOVER-GATING item 2, if option (a).
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

## 4. Migration ledger — 14 migrations, ordinals 0-13, monotone; **NEXT ORDINAL = 14**
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

RPC-B2 and RPC-D2 added NO new migrations (domain/logic only).

**The pre-R15 migration decision (§7.1) MUST use ordinal 14** — treating 13 as free
would collide with `v1-engine-request-kind`.

REPRODUCE THIS CLAIM (do it before authoring the migration; do not trust this table
alone — it is a snapshot):
```
rg -n 'MIGRATION_ID: &str|BASELINE_MIGRATIONS' crates/dohc-engine-storage/src/migration.rs
cargo test -p dohc-engine-storage migration   # the ledger's own ordinal/monotonicity tests
```
`BASELINE_MIGRATIONS` is the frozen ordered list; its length is the next ordinal.

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
  documented: sharing/multi-user secret access must stay OFF (and per-user socket
  auth, currently deferred, is part of the same boundary) while the residual is
  open. RESOLUTION REQUIRED at R15: either land the dirfd/openat2 + renameat closure
  before the cutover, OR confirm + enforce (in code/config, not prose) that no
  shared/ACL-partitioned secret path is reachable. Closure is REQUIRED before any
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
  desktop main process; per-user socket auth is R15+ scope.

### 6.CUTOVER-GATING — must be resolved at the R15 go/no-go (NOT closed by GATE6)
These are correctness/security items, not accepted flags. GATE6 surfaces them; the
R15 go/no-go decides each:
1. **Version-switch secret+file re-materialization** — stale/wrong disk secrets
   after a mid-session switch until reopen (wire it, or explicitly accept+surface).
2. **Richdoc→markdown fidelity** — the paragraphs+bold/italic subset DROPS
   unsupported richdoc content (data loss on projection); land full-fidelity
   projection or disable richdoc editing at cutover.
3. **Secret rename-TOCTOU assumption enforcement** — enforce owner-only/no-sharing
   (sharing + per-user socket auth OFF) while the residual is open, OR land the
   dirfd/openat2 closure.
4. **Pre-R15 migration** (secret-ownership column + moments payload-provenance) —
   cheap before the reset, expensive after.
Accepted flags (NOT gating): soak monitored-not-proven; the 3 marginal RPC-D2 P2
declines; BINHEAD (discharged). See §8.

## 7. Open decisions for Ice — these feed the R15 go/no-go (present, don't decide)
1. **Pre-R15 migration PR (secret ownership column + moments payload-provenance).**
   (a) Secret ownership keys on metadata_origin=="local-file" (also a legit API
   origin) — non-spoofable ownership needs a dedicated column. (b) The oracle's
   moments payload_before_*/payload_after_* provenance columns were never ported.
   Both are CHEAP before R15's reset, EXPENSIVE after. RECOMMEND one pre-R15
   migration PR for both.
2. **macOS evidence path** — BOTH tools now EXIST and ship in this PR: the
   dispatchable CI workflow `.github/workflows/rust-engine-macos-evidence.yml`
   (macos-latest, quick|full input) and the local `tools/rust-engine-program/
   macos-evidence.sh` (run on a Mac). Each reproduces the full-workspace gate +
   the cutoverBlocking soak and emits the verdict logs + soak-evidence JSON.
   Both DEFAULT TO `full` (the bankable 30-60min soak); `quick` is explicitly
   NON-GATING (the runner exits 0 with PASS-SCENARIOS-ONLY(trend-not-evaluated),
   which CANNOT satisfy this packet's soak evidence). Both install cargo-deny and
   FAIL on a `cargo-deny=SKIP` gate line, and both build the daemon + runner
   release binaries (the soak resolves the daemon as a sibling). The local script
   refuses non-Darwin hosts so a Linux/WSL run cannot masquerade as macOS proof.
   EXECUTION requires a Mac (a macOS CI runner or Ice's machine) — the Windows dev
   box cannot produce it. DECISION for Ice: dispatch the CI workflow, or run the
   script locally, before the R15 go/no-go. (This is a green-path confidence
   check, not expected to surface engine issues; the code is platform-portable
   Rust and the unix materialize/symlink paths already have `#[cfg(unix)]` tests.)
3. **RPC-E scope for cutover** (replication/relay; backend-modes.md). Interacts with
   RPC-C's sync-defer-while-open guard (fail-closed seam lands either way; live
   convergence is later).
4. **Richdoc at cutover (CUTOVER-GATING — data loss)** — Rust's richdoc→markdown
   projection is a paragraphs+bold/italic subset that DROPS unsupported richdoc
   content (headings/lists/links/code), so a cutover with richdoc editing live can
   silently lose content. Options: (a) port full-fidelity yDocToMarkdown to Rust
   before cutover — RECOMMENDED; (b) disable richdoc editing at cutover;
   (c) dual-engine — not recommended. Not acceptable to ship as-is with richdoc live.
5. **Secret rename-TOCTOU closure timing** — accepted as a documented residual for
   single-user; MUST close (dirfd/openat2) before any shared-secret model. Decide
   whether that lands pre-cutover or is explicitly deferred with the single-user
   constraint enforced.
6. **The R15 go/no-go itself** — dogfood reset, >=2-week dogfood plan,
   member-share-log-across-epoch-reset semantics, and wiring switch-time secret
   re-materialization (§6 gap) for a faithful desktop version-switch UX.

## 8. Flagged items — ACCEPTED FLAGS only (the CUTOVER-GATING items are in §6.CUTOVER-GATING)
These do NOT gate the cutover; they are honestly-recorded residuals/flags:
- Soak memory: PASS with the monitored-not-proven flag (§1) — not an unconditional
  leak-freedom proof.
- BINHEAD discharged (#194); binary heads have real in-DB representation.
- 3 marginal RPC-D2 P2 declines recorded in RPC_GAP (stale-plaintext-on-decrypt,
  single-client id-reservation, tests-only in-process egress).
- Adversarial-only cross-engine deltas (§6): moot post-R15 (the reset wipes
  pre-existing rows); differential/parity suites expect them.

The CUTOVER-GATING items (switch-materialization stale secrets, richdoc fidelity,
TOCTOU-assumption enforcement, pre-R15 migration) are NOT here — they are in
§6.CUTOVER-GATING and MUST be resolved at the R15 go/no-go.
