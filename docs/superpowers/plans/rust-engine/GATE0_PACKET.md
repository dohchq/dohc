# Gate 0 decision packet — RESOLVED 2026-07-16

> Ice approved all recommendations in-session: yrs PASS ratified
> (converging-prefix accepted), protocol ratified, GitHub CI skipped
> (local-first evidence; macOS deferred to pre-release), freeze enforced by
> Ice with in-flight engine changes integrated via delta reconciliation,
> decisions 3–8 per recommendation, both security hotfixes approved,
> NEEDS-DECISION defaults approved. Authoritative record: DECISIONS.md.

# (original packet below)

> One page + links. Gate 0 closes Phase 0 and opens Wave 1 capability work
> (R04 storage core + calibration slices). Everything below is evidence-
> linked; nothing requires re-reading the program.

## Wave 0 delivered (all adversarially reviewed; most twice)

| Evidence | Where | State |
| --- | --- | --- |
| Rev 2 plan + program machinery | PR #137 | 4 review rounds fixed; final bot pass pending |
| Behavior inventory: 232 behaviors, 218 exports, 46 test files, 117 determinism sites | PR #138 | review closed |
| Native TS-suite CI matrix | PR #139 | **blocked on billing (below)** |
| yrs interop spike: PASS, yjs 13.6.30 ↔ yrs 0.27.3 | PR #140 | 2 local reviews UPHELD + re-check + 2 codex rounds closed; 500/500 strict certification |
| Protocol spike: framed JSON + binary chunks, measured | PR #141 | review closed (supervisor admission redesigned) |
| Test oracle: 35 named fault points, packet builder | PR #142 | 2 review rounds closed; self-test 33/33 |
| Contracts: PORTING 15§, STATE_OWNERSHIP 52 rows, semantics matrix 91 rows | PR #143 | **Gate 0 approve-together SATISFIED** (2 reviewers + re-check) |

## Decisions needed from you

1. **Ratify the yrs PASS** (sole abort criterion). Evidence: PR #140 +
   `SPIKE_REPORT.md`. Five binding R11 constraints recorded in
   `DECISIONS.md`. One sub-option: yjs `applyUpdate` is non-atomic on
   malformed input — accept the pinned converging-prefix invariant
   (recommended, zero cost) or require strict state-unchanged (costs a
   snapshot/restore wrap in R11b).
2. **Protocol (open decision 1)**: ratify length-framed JSON control frames
   + raw binary blob chunks, serde-struct single schema source. Evidence
   and scorecard: PR #141 / `ENGINE_PROTOCOL.md`. Two freeze-time design
   items already escalated (event flow control; per-method schemas).
3. **CI matrix + billing (open decision 2)**: fix the org's GitHub Actions
   billing (everything CI is dead until then — PR #139 proves it), approve
   the mandatory Rust matrix (windows/macos-arm64/ubuntu; macOS x64 has no
   native runner — accept cross-build for packaging with native tests on
   arm64, or fund an external x64 runner).
4. **Enforce the freeze** (plan: from Wave 0 on `engineDbSchema.ts` + sync
   wire surfaces; full engine freeze at Wave 1). `engineDbSchema.ts` grew
   188 lines on main during Wave 0 day one. Whatever is landing that —
   stop it or route it through the BEHAVIOR_DELTA exception process.
5. **Open decisions 3–8** (recommendations inline in the plan): relay HTTP
   ownership (rec: Rust at cutover), standalone CLI/MCP stay external
   writers (rec: yes), share mounts in the atomic cutover (rec: yes),
   account/DM/registry saga model (rec: TS owner + Rust sagas),
   agent-run attribution under Rust (rec: yes, JSON as projection),
   dogfood/canary duration (needs your number; rec: ≥2 weeks).
6. **9 NEEDS-DECISION items from the contracts work** (list:
   `LANGUAGE_SEMANTICS_MATRIX.md` summary). Two are **current-product
   security holes deserving TS hotfixes now, independent of the rewrite**:
   `validateWorkspacePath` accepts NTFS ADS `:` segments / device names /
   8.3 short-name aliases, and search policy fails OPEN on read errors
   (`searchIndex.ts:53-77`). Recommendation: hotfix both this week; the
   fixes also become approved deltas the Rust port inherits cleanly.

## What happens on your go

Merges (#137→#138→#140→#141→#142→#143, branch cleanup per repo rule) →
R02 lands the Cargo workspace + CI over the merged crates → GATE0 flips in
SHARDS.tsv → Wave 1 opens: R04 storage core + the three calibration slices,
R01-DETERMINISM retrofit, R11b/R13b adapter work behind their deps. The
engine freeze becomes binding at Wave 1 open.

## Standing risks (tracked, not blocking your decision)

Billing (above); bot review rounds may trickle (loops stay open until
clean); the freeze is not yet enforced on main; TS-suite native results on
Windows/macOS unknown until CI runs — failures there become pinned deltas,
not blockers.
