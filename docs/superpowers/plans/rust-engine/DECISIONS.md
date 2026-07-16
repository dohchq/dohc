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
   stamp is the post-cutover fence (TS fails closed via the
   `schema_version` check in `initializeOrValidateEngineSchema`).
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

## Open — require Ice at Gate 0 (recommendations in plan)

| # | Decision | Status |
| --- | --- | --- |
| 1 | Protocol (after R03 spike) | open |
| 2 | Mandatory 4-platform Rust CI matrix (needed week one) | open |
| 3 | Relay HTTP client ownership at cutover | open |
| 4 | Standalone CLI/MCP stay external writers | open |
| 5 | Share mounts in the atomic cutover | open |
| 6 | Account/DM/registry saga model | open |
| 7 | Agent-run attribution under Rust | open |
| 8 | Dogfood/canary duration before stable | open |
| 9 | Mobile/web hosts — deferred; portability guardrails added 2026-07-16 (Ice) | deferred |
