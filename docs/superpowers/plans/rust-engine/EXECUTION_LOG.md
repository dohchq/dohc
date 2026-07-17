# Rust engine rewrite — execution log

Append-only narrative behind `SHARDS.tsv` (which is the machine-readable
source of truth every orchestrator session loads first).

## 2026-07-16

- Go signal received from Ice. Program opened.
- Rev 2 plan written after a 9-agent audit (6 claim verifiers: 14/16
  confirmed, 2 corrected, 0 wrong; 3 adversarial reviewers: 37 findings,
  8 P0 — all incorporated). Audit transcript:
  session workflow `wf_34a62e66-de2`.
- Environment verified on host `x86_64-pc-windows-msvc` (Windows 11 Pro
  10.0.22631), repo at `main` = `5b6d2009`, working tree clean. Commands:
  `cargo --version` → 1.96.1; `rustc --version` → 1.96.1;
  `codex --version` → 0.142.5 (later updated, below); `gh auth status` →
  authenticated with repo scope; `git status --short` → clean.
- Wave 0 opened: R00 scaffolding (this commit), YRS-SPIKE and
  R01-INVENTORY launched as background workstreams.
- R00 PR: dohc-ai/dohc#137.
- Codex CLI fixed (R00 checklist): 0.142.5 rejected `gpt-5.6-sol`
  server-side; `codex update` self-updater fails from Git Bash
  (PowerShell sub-invocation error); updated via pwsh installer to
  0.144.5; `codex exec` on the gpt-5.6-sol default verified working.
- Portability guardrails added to the plan (library-first core, trait
  seams in core crates, in-process protocol transport) + open decision 9
  (mobile/web hosts deferred). Requested and approved by Ice.
- PR #137 review round 1: CodeRabbit (13 actionable) + Codex (8 findings)
  all triaged valid and fixed in one batch — Gate 0 split from the go
  signal, fixture sanitization rules, stale-device epoch rejection,
  persisted post-settle inventory, triplet handle probe, export location
  outside workspace root, schema validation tightening + approved-unsafe
  path, SHARDS machine-readability (R00 narrowed, INTEGRATOR row, R13/R13b
  dependency fix), program-control docs review tier, enforceable build
  slots/disk hysteresis, Defender exclusions narrowed to build caches.
- R01-INVENTORY landed as PR #138 (branch codex/rust-engine-r01-inventory,
  new files only): 229 behaviors (52 critical/63 high), 218 exports
  (20 retired-delete, 2 decision-required), 44 test files classified
  (18 portable / 17 sql-oracle / 5 hook-dependent / 4 impl-specific),
  114 determinism sites (38 block trace determinism). 11-agent workflow
  wf_08d4899b-e02, 0 malformed rows on assembly validation.
- TS-NATIVE-CI landed as PR #139: native engine-suite matrix
  (windows-latest / macos-latest arm64 / ubuntu-latest) with arch
  assertion; the PR's own CI run is the first native Windows/macOS
  execution of the oracle suite. Known gap logged: no native macOS x64
  runner (open decision 2).
- R03 protocol spike launched (background agent, isolated worktree,
  branch codex/rust-engine-r03).
- YRS-SPIKE verdict: PASS (PR #140). 21/21 fidelity docs incl. 9 real
  dogfood lineages; 1,000 seeded fuzz runs clean; yjs 13.6.30 <-> yrs
  0.27.3 pinned. Sole abort criterion cleared. Binding R11 constraints
  recorded in DECISIONS.md (OffsetKind::Utf16 mandatory, nested map key
  sorting, UTF-16 well-formedness at adapter, shared root schema +
  destructive projection provenance). Safety fences verified held
  (copy-only harvest, fixtures local/gitignored, zero unsafe).
- PR #137 review round 2: CodeRabbit APPROVED; Codex posted 8 findings
  (1 P1: replicated Y.Doc rows are durable lineage, not prunable cache —
  plan section split into local-only vs replicated regimes; 7 P2: SHARDS
  gate rows GATE0/GATE6 for resolvable deps, R01-CONTRACTS shard for
  Gate 0 contract docs, R05 owns versions module, R13b owns flagged
  integration files, packet-builder ownership consistency, unsafe CI scan
  detector). All fixed.
- PR #139 CI BLOCKED: GitHub Actions billing failure at the org — no job
  starts on any runner. Escalated to Ice (open decision 2 now includes
  restoring Actions billing).
- R03 protocol spike delivered (PR #141, dormant crate
  dohc-engine-protocol): recommendation = length-framed JSON control
  frames + raw binary blob-chunk frames; serde structs as single schema
  source (ts-rs -> TS types, schemars -> JSON Schema); CBOR held as
  negotiated upgrade. Measurements: worst-case metadata JSON penalty
  ~1.5ms vs 1,500ms budget; raw chunk frames 4.7-6.6 GB/s vs 0.4-0.5 for
  base64-JSON; V8 JSON.parse decodes fastest on the JS peer. 35 Rust +
  7 Node tests over byte-identical shared fixtures; panic-free decoder;
  in-process transport with zero serde in path (portability guardrail 3).
  Two protocol-freeze escalations recorded: engine->client event flow
  control (bounded buffer + overflow policy), and per-method param/result
  schemas to close dual-implementation validation drift. Open decision 1
  now has its evidence; Ice ratifies at Gate 0.
- PR #140 local Claude review 1/2 (robustness/security): verdict UPHELD,
  5 non-blocking P2 hardening findings (symlink-bypassable harvest guard,
  hang-on-crash driver, u32 overflow nit, truncation-only fault model to
  narrow in report, Node>=22 note). Fix batch pending reviewer 2/2.
- PR #140 local Claude review 2/2 (evidence integrity): verdict UPHELD
  with independent reproduction (fidelity re-run, 25-seed fuzz matching
  report distributions ~2%, determinism probe 3x identical, Bytes crash
  re-demonstrated at yrs block.rs:1613). 2 P1 (synthetic-only fallback
  silently passes without harvested fixtures + single-update-blob corpus
  never exercises reverse-order path; truncation acceptance warns instead
  of failing) + 4 P2 (pinned Bytes probe, base clientID by construction,
  undeclaredRoot placeholder equality, skip-vs-fault classifier). Codex
  bot added 4 P2s. All 15 findings dispatched to the spike fixer as one
  batch; strict re-certification run required before re-review.
- R01-ORACLE delivered (PR #142): TEST_ORACLE.md with 35 named fault
  points (all Tier 1; 3 dual Tier 2; torn-write de-scoped per plan),
  mapped to 7 live TS hooks / 10 crash-state corpora / 4 structural /
  14 v2-only gaps shipping with their machinery shards; 6 environmental
  error kinds + 5-kind relay fault model; EngineTestAdapter sketch;
  anti-weakening mechanics. Packet builder self-test 25/25, --check green
  against live tables (30 shards / 229 behaviors). Escalations: legacy
  stale-lock corpus de-scoped via quarantine (re-opens if decision 4
  grants headless writes); dead onLockBlocked/lockStaleMs hooks flagged
  for deletion.
- CHURN ALERT: engineDbSchema.ts grew 188 lines on origin/main during
  Wave 0 day one (fence check moved :680 -> :852). Plan citations made
  symbol-based. The plan's Wave-0 freeze on engineDbSchema.ts + sync wire
  surfaces needs Ice to enforce starting now.
- R01-CONTRACTS delivered (PR #143): PORTING.md (15 mapping sections),
  STATE_OWNERSHIP.tsv (40 resources, column-validated),
  LANGUAGE_SEMANTICS_MATRIX.md (84 rows, ~60 named semantics/* fixtures
  with owning-shard index). Load-bearing: 4 independent same-DB
  connections with separate serializers enumerated for deletion; Windows
  junction detection weakens on naive Rust port (reparse-point detection
  required, matrix 7.6); JSON integral-float formatting breaks journal
  byte-parity (timestamps as i64); materialization today is plain
  writeFile (durable-job pipeline is a delta with oracle impact); engine
  has zero cancellation (drain semantics fixture-pinned).
- CURRENT-PRODUCT security findings from #143 (independent of rewrite):
  validateWorkspacePath accepts NTFS ADS ':' segments, drive-relative
  paths, and Windows device names; search policy read fails OPEN to
  no-rules on any error incl. EACCES (searchIndex.ts:53-77). Both
  escalated to Ice as NEEDS-DECISION — candidate TS hotfixes ahead of the
  rewrite.
- Gate 0 dual adversarial review of the contract set launched (two
  clean-context reviewers, approve-together requirement).
- PR #140 fix batch complete (94f8083b): all 15 findings fixed, none
  rejected; strict re-certification green (fidelity 23/23 with
  --require-harvested; fuzz 500/500 --strict, 2,041 truncated injections
  zero accepted). Two bonus bugs surfaced by the fixes themselves:
  serde rename_all silently dropped clientId/offsetKind fields (client
  ids were random pre-batch), and yjs 13.6.30 applyUpdate is NOT atomic
  on malformed input (67/2,041 leave a converging partial prefix; yrs is
  atomic) — pinned as true invariant, recorded as binding R11 constraint
  5 in DECISIONS.md with a Gate 0 option for the stricter
  snapshot/restore wrapping. Re-check reviewer launched; @codex re-review
  triggered by the fixer.
- PR #143 local review 1/2 (completeness): APPROVE-WITH-FIXES — 5 P1
  census gaps (cliServer's 2 untracked raw engine.db connections — census
  is six, not four; base64 strictness semantics; Windows 8.3 short-name
  aliasing bypass; registryStore/dmHomeStore/cloudCredentialStore
  untracked; smol-toml vs toml crate) + 5 P2. Reviewer 2 (correctness)
  still running; combined fix batch after.
- PR #143 local review 2/2 (correctness): APPROVE-WITH-FIXES — 2 P1
  ground-truth errors: matrix 7.6 junction claim EMPIRICALLY INVERTED
  (rustc 1.96.1 is_symlink()=true for junctions, matching Node — the
  'load-bearing finding 3' recorded earlier in this log is FALSE and is
  hereby corrected; naive port is correct there); matrix 4.1 'no
  normalization anywhere' false for chat surfaces (5 NFC sites incl. the
  sha256 projection path). 5 P2 (error-code counts 24/19 not 22/20; relay
  error structured-fields claim; V8 1e999 stated backwards; cross-branch
  citation provenance; line nits). Combined 17-finding fix batch (12 from
  completeness incl. 5 P1 census gaps + these 7) dispatched to the
  contracts shard.
- PR #140 re-check: 13/15 VERIFIED behaviorally (live junction refusal,
  child-death rejection, wire clientId, replay determinism, crafted
  undeclared-root failure; weakening sweep clean). 2 residual one-line
  P2s dispatched (realpathSync.native for 8.3 aliases; frontmatter
  classifier Date-object collapse). Verdict FIXES-NEEDED narrowly;
  certification completes on the two closures.
- PR #140 residuals closed (22fdf09a): realpathSync.native with live
  8.3-alias refusal probe (COM-obtained short name); yamlPlain classifier
  fix with pinned Date-pair + key-reorder regression checks on every run.
  Local review cycle complete: implementer -> 2 adversarial -> 15-fix
  batch -> re-check -> 2 residuals -> verified. Re-runs green (23/23
  fidelity --require-harvested; 25/25 strict smoke).
- PR #137 review round 3 fixed (2 P1 + 13 findings): dispatch raw-writer
  fence caveat made explicit (v2 stamp only locks out writers that check
  it; Gate 5 deletion + Gate 6 dispatch-path adversarial test now
  normative); R10b shard added owning sync-relay epoch rejection; GATE0
  deps extended (R01-DETERMINISM, TS-NATIVE-CI) and CAL-3/R11b/R13b gated
  transitively; status vocabulary normalized; R03 skeleton scoped to
  protocol-crate paths; recovery exports get backup posture; zero-handle
  proof OS-specified and held through swap; capture mismatch = durable
  failed state; PASS ledger entry marked provisional pending Ice
  ratification; handoff schema rejects contradictory unsafe approvals;
  build-slot reclamation owner-safe (heartbeat + pid-tree + tombstone
  rename).
- PR #142 review round addressed (40d3c675): 14 fixed (capability
  enforcement normative, structured delta_approval replaces free-text
  parity bypass, crashed as first-class trace outcome, one-per-chain
  assertion counting, fence-injection + diff-failure + provenance fixes
  in the packet builder), 1 partially declined on correct path-ownership
  grounds (program tables belong to INTEGRATOR/#138). Self-test 29/29,
  --check green. @codex re-review triggered.
- PR #143 fix batch complete (96629473): 19/19 local findings + 7 Codex
  inline fixed, 0 rejected; fixer independently re-verified the junction
  probe and 8.3 three-way split, and corrected the integrator's own
  decision-number error (account stores are open decision 6, not 3).
  STATE_OWNERSHIP 40->52 rows; matrix 84->91 rows; NEEDS-DECISION 7->9.
  Re-check launched to complete Gate 0's approve-together requirement.
- PR #140 codex round-2 batch complete (0fca9074): 4/4 fixed — CRDT
  state-vector + full-state byte comparison after every rejected cut, empty
  harvested manifest rejected under --require-harvested, landed-vs-attempted
  Rust edit accounting via a per-op changed flag (byte-length genuinely
  cannot distinguish no-ops — reviewer concession), malformed-stdout rejects
  the named in-flight request before killing the child. Stale 10:17Z
  threads replied with fixing hashes. Full 500-seed strict certification
  refreshed: 500/500 (7,480 landed yrs edits, 2,169 truncations
  zero-accepted, 77 recovered yjs partial-applies). PASS unchanged.
- PR #138 codex round complete (3a9de602): 9/9 verified-then-fixed (incl.
  a 9th inline beyond the 8 headlines): key-envelope randomness rows,
  desktop database-edit Date.now clock seam, 3 missing rust-authority
  behavior rows (versionCompare + key wrap/unwrap, critical), mention
  parsing reclassified rust-authority, MCP consumers added to 12 rows,
  dispatch-adapter + workspaceActivity tests queued, retired suites
  demoted to port_priority none, CLI granular-search caller corrected.
  Counts: 232 behaviors / 46 test files / 117 determinism sites; column
  validation clean.
- PR #141 codex round complete (f4a61885): 7/7 fixed. The starvation
  finding was confirmed worse than stated (mpsc-buried jobs equally
  unobservable) and fixed by redesign: counter-bounded admission with
  exact OVERLOADED + per-request biased select over
  {cancel, deadline, slot permit} — queued requests now resolve
  CANCELLED/DEADLINE_EXCEEDED behind a hung handler (2 new paused-time
  regressions). Float-form integers >2^53 rejected matching TS
  Number.isInteger semantics; BoundedWriter fails oversized encodes
  mid-write; nullable fields aligned with TS optional|null contract;
  blob stream ids typed-rejected both directions; no-nested-batch encoded
  at the schemars generator with TS not-subschema support; uint32 maxima
  range-checked. clippy -D warnings clean; 41 Rust + 10 Node tests
  green.
- PR #143 re-check: 26/26 VERIFIED (junction + 8.3 probes independently
  re-run; NFC census exact; TSV 52x11 clean; 9 NEEDS-DECISION items all
  genuine). 2 one-line P2s introduced by the batch (row 4.8 error code
  invalid-input -> invalid-follow-target + self-reference; row 6.5
  off-by-one decision pointer) dispatched. Gate 0 contract approval
  completes on those two lines.
- PR #143 two-line residuals closed (399645d5) with independent
  verification of the error-code claim at linkedChatStore.ts:908-910.
  R01-CONTRACTS complete: both Gate 0 adversarial approvals + 26 verified
  fixes + re-check residuals. Deliverables final: PORTING.md 15 sections,
  STATE_OWNERSHIP.tsv 52 rows, LANGUAGE_SEMANTICS_MATRIX.md 91 rows,
  9 NEEDS-DECISION items for Ice at Gate 0.
- PR #137 review round 4 fixed (3 P1 + 6 P2): cutover build defined as
  the sole signed exception to the shadow-only fence (Gate 6-materialized
  authorization marker; rehearsal-scoped variant for clones); zero-handle
  proof made Windows-honest (no-share handles cover the copy phase via
  read-through-held-handles; close->rename window is a documented residual
  race with post-swap identity re-verification -> failed state on
  mismatch, interloper test); GATE6 now depends on R10b (relay epoch
  enforcement on the release path); SHARDS owned_paths made pure globs;
  failed branch added to the reset state-machine diagram; R11a/R13b start
  conditions re-anchored to Gate 0; ENGINE_SCOPE.tsv named consistently;
  locked decision 3 qualified with the raw-writer caveat.
- PR #142 round 2 closed (9082e3f7): 5/5 codex fixed (errorArgs in
  fault contract with per-kind validation, hyphenated test-stem parsing,
  restart-after-crashed trace semantics, count + CLI-guard nits);
  CodeRabbit 11:14Z posts were fix confirmations. Self-test 33/33.
- GATE0_PACKET.md assembled for Ice: ratifications (yrs PASS + protocol),
  billing + CI matrix, freeze enforcement, open decisions 3-8,
  9 NEEDS-DECISION items incl. 2 recommended current-product TS hotfixes.
  Gate 0 close sequence documented: merges -> R02 -> GATE0 flips ->
  Wave 1.
- GATE 0 DECISIONS RESOLVED by Ice (in-session): yrs PASS ratified
  (converging-prefix accepted); protocol ratified; GitHub CI SKIPPED ->
  local-first evidence (Windows native + WSL Linux; macOS = mandatory
  pre-release revisit); freeze enforced by Ice with in-flight engine
  changes INTEGRATED via BEHAVIOR_DELTA reconciliation (not discarded);
  decisions 3-8 per recommendation; both security hotfixes approved;
  NEEDS-DECISION defaults approved. PR #139 workflow retired;
  TS-NATIVE-CI repurposed to local runner scripts under R02.
- PR #137 review round 5 (2 P1 + P2s): R09 now owns
  desktopAgentDispatchStore.ts deletion (Gate 5 raw-writer requirement had
  no executable owner); cutover-build fence exception split into two tiers
  (rehearsal tier available Phase 5 for clones, real-cutover tier only
  post-Gate-6) resolving the circular Gate 6<->rehearsal dependency I
  introduced last round; R15/R16 placeholder owned_paths made concrete
  globs; R11b start text gated on Gate 0.
- PR #142 round 3 closed (74ff4856): trailing-slash path matching,
  directory+stem classification keying, and a real optionalFor redesign
  (the old design left engines with contradictory expectations on
  crash/error faults; now uses an engines:["rust"] self-consistency
  label restricted from expectation-bearing faults). Self-test 38/38.
- BASELINE DISCREPANCY found by DELTA shard (BEHAVIOR_DELTA.md landed):
  R01-INVENTORY was extracted at 5b6d2009 (session-start HEAD), ONE MERGE
  behind origin/main=958cdfd3. The gap is PR #136 (native workspace chat,
  33 commits, +18,235 lines, engine-heavy). Verified: applyReplicationOp
  cited at :2478 (5b6d2009) vs :4182 (958cdfd3). CORRECTION to the earlier
  'engineDbSchema grew 188 lines during Wave 0' churn alert: that was NOT
  active churn — it was PR #136 already on origin/main while local baseline
  lagged. Freeze IS holding (958cdfd3..origin/main empty). Impact: inventory
  misses PR #136's engine surface — first migration machinery (engine_migrations
  ledger, invalidates the no-migration-machinery claim), 7 new tables,
  15 new chat methods, 2 new sync op kinds (chat.follow.set/chat.feed.read.set),
  semantic changes to 32 chat rows. R01-CONTRACTS forked correctly at
  958cdfd3 and is unaffected. Delta register records the reconciliation; canonical BEHAVIOR_DELTA.md is PR #144 (26 new / 16 changed behaviors, +7,760/-50 across 36 engine files; 0 drift on secrets/Y.Doc/shared-channels/watcher/policy/search). NOTE: R01-ORACLE also forked at 958cdfd3 and is current — no oracle update owed.
  New REINV shard blocks R04/R09; GATE0 gains REINV dep. GATE0_PACKET counts
  232/218/46/117 are pre-merge and will move.
- HOTFIX PR #145 up (023dbedd): path-validation (ADS ':' segments,
  Windows device names, 8.3 short-name aliases rejected in
  validateWorkspacePath covering both read+write paths) + search
  fail-closed (ENOENT->defaults, EACCES/parse/oversized->fail closed with
  typed diagnostic, no stale index). Tests: workspace-core 122,
  workspace-engine 460+19 fs-lock, incl. ENOENT-vs-EACCES + broken-then-
  fixed search e2e. DESIGN FLAG: rejections are cross-platform, not
  Windows-only -> newly rejects meeting 10:30.md / nul.md / draft~2.md on
  POSIX. Two adversarial reviewers launched (bypass+regression;
  cross-platform-breadth product call) — the breadth is a conscious
  decision for Ice, not auto-shipped.
- PR #145 product-coherence review: APPROVE-WITH-FIXES, verdict reframed.
  KEY FINDING (P1): validateUserWritePath gates the disk->engine CAPTURE
  path, not just dohc writes — so universal rejection makes dohc silently
  DROP legal-on-host files that already exist in the user's folder
  (VersionedTextStoreError -> console.error only), and (P2) one such file
  permanently disables the Rust fast scanner for the workspace after N
  reconciles. That silent folder<->dohc divergence is the real 'obvious
  workspace' violation, not the rule itself. Recommendation: ship universal
  rejection (right for portability — a Windows peer self-protects at its own
  materialize boundary, so universal is about SYNC PORTABILITY not peer
  protection) BUT (a) surface capture rejections to the user, never silent;
  (b) kernel scan collect-and-continue, not throw-and-disable; (c) surface
  search diagnostics to renderer. Long-term dohc-native answer:
  escape-on-materialize (logical path primitive, Windows disk name a
  reversible mirage). P1 + kernel-disable P2 are release blockers. Holding
  fix batch for reviewer 1/2 (bypass/regression).
- PR #145 both reviews APPROVE-WITH-FIXES; fix batch dispatched. Both
  found the over-block hits READ+CAPTURE (silent data-loss, scanner
  self-disable) and that every hazard is Windows-only. Resolution:
  win32-gate write/materialize rejection, never block read/capture,
  surface rejections not silent-drop, kernel collect-not-throw, search
  fail-closed scoped to file-indexing + diagnostics surfaced. Holes stay
  closed without breaking Mac/Linux workspaces. Escape-on-materialize
  filed as rewrite-era roadmap (Rust materialization pipeline).
- RE-INVENTORY at 958cdfd3 complete (workflow wf_10f603b4-923): 76
  corrected chats rows, 28 schema rows (incl. the engine_migrations ledger
  + repairDeferredChatParentsOnce that the stale inventory missed), 8
  chat-determinism rows — all column-valid. Merge agent dispatched to
  replace the stale chats+schema clusters on PR #138 and correct the
  'no migration machinery' claim in INVENTORY_NOTES. Once merged, REINV
  clears and R04/R09 unblock.
- RE-INVENTORY merged into PR #138 (46de82a3): BEHAVIOR_INVENTORY
  232->261 rows (75 stale chats/schema rows replaced by 104 corrected;
  no behavior_id collisions; non-chats/schema clusters byte-identical),
  DETERMINISM 123, TEST_CLASSIFICATION 49 (+3 verified chat test files).
  INVENTORY_NOTES 'no migration machinery' claim corrected. ENDORSED
  merge-agent deviation: kept the 5 dispatch-store determinism seams
  (byte-identical at baseline, still valid) rather than the literal
  remove-all instruction — correct call. GATE0_PACKET counts superseded:
  261/218/49/123. REINV done; R04/R09 REINV-block cleared (still gated on
  GATE0).
- PR #137 review round 6 (3 P1 + 3 P2): R15 split into R15-REHEARSE
  (pre-Gate6, clone rehearsal tier, feeds GATE6) + R15 real cutover
  (Gate6-gated) — resolves the machine-level Gate6<->rehearsal circularity;
  R16 gains ownership of crates/workspace-kernel* + workspace-kernel-client
  deletion; R13b gains cli/** + mcp/** ownership (their raw engine.db
  consumers need the replacement API for Gate 5/8 audit); stale CI-matrix
  prerequisite in the cross-platform section replaced with the Gate 0
  local-runner resolution; disk-inventory scope clarified (normal file tree
  only, checkpoint-invariant); GATE0_PACKET header corrected to
  'decisions resolved, gate not yet closed / Wave 1 not opened'.
- PR #142 round 4 closed (054e36b3): 5 P2 fixed (pause-fault schedule
  desync restricted to observe-only optionalFor; ** glob boundary;
  within-engine-only secret-key assertion; per-behavior mutation
  attribution; oracle tools in ownership walk), 1 correctly re-declined
  (table commit = path ownership). Self-test 41/41. Oracle review fully
  converged across 4 rounds -> parity verified. (Its --check reads 229
  behaviors from its pre-REINV branch fork; resolves to 261 at merge.)
- PR #145 hotfix rescope DONE (8dafa7cb + 04761e82): all 6 fixes
  applied. win32-write-only gating for colon/device/8.3; read+capture
  never blocked (silent-data-loss root cause eliminated — host-legal
  files seed on every host incl. Windows); .dohc/shared-with-me exact
  reservation stays universal; materialize throws typed
  UnsupportedWorkspacePathError surfaced via history-capture-failed
  notice; kernel scan collect-not-throw; search fail-closed scoped to
  file indexing (chat preserved, no index_state while degraded, freeze-
  not-drop); search diagnostics surfaced; CONIN$/CONOUT$/CLOCK$ added.
  Tests: workspace-core 123, workspace-engine 460+19, desktop suites all
  green. RESIDUAL for Ice: on Windows WRITE, 8.3-shaped names
  (report~1.pdf) still rejected (shape-ambiguous with real aliases);
  reads always work, non-win32 writes work; escape-on-materialize is the
  roadmap fix. Security-critical shipping code -> re-check launched.
- PR #145 re-check: CLEAN — mergeable. All security claims verified via
  direct node runs of real validators. 2 non-blocking P2 follow-ups filed
  (desktop search blocks chat too on broken policy — pre-existing, safe;
  frozen-index staleness window — self-healing). Hotfix ready to merge
  pending codex bot confirmation; unblocks R01-DETERMINISM.
- PR #137 review round 7 (SHARDS ownership completeness class): fixed 4
  concrete items — R15 cutover glob narrowed (cutoverReset*/cutover_real*)
  to not overlap R15-REHEARSE; R13b gains share/workspace consumers
  (sharedView/sharedChannels/shareMounts/workspaceFiles/workspaceSearch/
  workspaceGraph + collab ydocEngineProviderSession); R16 gains
  collab/** + agents/** deletion ownership; GATE0_PACKET close-sequence
  now names all GATE0 deps (incl. R01-DETERMINISM, TS-NATIVE-CI). Installed
  a structural OWNERSHIP MODEL provision at SHARDS.tsv head: owned_paths
  are the starting allocation, integrator refines at shard-open via
  repo-wide import scan, the pre-merge hook is advisory until Wave 1 —
  defusing consumer-enumeration as integrator-upkeep, not a merge blocker.
- PR #145 round 3 (dc749c69): codex caught a P1 my re-check MISSED —
  the win32 default over-applied beyond the materialize sink to
  classifyEngineFilePath + persisted-row checks, so on Windows a synced
  report~1.pdf classified 'ignored'/state-corrupt (the recurring
  over-block class, one layer up). RE-CHECK LIMITATION NOTED: verifying
  'no bypass at write sinks' missed that the win32 default also hit
  non-sink write-path callers. Fix is architecturally cleaner: host-unsafe
  check OFF by default, only assertEngineWritablePath/
  assertGeneratedMarkdownPath opt in with win32; classifyEngineFilePath
  tracks these names on every platform (regression test added). Also:
  policy size cap aligned 64->256 KiB; freeze now invalidates index_state
  for added-during-degraded files. Tests green (core 123, engine 463+19,
  capture 71). Lesson: did NOT merge on the single CLEAN re-check — the
  codex confirmation pass caught a real P1; holding for re-confirmation
  before merge.

## 2026-07-17 — Wave 0 merged
- All 7 Wave 0 PRs merged to main (squash): #137 program/plan, #138
  inventory (261 behaviors), #140 yrs-spike, #141 protocol crate, #142
  oracle, #143 contracts, #144 delta. All remote branches deleted (repo
  rule); 0 rust-engine branches remain except the new integrator branch.
  CodeRabbit CHANGES_REQUESTED on #137 overridden with documented
  rationale (7 rounds, all substantive findings fixed, remainder stale
  re-flags + provisioned ownership-upkeep on a living doc).
- Gate 0 remaining deps: R01-DETERMINISM (queued behind hotfix #145 to
  avoid engine-file conflict) + R02 (+ its local-runner native evidence,
  = TS-NATIVE-CI). R02 launched on codex/rust-engine-r02.
- Hotfix #145 still iterating on its own track (two-check A/B model
  dispatched to converge the ADS/device/8.3 boundary).

## 2026-07-17 — R02: Cargo workspace + toolchain + local-runner evidence
- Repo-level Cargo workspace created (`Cargo.toml`, resolver 3). MEMBERS:
  `crates/dohc-engine-protocol` (dormant production protocol crate) and
  `crates/yrs-spike` (permanent R11 interop harness). EXCLUDED (kept
  standalone): `crates/workspace-kernel` + `crates/workspace-kernel-spike`
  — making the kernel a member relocates its build output away from the
  HARD-CODED `crates/workspace-kernel/target/release/<bin>` path that
  `apps/desktop/scripts/build-workspace-kernel.mjs` copies from, which
  (given that script degrades silently) would ship the app WITHOUT the
  kernel binary. Verified the excluded kernel still builds via
  `cargo build --release --manifest-path crates/workspace-kernel/Cargo.toml`
  and emits the binary at the expected staging path. Desktop build unchanged.
- Pinned `rust-toolchain.toml` (channel 1.96.1, components rustfmt+clippy).
  `[workspace.package]` (version/rust-version/publish) + `[workspace.lints]`
  with `unsafe_code = "forbid"`; both members inherit via `[lints]
  workspace = true` (yrs-spike's crate-local forbid superseded). Committed
  root `Cargo.lock`; removed the two members' now-superseded per-crate locks.
- `deny.toml` added (cargo-deny licenses/bans/advisories/sources); cargo-deny
  installed locally and `cargo deny check` passes. cargo-audit absent — the
  runner skips-with-warning.
- Applied a mechanical rustfmt normalization to `crates/yrs-spike/src/main.rs`
  (behavior-preserving) so the workspace has a fmt-clean baseline under the
  pinned rustfmt.
- Local runners under `tools/rust-engine-program/`: `run-rust-checks.mjs`
  (fmt/clippy -D warnings/build/test + optional deny/audit) and
  `run-native-suite.mjs` (TS-NATIVE-CI equivalent; asserts host arch; WSL =
  Linux evidence; macOS = pre-release obligation), plus a `README.md`
  documenting the local-evidence-replaces-CI workflow.
- EVIDENCE (native Windows x64, dev machine):
  - 2026-07-17 | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
  - 2026-07-17 | run-native-suite | win32/x64 | PASS | typecheck=PASS test=PASS  (25+2 vitest files, 470 tests passed, 114 platform-skipped)
  - Linux x64 (WSL) + macOS evidence still outstanding (macOS = pre-release obligation).

## 2026-07-17 — GATE 0 PASSED · Wave 1 open

- Security hotfix #145 MERGED to main: converged two-check model (Check A
  reserved-path always all-platforms incl. win32 8.3 alias resolution;
  Check B materialize-hazard win32-write-only via validateUserMaterializePath;
  ADS-colon blocked win32 read+write). Fixed two real current-product
  security holes. Branch deleted. (Notable: a local re-check called it
  CLEAN but codex caught a P1 — held merge for confirmation; validated the
  multi-layer discipline. Final validator personally read before merge.)
- R02 #146 MERGED: Cargo workspace (members: dohc-engine-protocol,
  yrs-spike; workspace-kernel EXCLUDED to preserve desktop staging path),
  rust-toolchain 1.96.1, deny.toml, local-runner scripts
  (run-rust-checks + run-native-suite) replacing skipped GitHub CI. Native
  Windows evidence: workspace build/clippy/deny green + 470 engine tests.
  Branch deleted.
- R01-DETERMINISM #147 MERGED: 12 injection seams (createId/nowMs options
  defaulting to Date.now/randomUUID — zero production behavior change,
  spot-verified + 488 tests green + per-site injection tests). One site
  escalated (versionedFileWorkspace pending-id) and correctly left
  un-seamed: it's quarantined legacy (R16 deletion), oracle excludes it.
  Branch deleted.
- **GATE 0 PASSED**: all deps merged (YRS-SPIKE, R01-INVENTORY, REINV,
  R01-CONTRACTS, R01-ORACLE, R01-DETERMINISM, TS-NATIVE-CI [=R02 native
  run], R02, R03). Phase 0 closed. Ice's Gate-0 decisions all recorded in
  DECISIONS.md; yrs PASS ratified.
- **Wave 1 OPENS**: R04 storage core (day-one v2 schema + migration/
  idempotency/materialization-job ledgers + backup/integrity) and the 3
  calibration slices (CAL-1 ws-open/close/txn/restart, CAL-2 versioned
  write/read/history/restore, CAL-3 scan/hash/reconcile/cancel). Engine
  freeze binding from here.

## 2026-07-17 — CAL-1 merged (first Wave 1 slice) · Gate 1 signal forming

- CAL-1 #149 MERGED: 4 engine crates on main (dohc-engine-storage/runtime/
  testkit + protocol), workspace-kernel excluded. First production Rust of
  the engine.
- CALIBRATION LESSON (the value of the slice): two clean-context adversarial
  reviewers built+probed and REPRODUCED two P1s in v1 — (1) the one-writer-
  per-file invariant was keyed on path canonicalization, forking a 2nd writer
  for filename-case aliases / file-symlinks / hardlinks; (2) the v1/v2 fence
  applied WAL (persistent) BEFORE the fingerprint check, mutating rejected
  files. Both FIXED: identity now keys on OS FILE-ID (dev+ino / Windows
  volume+file-index via the safe `file_id` crate — forbid(unsafe) holds);
  fence reordered to classify read-only before any persistent pragma; open
  encapsulated pub(crate) + WorkspaceSupervisor::global() singleton. Plus
  durability pinned (synchronous=NORMAL + WAL-replay test), idempotency
  payload SHA-256, and actor-edge hardening (panic drop-guard, restart
  generation continuity, lock-not-held-across-spawn, typed Overloaded,
  close/open race). 23 tests green; all local gates pass; 0o700 dir perms.
- CORRECTED CLAIM: "one writer per engine.db is compiler-enforced" is precise
  only for one-writer-per-CONNECTION (airtight, type-level). Per-FILE
  uniqueness is a runtime property now enforced via file-id identity +
  pub(crate) open + process-global supervisor — not the type system.
- Gate 1 signal: approach SOUND (intra-actor ownership airtight, impl boring,
  PORTING mapped line-for-line) with the correct identity architecture now in
  place for R04 to inherit. NEEDS-DECISION logged: SQLITE_BUSY-vs-corruption
  error mapping (deferred). Deferred to CAL-2: tokio async-runtime actor loop
  + cfg-gating the fault seam out of release builds.
- PROCESS NOTE: merged #149 before fully reviewing bot findings; verified
  post-hoc the one distinct bot P1 (0o700 dir) was addressed. Going forward:
  review bot findings before merge.

## 2026-07-17 — CAL-2 merged (versioning slice)

- CAL-2 #151 MERGED: dohc-engine-domain crate (versioned write/read,
  history/keyset-pagination, create_named_version fork, set_active_version
  restore, NormalizedState differential); 9 versioning tables in v2 schema;
  runtime migrated to tokio actor loop (writer on dedicated blocking thread,
  cancellation between-units, DCE-proven fault seam); fault seam cfg-gated.
  46 tests green.
- CALIBRATION LESSONS (2 reviewers, both reproduced bugs):
  1. P1 fork provenance: fork_moment_id was workspace-GLOBAL latest, not
     source-version latest (dropped `version_id` filter vs TS oracle) —
     corrupts the merge base. Fixed + sync clause aligned to
     `(IS NULL OR = 0)`.
  2. DIFFERENTIAL TAUTOLOGY: the golden harness pinned Rust's own output,
     only forked from tip, and omitted fork_base_snapshots — so it couldn't
     catch the P1. Hardened (capture fork_base, cross-version fork trace,
     value-based sync classification) and PROVEN to now fail on the pre-fix
     bug (fork_moment m2 vs m1). Standing rule for future differentials:
     the trace must exercise divergence-prone paths and NormalizedState must
     capture every table where a divergence can hide, or the oracle is
     tautological.
  3. Codex P1: deduped write read the live snapshot, not the recorded
     moment — fixed (reconstruct from moment). Plus fail-closed hardenings.
  4. Tokio migration verified solid down to release asm (fault seam DCE'd,
     seam armed under test); nits fixed (OwnedPermit fair close,
     sync-in-runtime debug_assert).
- Tokio actor loop is now the runtime model going into CAL-3/R04.
- Housekeeping: .gitignore now ignores in-worktree target-*/ dirs (agents
  keep using in-worktree CARGO_TARGET_DIR despite WINDOWS_DEV out-of-repo
  convention).

## 2026-07-17 — CAL-3 merged · GATE 1 PASSED (calibration checkpoint)

- CAL-3 #153 MERGED: dohc-engine-files crate (scan/hash/diff/reconcile,
  path floor, bounded streaming sha256 pool, FilesActor, dirty-generation
  state machine). 44 tests. Both false-delete vectors sealed (transient-IO
  fail-closed + size-cap-grow retained_over_cap); dirty mark unlosable via
  sticky AtomicBool; everything bounded (max_entries incl. dirs/skipped);
  POSIX floor corrected.
- CALIBRATION RECORD across the 3 trial slices — the review cell caught
  FIVE P1-class foundation bugs before any propagated:
  CAL-1: file-id identity (path-canon forked a 2nd writer); fence mutated
  rejected files. CAL-2: fork provenance (workspace-global vs source
  version); deduped-write read live snapshot. CAL-3: size-cap-grow
  false-delete. Plus the differential-tautology lesson (harness must
  exercise divergence paths + capture all fields) and a current-product
  floor bug (TS kernel over-excludes .DOHC on POSIX — BEHAVIOR_DELTA §7.2).
- GATE 1 READ = PROCEED (calibration checkpoint, not go/no-go — full
  commitment already decided). The architecture is sound and BORING:
  pure bounded domain logic + single-owner actor on a dedicated thread +
  tokio command loop + cancellation-between-units + non-tautological
  differentials. It composed slice→slice with ZERO rework; PORTING/
  contracts mapped line-for-line; the review cell is indispensable and
  stays for every shard.
- Three items scheduled into the capability waves (not blockers, flagged
  by the slices): (a) a files/runtime NAMED-FAULT-POINT seam for R07's
  watcher/materialization crash traces; (b) the tolerant-vs-fail-closed
  scan decision for the false-delete defense (R07); (c) R07's TWO-PHASE
  apply-ack (persisted pending plan, manifest advance gated on
  materialization ack) before reconcile drives real fallible capture.
- PHASE 2 (durable core) opens: R04 storage-core machinery — complete the
  migration ledger, backup/integrity/corruption-recovery, the durable
  materialization-job pipeline, blob storage, and harden the versioned-text
  core schema. Domain-specific tables (chats/secrets/sync/ydoc/search) come
  with their capability shards per SHARDS ownership.

## 2026-07-17 — R04 merged (durable storage core) · capability waves open

- R04 #155 MERGED: migration ledger (ordinal-validated, checksum-gated,
  crash-recoverable), restore-tested backups + load_valid_backup validator,
  6-kind corruption classification (header-corrupt → Corruption), content-
  addressed blobs (dedup + integrity-on-read), materialization-job two-phase
  pipeline (enqueue_job type-enforces atomicity via &Transaction;
  target_generation gates stale jobs → Superseded; Windows atomic-replace
  verified replaces-existing; backoff retry; preimage preserve-both;
  .conflict floor-excluded). 2 adversarial reviews (both no-P1, independent
  crash probes) + agent's own codex review (5 bugs) + 10 P2 hardening.
  Documented residuals: read→rename TOCTOU (§8.2), backup republish window
  (§8.4), Windows dir-fsync no-op, synchronous=NORMAL tier-3.
- CAPABILITY-SHARD CONTRACT (from R04): later schema changes MUST append an
  ordinal-increasing, unique-id Migration to BASELINE_MIGRATIONS (no more
  eager CREATE); the runner handles transactional + non-transactional.
  Because BASELINE_MIGRATIONS is one integrator-owned list, schema-touching
  capability shards SERIALIZE through the migration append (run one at a
  time) to avoid ordinal/textual collisions. Materializing shards drive
  phase-1 via enqueue_job inside write_with, phase-2 via run_pending_jobs.
- Wave 2 opens (serialized on schema): R08 secrets first (new
  dohc-engine-crypto crate, AEAD cross-engine parity, secret-file
  materialization), then R09 chats, R11a ydoc, R12 search, R05
  identity/restore completion. R07 (watcher/materialization) inherits the
  3 deferred items (files-side fault seam, tolerant-vs-fail-closed scan,
  two-phase apply-ack — now available via R04's job pipeline).

## 2026-07-17 — R08 merged (secrets) · R11a next (Y.Doc durable cache)

- R08 #157 MERGED: dohc-engine-crypto (AES-256-GCM, scrypt envelope,
  zeroizing redaction-safe types) + secrets domain. Cross-engine parity
  BYTE-EXACT and independently verified (fixtures regenerated from Node
  v24.16.0; AAD byte-exact vs secretFileStore.ts; bidirectional). Plaintext-
  never-leaks independently scan-verified (db+wal+shm, post-checkpoint).
  Migration ordinal 1 (v1-secrets). 2 adversarial reviews caught: P1
  SecretWrite plaintext-via-Debug (redacted); seal_with_iv nonce-reuse
  footgun (test-gated, out of public API); 2 zeroization gaps; base64
  Node-mismatch; delete-tombstone documented (§9.1). All fixed + extra bot
  findings (bounded base64, idempotent write/delete, backup table coverage).
- INTEGRATOR NOTE (for composition/R07): the generic dohc-engine-files
  materialization executor would write CIPHERTEXT to a secret path; a
  secret-aware executor (decrypt-before-write via materialize_secret_file)
  is the required integration point before the dormant pipeline runs on
  secret jobs (BEHAVIOR_DELTA §9.2). Not a blocker (pipeline dormant).
- R11a opens (migration ordinal 2, ydoc tables): the Rust durable Y.Doc
  cache/snapshots/compaction/leases + replication of ydoc.update ops +
  settle pipeline, in dohc-engine-collab. Applies the 5 binding yrs
  constraints (DECISIONS.md: OffsetKind::Utf16, nested-map key sorting,
  UTF-16 well-formedness, shared root schema, destructive-projection
  provenance, yjs non-atomic applyUpdate). Respects the local-only-cache vs
  replicated-durable-lineage regime distinction. R11b (TS live adapter) is
  separate/later.

## 2026-07-17 — R11a landed (Y.Doc durable cache — dohc-engine-collab)

- New crate `dohc-engine-collab` added to the workspace members; migration
  APPEND ordinal 2 (`v1-ydoc`: `ydoc_docs` / `ydoc_updates` / `ydoc_snapshots`,
  content-addressed into `binary_blobs`) added to BASELINE_MIGRATIONS +
  REQUIRED_TABLES. Two ordinal-count assertions bumped (storage migration
  tests → probe ordinal 3; testkit `close_reopen_mutate_cycle` ledger 2→3).
- TWO REGIMES kept distinct in a durable `regime` column: local-only (prunable
  fast-resume cache, pruned to bare marker on close) vs replicated (base-once
  durable lineage, compacted-not-pruned on close so peers bootstrap).
- Behaviours: durable update append (bounded/validated/content-addressed/
  dedup-idempotent), convergence-neutral snapshot+compaction, per-doc leases
  (RAII, deterministic Drop), base-once claim (atomic re-check), idempotent +
  echo-suppressed ydoc.update replication apply, settle→markdown projection
  with provenance materialized via R04's job pipeline (deterministic job id,
  exactly-once).
- All 5 binding yrs constraints enforced in code (see ydoc.rs module docs).
- Cross-engine (non-tautological) regression: `tests/fixtures/gen-fixtures.mjs`
  emits REAL yjs 13.6.30 lineages + yjs-computed expectations (48 seeded
  fixtures: 24 plaintext incl. CJK/emoji/RTL/astral + 24 richdoc incl. marks,
  + offset/surrogate/nested probes). The durable append→reconstruct pipeline
  converges on the yjs expectation for every fixture; compaction is
  convergence-neutral; the offset probe pins OffsetKind::Utf16 as load-bearing;
  the surrogate probe pins the isWellFormed() boundary as load-bearing (yrs
  diverges from yjs on a surrogate split — R11b must validate/reject at the
  boundary before journaling).
- Crash/exactly-once via the shared storage fault seam (append + settle,
  before-persist rollback + after-commit-before-ack kill→reopen→exactly-once).
- EVIDENCE (run-rust-checks, native Windows):
  - 2026-07-17T00:52:35.592Z | run-rust-checks | win32/x64 | PASS |
    fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS
    test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
  - `cargo test -p dohc-engine-collab --features fault-injection`: 6
    cross_engine + 11 durable_regimes (incl. 3 crash-recovery) = 17 PASS.
    (The 3 crash tests need the crate's `fault-injection` feature, which is not
    in the `--workspace` unification set; they run under `--features
    fault-injection` / `--all-features`, and clippy `--all-features` compiles
    them in the gate above.)
- REVIEW ROUND 1 (two clean-context reviewers; non-tautology re-confirmed by
  regenerating all fixtures from Node yjs 13.6.30). Fixes applied on branch:
  - P1 (blocker) — local→shared transition destroyed the lineage: `claim_base`
    upsert was `ON CONFLICT DO NOTHING`, leaving an individual-first doc's
    marker `local-only` while writing the base, so the next `close_session`
    pruned the just-claimed base. Now `DO UPDATE SET regime='replicated',
    content_kind=excluded.content_kind` — promote-on-claim ("open when shared").
    Regression: `local_to_shared_transition_keeps_the_base`.
  - P2 — log now SELF-bounds: `record_local_update` / `apply_remote_update`
    auto-trigger compaction past `DEFAULT_COMPACTION_THRESHOLD` (was
    caller-driven; the const was dead). Regression:
    `append_self_bounds_the_log_at_threshold`.
  - P2 — settle is now CLOCK-INDEPENDENT: generation is a durable monotone
    per-doc `settle_seq` (never reset, incremented only on a content change),
    not `now_ms`; a crash-retry with an advanced clock dedups. Added
    `settle_seq`/`last_settled_sha` columns to the ordinal-2 ydoc migration.
    Regression: the settle-crash test now retries with a different clock.
  - P2 — `MAX_REPLICATION_APPLY_BATCH` doc marked a FORWARD CONTRACT (not active
    today; single-update apply).
  - P2 — lease doc now states PROCESS-LOCAL/per-registry scope + poison
    fail-closed; regression `leases_are_process_local_per_registry`.
  - EVIDENCE: 2026-07-17T01:12:00.814Z | run-rust-checks | win32/x64 | PASS |
    fmt=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS
    cargo-deny=PASS cargo-audit=SKIP. collab `--features fault-injection`: 6
    cross_engine + 14 durable_regimes = 20 PASS.
- BOT REVIEW (coderabbit + codex, same round) — additional genuine findings
  fixed on top of the reviewer-relayed set:
  - CRITICAL (coderabbit) — `load_persisted` read marker/snapshot/tail in three
    separate reads (a concurrent compaction could drop the tail → silent
    omission). Now ONE DEFERRED read snapshot + reconstruction validated against
    the marker head (shortfall ⇒ `Corrupt`, never a truncated doc).
  - CRITICAL (coderabbit) — local-only `close_session` pruned without a settle
    handoff (data loss). Now refuses (`UnsettledClose`) unless the current head's
    projection == `last_settled_sha`; a doc with edits must settle before close.
  - P2 (codex) — settle used `Preimage::Absent` on EVERY job, so an edited doc
    conflict-flagged after its first on-disk write. Now `Present(last_settled_sha)`
    on re-settle so the materializer replaces the previous projection.
  - P2 (codex) — `emit_outbound` broadcast on a replicated marker BEFORE the base
    was claimed (peers get a delta without the seed). Now gated on
    `base_claimed`.
  - MAJOR (coderabbit) — NUL/control bytes now rejected in `DocKey` (they could
    forge a settle job-id collision across keys); `regime`/`content_kind` now
    CHECK-constrained in the migration (fail closed at write, no silent
    downgrade of a corrupted value).
  - DEFERRED to R11b (documented, not silently) — durable cross-COMPACTION dedup
    by a per-peer applied cursor: after a fold, a redelivery of already-folded
    bytes is re-appended but is a CRDT no-op (convergence preserved, re-folded
    at the next compaction). The `origin_seq` on `RemoteUpdate` is that cursor's
    input; the replication drain is R11b's.
  - EVIDENCE: 2026-07-17T01:21:51.532Z | run-rust-checks | win32/x64 | PASS |
    fmt=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS
    cargo-deny=PASS. collab `--features fault-injection`: 6 cross_engine + 16
    durable_regimes = 22 PASS.

## 2026-07-17 — R11a merged (Y.Doc durable layer) · R09 next (chats)

- R11a #159 MERGED: dohc-engine-collab — durable Y.Doc cache/snapshots/
  compaction/leases + ydoc.update replication + settle. All 5 binding yrs
  constraints enforced with load-bearing probes. Cross-engine convergence
  NON-TAUTOLOGICAL (51 fixtures regenerated from real Node yjs 13.6.30,
  byte-identical expectations). Compaction convergence-neutral even
  out-of-order+missing-dep. Migration ordinal 2 (v1-ydoc). Review caught:
  P1 local→shared destroyed the replicated lineage (claim_base DO NOTHING
  left regime local-only → close pruned the base — hits individual-first
  "share later"; fixed DO UPDATE regime='replicated'); + 2 coderabbit
  Critical (inconsistent multi-read in load_persisted; prune-without-settle
  data loss → UnsettledClose guard); + settle clock-fragility (durable
  settle_seq counter); + broadcast-before-base-claimed; + control-byte
  DocKey injection. All fixed, 22 tests green. The SOLE ABORT CRITERION is
  now fully realized in durable Rust.
  R11b (TS live adapter) carries forward: isWellFormed() is a HARD boundary
  requirement (yrs diverges from yjs on surrogate split); richdoc markdown
  byte-parity; the emit_outbound replication-bus seam; cross-compaction
  per-peer applied cursor.
- OPERATIONAL NOTE: an integrator worktree-cleanup pattern removed an
  active reviewer's worktree mid-run (no harm — findings were cached).
  Rule reinforced: scope cleanup to the exact worktree a COMPLETED agent
  names; never a glob that can catch a running reviewer.
- R09 opens (migration ordinal 3, chat tables): the chats domain — threads/
  channels/messages, reactions/decisions/attachments/mentions/read-state,
  follows/personal-feed/bookmarks (PR #136 surface), dispatch ledger +
  agent-run records. Byte-compatible with the TS chat schema (base64url
  cursors, generation-CAS bookmarks, deferred-parent repair). Full cell.

## 2026-07-17 — R09 merged (chats) · R12 next (search)

- R09 #161 MERGED: chats domain (21 tables, migration ordinal 3) —
  channels/threads/messages/reactions/decisions/mentions/read-state,
  follows/feed/bookmarks(gen-CAS), dispatch ledger (single-writer replacing
  the deleted desktop raw connection). Cross-engine parity BYTE-VERIFIED vs
  real Node (NFC projection paths, base64url cursors, slugs). Review caught:
  P1 dispatch liveness (claim-only, no completion/reclaim → wedged; fixed
  complete/fail/reclaim state machine + startup reaper); P1 DM-kind-dropped
  (codex); exactly-once replay via engine_requests; author_kind CHECK;
  normalize_body JS-trimEnd parity (U+FEFF); list bounds; + a pre-existing
  collab test-flake (unique_dir pid+nanos collision) fixed. 29 tests green.
- PROCESS NOTE: chats.rs shipped with 3 LITERAL control bytes (0x00/0x1f/
  0x7f) pasted into a regex doc-comment → git flagged the file BINARY → bot
  diffs didn't render → lighter bot review (the 2 local adversarial
  reviewers, reading full content, carried the substantive review). Caught
  by verify-before-merge byte inspection; fixed (escaped) pre-merge. LESSON:
  spot-check for git-binary-flagged source on every shard; "compiles+tests
  pass" does not catch unreviewable/binary source.
- Wave 2 status: R08 secrets ✓, R11a ydoc ✓, R09 chats ✓ (the 3 biggest
  domains). Remaining: R12 search, R05 identity/restore completion.
- R12 opens (migration ordinal 4, search FTS tables): FTS index over files
  + chat messages, policy-filtered visibility (fail-CLOSED per the hotfix
  posture), read-your-writes read-generation snapshot. Byte/behavior parity
  with the TS search where it exists.
