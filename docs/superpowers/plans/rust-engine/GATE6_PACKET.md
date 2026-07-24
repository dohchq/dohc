# GATE 6 — release-candidate evidence packet

**Status: ASSEMBLED 2026-07-24.** GATE6 is the release-candidate gate: it declares
the Rust engine feature-complete and evidenced for the R15 cutover, with every
claim carrying its evidence and its limitations. Every dependency
(R14 robustness, R10b relay-epoch, R15-REHEARSE, and all RPC shards A/B/C/D/B2/D2)
is `gate passed` / `done`. This packet is the evidence; the R15 go/no-go package
(the ICE STOP) is separate and consumes the "open decisions" below.

---

## 0. Completeness — all implementation shards done

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

No implementation shard remains. R16 (legacy deletion) is POST-cutover by design.

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

## 4. Migration ledger — 13 migrations, ordinals 0-12, monotone
baseline(0), v1-secrets(1), v1-ydoc(2), v1-chats(3), v1-search(4),
v1-moment-before-link(5), v1-sync(6), v1-conflicts(7), v1-shadow-clone(8),
v1-binary-conflict-sides(9), v1-binary-head(10), v1-path-aliases-object-index(11),
v1-engine_requests-kind(12, RPC-D — kind-scoped ledger purge; every writer stamped).
RPC-B2 and RPC-D2 added NO new migrations (domain/logic only).

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
- **Secret rename-TOCTOU — ACCEPTED RESIDUAL** (D2, BEHAVIOR_DELTA.md): path-based
  ancestor checks are not fd-relative; a potential secret-disclosure/overwrite risk
  accepted ONLY under the single-user/local-first/owner-only/no-sharing assumption;
  **dirfd/openat2 + renameat closure REQUIRED before any shared-secret model.**
- **Secret re-materialization on mid-session version SWITCH — GAP** (D2, RPC_GAP):
  the daemon lacks the oracle's switch-time secret rebuild (SetActiveVersion is
  DB-only; only open-replay materializes). Open-time projection is correct; a
  mid-session switch does not refresh disk secrets until reopen. **R13/GATE6
  daemon-composition scope, not the secret executor — must be wired for a faithful
  desktop switch UX.** Non-secret files share the same switch-materialization
  dependency on the composition layer.
- **Identity posture** (recorded across shards): the daemon's DOP1 client IS the
  desktop main process; per-user socket auth is R15+ scope.

## 7. Open decisions for Ice — these feed the R15 go/no-go (present, don't decide)
1. **Pre-R15 migration PR (secret ownership column + moments payload-provenance).**
   (a) Secret ownership keys on metadata_origin=="local-file" (also a legit API
   origin) — non-spoofable ownership needs a dedicated column. (b) The oracle's
   moments payload_before_*/payload_after_* provenance columns were never ported.
   Both are CHEAP before R15's reset, EXPENSIVE after. RECOMMEND one pre-R15
   migration PR for both.
2. **macOS evidence path** — CI workflow (`rust-engine-macos-evidence.yml`,
   dispatchable) vs Ice-run `macos-evidence.sh`. Both drafted; either produces a
   macOS gate log + soak-evidence JSON. (This is the next work item after GATE6.)
3. **RPC-E scope for cutover** (replication/relay; backend-modes.md). Interacts with
   RPC-C's sync-defer-while-open guard (fail-closed seam lands either way; live
   convergence is later).
4. **Richdoc at cutover** — Rust's richdoc→markdown projection is a paragraphs+bold/
   italic subset. Options: (a) port full-fidelity yDocToMarkdown to Rust as
   cutover-gating work — RECOMMENDED; (b) disable richdoc editing at cutover;
   (c) dual-engine — not recommended.
5. **Secret rename-TOCTOU closure timing** — accepted as a documented residual for
   single-user; MUST close (dirfd/openat2) before any shared-secret model. Decide
   whether that lands pre-cutover or is explicitly deferred with the single-user
   constraint enforced.
6. **The R15 go/no-go itself** — dogfood reset, >=2-week dogfood plan,
   member-share-log-across-epoch-reset semantics, and wiring switch-time secret
   re-materialization (§6 gap) for a faithful desktop version-switch UX.

## 8. Known limitations / flagged items (summary)
- Soak memory: PASS with the monitored-not-proven flag (§1).
- Secret rename-TOCTOU: accepted single-user residual, closure required for sharing (§6).
- Mid-session switch secret re-materialization: gap, composition-layer scope (§6).
- BINHEAD discharged (#194); binary heads have real in-DB representation.
- 3 marginal RPC-D2 P2 declines recorded in RPC_GAP (stale-plaintext-on-decrypt,
  single-client id-reservation, tests-only in-process egress).
