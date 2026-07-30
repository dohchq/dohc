# dohc Rust Engine Rewrite — SESSION HANDOVER (finish to 100%)

**Written 2026-07-21 ~06:00Z. This file is the complete transfer.** Paste the
kickoff prompt below into a fresh session; that session carries the program
to completion.

---

## LIVE ADDENDUM (2026-07-22 ~12:40Z — the executing session updates this in place)

- **PR #223 REVIEW ROUND 1 COMPLETE** (all three sources triaged, fixes
  committed): CodeRabbit 3/3 implemented (31d8f0ee — readBlob base64,
  crypto Internal severity, loopback limit refusal). Local claude
  (fable-5) 4 P2 + 7 P3: implemented in 9d8b3d19 (rollback/binary-write
  post-commit seams + self-write retraction, secret-delete completed
  markers, merge foreign-op-requestId reuse-mismatch, apply up-front
  path gate + version-not-found, loopback duplicate-id/setActive);
  ONE decline with citation (createNamed DOES fork secrets in-tx,
  store.rs:1397). Codex 6 P2s: readBlob shape already fixed; 4 code
  gaps implemented by codex round 6 in f775daed (workspace-scoped
  readBlob mutation-verified, binary-write requestId ledger,
  version-wide secrets.moments.list, explicit apply
  sourceVersionId/targetVersionId per oracle engine.ts:1926); the 6th
  (secret disk materialization) RECORDED as RPC-D2 scope (SHARDS +
  RPC_GAP: secret-aware disk executor, GATE6-blocking).
- **LESSON (cost a gate cycle)**: NEVER edit the worktree while a gate
  runs in it — the gate builds the WORKING TREE (s7 failed on my
  mid-gate tracing:: edits; engine crates deliberately have no logging
  framework — materializeOutcome on the wire IS the observability).
- **ROUND 2 COMPLETE** (~13:30Z): CodeRabbit APPROVED at f775daed (its
  3 round-2 comments were confirmations). Claude round 2 found 1 P1
  (readBlob refused conflict-side-only blobs — oracle serves an open
  conflict's incoming binary side, syncFolder.test.ts:1735; conflicts
  EXISTS branch added + mutation-verified) + 2 P2 + 5 P3; codex-bot
  round 2 found 7 (2 overlapped). All fixed in 6c5a6fa9 (Rust: restore
  marker, object_id hash, invalid-version, optional versionId, clamp
  revert — round-1's loopback limit-refusal was the WRONG direction,
  CodeRabbit's fail-closed claim didn't survive verification; corrected
  in-thread) + 7b01562f (loopback: restore version targeting, typed
  textRead, rollback history, retry no-op, merge moments). Gate s9
  PASS; pushed; all threads answered; @codex review re-tagged; claude
  round 3 launched (fresh-eyes on the two round-2 commits).
- **RESTART NOTE (2026-07-22 ~15:05Z, PC reboot imminent)**: everything
  through 7c033d46 is COMMITTED AND PUSHED (gate s13 PASS). Codex round
  9 (CODEX_TASK9.md — the codex-bot round-4 fixes: apply provenance
  threading, degraded-write search-state invalidation, replay-safe FTS
  deletes, over-cap length verification) was IN FLIGHT and dies with
  the reboot, leaving possibly-partial UNCOMMITTED edits in C:/w/rpcd.
  Recovery after reboot: (1) `git -C C:/w/rpcd status` — discard any
  uncommitted tracked changes (`git checkout -- .`; untracked CODEX_*/
  gate logs are harmless), (2) re-dispatch the codex wrapper on
  CODEX_TASK9.md verbatim (task file is on disk), (3) re-arm the PR
  #223 watcher (paginated reviews+comments poll). Review-loop state:
  CodeRabbit APPROVED; local claude CONVERGED (r4 =
  CLEAN-ENOUGH-TO-MERGE, all items closed/recorded); codex bot r4's 4
  P2s = CODEX_TASK9 scope; after round 9 lands: verify + commit + gate
  s14 + push + in-thread replies + @codex review re-tag; merge #223 on
  a quiet codex pass, delete branch + verify, EXECUTION_LOG entry.
- **ROUNDS 3-4 (~14:45Z)**: codex r3 found 5 (all implemented in
  1a401b04 — headline: normalize_rpc_path/NFC was NEW in this PR and
  WRONG, removed from all 13 arms, paths verbatim everywhere with NFD
  round-trip test; blob reads metadata-first + fail-closed
  state-corrupt on referenced-but-missing; digest lowercasing;
  legacyBeforeText in rollback hash). Claude r3 found 1 P2 (loopback
  objectId continuity on overwrite — daemon right) + 4 P3, fixed in
  f5ef8352; CodeRabbit's follow-up learning (per-endpoint limit
  semantics: moments.list refuses <1 per oracle, secrets clamps) fixed
  in 4f117a4d. Claude r4 = CLEAN-ENOUGH-TO-MERGE (verbatim sweep
  verified consistent — lease keys are object_id-based; 4 P3s: two
  fixed in 7c033d46 (hash-fn collapse, negative-length fail-closed),
  two recorded in RPC_GAP (secret slash-spelling delta ruling owed with
  RPC-D2 executor; shared-ledger result_seq purge audit)).
- **POST-REBOOT ROUNDS (through ~16:50Z 07-22)**: codex r4 (4 P2:
  apply provenance — "sync" ruling was wrong for the desktop merge
  caller; degraded-write search-state; replay-safe FTS delete; verified
  blob lengths) fixed in c235b6c1. CR re-approved after e5073379 (apply
  tests pin provenance; both RPC_GAP deferred items elevated
  GATE6-BLOCKING). Codex r5 (P1: absent-path lease keys keyed on RAW
  spelling → write-behind-editor via notes//draft.md; ensureIndex
  unknown-version healthy-state; rollback restore-path lease; 2 loopback
  P3s) fixed in 691c8d54, P1 mutation-verified. Codex r6 (P1: lease
  check races ydoc.open — no session_ops guard held across
  check+dispatch, an open can acquire between; P2 deduped binary write
  never retries a pending materialization job; P2 moment ids not unique
  ACROSS text/secret tables) = CODEX_TASK11, round 11 IN FLIGHT.
- **ROUNDS 6-8 (through ~19:00Z 07-22)**: codex r6 (P1 lease-vs-open
  race → session_ops guard held across every mutating arm's
  check+dispatch; deduped materialization retry; cross-history moment
  ids) fixed fc6b336e. CR r4 (stderr trail at post-commit seams — the
  DOP1 wire owns stdin/stdout, eprintln is the daemon's operational
  channel) b94aa672; CR re-APPROVED. Codex r7 (unscoped rollback ledger
  purge → engine_requests.kind column MIGRATION 13, every writer
  stamped, purge kind-scoped — DISCHARGES the GATE6 shared-ledger
  obligation (RPC_GAP updated 728c5375); main-only bootstrap — typoed
  first write no longer becomes main; root-scoped suppression on binary
  write AND rollback; ydoc renderer label; loopback digests) a89c37b6.
  CR r5 outside-diff (i64 limit wrap → unbounded SQLite LIMIT; loopback
  orphaned-blob serving) bb968456, CR confirmed resolved. Codex r8
  found: P1 merge-into-inactive-version enqueues a materialization job
  the version-blind open replay drains onto the ACTIVE working tree; P2
  rollback purge misses kind='merge' rows; P2 active binary
  rename/delete never reconciles disk = CODEX_TASK13, round 13 IN
  FLIGHT (includes a FULL enqueue-site audit: every materialization
  enqueue → gated-by-active-version or not).
- **ROUNDS 8-11 (through ~21:00Z 07-22)**: codex r8 (P1
  merge-into-inactive materialization; merge-kind purge; binary
  rename/delete disk reconciliation) d8f3e158 with the 14-site enqueue
  audit + centralized active-version gate (mutation-verified). r9
  (single: migration-13 kind BACKFILL — provable classes classified,
  compound traced CAL-1-only so positives→versioned; -1/0 sentinels
  NULL fail-safe with documented chat/ydoc ambiguity) cfba8e5a. r10 (3
  P2: binary domain-door capture-origin guard; loopback binary
  content-dedup; compareFiles first-row progress) a37a42f1
  (implemented directly). CR passes at 728c5375→cfba8e5a CLEAN (zero
  comments), approval standing. Codex r11 found 2 P1 (EMPTY fork base
  reads as missing → a branch forked from an empty version can never
  compare/merge back; merge never drains its own merge-mat_ job —
  EXPOSED BY r8's gating, disk now catches up only at next open) + 5
  loopback P2s (incl. my r10 content-dedup returning moment:null where
  the daemon exposes the existing head moment) = CODEX_TASK15, round
  15 IN FLIGHT (merge wire result gains the materialize trio — TS
  types too).
- **ROUNDS 11-15 (through ~00:00Z 07-23)**: r11 (2 P1: empty fork
  bases; merge drains its own materialization + wire trio; 5 loopback)
  c5cbd35e — the wrapper's OUTSIDE-SANDBOX vitest caught a wrong
  codex-authored expectation. CR r6 (test hardening) d3ba9d05 +
  APPROVED standing. r12 (6 loopback in 89f77212; compound-migration
  objection DECLINED w/ cfg(test) citation). r13 (merge replay
  reconstructs before compare; contract completeness
  versions.list/secrets.list/materialize; 4 loopback guards) ef526569;
  the cross-table moment-id re-raise DECLINED as already-fixed
  (fc6b336e citations). r14 (binary-head-not-text wire mapping;
  compound decline CONVERTED to a per-database proof — positives
  classify versioned only when documents table is EMPTY; rollback
  cancels stale pending jobs UNCONDITIONALLY across version switches)
  30d31224. r15 = 7 loopback-ONLY items (three-way compare/merge port,
  cursor ordering, delete-moment content, momentId replay,
  limit-then-filter pages, fork points) = CODEX_TASK19 IN FLIGHT.
  DAEMON HAS BEEN QUIET TWO ROUNDS — findings are now exclusively
  loopback/test fidelity.
- PR watcher persistent monitor active. NEXT: round 19 lands → verify +
  commit + gate s28 + push + replies + @codex re-tag; MERGE #223 on a
  quiet pass (CodeRabbit APPROVED, claude converged). Then delete
  branch (verify gone), EXECUTION_LOG entry, RPC-B2 (+RPC-D2), GATE6
  packet, macOS evidence, R15 go/no-go (ICE STOP).

## SUPERSEDED ADDENDUM (2026-07-22 ~02:50Z)

- **RPC-D steps 6-7 COMMITTED** (d9009e78; s3 gate running with stall
  watchdog): codex round 3 (NO refusals, incl. the ciphertext-adjacent
  secrets work) delivered the full secrets RPC surface
  (write/delete/fork/compare + moments.list/get + apply/restore as
  VERBATIM ciphertext copies, new `invalid-version` wire code scoped to
  secrets, map_runtime no longer degrades secret domain errors),
  moments.list/get afterInbandLimitBytes/beforeInbandLimitBytes,
  search.ensureIndex wired end-to-end (was dead code), and the
  compareFiles DB-level FULL OUTER JOIN keyset scan (SHA-only, no body
  hydration; paginated parity pinned against the in-memory oracle in
  rpc_write_surface.rs). Orchestrator-verified: 73/73 sweep; apply
  no-op mutation check verified (break content-equality → named secrets
  test fails → reverted → 21/21 green).
- **Step 8 COMMITTED** (58689b55): codex round 4 built
  `packages/workspace-engine-client/src/versioned/` (wire contract +
  decoders + loopback parity, 37 vitest cases). Codex's sandbox could
  not spawn vitest (EPERM) — orchestrator ran the real suite, caught
  and fixed ONE fixture bug (incomplete stubs made the decoder throw on
  snapshot.workspaceId before the pinned object.createdAtMs field;
  fixture completed). tsc + vitest green. Clippy fix 3ec0e9ed
  (ApplySecretFileVerbatim record struct) landed after s3 gate FAILED
  on too-many-arguments; s4 gate PASS; pushed through 3ec0e9ed.
- **Integrator pass #222 MERGED** (3f13a3c1, branch deleted+verified):
  wire-backfill-journaling obligation recorded in RPC_GAP.md (owned by
  RPC-E/sync); RPC-B/RPC-C flipped done in SHARDS.tsv; EXECUTION_LOG
  2026-07-22 entry.
- **Gate s5 PASS, pushed to 01575c4a** (origin/main 3f13a3c1 merged in).
- **Adversarial pre-review returned FIX-FIRST** (fable-5, 15 findings;
  orchestrator verified every blocking citation against the oracle
  before acting): P1s = (1) secrets.apply is the oracle's THREE-WAY
  MERGE (secretFileStore.ts:1517-1583: plaintext-equality no-op,
  unchanged-since-fork-base no-op protecting target-side changes,
  DELETE PROPAGATION when source tip absent) — the shipped code was a
  blind ciphertext copy and the PR's own loopback disagreed with the
  daemon; (2) normalize_rpc_text trim/CRLF/NFC CORRUPTS file+secret
  bodies (oracle normalizeWriteText/normalizeSecretText validate only —
  design P2-12 was wrong to borrow the chat convention); (3) the branch
  DELETED versions.active's null-on-fresh-workspace parity arm. P2s:
  DuplicateMomentId must wire as "duplicate-id" (oracle rejectDuplicateId
  is ONE code for all kinds), ForkBaseNotFound as "fork-base-not-found";
  binary write/rollback refuse AFTER commit (materialize outcome must
  self-describe); merge replay re-derives instead of returning the
  recorded variant; secrets.moments.list truncates cursorless; FTS
  hygiene (binary-head rename upsert, deduped-write re-upsert); ledger
  hashes omit origin/author. SCOPE RULING: blob-egress producer
  RE-SCOPED to a follow-up shard (record as RPC-D2 in SHARDS/RPC_GAP
  before the PR); BlobStart ingest refusal, versionedBinary.read
  null-on-text, and bridgeContract.ts ydoc-origin widening ARE in this
  round.
- **Fix round COMMITTED (79a2e36e) + gate s6 PASS + PR #223 OPEN**
  (2026-07-22 ~11:35Z): codex round 5 fixed all 14 findings;
  orchestrator verified (73/73 sweep, desktop typecheck, fork-base
  no-op mutation kill on secret_apply_target_newer_..., 24/24 secrets);
  RPC-D2 re-scope recorded (SHARDS row + GATE6 dep + RPC_GAP note,
  rides the PR). PR #223 opened with gate evidence comment; @codex
  review tagged; CodeRabbit auto-reviews. IN FLIGHT: persistent PR
  watcher (paginated reviews+comments) + local claude (fable-5) review
  pass (fix-verification + fresh eyes on 79a2e36e). Review loop next:
  per-finding in-thread replies (implement or decline-with-citation),
  gate on every pushed head, @codex review re-tag after each push,
  claude review results posted as PR comments. Then: RPC-B2 (+RPC-D2
  blob egress), GATE6 packet, macOS evidence, R15 go/no-go (ICE STOP).

## LIVE ADDENDUM (2026-07-22 ~23:00Z — superseded above)

- **RPC-D steps 1-3 COMMITTED** (4e17753d on codex/rust-engine-rpc-d,
  first gate running): codex built §1-7 (writes/rename/delete/rollback/
  merge/compare/compareFiles, 17 mutation-commented tests, +1727/-62, NO
  classifier blocks) but its sandbox couldn't compile (target dir outside
  worktree denied — codify: give codex an IN-WORKTREE target or expect
  source-only verification). Orchestrator verification found+fixed: `after`
  hook shadowed by a SnapshotRecord binding; unqualified SearchError paths;
  test fixtures (shadow-token binding for pre-seeded DBs; search responses
  are BARE ARRAYS not {results}; FTS queries must use content terms);
  **REAL BUG: versionedBinary.write materialized NON-ACTIVE-version bytes
  to disk → capture baseline ingested them into main** (found via the
  compare-paging probe; fix = active-version-gated enqueue + actor skip,
  materialize_enqueued on BinaryWriteResult); momentId collisions now
  refuse duplicate-moment-id (oracle) not idempotency-mismatch; adapted
  pre-existing suites to new invariants (rival write on a leased path →
  ydoc-session-busy, replacing the old owner-change fixture; closed-set
  origins in shadow_replay). 73/73 suites green (two flaky singles under
  full-parallel load each passed in isolation and in clean re-sweeps).
- **KNOWN FOLLOW-UPS before PR**: requestId ledger on rename/delete/
  rollback/merge (design P1-8 covers the whole versionedText surface);
  DB-level keyset for compareFiles (currently wire-level cut). Then brief
  steps 4-8 (createNamed+fork atomic, setActive/ensureMain/active widen,
  read parity + readBlob, secrets surface, RPC_GAP items, client
  wrappers), adversarial review, PR.
- File-doubling gotcha: a python splice on rpc_write_surface.rs DUPLICATED
  the whole file once — after any scripted splice, wc -l sanity-check.

## LIVE ADDENDUM (2026-07-22 ~21:00Z — superseded above)

- **#220 (RPC-C) MERGED** 2026-07-22T06:52:33Z after 21 rounds (codex
  quiet: "Didn't find any major issues" on 36663201; CR approved); remote
  branch deleted+verified. Rounds 19-21 closed: epoch-unique session ids
  (+process-global instance counter), crash-safe drain ordering
  (apply→project→delete-markers-last, dedupe-tolerant count, permanent-
  refusal recovery, real coordinates for projection ids), root-scoped
  leases, plaintext default for omitted contentKind, policy-exit
  suppression clear. DECLINED (oracle): version auto-create for remote
  bases (requireWorkspaceVersionRow refuses; version.create arm = R13).
- **AGENTS.md refresh merged** (#221, Ice-authored, docs-only).
- **RPC-D LAUNCHED**: worktree C:/w/rpcd @ 82d34c02 (all merges in),
  branch codex/rust-engine-rpc-d, RPCD_DESIGN.md + RPCD_BRIEF.md staged;
  codex wrapper running brief steps 1-3 (text/binary writes + suppression;
  rename/delete/rollback; merge/compare + compareFiles paged). Expect
  classifier blocks on byte-work → orchestrator implements those directly.
  CARGO_TARGET_DIR=C:/w/_targets/rpcd.
- Reviews-API pagination hazard codified: ALWAYS --paginate the reviews
  list (19 reviews neared the 30/page default; an unpaginated query would
  silently drop the newest).

## LIVE ADDENDUM (2026-07-22 ~19:55Z — superseded above)

- **#220 at round 19** (cc2dc95d, gate PASS, pushed+replied+re-tagged):
  codex r18 — session ids embed a per-service epoch (pid+boot-ms; the r18
  idempotency ledger made per-lifetime counters collide across restarts);
  drain applies→PROJECTS→deletes markers LAST (projection also on deduped
  redeliveries — the crash-retry applied==0 case); LeaseRegistry
  root-scoped views (two clones of one workspace no longer exclude each
  other). DECLINED: auto-creating versions for remote bases (oracle
  requireWorkspaceVersionRow refuses, versionedTextStore.ts:1312; stream
  ordering is the mechanism; version.create apply arm = R13 sync shard).

## LIVE ADDENDUM (2026-07-22 ~18:30Z — superseded above)

- **#220 round 18 PUSHED** (cb60289e = r18 ba72d189 + origin/main MERGE
  943605c6 + SupervisorOpen fixups; gate PASS; MERGEABLE/CLEAN again):
  codex r17's five in (root-scoped suppression; seeded initialUpdate;
  stale-held resync; drain-internal projection with the close-site block
  collapsed; recordUpdate idempotency ledger with NEGATED result_seq).
  Merge conflicts were import unions + one structural piece (early
  OpenGuard now wraps main's created-actor reclaim); 72 suites green.
  Re-tagged. #220 is the LAST PR before RPC-D.

## LIVE ADDENDUM (2026-07-22 ~17:40Z — superseded above)

- **#218 (RPC-B) MERGED** 2026-07-22T05:01:24Z after 17 rounds; remote
  branch deleted+verified (Not Found). Final round: codex r16's four were
  ALL standing-posture items (replication-owner, enqueue eligibility,
  authorship, bookmark owner) — consolidated decline posted citing the
  RPC_GAP posture + oracle division of labor; CR approved (3x); merge
  point declared explicitly in-thread. RPC-B COMPLETE.
- **#220 at round 18** (7e299a4f committed, gate running): codex r17's
  five — root-SCOPED suppression keys (same ws id under two roots);
  session.initialUpdate re-encoded post-seed (renderer empty-doc P1);
  stale guard held across recursive resync; drain projects internally
  (close-site block collapsed into it; parked-envelope test asserts the
  drained head); recordUpdate idempotency ledger (payload-hashed,
  result_seq NEGATED out of the moment-order domain; replays original seq
  after compaction).
- RPC-D remains blocked on #220 only.

## LIVE ADDENDUM (2026-07-22 ~16:50Z — superseded above)

- **#218 at round 16** (53655fd0, gate PASS, pushed+replied+re-tagged):
  codex r15's three — reserved wire ids refuse on ensure paths;
  follows.list omitted-state=ALL incl. tombstones (+ filter/refusal);
  chats.bookmarks.find + listPending (desktop materializer poll loop now
  wire-reachable). All mutation-verified. Dead ChatOwnerParams removed
  (clippy).
- **#220 at round 17** (054c82c2, gate PASS, pushed+replied+re-tagged):
  codex r16's four — idempotent pulls advance the marker; OpenGuard arms
  before startup replay; drain delete propagates crash seams;
  close-drain projection gated on pending dependencies. CR APPROVED at
  r16.
- Watcher gap lesson: a since-window opening minutes AFTER the re-tag can
  MISS a fast codex review (happened on #218 r15, found by manual check).
  Overlap the since window with the push time, and on any quiet period
  poll the reviews list directly before assuming codex is silent.

## LIVE ADDENDUM (2026-07-22 ~15:10Z — superseded above)

- **#220 at round 16** (0ef6166d, gate PASS, pushed+replied+CR-resolved+
  re-tagged): codex r15 (3 P1+3 P2) + CR r15 (2) all in — post-lease-only
  retired-lineage clearing; startup replay skips secret-mat_ (ciphertext
  would hit user paths); pulled projections advance
  settle_seq/last_settled_sha; close-drain projects the merged head;
  compacted-base redelivery resumes; recordUpdate holds an OWNED
  session_ops guard through its spawned task (closes CR's interleave AND
  codex's close-race in one mechanism); portable fault-injection
  settle-replay test (MaterializeAfterJobCommit leaves the same durable
  state as a transient replace failure).
- **#218 still at round 15** (d8101e8c) awaiting codex.
- Round-16 reviewer quality note: findings are now exclusively about code
  added in rounds 13-15 (the materialization parity work); nothing about
  the original port in 4+ rounds.

## LIVE ADDENDUM (2026-07-22 ~14:00Z — superseded above)

- **#218 at round 15** (d8101e8c, gate PASS, pushed+replied+re-tagged):
  bookmark destinations require Tracked (secret paths refuse,
  mutation-verified); identity + enqueue-eligibility P2s declined via the
  standing main-process-trust posture (3rd/4th occurrences). CR resolved
  and APPROVED twice.
- **#220 at round 15** (396204b8, gate PASS after a clippy type-alias
  amend, pushed+replied+re-tagged): codex r14's five all in —
  multi-sha ORDERED suppression (coalesced-consume/mismatch-clear/
  targeted-retract, unit mutation-verified); default close retries once
  after ydoc-remote-updates-pending (close is final → converged doc IS
  the artifact); retired LOCAL-ONLY docs reopen absent (clear stale cache;
  never-settled drafts and replicated lineages excluded); prune-close
  refuses on pending ydoc-mat_ job (+ distinct ydoc-unsettled-close wire
  reason); close-task reinserts only on genuine refusals (teardown races
  no longer resurrect leases). LATENT BUG found by the H4 mutation probe:
  the r13 hoisted replay ran COMPLETED jobs (settle died pre-commit on a
  locked-target read) — replay now PENDING-only.
- Both PRs: CR-approved; codex rounds now exclusively refine THIS PR's new
  code. Merge on the first quiet codex pass.

## LIVE ADDENDUM (2026-07-22 ~12:50Z — superseded above)

- **#218 round 14 PUSHED** (a05d2467, gate PASS, CR resolved+APPROVED
  twice): cancellation-aware startup reclaim + 3 SUMMARY fixes; 3 CR
  oracle-parity declines (opening-message ordering :622/:876/:2625;
  enqueue validation re-raise; identity-less markReady :4068/:4098).
  Awaiting codex r14.
- **#220 round 14 COMMITTED** (d1cac16c, gate running): codex r13 all
  five in — has_pending_dependencies gates pulled projections; base claim
  projects load_persisted+base (promotion keeps local rows,
  mutation-verified); recordUpdate + first_update_pending in a spawned
  task (dropped-reply seed quarantine); open-time replay Conflict arm
  NULLs last_settled via the job's moment coords; loopback resync keeps
  eventSeq monotonic.
- **NUL-byte gotcha**: bash-heredoc python writing Rust string escapes can
  land RAW 0x00 bytes in source (file reads as binary; rustc accepts!).
  b'\\x00' inside heredocs is unreliable — construct bytes([0]) instead;
  scan crates for NULs if `grep` starts saying "Binary file matches".

## LIVE ADDENDUM (2026-07-22 ~11:30Z — superseded above)

- **Round 12 pushed on both; round 13 committed, gates running.** CR
  APPROVED #218 (r12) + resolved. Codex r12 was heavy on #220 (4 P1+2 P2 —
  all six implemented in r13): pulled ydoc envelopes now MATERIALIZE
  (oracle projectYDocUpdate parity: identity-pinned in-tx projection write
  + job; drain-before-project); workspace.open replays pending jobs
  pre-watcher (startup replay was ASPIRATIONAL — run_pending_jobs had no
  production caller until now); claim_base refuses divergent bases
  (BaseStateDiverged, unacked); prune-close clears last_settled_sha
  (pruned-reseed wedge); take-before-spawn close; ydoc heads retire on
  disk-driven deletes (YDOC_ORIGIN in the gate); suppression
  process-global. #218 r13: global runId-taken refusal (oracle MINTS ids;
  our wire keeps caller ids for rehydration → clean refusal instead of
  UNIQUE violation); chat idempotency sentinel result_seq=-1 (codex's
  rollback-purge premise was FALSE — orders start at 1 — but the sentinel
  was convention-fragile); identity P1 re-declined via standing posture.
- **NEW GOTCHA codified in memory: NEVER `git checkout <file>` to revert a
  mutation** — it reverts to the last commit and destroys the round's
  uncommitted work (lost+rebuilt F4 once). Revert mutations by replacing
  the mutated lines back.
- Facts for RPC-D/replies: versionedText.write is DB-ONLY today (no
  materialization job; disk delivery is RPC-D scope); one rootDir binds
  ONE workspace at the RPC layer.

## LIVE ADDENDUM (2026-07-22 ~10:10Z — superseded above)

- **Round 11 pushed+replied+re-tagged on both PRs; round 12 committed,
  gates running.** RPC-D design v2 has ZERO open questions (all three
  closed oracle-verified: compareVersionFiles shape; same-key proven by
  forkVersion's verbatim-copy AAD comment; setActive lease-free — DROP its
  v2 §c lease row). Build brief drafted (scratchpad/rpcd-build-brief.md).
- **#218 round 12** (3353f0ab): codex r11 — reclaim UPDATE workspace-scoped
  (NOTE: idx_agent_run_records_run_id makes run ids globally UNIQUE, the
  collision is structurally unreachable — scoped for symmetry; no test
  possible, the fixture hits the UNIQUE constraint); markReady refuses
  generations > MAX_SAFE_INTEGER; claim command/logPath reject explicit
  null (non-null deserializers). DECLINED with citations: per-label
  bookmark error codes (oracle normalizeFeedIdentity hardcodes
  invalid-follow-target for ALL labels, :794-803); send_message thread-id
  normalization (oracle sendMessage uses RAW threadId, :2751-2754).
  Wire-backfill journaling gap (ensureGeneral backfill not relay-visible)
  DECLINED as oracle-parity but OWED: record as cross-engine obligation in
  RPC_GAP on the next integrator pass. CR r11 CHANGES_REQUESTED handled in
  the same round (SUMMARY.md file-linked reads added; perf + truncation
  flags acknowledged-only).
- **#220 round 12** (74875652): codex r11 all four in — expected_key gates
  the open drain (probe key threaded; foreign-key drains impossible);
  idempotent settles verify ownership (rebind-with-identical-bytes test
  via domain rename + capture disambiguation); pending-job replay hoisted
  before BOTH settle branches (changed-projection-after-transient-failure
  windows test); close take→reinsert in a spawned task (cancellation-safe
  by construction; sessions behind Arc). All mutation-verified.
- RPC-level lesson: one rootDir binds ONE workspace ("workspace root is
  already bound"), so cross-workspace-same-store states are only
  constructible at the domain level; and versionedText.write on a BOUND
  path follows the existing alias (caller objectId ignored) — rebind
  fixtures need domain rename + capture's disambiguated mint.

## LIVE ADDENDUM (2026-07-22 ~08:40Z — superseded above)

- **#218 round 11 committed** (6a8286fe, gate running): codex r10's three
  P2s — bookmarks.list optional state filter (active/archived, invalid
  refuses); claimNextPending omitted command = oracle's EMPTY string
  (whitespace preserved verbatim; only NUL + length cap refuse); bookmark
  destinations now clear the CANONICAL Check-A floor
  (classify_engine_file_path_normalized: iterative %25/%2e/%2f/%5c decode
  until stable, full reserved/ignored set, NORMALIZED path persists — my
  earlier "verbatim" decline was wrong for percent DISGUISES, which the old
  substring-".." check never saw). review_round_11 test, 3 mutation checks.
- **#220 round 11 committed** (693f4e97, gate running): codex r10 — (1)
  absent-path open refuses ydoc-object-alias-collision when the derived id
  is LIVE at another alias (capture mints order-disambiguated ids for that
  rename edge; open can't reserve one pre-commit); (2) transient
  materialize failure now leaves the CRASH-CONSISTENT state (committed
  marker + pending job, startup replay via run_pending_jobs) instead of
  prior-marker rollback that wedged every retry in ConflictStaleTarget —
  retry flows through the idempotent no-op branch which replays the job
  (windows-only exclusive-lock test proves fail→unlock→retry→disk); (3)
  client seed-failure cleanup escalates close settle:false→settle:true when
  refused (committed seed), no more orphaned daemon session. 3 tests, all
  mutation-verified (incl. TS).

## LIVE ADDENDUM (2026-07-22 ~08:00Z — superseded above)

- **#218 round 10, #220 round 10** — gates PASS, re-tagged. #218's r9
  was TWO normalization nits (implemented directly, no codex run) —
  convergence near. #220's r9 was the dropped-future batch: guarded
  one-tx seeds (retry DEDUPES), durable-derived settle expectations,
  entry-held closes, per-(workspace,object) leases, pending-only
  manifest filter, ydoc-remote-updates-pending as a distinct wire signal
  with client resync+retry.
- **RPC-D design v1 adversarially reviewed: REVISE** — 4 P0s (no lease
  ruling; versionId missing everywhere; write caps not wire-reachable —
  daemon rejects BlobStart ingest, 48 KiB in-band is the real bound;
  undecodable mutation responses need paging + refuse-before-commit),
  P1s incl. secret apply/restore = verbatim ciphertext copy (NO
  requestId, whole-version compare), write-lane-reentry cannot exist,
  origins write-reject capture+ydoc. All six open questions ANSWERED
  (binary entries {path,status,binary:true}; apply=sync restore=restore;
  momentId collisions reject; createNamed+fork one atomic tx). Design v2
  being drafted by the design agent with the full review folded in.

## LIVE ADDENDUM (2026-07-22 ~06:40Z — superseded above)

- **#218 round 8, #220 round 8** — both gates PASS, both re-tagged.
  Codex finding trajectory narrowing (218: 9→4→6→4 P2-nits; 220:
  8→10P1-heavy→6→5→8 P2/P3-only). Notable #220 corrections this stretch:
  settles refuse over-cap PRE-COMMIT (Option-markdown response reverted —
  frozen client decoder demands string); stale-head guard precedes the
  idempotent no-op; materialize-ERROR compensation; suppression TAKE on
  every Changed; capture manifest rehydrates ydoc heads; per-session
  expected-head sha (open-time, replaced by own settles). #218 landed:
  relay-owner-gated follow/feed journaling, core chat op journaling,
  hydrated ChatFeedItems, full bookmark lifecycle, getWireId precheck,
  replicated-id bounds (budget test rebuilt on big BODIES — 60 KiB ids
  now impossible).
- RPC-D design v1 drafted (scratchpad/rpcd-design-v1.md, opus): 25+
  contracts, 26 mutation-paired test obligations, 6 open questions
  (createNamed↔secret-fork atomicity recommended single actor command;
  origin decisions). Next: adversarial review after B/C merge.
- Client baseline PRESERVED across resync now (reset made post-resync
  gaps undetectable); dead resetEventBaseline removed.

## LIVE ADDENDUM (2026-07-22 ~05:10Z — superseded above)

- **#219 MERGED** (a2b6814a, 21:04:23Z, 16 rounds: CR APPROVED + Codex
  "no major issues" at 4dce3db1). Branch codex/rust-engine-int-rpca
  deleted+verified. SHARDS/RPC_GAP/BEHAVIOR_INVENTORY on main now carry:
  honest partial-split RPC-A rows, gated RPC-B2/C/D behavior sets (B2=39
  rows incl. desktop wrapper paths), the 48 KiB in-band cap wording, the
  R15 destructive-cutover policy, the PENDING-#220 labels, and the
  STANDING IDENTITY POSTURE note (chats identity params sit in main's
  trust position; socket is shadow-fence authed) that #218 declines cite.
- **#218 at round 5→6**: codex r5 fixes landed (359-byte cursor budget +
  encoded backstop; bookmark workspaceId; idempotent same-runId claim
  rehydration; follow/feed ops now relay-visible in replication_log with
  distinct seqs). Gate r6 running; round-6 push will DECLINE the
  identity P1 citing the posture note.
- **#220 at round 5** (259122cc): codex r4's eight (6 P1) in; awaiting
  next codex pass. CR APPROVED.
- Scratch-flake lesson: killed gates strand dohc-cal1-* dirs; PID reuse
  then collides ScratchDir::new (fail-loudly by design). PRE-CLEAN
  %TEMP%/dohc-cal1-* before every gate — the convention exists for this.

## LIVE ADDENDUM (2026-07-22 ~04:30Z — superseded above)

- **#220 (RPC-C) round 4** (26b95d11, gate PASS): codex r3's ten (4 P1)
  in — one durable-state predicate (updates OR snapshots) drives settle
  refusal + open lineage; drain-before-project; live replicated edits
  journal ydoc.update IN-TX (journal_local_op_in_tx + creating-marker
  post-append hook); ydoc.apply refuses busy under a live lease;
  suppression records pre-replace with retract on conflict; untouched
  sessions close settle-free; process-wide lease registry; deferred rows
  FK CASCADE; fresh-token close after settle.
- **#218 (RPC-B) round 5** (05be3598, gate PASS): codex r4's four in —
  opaque headCursor markSeen returning ChatFeedReadState; server-derived
  follow origins (forged origins = unknown-field reject; TS ChatFollow
  shape with workspaceId); claim command/logPath validation; message-id
  256-char cursor cap on send + thread start.
- **#219 round 12** (b406c8ee): RPC-A's set is now fully partial-split
  (rpc-a-read-text-inband/read-binary-inband/list-text-files-metadata-
  only/versions-active-id-only/moments-inband); full contract IDs live
  only in RPC-D; wire-limit paragraph states the 48 KiB in-band cap; B2
  owns the desktop dispatch wrapper paths.
- Codex severed-attribute gotcha: inserting a fn ABOVE an existing
  #[allow]-annotated fn leaves the attribute on the new fn — clippy
  flags the old one. Check attribute adjacency when inserting.

## LIVE ADDENDUM (2026-07-22 ~04:00Z — superseded above)

- **#220 (RPC-C) round 3** (head 9831e829, gate PASS, 22/22 vitest):
  codex r2 (3 P1 + 5 P2) + CodeRabbit r1 (2) all in — settle-marker
  compensation on materialize conflict; close defaults to SETTLE with
  richdoc default-close persisting CRDT (persist-closed-state);
  ydoc_deferred_updates table (migration ordinal 12) for exact-coordinate
  drains; defer admission refuses non-replicated lineages unacked;
  eviction only after close owns teardown; actorOriginId persisted
  (record_local_update_with_origin); client marks dropped-while-stale on
  gap/generation during the resync window.
- **#218 (RPC-B) round 4** (head f79eaf8d, gate PASS): codex r3's nine
  findings in — derived bookmark ids (sha256/base32 + hardcoded vector),
  ownership clears, monotonic follow LWW, feed byte budget, snippet
  display titles, __thread__/wire-id guards + INSERT OR IGNORE parity,
  failure-reason bounds, full {dispatch, run} claim.
- **#219 (integrator docs) round 10** (head 3d5a3b7d): CR APPROVED at r4;
  codex audit converging (13→7→6→7→6 findings/round). RPC-A partial
  contracts are now their own inventory rows; RPC-D owns search runtime
  paths + bridgeContract ydoc-origin widening; RPC-C pr=220.
- **Gate ops lesson**: killing a detached gate leaves orphan cargo
  children sharing the target dir — the NEXT gate can fail spuriously
  (r4c). Verify orphans exited (Get-Process cargo,rustc) before
  relaunch; a clean rerun (r4d) PASSED.
- RPC-D design inputs sweep saved (scratchpad/rpcd-design-inputs.md):
  moment ids are RANDOM UUIDs (no fingerprint scheme); origin closed
  5-set with "ydoc" delta recorded; write_projected arrives with RPC-C;
  secret compare/apply/restore + read_binary_blob + blob-stream pump are
  the new-domain items; TS-CONFIRMED delete gate + rename coordination
  are desktop-side.

## LIVE ADDENDUM (2026-07-22 ~03:00Z — superseded above)

- **#220 (RPC-C) OPEN at round 2** (head 25122448, gate PASS, 22/22
  client vitest): opus adversarial pre-review found P0 empty-lineage
  settle clobber (fixed+mutation-verified), P1 drain-on-open, P1 atomic
  settle marker; strengthening the resync assertion exposed the
  pruned-reopen flow bug (lineage now reports durable DOC STATE).
  Codex round-1 (3 P1 + 2 P2) all implemented: committed settles run to
  completion, owner-change ConflictStaleTarget refusal
  (mutation-verified), blob validation before defer-ack, teardown-ordered
  suppression clear, client resync-window re-resync (mutation-verified).
- **#218 (RPC-B) at round 3** (head bd1bea1e, gate PASS): codex round-2
  brought 7 findings; verification sweep proved my round-2 enqueue
  decline WRONG (owned publicly in-thread) — write-time chat FTS,
  enqueue conflict surfacing, channel-write tokens, runId trim,
  read-state sanity all implemented; 2 parity declines (wire ids,
  bookmark paths) with dual-side citations.
- **#219 (integrator docs) at round 6** (head 16d490d7): CodeRabbit
  APPROVED (r4); codex ran four deepening membership audits — SHARDS
  behavior sets now enumerate the full gated surface (RPC-B2 packet: 36
  rows; RPC-D: 21 rows incl. streaming/parity obligations), RPC_GAP
  current (dispatched-today list, R15 destructive-cutover policy
  callout).
- **RPC-D design-inputs sweep launched** (TS oracle contracts for the
  mutating surface; feeds the design doc → adversarial review → codex
  build once B/C merge).
- Reply drafts live in scratchpad (pr218-r2-comment.md posted; rpcc-pr-body.md).

## LIVE ADDENDUM (2026-07-22 ~02:15Z — superseded by the ~03:00Z addendum above)

- **#217 (RPC-A) MERGED** after 19 rounds; branch deleted+verified. Final
  rounds: verbatim-resolution correction (store keeps RAW path spellings;
  classify-via-normalization but query verbatim), measured
  byte_budget_cut_serialized, Codex-caught phantom edit landed for real in
  r19 with grep-verification (rule codified in memory).
- **#218 (RPC-B) OPEN, round 2 in flight**: CodeRabbit quiet ("no
  actionable comments"); Codex round-1 triage complete — 7 implements
  briefed in C:/w/rpcb/RPC_B_FIXES.md (reclaim moved into workspace.open;
  token entry-checks; followability validation; page-level
  readState/headCursor; markReady guarded transition; runId bounds;
  channel counts) + 2 evidence-cited declines (author attribution derives
  in main which IS the daemon's DOP1 client, main.ts:5215-5225; enqueue
  cross-validation absent in TS recordTrigger too,
  agentDispatchStore.ts:463-485). Codex fix run in flight; staged reply at
  scratchpad/pr218-r1-comment.md.
- **#219 (integrator docs) OPEN**: CodeRabbit was rate-limited 17:29Z;
  review re-requested 2026-07-22 ~02:00Z.
- **RPC-C BUILT** (codex, C:/w/rpcc, branch codex/rust-engine-rpc-c,
  based on merged RPC-A): ydoc.open/recordUpdate/settle/close/resync +
  applyExternalMarkdownEdit refusal (C1), lease registry + LeaseProbe
  sync seam, daemon-side (workspace,path,sha) capture suppression,
  AtomicU64 session generation, moment-minting settle via domain write.
  Client seed/resync path touched (ydocLiveAdapter/LoopbackEngine + new
  @dohc/ydoc-projection dep; ydocWireContract.ts UNCHANGED). TS side
  verified green (tsc clean, 21/21 vitest). Two inference fixes +
  clippy allow applied by orchestrator; full gate re-running. Next:
  adversarial review -> PR.
- Gate note: run-rust-checks.mjs on a detached process + Monitor
  staleness watchdog (10-min Bash cap can kill cold-build gates).

## LIVE ADDENDUM (2026-07-21 ~15:35Z — superseded by the 02:15Z addendum above)

- **#215 MERGED** (126d79eb) · **#216 MERGED** (13:10:46Z, integrator +
  final GATE6 artifact: FIFTH 30-min PASS 2026-07-21T12:44:01Z, all
  assertion keys self-naming, five-run slope series 12.5/13.5/13.0/13.7/
  13.2 KiB/s). Branches deleted+verified.
- **#217 (RPC-A) at ROUND 14** (head bf9ed6e9, every gate PASS). The
  review arc: wire-limit design (rounds 1-3, opus adversarial caught it)
  -> failure paths (4-8) -> oracle-parity corrections (9-11: my
  moments-payload decline was WRONG — momentSelectSql joins blobs; owned
  publicly; write paths now RE-READ their own moments; schema gap
  payload_before_*/before-identity recorded as pre-R15 obligation) ->
  one-turn atomic caps (12-14: cap decided INSIDE each actor turn's SQL;
  get_snapshot_meta so head resolution can't hydrate; both-guards CASE
  vs corrupt rows; single cap constant pinned by const assertion; hard
  700 KiB single-row bound with explicit refusal).
- **RPC-B**: implemented+gated in C:/w/rpcb (stacked on rpca@6a9dc3e0 —
  STALE, rebase onto RPC-A's final; adopt byte_budget_cut_serialized in
  its five call sites + the SINGLE_ROW_HARD_CAP refusal). Adversarial
  review P1 (messages.list byte-cut) fixed+tested; cross-workspace
  domain test added.
- **Ice decision list now SIX items** (gate6-packet-draft.md): secret
  ownership column + moments payload-provenance schema gap (RECOMMEND one
  pre-R15 migration PR for both), macOS path, RPC-E scope, richdoc at
  cutover, R15 go/no-go.
- Session lesson added: python replace-scripts must WRITE INCREMENTALLY
  (an assert after edits loses everything before it) and never marker-
  round-trip substrings that occur in identifiers (49152/CAP corrupted
  CAPTURE_ORIGIN; caught by compile).

## LIVE ADDENDUM (2026-07-21 ~12:00Z — superseded by the 15:35Z addendum above)

State at ~12:00Z (supersedes the 09:35Z addendum below where they differ):

- **#215 MERGED** (squash 126d79eb, 9 rounds); branch deleted+verified.
- **#216**: rebased onto main; carries the E integrator note, SHARDS E-done,
  RPC_GAP (r3 fixes + wire-limit obligation + file-linked-chats RPC-B2
  obligation + moments payload split), the runner assertion-key rename
  (handlesWithinRecordedSlack), and the FINAL GATE6 artifact
  (2026-07-21T11:52:08Z PASS — FOURTH consistent warmup-shaped run,
  12.5/13.5/13.0/13.7 KiB/s). Both bots re-tagged after the force-push.
- **#217 (RPC-A)**: round 5 staged (gate running): read_binary_meta
  (over-cap reads never hydrate), spawn_blocking key IO, measured-
  serialization byte budgets on ALL list families (JSON-escape-proof),
  keyless secret-path gate, versions.list budget, -1 sentinel, every-page
  version refusal. Rounds 1-4 story: opus adversarial caught the wire-limit
  design flaw; bots deepened it; all addressed.
- **RPC-B (C:/w/rpcb, stacked on rpca@6a9dc3e0)**: codex-implemented
  (23 methods), FULL GATE PASS, adversarial review's P1 fixed
  (messages.list byte-cut + test), cross-workspace domain test added.
  NEEDS: rebase onto RPC-A's final head (expect byte_budget_cut helper
  conflict — rpca r5 renamed it byte_budget_cut_serialized with measured
  sizes; adopt that in rpcb's five call sites), regate, PR.
- Program queue after the two PRs merge: RPC-C (design v2 in scratchpad,
  adversarially reviewed) -> RPC-D -> GATE6 packet (draft in scratchpad;
  stats banked) -> macOS (drafts in scratchpad) -> R15 package (ICE STOP).

## LIVE ADDENDUM (2026-07-21 ~09:35Z — the executing session updates this in place)

Position now (supersedes §3/§4 below where they conflict):

- **#215** at ROUND 8, head `e9e98034`, all gates PASS. CodeRabbit APPROVED
  at r3 (its later r7/r8 findings were COMMENTED — the quick-exit-code and
  quarantine-test items, both addressed). Codex rounds 3–8 each had real
  findings, each fixed same-round with gate + a 3-min `--quick` smoke
  before every push (the smoke caught two of my own fix bugs: a DOP1
  64 KiB string-limit trip and a consumed-oneshot double-await). Awaiting
  Codex on r8; when both quiet → merge (squash), delete branch, verify.
- **#216**: RPC_GAP r3 fixes applied in worktree (uncommitted); the soak
  artifact will be REGENERATED with the settled runner (one final 30-min
  run) before its round pushes — see scratchpad `log-amendment-plan.md`
  and `pr216-comment.md` (session scratchpad:
  `%LOCALAPPDATA%/Temp/claude/C--Users-ice-dev-dohc/68936c26-*/scratchpad`).
- **Soak**: two independent 30-min PASS runs banked as reproducibility
  signal (v2 12.5 KiB/s, v4 13.5 KiB/s, both warmup-shaped, handles +2).
  The BANKED artifact comes from the final run on the settled runner.
- **RPC-A**: rebase DE-RISKED — `temp-rebase-test` branch in C:/w/rpca
  holds RPC-A rebased onto #215 r7 (one dispatch conflict, resolved, cargo
  check clean). PR body draft in scratchpad `rpca-pr-body.md`.
- **RPC-C**: design v2 in scratchpad `rpcc-design-v2.md` — adversarially
  reviewed (opus; 1 P0 + 5 P1 + 4 P2, all incorporated): C1 refuses
  applyExternalMarkdownEdit live (client/server doc divergence hole),
  settle = ONE domain moment-minting path (moment_order namespace, never
  collab settle_seq), daemon-side lastSettledSha suppression (settle→
  capture re-ingest loop), open returns lineage+seedMarkdown (client
  seeds; server guard refuses seed-onto-existing-head), no in-memory
  LiveDoc in C1, no idempotency ledger (content-dedup returns original
  seq). RICHDOC AT CUTOVER is an Ice decision (Rust projection is a
  paragraphs subset): port full-fidelity (recommended) / disable / dual-
  engine (not recommended). Inputs digest: `rpcc-design-inputs.md`.
- **GATE6 packet**: skeleton in scratchpad `gate6-packet-draft.md`; stats
  banked (39 merged PRs, 372 review events: 95 CodeRabbit/121 Codex, 203
  commits; per-PR table `gate6-review-stats.tsv`); migration ledger
  ordinals 0–11; R15-REHEARSE re-verifies via every gate's cargo test.
- **macOS**: both paths DRAFTED in scratchpad `macos-prep/` (dispatchable
  workflow + Ice-run script); runner sampling now has a real macOS impl
  (ps/lsof) as of r5.
- **E integrator note**: draft in scratchpad `e-integrator-note-draft.md`.

Session lessons (beyond §7): run a 3-min `--quick` soak smoke before every
runner-affecting push; stop each gate watchdog in the same action that
processes its result; python edits on repo files need newline='' (a default
round-trip converts the file to CRLF — git checkout restores); fmt BEFORE
gating, always.

---

## 0. THE KICKOFF PROMPT (paste verbatim as the opening message)

> You are taking over the dohc Rust engine rewrite — a multi-week program
> replacing the TypeScript workspace engine with a Rust daemon, built
> dormant/shadow-only, merged to `main` incrementally, with an atomic cutover
> at the end. Repo: `C:/Users/ice/dev/dohc`.
>
> Read `docs/superpowers/plans/rust-engine/SESSION_HANDOFF.md` first, in
> full — it is your complete brief, current to the hour. Then read the tail
> of `EXECUTION_LOG.md`, `SHARDS.tsv`, `RPC_GAP.md` (same directory), and
> your auto-memory index.
>
> Your job: **finish the program 100%** — drive every remaining item in the
> handoff's roadmap through the established review→merge workflow, keep
> going without stopping, and do not wait for me between items. The single
> exception: executing the R15 cutover itself resets my dogfood data, so
> when everything for R15 is prepared and verified, present the go/no-go
> package compactly and get my one-word confirmation before flipping it.
> Everything else — all fixes, reviews, merges, new shards, GATE6 assembly,
> and the full R15 preparation — is yours to complete autonomously.
>
> You must be running as fable-5. If you are not, stop immediately and tell
> me. Follow the workflow conventions in the handoff exactly — the full
> gate on every push, ≤2 concurrent Rust builds, watchdogs on everything
> that can silently stall, mutation-verify supervision-grade logic, and
> adversarial review before every PR.

---

## 1. Mission and definition of 100%

Done means ALL of:

1. **PRs #215 and #216 merged** (findings addressed, both bots quiet,
   remote branches deleted + verified gone).
2. **RPC growth complete per `RPC_GAP.md`**: RPC-A (done on branch) merged;
   RPC-B (chats) built+merged; RPC-C (ydoc session protocol) built+merged;
   RPC-D (mutating text/version surface) built+merged. RPC-E
   (replication/relay) is scoped WITH Ice as part of the R15 package.
3. **GATE6 evidence packet** assembled in `EXECUTION_LOG.md`: corrected
   soak artifact (banked, §3), differential results, review-history stats,
   migration-ledger state, and the open decisions surfaced (§8).
4. **macOS build + smoke evidence** — cannot run on this Windows host;
   prepare both paths (CI runner / Ice-run script) and present.
5. **R15 prepared end-to-end**: cutover rehearsal re-verified on current
   `main` (R15-REHEARSE machinery exists, gate-passed), desktop adapter
   flag path validated (`DOHC_RUST_ENGINE_ADAPTER`), go/no-go package
   written (scope, dogfood-reset consequence, ≥2-week dogfood plan,
   member-share-log-across-epoch-reset semantics, macOS status). STOP for
   Ice's one-word go; on go, execute, verify, record.
6. Every merged shard has its integrator note + SHARDS.tsv row current; a
   final EXECUTION_LOG entry declares the program complete.

## 2. HARD RULES (from Ice directly; non-negotiable)

- **fable-5 always.** On context overflow: compact and stay on fable-5. If
  the session is not fable-5 (check the environment block and the
  commit-trailer instruction): STOP substantive work and tell Ice. If
  another model did interim work, retro-review it as fable-5 before
  building on it. (Memory: `orchestrator-model-fable5`.)
- **Full-workspace gate on every pushed head**:
  `node tools/rust-engine-program/run-rust-checks.mjs` with
  `CARGO_TARGET_DIR=C:/w/_targets/<worktree>` `CARGO_BUILD_JOBS=4`. Verify
  the PASS verdict line explicitly — never chain a push behind grep exit
  codes. Clean `%TEMP%/dohc-cal1-*` before runs.
- **≤2 concurrent Rust builds** (a prior session OOM-crashed the machine).
  In practice: one gate at a time.
- **Watchdog everything long-running** (gates, soaks, bot reviews): Monitor
  loops whose filters catch FAILURE signatures, not just success. Never sit
  blind. (Memory: `rust-gate-stall-watchdog`.)
- Never push on a failed/unverified gate; never skip hooks.
- After every merge: delete the remote branch and VERIFY it is gone.

## 3. Exact position (2026-07-21 ~05:50Z)

**Merged this phase:** FCOMP A(#204) B(#205) B-binary(#208) B-secret(#210)
C(#212 — the capture OWNERSHIP model, 9 rounds) D(#214 — supervision +
one-word status, 12 rounds), docs #213. Earlier program (R00–R14,
GATE-COMPLETE, R15-REHEARSE, YRS-ABORT-SAFETY): merged, see SHARDS.tsv.

**Open PRs:**
- **#215 (E shard)** — `watcher.status` + `capture.flush`, the TS-vs-Rust
  capture differential (10 scenarios, committed goldens, tamper-verified),
  shadow-scope acceptance, the cutoverBlocking SOAK RUNNER. Branch
  `codex/rust-engine-fcomp-e-differential`, worktree `C:/w/fcompE`; head =
  round 2 + evidence-format commit; gate PASS `2026-07-21T05:34:19.979Z`.
  OUTSTANDING: CodeRabbit's 04:32Z review (1 actionable) predates round 2
  and was NEVER READ — fetch (`gh api .../pulls/215/reviews`, the body) and
  disposition; ensure Codex reviewed the current head; then both quiet →
  merge.
- **#216 (D integrator note + soak evidence + RPC_GAP.md)** — branch
  `codex/rust-engine-int-d`, worktree `C:/w/intC`. OUTSTANDING: Codex r3's
  five RPC_GAP wording fixes (§5) — apply, push, re-tag; then quiet →
  merge.

**Ready, unpushed:** **RPC-A** at `a282f700` on `codex/rust-engine-rpc-a`
(worktree `C:/w/rpca`, stacked on the #215 branch), gate PASS
`2026-07-21T05:12:31.311Z`. Eight read-surface RPCs (versions.active/list,
versionedText.list, versionedBinary.read w/ text-head refusal,
moments.list/get, secrets.list keyless, secrets.materialize w/ key custody
posture) + end-to-end acceptance test. After #215 merges: rebase onto
`origin/main` (`git rebase --onto origin/main <old-E-head>`), re-gate,
push, open PR, review loop.

**Banked GATE6 artifacts:**
- Corrected soak v2:
  `2026-07-21T05:06:40Z | soak-cutoverBlocking | windows/x86_64 | PASS | cycles=7771 crashes=83 durationSecs=1805 rssSlopeB/s=12497.7 handles 110->112 threads 38->37`
  — series committed at
  `tools/rust-engine-program/soak-evidence/2026-07-21-cutoverBlocking.json`
  (on the #216 branch). Curve decelerates 26.0→4.9 KiB/s (warmup-shaped).
  Disposition: **PASS-WITH-FLAG** (memory monitored through dogfood) —
  never an unconditional leak-freedom claim. The v1 run is WITHDRAWN
  (vacuous slope) — do not cite it.
- Differential: 10/10 scenarios green on both engines; tamper-check proves
  the compare is real.

**Worktrees:** `C:/w/fcompE` (#215) · `C:/w/intC` (#216) · `C:/w/rpca`
(RPC-A) · `C:/w/fcompC` `C:/w/fcompD` (merged; keep until program end).
Targets: `C:/w/_targets/<name>`. Never check out `main` in the main repo
dir (another worktree holds it — use `git -C` push/fetch there).

## 4. Immediate actions, in order

1. **#216**: apply §5, commit, push, `@codex review`; both quiet → merge
   (squash), delete branch, verify.
2. **#215**: read+disposition CodeRabbit's 04:32Z actionable; re-tag Codex
   if >30 min quiet on the current head; CodeRabbit per the rate-limit
   dance (§7); both quiet → merge, delete, verify.
3. **E integrator note** (EXECUTION_LOG entry + SHARDS FCOMP row → E done)
   via docs PR — include differential + soak-runner story + final gate line.
4. **RPC-A**: rebase → gate → push → PR → review loop → merge → note.
5. **RPC-B → RPC-C → RPC-D** (§6), each through the full workflow.
6. **GATE6 packet → macOS → R15 prep** (§1.3–1.5, §8).

## 5. The five open RPC_GAP.md fixes (Codex r3 on #216)

1. `versions.active`: note TS `getActiveVersion` returns a full
   `VersionRecord | null`; RPC-A ships id-only — record the delta (full
   record via `versions.list` join, or extend in RPC-D).
2. Secret compare/restore row: soften to "partially exists — VERIFY per
   slice" (branch-state line numbers overclaimed vs main).
3. Mark `watcher.status`/`capture.flush` rows "(lands with #215)".
4. Chats row: R09 scoped reactions/decisions/attachment/mention indexing
   only PARTIALLY — soften "complete domain"; verify per method before
   RPC-B estimates.
5. Evidence-disposition comment: already addressed (PASS-WITH-FLAG note +
   runner tolerances/`rssDisposition`) — reply-and-point only.

## 6. Remaining build shards

- **RPC-B — chats.** Expose R09's `LinkedChatStore`
  (`crates/dohc-engine-domain/src/chats.rs`) via actor passthroughs +
  dispatch arms: channels, threads, messages/send, read-state, follows,
  feed, bookmarks, reactions, mentions, decisions, dispatch queue. VERIFY
  each method exists Rust-side first (§5.4). Largest surface, mechanical;
  copy RPC-A's acceptance-test style (state via real writes, never
  seeded). Desktop call sites: RPC_GAP.md + `apps/desktop/src/main.ts`,
  `cli/cliServer.ts`, `agents/*`.
- **RPC-C — ydoc session protocol.** The dormant adapter speaks
  `ydoc.open/recordUpdate/settle/applyExternalMarkdownEdit/close/resync` +
  `ydoc.remoteUpdate` events. Contract:
  `packages/workspace-engine-client/src/ydoc/ydocWireContract.ts`; TS
  semantics to port: `apps/desktop/src/collab/ydocLoopbackEngine.ts`.
  Build daemon-side over `ydoc.apply` + `dohc-engine-collab`. CONSTRAINT
  (in RPC_GAP): server-side Y.Doc is CANONICAL; session/markdown APIs are
  projections. The one remaining piece of real design work — plan first,
  adversarially review the plan, then build. Needs the DOP1 EVENT side
  (daemon→client): `Envelope::Event` exists in the wire contract but has
  no daemon producer yet.
- **RPC-D — mutating surface.** rename/delete/rollback text, compare/merge
  versions, create/fork/set-active version, secret write/delete via RPC.
  Ownership-model interaction: RPC writes carry real origins (`api`),
  never the reserved `capture`; forks carry secrets
  (`secrets.rs fork_version`).
- **RPC-E — replication/relay.** Scope with Ice at R15
  (`docs/architecture/backend-modes.md`).

Standing contract for every slice (in RPC_GAP): authz + workspace scoping
derived SERVER-SIDE from the daemon's handle table under the authenticated
DOP1 session.

## 7. The workflow (proven across ~25 merged shards)

Per shard: worktree off the right base → implement with tests → full gate →
commit (gate evidence line in the message) → push → PR (body carries the
design narrative, review history, gate line) → independent adversarial
Claude review (opus subagent; you judge as fable-5) before or immediately
after opening → CodeRabbit + Codex rounds until BOTH quiet — reply to every
round on the PR, `@codex review` after each fix push, disposition declines
WITH reasoning (TS-parity arguments have repeatedly been accepted) → merge
(squash, `R##-X: title (#PR)`) → delete remote branch + verify → integrator
note + SHARDS row via docs PR.

Mechanics learned the hard way:
- **CodeRabbit rate-limits**: it ACKS with a comment whose body says
  "Review limit reached / next review available in N min" and does nothing
  else. Read the BODY, arm a background sleep+re-request timer, make
  watchdogs grep for "Review limit". `@coderabbitai review` NO-OPS on
  already-reviewed commits ("Review finished" = zero-actionable pass; a
  stale CHANGES_REQUESTED verdict object may linger — `@coderabbitai
  resolve` + merge on substance). (Memory: `coderabbit-rate-limit`.)
- **Codex** re-reviews only when tagged; its inline comments RE-ANCHOR onto
  new heads — filter by `created_at`, never `commit_id`. It found real
  defects in 7 consecutive rounds on D; treat findings as real until shown
  otherwise.
- **Mutation-verify** supervision/consistency logic: restore the bug, prove
  a test fails. True-by-construction tests (asserting one layer below the
  defect; fakes with fidelity gaps) were THE recurring failure mode. The
  `DriverEnv` seam + paused-time loop tests in `capture_driver.rs` are the
  pattern; `#[tokio::test(start_paused = true)]` + tokio `test-util`.
- **Scripted edits**: `assert old in s` on EVERY replacement, grep-verify
  after — two silent no-op edits shipped real gaps this program. No inline
  python heredocs (quoting breaks); write scripts to the scratchpad.
  Backticks in `gh pr comment` bash strings command-substitute — escape.
- **DOP1 client code**: `encode_control` emits the COMPLETE frame — never
  wrap in `encode_control_frame` (double-framing → invalid envelope).
- Windows: tempdir uniqueness needs COUNTERS (clock granularity collides);
  kill leftover `%TEMP%/dohc-cal1-*` before gates.

## 8. Ice's reserved decisions (present, don't decide)

1. **Secret ownership-marker column** (GATE6): secret ownership keys on
   `metadata_origin == "local-file"`, which is also a legitimate API origin
   — non-spoofable ownership needs a dedicated column = a migration, cheap
   before R15's reset, expensive after. Recommend pre-R15; present
   cost/benefit.
2. **macOS evidence path**: CI runner vs Ice-run script (prepare both).
3. **RPC-E scope** for cutover.
4. **R15 go/no-go**: the single confirmation before executing the cutover
   (resets dogfood data). Package per §1.5. This is the ONLY stop.

## 9. Communicating with Ice

Progress summaries between stretches with real content: what was found,
what was decided and why, what is honestly uncertain. Flag deviations from
ratified sketches loudly and argue them on the PR. State evidence WITH its
limitations (the PASS-WITH-FLAG soak disposition is the model). When the
process catches the program's own evidence being wrong, say so plainly and
fix the process, not just the artifact.

## 10. Reference map

- Governing plan: `docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md`
- Program state (this dir): `SHARDS.tsv` (authoritative) ·
  `EXECUTION_LOG.md` (read the tail) · `RPC_GAP.md` · `DECISIONS.md` ·
  `TEST_ORACLE.md`
- Gate: `tools/rust-engine-program/run-rust-checks.mjs` · soak config
  `soak-config.json` · runner
  `crates/dohc-workspace-engine/src/bin/dohc-soak-runner.rs`
  (`--features harness`; build BOTH bins) · evidence
  `tools/rust-engine-program/soak-evidence/`
- Differential: `tools/rust-engine-program/capture-fixtures.json` +
  `capture-goldens.json` · TS emitter
  `apps/desktop/src/workspaces/captureOracleGoldens.test.ts`
  (goldens are FROZEN — no regeneration flag, see capture-goldens.provenance.md; pnpm; Windows needs
  `closeTrackedEngineDbHandlesForTest`) · Rust replay
  `crates/dohc-workspace-engine/tests/capture_differential.rs`
- Daemon: `crates/dohc-workspace-engine/src/lib.rs` (dispatch) ·
  `bin/dohc-workspace-engine.rs` (DOP1 stdio) · driver
  `src/capture_driver.rs` · sink `src/capture_sink.rs`
- Auto-memory (`C:\Users\ice\.claude\projects\C--Users-ice-dev-dohc\memory\`):
  `orchestrator-model-fable5` · `rust-engine-orchestration-gotchas` ·
  `rust-gate-stall-watchdog` · `coderabbit-rate-limit` · `dohc-repo-layout`
- PR state on start: `gh pr list`; per-PR
  `gh api repos/dohc-ai/dohc/pulls/<n>/reviews` (filter `submitted_at`) and
  `/comments` (filter `created_at`).
