# Rust engine rewrite — decision ledger

Append-only. Every entry: date, decision, decider, rationale pointer.

## 2026-07-16 — Program authorized (go signal)

- **Decider:** Ice, in-session, after Rev 2 plan review.
- **Scope:** full rewrite per Rev 2 plan
  (`docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md`). No
  go/no-go trial; Phase 1 slices are calibration only.
- **Sole abort criterion:** the week-one yrs interoperability spike.

## 2026-07-16 — Locked at planning (see plan "Decisions locked")

1. Full commitment, no trial.
2. Clean reset of pre-launch data; two retained safety mechanisms (Rust
   refuses unrecognized DBs; verified restore-tested backup before first
   write).
3. Day-one Rust schema: `schema_version = 2`, current v1 logical shapes,
   eager creation, migration/idempotency/job ledgers from day one. The v2
   stamp is the post-cutover fence (TS fails closed via
   `engineDbSchema.ts:680`).
4. yrs owns Y.Doc durability iff the spike passes; no fallback menu.
5. Rust over Go; pinned stable toolchain, edition 2024.
6. Oracle = existing ~22k-line suite ported to implementation-neutral
   adapter + differential traces + named-fault-point crash injection.

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
