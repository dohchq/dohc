# R15 CUTOVER — GO / NO-GO PACKAGE

**This is the one mandatory human stop in the program.** The cutover RESETS Ice's
dogfood data. Nothing flips without Ice's explicit go. Assembled 2026-07-25.

Inputs: `GATE6_PACKET.md` (evidence + cutover-gating items), `RPC_GAP.md` /
`BEHAVIOR_DELTA.md` (deltas + accepted residuals), `SHARDS.tsv`, `EXECUTION_LOG.md`.

---

## Where the program stands

- **All GATE6-blocking implementation is done.** RPC-A/B/C/D/B2/D2 merged
  (#217 / #218 / #220 / #223 / #225 / #227) plus integrator passes; every earlier
  wave gate passed. RPC-D2 — the secrets-to-disk executor — took 8 build/fix rounds
  and 4 adversarial passes and is the most heavily reviewed shard of the program.
- **Evidence is green** (GATE6_PACKET): canonical full-workspace gate on main PASS
  (fmt/clippy -D warnings/build/test/cargo-deny); soak v3 PASS (5564 cycles, clean
  shutdown, with the honest monitored-not-proven memory flag); TS-vs-Rust capture
  differential 10/10 tamper-checked; 14-migration monotone ledger (ordinals 0-13).
- **GATE6 is NOT closed.** Two plan-required criteria remain, and BOTH are resolved
  by this stop:
  1. an end-to-end **clone-reset rehearsal on REAL dogfood workspace byte-clones**
     — the machinery is built and gate-verified by its rehearsal-on-clones suite,
     but it has NEVER run against Ice's real data (needs Ice's machine);
  2. **Ice's explicit authorization.**
- **This is NOT code-complete.** Deferred implementation, by design, outside GATE6:
  R13b-rest (desktop-adapter remainder), RPC-E (relay/replication cutover scope),
  switch-time re-materialization wiring, richdoc full-fidelity projection.

---

## THE SIX DECISIONS

### 1. Pre-R15 migration (ordinal 14) — author it before the reset?
Two schema gaps are CHEAP before R15's reset and EXPENSIVE after:
(a) secret **ownership** keys on `metadata_origin == "local-file"`, which is also a
legitimate API origin — non-spoofable ownership needs a dedicated column;
(b) the oracle's moments `payload_before_*` / `payload_after_*` provenance columns
were never ported (Rust hydrates only what its schema has).
**RECOMMEND: yes — one pre-R15 migration PR covering both, at ordinal 14.**
NOT 13 — ordinal 13 is `v1-engine-request-kind`; verify with the REPRODUCE commands
in GATE6_PACKET §4 before authoring.

### 2. macOS evidence — run it how, and does it gate the flip?
macOS is a shipping platform that the Windows + WSL-Linux evidence never covered.
Both tools now exist and are hardened: dispatchable
`.github/workflows/rust-engine-macos-evidence.yml` and local
`tools/rust-engine-program/macos-evidence.sh`. Both default to `full` (the bankable
30-60min soak), pin cargo-deny, and require a canonical PASS verdict. The CI workflow
also has an always-run check that makes a green run impossible unless exactly one
nonempty soak evidence JSON exists, and its artifact name records the final job status;
the script refuses non-Darwin hosts. Execution needs a Mac.
**RECOMMEND: dispatch the CI workflow in `full` mode before the flip and treat a
non-PASS as a no-go.** Expected to be a green-path confirmation.

SCOPE OF WHAT A macOS PASS PROVES (recorded at R15-2, do not overread it): the
soak's handle/thread tolerances were calibrated against WINDOWS jitter, while
macOS counts `lsof` rows and `ps -M` threads — different populations. A macOS
PASS therefore shows the gate passed and the scenarios ran clean; it does NOT
make the RESOURCE-LEAK verdict bankable, because nobody calibrated those bounds
for macOS. Treat gate+scenarios as evidence and the leak verdict as
uncalibrated until it is measured on representative Macs.

### 3. Richdoc at cutover — CUTOVER-GATING (silent data loss)
Rust's richdoc→markdown projection is a paragraphs + bold/italic subset; it DROPS
headings, lists, links and code. Cutting over with richdoc editing live can silently
lose user content.
**Options: (a) port full-fidelity `yDocToMarkdown` to Rust before the flip
(RECOMMENDED); (b) disable richdoc editing at cutover; (c) dual-engine richdoc
(contradicts the atomic cutover — not recommended).** Shipping as-is with richdoc
live is not acceptable.

### 4. Version-switch re-materialization — CUTOVER-GATING (stale/wrong secrets)
`SetActiveVersion` is DB-only and only open-replay materializes, so a **mid-session
version switch leaves on-disk secrets and files STALE** — potentially the wrong
version's `.env` — until the next workspace open. The oracle re-materializes on
switch (`planSecretMaterialization` / `switchVersion`).
**Options: (a) wire a switch-time re-materialization pass (RECOMMENDED — restores
oracle-faithful switch UX); (b) explicitly accept AND surface the
stale-until-reopen behavior in the UI.**

### 5. Secret rename-TOCTOU — CUTOVER-GATING (enforcement, not prose)
The residual is accepted ONLY under single-user / local-first / owner-only /
no-sharing. Winning the race can redirect a 0600 plaintext `.env` through a
swapped-parent symlink to an attacker-readable path — so the assumption must be
ENFORCED, not merely documented (sharing and per-user socket auth stay OFF).
**Options: (a) confirm + enforce the single-user boundary in code/config for the
dogfood window (RECOMMENDED for the MVP); (b) land the dirfd/`openat2` + `renameat`
closure before the flip.** Closure is REQUIRED before any shared-secret model ships.

ICE CHOSE (b) — see DECISIONS.md. Two corrections recorded after that choice:
the "per-user socket auth stays OFF" clause above is WITHDRAWN because there is
no socket (the daemon reads inherited stdio pipes; see the transport correction
in RPC_GAP.md and the finding under decision 5 in DECISIONS.md), and the TOCTOU
closure itself is owned by R15-5 (#237) — it is NOT closed by the docs PR that
recorded these corrections.

### 6. Cutover scope + THE GO/NO-GO ITSELF
- **RPC-E** (relay/replication) and **R13b-rest** (desktop-adapter remainder):
  in-scope for cutover, or explicitly deferred post-cutover?
- **The flip:** the dogfood **RESET erases Ice's current dogfood data**; the >=2-week
  dogfood plan; member-share-log-across-epoch-reset semantics.
- **Order to run it:** decisions 1-5 land → **rehearsal on real byte-clones of Ice's
  dogfood workspaces** → Ice's authorization (this closes GATE6) → flip → >=2-week
  dogfood → R16 legacy deletion.

---

## What is needed from Ice

A decision on each of 1-6 — or "take your recommendations" to adopt the RECOMMENDED
option on 1-5 and an answer on 6 — and then an explicit **go**.

Until then: nothing flips, no data is reset, and GATE6 stays open.
