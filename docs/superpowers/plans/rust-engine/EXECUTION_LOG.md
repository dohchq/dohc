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

- R12 search GATE PASSED (PR #163, squash-merged; branch deleted). Two-lens
  adversarial cell: Reviewer 1 (no-leak) APPROVED via its own leak_probe
  (hidden/secret/.dohc content never written to the FTS table; secrets
  architecturally excluded; fail-closed; chat-scoped). Reviewer 2
  (crash/bounds) found a P1 the security lens could not see: the shard's
  atomic-rebuild guarantee only held under `write_with`, but `search_workspace`
  runs via `read_with` (autocommit), so a first-search-of-unindexed-version
  crash left a torn FTS index the granular reader then served. FIX: the whole
  rebuild (FTS wipes + inserts + state row) now runs in its OWN `SAVEPOINT`,
  atomic + crash-safe on ANY connection incl. autocommit; regression
  `read_with_rebuild_is_atomic_across_mid_rebuild_crash` proves it (new
  `search.mid-rebuild` fault point). Plus P2s fixed: orphan chat thread now
  SKIPS (was: hard-error → disabled ALL search workspace-wide); durable
  `file_policy_degraded` marker so a stable broken files.toml is a cheap
  early-return (was: re-indexed chat FTS every query); quadratic chat preview
  → group-once; preview offsets made explicit UTF-8 bytes (+astral test);
  over-long query fails closed. 0 unaddressed bot P0/P1; sources scanned
  clean of control bytes; run-rust-checks green 3×.
- **WAVE 2 COMPLETE**: R04 storage core + CAL-1/2/3 + R08 secrets + R11a ydoc
  + R09 chats + R12 search all on main, each cross-engine-verified by the
  2-reviewer cell. 8 engine crates on main. Review cell has now caught 12+
  P1/Critical bugs (second-writer fork, fence mutation, fork-provenance
  corruption, 2 false-deletes, plaintext-in-logs leak, lineage-destroying
  regime bug, dispatch deadlock, torn-index-on-crash) + 3 latent bugs in the
  shipping TS product — every one before a downstream consumer.
- Wave 2 tail + Wave 3 open, ready-now frontier launched in PARALLEL (disjoint
  path ownership, worktree-isolated codex impl agents):
  - **R05** (deps R04 ✓): COMPLETION shard — CAL-2 landed versions/moments/
    history/fork/restore and R04 landed blobs/identity, so R05 closes only the
    residual (identity hardening, restore edge cases, moments/binary
    completeness) against the inventory cluster. Unblocks R06, R07.
  - **R10** (deps R04 ✓, R09 ✓): replication/cursors/shares engine substrate
    (ordered-apply, read-your-writes, share-scoping fail-closed). Holds the
    R10b relay-epoch boundary. Unblocks R10b.

- R05 versioning-completion GATE PASSED (PR #165, squash-merged at migration
  ordinal 5; branch deleted; main migration ledger now len 6). COMPLETION
  shard: CAL-2 had landed versions/moments/history/fork/restore and R04
  blobs/identity; R05 closed the residual — `get_main_version`,
  `delete_text_file`, `rename_text_file`, and the `rollback_text_file_mutation`
  undo primitive. Two-lens adversarial cell (fork-lineage + migration/crash)
  INDEPENDENTLY CONVERGED on one P1: on a store migrated from pre-R05, ordinal 5
  backfilled `before_latest_moment_id` as NULL, blinding the rollback
  dependents-guard → rolling back a parent moment a child fork's preimage
  depends on was wrongly allowed → dangling `fork_base_snapshots` ref + the
  child wedged with StateCorrupt. FIX (proven fresh-parity): ordinal-5 migration
  now BACKFILLS the producer link via two correlated UPDATEs — same-version
  predecessor, then fork-inherited producer read directly from
  `fork_base_snapshots.latest_moment_id` (which `create_named_version` freezes
  from the parent's already-resolved snapshot, so it is transitively correct
  across multi-level forks with no recursive CTE). Defense-in-depth guards
  (fork_base_snapshots reference + fail-closed on any residual NULL-link
  concrete-preimage row) make any backfill miss degrade to a REFUSED rollback,
  never corruption. Plus P2s: idempotency-ledger row cleared in the rollback txn
  (stale exactly-once retry no longer replays a foreign write); dependents scan
  bounded to the <=N fork-point orders (was O(total history)). Legacy-unset
  write-rollback parity divergence recorded in BEHAVIOR_DELTA.md §11.1
  (Rust stricter, deliberate). delete/rename crash-fault coverage added
  (before-persist + after-commit, reopen-verified). 7 new tests. green 2x;
  control-byte clean.
- **DEFERRAL → R07 OBLIGATION (tracked):** `rename_text_file`'s destination is
  validated by the generic path validator but NOT the secret-path floor (TS
  parity for `versions-rename-text-file` reruns the destination secret-floor).
  The Rust secret-path floor is R07's to build; the codex bot (P1) and reviewer
  1 both flagged it. Deferral is SAFE, not a gate-weakening: the Rust engine is
  dormant (not canonical until the R15 cutover), the TS engine keeps its floor
  while canonical, and R07 lands before cutover. Recorded on the R07 SHARDS row
  as `OBLIG:gate-R05-rename-dest-through-secret-floor` — R07 MUST cover the R05
  rename entry point (and the pre-existing write entry points) before it can
  gate-pass. Also carried: FTS-row cleanup on delete/rollback → R13/R13b
  composition (R12 layering; write_text has the same posture).
- Merge serialization (ordinal collision): R05 and R10 were built in parallel
  off the same main and both claimed ordinal 5. R05 was clean first → merged at
  ordinal 5. **R10 must rebase onto this main and take ordinal 6** (its testkit
  migration_ledger_len assertion 6→7) before it can merge.

- R10 replication/cursors/shares GATE PASSED (PR #166, squash-merged at
  migration ordinal 6 after the R05/R10 ordinal-5 collision was serialized;
  branch deleted; main migration ledger now len 7). New crate
  `crates/dohc-engine-sync` (14 modules): ordered/idempotent compound-commit
  apply, LWW convergence, share fail-closed, R10b relay-epoch boundary held,
  R11a CRDT constraints preserved. Two-lens cell: Reviewer 2 (crash/migration/
  CRDT) APPROVED — PROVED the Y.Doc-apply extraction equivalent (44 real
  yjs-13.6.30 fixtures through old+new paths, state-vector AND plaintext
  equality; the only OffsetKind::Utf16 site + durable.rs byte-unchanged) and
  reproduced all 5 crash-reopen results. Reviewer 1 (share/apply) found a P0:
  the SharedChannel receiver boundary failed OPEN when the channel selector
  field was absent (and message/reaction/decision/attachment payloads never
  carry one → the check was ALWAYS vacuous for them → probe-confirmed
  cross-boundary chat leak). FIX: enforcement moved inside the write txn and
  now requires a positive channel binding per op — channel.create/thread.create
  must carry the granted wire id (absent → deny, no channelSlug placeholder
  bypass); message/reaction/decision/attachment RESOLVE thread_id → channel_id
  → wire_id in-store and require equality; mirrors filterChatOpForChannelShare.
  Then a bot-finding triage round (my check-before-merge rule): 8 codex-bot
  threads — 5 FIXED with TS-oracle citations + tests (apply.rs dedup-before-
  mutation byte-compare fail-closed; relay.rs foreign-workspace pull rejection;
  secret_apply.rs delete-tombstone anti-resurrection; feed-read ranking;
  reserved agent-channel biconditional), 2 DISMISSED on the clean-reset/
  schema_version=2 fence (no TS binary opens a Rust v2 DB; relay uses Postgres,
  never engine.db — so Rust-only DDL can't break a shipping path; same
  rationale as R08/R09/R11a timestamp columns), 1 DEFERRED to R13b with proof.
  Codex re-review of the fixes posted nothing in an 8-min window; UNSTABLE was
  solely CodeRabbit's rate-limit failure (non-substantive). green 2x.
- **DECISION FLAG FOR ICE (freeze boundary, reversible):** R10 modified three
  FROZEN TS-engine files — `packages/workspace-engine/src/{enginePathFloor,
  linkedChatStore}.ts` and `services/sync-relay/src/shareFilter.ts` — but ONLY
  as behavior-preserving EXTRACTIONS into a new shared `@dohc/security-contract`
  package, leaving compatibility re-export shims behind (identical values +
  logic; TS typecheck + the contract's vitest pass). Purpose: decouple the
  relay from engine internals AND give the Rust differential fixture a shared
  source-of-truth to validate the security floor against. This is in tension
  with Ice's "don't touch the TS engine" instruction; accepted here because it
  changes no behavior, is load-bearing for the cross-engine parity proof, and
  reverts trivially (invert the dependency: contract package imports FROM the
  unmodified engine). Bringing to Ice for review/veto; not blocking downstream.
- R10b (relay-epoch-enforcement, deps R10 ✓) is now UNBLOCKED. R06
  (compare/merge/conflicts, deps R05 ✓) and R07 (watcher/reconcile/pathfloor/
  policy, deps CAL-3 ✓, R05 ✓ — carries the R05 rename-secret-floor OBLIG)
  launched in PARALLEL from this main (which already includes R05+R10, so their
  migration ordinals serialize cleanly after 6). R10's deferred
  versions-replication-apply-conflict is blocked on R06's conflict-object
  primitive — R06 unblocks it.

- R07 watcher/reconcile/pathfloor/policy GATE PASSED (PR #169, squash-merged;
  NO migration ordinal — files-side/in-memory, no collision with R06 ordinal 7;
  branch deleted). Ported the notify-backed watcher, tolerant/degraded scan
  (corrected CAL-3 whole-pass abort → BEHAVIOR_DELTA §11.1), the secret-path
  floor classifier (policy.rs, platform-independent port of
  @dohc/security-contract), two-phase apply-then-ack capture, files-side fault
  seam. DISCHARGED the R05 rename-secret-floor OBLIGATION (rename to_path now
  refused when secret-classified). Cell: Reviewer 1 (secret-floor) APPROVED via
  a 30,672-path differential — 0 secret→tracked leaks, byte-parity with the TS
  oracle, both gates fail-closed, deferred Check-B proven secret-floor-safe.
  Reviewer 2 (capture/false-retire) proved apply-ack exactly-once crash-safety
  + /-boundary-precise false-retire hold, found two P1s: (1) a STALE reconcile
  plan's destructive ops reached the sink BEFORE the staleness guard →
  CAL-3-class false-delete via the public API — FIXED (validate generation+epoch
  before the sink loop + single-outstanding-plan invariant); (2) plaintext store
  door rejected only Secret, letting reserved/ignored/traversal (DOHC~1 8.3
  alias of .dohc, node_modules, .git, shared-with-me, %2e%2e) into plaintext
  history — FIXED to accept only Tracked on the normalized path, matching TS
  validateUserWritePath. HARD GATE fix: cargo-deny FAILed on notify's ISC/CC0-1.0
  inotify deps (impl agent's first 'green' missed it) — added ISC + CC0-1.0 to
  deny.toml allow, re-verified all five stages incl cargo-deny green 2x. P2s:
  read-side win32 ADS-colon rejection (.env::$DATA latent secret-alias) closed;
  degraded-retry thrash backoff added. Bot-finding round: 2 codex-bot
  correctness bugs FIXED — hard-deadline drain (settle reset could postpone the
  WATCH_HARD_DEADLINE indefinitely under an event storm) and file→dir
  replacement never retired (StdAbsenceProbe made tri-state). Deferred to R14
  (recorded on R14 row): watcher auto-reattach, startup deadlines +
  force-reconcile-on-restart, manifest rehydration. green 2x.
- R05 rename-secret-floor OBLIGATION: DISCHARGED by R07.
- NOTE (fixed process slip): the first R07 integrator PR (#171) was branched off
  a stale main and closed CONFLICTING; re-applied cleanly here. No content lost.

- R06 compare/merge/conflicts/materialization GATE PASSED (PR #170,
  squash-merged at migration ordinal 7 `v1-conflicts`; ledger now 8; branch
  deleted). Built three-way compare/merge (verbatim mergeMarkdown.ts port), the
  reusable conflict-object primitive R10 will consume (insert-if-absent,
  live-head-match gate, update-row), and closed the materialization-enqueue gap
  for merge/resolve writes+deletes through R04's &Transaction choke point.
  Two-lens cell BOTH APPROVED (no P0/P1): Reviewer 1 (merge/conflict) ran a
  5,533-triple TS-vs-Rust merge differential (0 mismatches) + 7/7 clobber probes
  refused; Reviewer 2 (materialize/migration) proved the ordinal-6→7 forward
  migrate on a populated materialization_jobs table (a queued pre-R06 write can
  never be misread as a delete) + materialize_delete crash-safety. Fix batch
  (all P2, pre-merge because 2 were freeze-timing): materialize_delete now
  sync_parent_dir before mark-complete (durability, was resurrection-on-crash);
  conflicts table converted REAL→INTEGER + STRICT matching R08/R09/R11a/R12;
  ConflictContentKind::Binary made explicitly fail-closed. Codex-bot triage:
  the 'persist side blobs' P2 was a real TS-parity divergence FIXED (TS calls
  putBlob per text side; the primitive only copied the sha → would FK-fail for
  R10's replicated conflict.open) — important for R10 consumption; the
  empty-base-fork 'P1' was correctly kept as FAITHFUL TS PARITY (identical
  fork-base-not-found guard in TS — no divergence without cause; integrator
  ruling: keep parity). green 2x.
- Merge-order note: R06 branched before R07 (#169) merged, so #170 went
  CONFLICTING. Resolved by merging main — the SEMANTICALLY tricky conflict was
  in store.rs write_text/delete_text_file: R07 added its secret-floor
  enforcement INLINE there, while R06 had refactored those bodies into shared
  write_text_in_tx/delete_text_in_tx helpers that merge/resolve reuse. A naive
  union would have SILENTLY DROPPED R07's floor (re-opening the plaintext-door
  P1); instead R07's floor was threaded into the shared helpers, so it now
  covers direct writes AND merge/resolve writes (strictly better). Verified:
  merge.rs/conflicts.rs write+delete sites all route through the floor-checked
  helpers; R07's floor tests + R06's 8 merge tests all pass. No ordinal
  collision (R07 consumed none; R06 stays ordinal 7). ledger 8. cargo-deny PASS
  (R07's ISC/CC0-1.0). green 2x.
- **FOLLOWUP OBLIGATION (tracked on R10 row):** R10's deferred
  versions-replication-apply-conflict-open/-resolve is now UNBLOCKED (R06's
  conflict primitive exists). When implemented it MUST handle binary conflict
  sides — R06 gated ConflictContentKind::Binary fail-closed, and the side FKs
  pin to the text blobs table, so binary mirror-apply needs the schema/primitive
  extended (R06 rev1 finding). Schedule as a small R10-conflict-apply follow-up
  or fold into R13 composition.
- **WAVE-3 DOMAIN COMPLETE**: R10 (replication) + R06 (merge/conflicts) + R07
  (watcher/pathfloor) all merged. All engine domains + calibration on main.
  Remaining Wave 3: R10b (relay epoch, deps R10 ✓), R11b (TS live Y.Doc adapter,
  deps R03;GATE0 ✓), R13b (dormant desktop adapter, deps R03;GATE0 ✓) — the
  TS/services-side adapter shards. Then R13 composition (deps all), R14
  robustness, GATE6, R15-REHEARSE, R15 cutover (USER checkpoint), R16.

- R10b relay-epoch-enforcement GATE PASSED (PR #174, squash-merged; no engine
  migration — TS relay service; branch deleted). Server-side epoch/stream-
  identity rejection at the sync-relay push/pull/claim endpoints + a new
  owner-only epoch-rotation route + durable supersession table, mirroring R10's
  first-write-wins-then-immutable model. Two-lens cell BOTH APPROVE-WITH-FIXES
  (no P0): Reviewer 1 (enforcement soundness) proved no cross-principal bypass /
  impersonation / replay / privilege-escalation (6 probes) and gave the reasoned
  verdict that the opt-in field-omission bypass was OWNER-ONLY self-harm (P2, the
  owner already has full write authority over their own bucket; epoch/stream are
  replication coordinates, not authz). Reviewer 2 (no-false-reject/durability)
  proved restart durability, crash-mid-rotation atomicity, migration-forward, and
  no-false-reject (100 pushes + 20 rotations), and found the key P1: a never-
  superseded (typically NEWER) epoch was misreported as `epoch_superseded` →
  a fresh-reset client told to discard its own data (data loss). Fix batch:
  distinct 409 `identity_not_recognized` for unknown/newer coords vs
  `epoch_superseded` only for proven-superseded (P1); enforcement now MANDATORY
  once an identity is established (`identity_required` — closes the owner-only
  bypass, free since honest clients always send identity); claim only on a
  SUCCESSFUL request + GET is read-only (was: a rejected push / bare GET stamped
  identity); full (epoch,stream) supersession keying so rotate-back can't
  resurrect + injected clock; SELECT-before-write-lock on the hot pull path;
  idempotent rotation retry (200 {rotated:false}); identity-enforce routed
  through appendLogBatch's guard for atomicity. Plus two in-scope codex-bot
  findings: **F8 epoch_log_floor** — a fresh client pulling since=0 under a new
  epoch would otherwise replay pre-rotation ops (resurrection-via-sync the plan
  warns of, i.e. epoch enforcement would be trivially bypassable); rotation sets
  floor=MAX(relay_seq) and identity-bearing pulls clamp to it. F9 512-byte
  identity caps + supersession quota. 216/216 tests. R10b unblocks the GATE6
  path.
- **OBLIGATION → R15 reset workflow (ICE DECISION):** member `share-log` appends
  remain un-epoch-gated (documented in-code as the deliberate R10b boundary —
  members are authorized share participants under the namespaced
  `share:<id>:<origin>` origin + fail-closed share filter, NOT the owner's
  workspace replicas). Open product/security question for the reset/cutover
  workflow: should an owner's epoch rotation (device reset) SEVER a live
  read-write share member's sync, or may the member keep appending? Recorded as
  an OBLIG on the R15 row; needs Ice's semantics call when the reset workflow is
  designed.
- Wave-3 adapter progress: R10b ✓ merged. R11b (TS ydoc adapter, #175) in
  adversarial fix round (2 P0 caught: an observer-throw that permanently wedged
  the Y.Doc, and an isWellFormed check structurally unable to catch surrogate-
  split lineages that diverge yjs↔yrs per R11a's pinned cross_engine.rs). R13b
  (dormant desktop adapter) queued behind R11b.

- R11b TS live Y.Doc adapter GATE PASSED (PR #175, squash-merged; DORMANT — new
  package @dohc/workspace-engine-client, no existing shipped file touched except
  the required pnpm-lock.yaml; branch deleted). The client-side adapter
  connecting live Yjs editing to the Rust Y.Doc engine over the R03 protocol,
  honoring all 5 yrs-spike constraints. Two-lens cell + a P0-fix RE-VERIFY — the
  deepest review of the program because this is the CRDT-safety boundary all
  durable-document integrity rides on at cutover. Found + fixed 2 P0s: (P0-1) an
  IllFormedUtf16EditError thrown from INSIDE the yjs update observer permanently
  wedged _transactionCleanups → all later edits silently never journaled →
  fixed to reject-and-quarantine, never throwing in the observer (throw moved to
  runLocalMutation after the txn); (P0-2) the isWellFormed check scanned the
  post-transaction string, but yjs sanitizes a surrogate-split to well-formed
  U+FFFD while the WIRE LINEAGE still diverges yjs↔yrs (proven vs R11a's pinned
  cross_engine.rs:264: yrs "😀X" vs yjs "�X�") → fixed with pre-transaction
  structured-edit detection (lone-surrogate + pair-split index) + an opaque
  before/after backstop. The re-verify (reviewer who found P0-2 re-attacked the
  fix) caught a surviving MASKED-split bypass: the backstop's aggregate-U+FFFD-
  count heuristic missed a split masked behind offsetting U+FFFD deletions in the
  same txn (confirmed vs the real yrs engine) → fixed with EXACT deleted-U+FFFD
  accounting via a gc:false tombstone-retaining Y.Doc clone (reject any net-new
  U+FFFD regardless of offsetting deletes; verified no over-rejection). Also
  fixed: ingress bypasses (non-schema roots + Y.Text attrs/embeds now covered),
  lost-update silent fork (now surfaces via onSessionError + settle fails closed;
  Event.seq gap → resync-needed), lockfile (frozen-lockfile CI install; the
  desktop-release/docs workflows DO run on packages/** PRs — 'skip GitHub CI'
  was only the Rust matrix), + P2s (loopback validate/reject, feature-detected
  isWellFormed, event-decode error channel, recordUpdate idempotencyKey). 21
  tests. Converging-prefix + offset fidelity PROVEN to hold throughout.
- **HARD R13 OBLIGATIONS (recorded on the R13 row):**
  1. **engine-side yjs↔yrs replay-parity gate — REQUIRED before any live editing.**
     R11a's Ydoc::apply (crates/dohc-engine-collab/src/ydoc.rs:169-179) accepts
     any decodable update with NO divergence gate today. The R11b TS backstop is
     exact for the maskable class but CANNOT reconstruct arbitrary opaque splits;
     the general guarantee MUST be an engine-side replay-parity/divergence gate
     at R13 before the encoded editor path journals, else a crafted opaque split
     corrupts the durable doc silently at cutover. Regression fixture ready
     (reviewer's bypass1_probe.rs pattern). This is the real CRDT-safety backstop.
  2. R10-conflict-apply must handle binary conflict sides (from R06; R06 gated
     ConflictContentKind::Binary fail-closed).
- **WAVE 3 nearly complete**: R10 ✓, R06 ✓, R07 ✓, R10b ✓, R11b ✓ merged. Only
  R13b (dormant desktop adapter) remains before R13 composition.

- R13b dormant desktop adapter CORE GATE PASSED (PR #178, squash-merged; branch
  deleted). Landed strictly DORMANT: the desktop engine-client (DOP1 frame codec
  + R11b EngineTransport over R03), a default-OFF flag (`DOHC_RUST_ENGINE_ADAPTER`,
  read by no live code), and the Rust ydoc provider entry — plus inert optional
  seams on relaySyncEngine/workspaceActivity/workspaceEngineCapture. Two-lens
  cell: Reviewer 1 (dormancy) APPROVED — proved (grep coverage + per-edited-file
  inertness + no import-time side effects + new dep tree-shaken out of the bundle
  + pre-existing failures reproduced identically on origin/main: 20/20 same split,
  +15 net-new passing) that the shipping desktop product is behaviorally
  unchanged. Reviewer 2 (frame codec) proved the codec CORE solid (byte-exact
  reassembly at every split; 4GiB rejected from the header; sticky poison;
  correct correlation/handshake/events) but found lifecycle bugs: (P0) fail()
  detached the connection 'error' handler before destroy(), so Duplex.from(child)
  .destroy()'s AbortError would hit uncaughtException → Electron-main crash on
  EVERY teardown (the no-op FakePeerConnection masked it) — FIXED with a permanent
  no-op error listener + a REAL-stream teardown regression test; (P1) receiveEnvelope
  /acceptHelloAck didn't check this.closed, so a helloAck co-chunked after fail()
  resurrected readyState and delivered events to subscribers — FIXED with closed
  guards + frame-loop break; plus P2s: inbound `batch` now UNWRAPPED (bounded by
  maxBatchLen), maxFrameBytes floor (64 KiB) rejected at handshake, limit-clamp
  co-chunk race closed. 18 engineClient tests. Dormancy preserved throughout.
- R13b DEFERRED surfaces (tracked as new row R13b-rest, dormant, land with/before
  R13): main.ts wiring, cli/**, packages/mcp/**, the workspace surfaces
  (sharedView/sharedChannels/shareMounts/workspaceFiles/workspaceSearch/
  workspaceGraph), BlobChunk streaming. The real Rust sidecar binary + the
  engine-side replay-parity gate are R13.
- **WAVE 3 COMPLETE.** All engine domains (storage, versioning, files/watcher,
  secrets, ydoc, chats, search, replication, merge/conflicts) + the TS/services
  adapter layer (relay epoch enforcement, TS ydoc adapter, dormant desktop
  adapter core) are on main, each cross-engine-verified by the 2-reviewer cell.
  Next: R13 daemon composition + shadow replay (all deps satisfied) — must
  discharge the engine-side ydoc replay-parity gate + R10 conflict-apply binary
  + compose the real sidecar the R13b adapter talks to. Then R14 robustness,
  GATE6, R15-REHEARSE, R15 cutover (ICE checkpoint), R16.

- R13 daemon-composition + shadow-replay GATE PASSED (PR #180, squash-merged at
  migration ordinal 8 `v1-shadow-clone`; ledger now 9; branch deleted). THE
  composition: new `crates/dohc-workspace-engine` (in-process EngineService +
  auth-gated DOP1 stdio daemon, R03 supervisor, bounded queues) serving
  workspace.open/close, versionedText.write/read, ydoc.apply, conflicts.*,
  search.query — SINGLE-WRITER preserved (one actor-owned EngineStore, proven).
  Effective owned_paths expanded to `dohc-engine-runtime/**` (additive
  supervisor/actor to serve domain ops without a 2nd writer) + `dohc-engine-
  collab/**` (the replay-parity gate). This was the DEEPEST review of the
  program (the CRDT-safety gate the cutover rests on): 2 reviewers + 4 gate
  re-verifies + multiple Codex/CodeRabbit rounds.
  * Composition/single-writer/shadow-fence/auth: APPROVED against the real
    daemon binary (single-writer audit, 40-concurrent-write, fence refuses every
    malformed marker, auth rejects before-hello/wrong/empty, bounded queues shed
    load 165+836-OVERLOADED, additive-runtime regression clean).
  * Replay-parity gate (the CRDT-safety backstop): APPROVED sound-for-shadow
    after a saga — a P0 false-negative (overlap-slice divergence) fixed via
    candidate-clock-coverage; then Codex found park-pending interactions
    (mixed-pending coverage bypass, compaction-prunes-parked, parked-interior-
    split, mirrored-resolve-content) all fixed; then a fix ROUND REGRESSED it
    (differential 6->596 via a mid-pair-delete hole + 41/3000 yrs panics),
    both fixed (restored base∪candidate delete-boundary check; wrapped the gate
    in catch_unwind->ReplayParityViolation). FINAL re-verify: divergences back
    to 13 (all the tracked hostile-peer resend-re-encode content-parity class;
    honest-only 37k-update corpus = 0 divergences/0 rejections/0 panics), zero
    escaping panics, no false positives. Sound for the dormant/shadow scope.
  * Snapshot-hash integrity (CodeRabbit Critical): local conflicts.open accepted
    the client's blobSha256 unchecked -> could write a corrupt (sha,text) pair;
    now verified before any durable write. + 3 conflict-apply integrity fixes.
  * Replicated mirrored-resolve scoped to a SAFE subset: apply-incoming-text
    converges; path-change/merged/stale-head/binary/divergent all ACK-and-defer
    (Ok + advance the peer ack so replication converges, no content, leave the
    conflict Open for reconciliation) — NEVER Err-rollback (which would halt
    replication) and NEVER a wrong apply. Local resolve made idempotent via the
    ledger. The contract-diverging `resolvedText` requirement removed.
  * Shadow fence hardened: migration ordinal 8 stamps a `shadow_clone` token
    (empty in real stores) verified before any write, closing the marker-only +
    validate->open TOCTOU (a real v2 store under a valid marker is refused).
  404 tests, green 2x. `#![forbid(unsafe_code)]`, no unwrap/expect/panic in
  non-test, single-writer preserved.
- **TRACKED OBLIGATIONS from R13 (recorded on SHARDS rows):**
  1. **GATE-COMPLETE (new row, CUTOVER-GATING, on R15's dep list):** before any
     LIVE editing at cutover, close the 13-seed resend-re-encode +
     parked-delete-in-dependency-scalar content-parity residual (hostile-peer-
     only) AND root-cause the yrs slice.rs:282/store.rs:234 unwinds (catch_unwind
     currently CONTAINS but masks them — a future honest input that unwinds yrs
     would be silently rejected). Acceptance test = the reviewer's inductive
     gate-driven differential (`adversarial_inductive_probe.rs` DOHC_SEQS) at 0
     genuine divergences + the 13 seeds as regressions. Also the perf redesign
     (O(doc)-per-append -> cached/incremental base). R15 now deps GATE-COMPLETE.
  2. **R10-CONFLICT-COMPLETE (new row):** full mirrored-resolve semantics
     (path-change, merged content, stale-head reconciliation, binary content);
     R13's ACK-flagged Open conflicts + imported resolve ops are the substrate.
  3. **BINCONFLICT (new row):** binary conflict-side schema/persistence (migration
     ordinal 9).
  4. R14 gains the 3 R13 daemon-liveness items (cancellable admission, halt-on-
     writer-failure, drain-before-close) alongside the R07 watcher-hardening.
- **WAVE 4 (composition) — R13 DONE.** The Rust engine is a working shadow-mode
  daemon on main: all domains composed, gate sound-for-shadow, single-writer +
  shadow-fence + auth proven. Remaining: R14 robustness (fuzz/soak + the
  deferred liveness/watcher items), GATE-COMPLETE + R10-CONFLICT-COMPLETE, GATE6,
  R15-REHEARSE, R15 cutover (ICE checkpoint: cutover scope + dogfood reset +
  member-share-reset semantics), R16 legacy deletion. R13b-rest (desktop adapter
  remaining surfaces) also pending.

- **GATE-COMPLETE (ydoc replay-parity gate completion) GATE PASSED (PR #182,
  squash-merged; no migration).** THE cutover-gating CRDT-safety milestone. The
  gate now rejects the full divergence surface — string surrogate-split,
  overlap-slice/coverage, mid-pair delete/insert boundaries, AND cross-type +
  same-kind-different-payload redefinitions (a per-clock ClockIdentity:
  StringUnit / Typed{kind,sorted-key-canonical-fingerprint} / Tombstone, with a
  delete-set distinguisher so honest delete+GC+resync is NOT false-rejected) —
  and root-causes the yrs internal unwinds (eliminated the scratch.diff store.rs
  path + rejects zero-length blocks; catch_unwind demoted to backstop). Also
  fixed a latent yrs ContentJson decode off-by-one (scan reads count+1).
  Authoritatively verified by the gate reviewer against its inductive
  differential on BOTH the original and a FRESH independent 3000-seq/37k-update
  corpus: 0 genuine divergences, 0 escaping panics, 0 internal unwinds, all 13
  residual seeds reject, cross-type LIVE redefinitions reject, AND 0 honest
  false positives (the delete+GC+resend regression that spiked to 17%/33% was
  closed and re-verified to 0/0). The tracked pre-cutover content-parity
  completion obligation is DISCHARGED; R15 dep GATE-COMPLETE satisfied.
- R14 robustness-closure GATE PASSED (PR #183, squash-merged; new `file-id` dep,
  lockfile consistent, cargo-deny green). Discharged the 6 deferred hardening
  items (R13 daemon-liveness: cancellable admission, halt-on-writer-failure,
  drain-before-close; R07 watcher: auto-reattach+WatcherUnavailable, startup
  deadline, manifest rehydration) + a proptest fuzz harness (framing/ydoc/
  replication/secret-apply) + a soak smoke test. Two-lens cell: found + fixed
  3 P1s — a watcher root delete+recreate silently-missed-changes hole (fixed via
  file-id root-identity compare + reattach), a transport read-ERROR path that
  skipped drain/close (R13 abandoned-workspaces bug surviving on the error path;
  fixed to fall through the drain/close tail), and an unbounded request JoinSet
  (fixed with per-iteration reap) — plus a droppable-reattach-signal codex P1
  (sticky AtomicBool) and fuzz hygiene (real assertions, secret_apply family).
- **NEW CUTOVER-GATING OBLIGATION — YRS-ABORT-SAFETY (new SHARDS row, on R15's
  dep list):** R14's fuzzing CONFIRMED (reviewer-reproduced) that yrs 0.27.3
  `Update::decode_v1` HARD-ABORTS the process (uncatchable UB, 0xc0000409
  STATUS_STACK_BUFFER_OVERRUN "invalid value for char"; a non-unwinding panic
  that `catch_unwind` does NOT catch — INCLUDING the gate's own AssertUnwindSafe)
  on malformed bytes, and in RELEASE builds the debug precondition check compiles
  out → SILENT UB / memory corruption. Reachable on untrusted input via TWO
  unguarded paths: hostile-peer replication (apply_remote_update→validate_update
  _bytes→decode_v1) and a malformed local ydoc.apply (reachable today against a
  shadow workspace). REQUIRED before any live/remote Y.Doc ingestion: a
  byte-level well-formedness pre-validator before EVERY decode_v1 site, OR a yrs
  upgrade/upstream fix. Acceptance = R14's #[ignore]d 41-byte `known_crash_
  witness_yrs_char_decode_ub` + the ydoc fuzz family. R15 now deps
  YRS-ABORT-SAFETY.
- **WAVE 5 (robustness) — R14 + GATE-COMPLETE DONE.** Remaining tracked
  obligations before/around cutover: YRS-ABORT-SAFETY (cutover-gating),
  gate-perf redesign (load_for_replay_gate cached/incremental — GATE-COMPLETE
  removed 2 of 3 O(doc) ops), R14-deferred (WatcherUnavailable production wiring,
  open-after-close race, full soak runner), R10-CONFLICT-COMPLETE,
  BINCONFLICT, R13b-rest, member-share-reset semantics (ICE). Remaining path to
  cutover: GATE6 (deps R14 ✓, R10b ✓, R15-REHEARSE), R15-REHEARSE (deps R13, R14
  ✓), then R15 cutover (ICE checkpoint), R16.

## 2026-07-18 — YRS-ABORT-SAFETY merged (#185) · R15-REHEARSE in review

- YRS-ABORT-SAFETY #185 MERGED (squash; no migration). THE cutover-gating
  abort-safety milestone: yrs 0.27.3 `Update::decode_v1` HARD-ABORTS the
  process (uncatchable UB, `catch_unwind` does not stop it; SILENT UB in
  release) on malformed update bytes, reachable via hostile-peer replication
  and local `ydoc.apply`. Closed with a byte-level well-formedness
  PRE-VALIDATOR built on `replay_parity::scan_v1` (never calls `decode_v1`,
  never uses yrs' unsafe string decode), wired FIRST at every `decode_v1` site
  (`Ydoc::validate_update`, `Ydoc::apply`, `merge_updates`) and again at the
  durable `validate_update_bytes` choke point. The R14 41-byte crash witness is
  un-ignored and passes fail-closed; new never-abort proptest families
  (arbitrary/mutated/nested-Any/structured-parser-deep) run at proptest-default
  in the gate and scale to 20k cases via `PROPTEST_CASES`.
- Review caught (2 local fable reviewers + CodeRabbit + Codex, 3 fix rounds
  before merge — every finding real):
  - P0 (BOTH local reviewers, independently reproduced) — unbounded
    `safe_read_any` recursion → uncatchable STACK OVERFLOW via deeply-nested
    `ContentAny`/sub-doc (2 wire bytes/level, ~KB reachable on the replication
    path). Fixed: `MAX_ANY_DEPTH=128` + `nested_any_never_aborts` proptest.
  - P1 (Codex, past CodeRabbit's approval) — `safe_read_client` applied the
    53-bit mask to yrs' `read_var::<u64>` output, but yrs decodes with
    `wrapping_shl` and only errors past 70 bits, so an OVERLONG/padded wire
    client id (`2^70+n`) wraps to `n` and aliased honest client `n`. Fixed:
    read the client LEB128 groups CANONICALLY, fail closed on non-minimal
    terminator / >8 groups / value >2^53-1 (stricter than yrs, no false
    positives).
  - Major (CodeRabbit) — the content-parity fingerprint used the LOSSY
    `any_to_json` projection (collapses BigInt/Number, Null/Undefined,
    Buffer/`{__bytes__}`), so a hostile re-encode could share a fingerprint.
    Fixed: tagged variant-preserving `append_canonical_any`.
  - P2 (Codex) — hashing raw sub-document `Options` false-REJECTED honest
    full-state resends (yrs fills option defaults on re-encode). Fixed:
    ContentDoc fingerprint is GUID-only (the subdoc identity); options still
    consumed+validated for wire position.
  - + P2/P3: `merge_updates`/`diff` state-vector pre-validation, the redundant
    durable double-scan removed, and the fuzz `validate==apply` equality
    dropped (validate only decodes; apply also integrates — not a valid
    invariant). collab 27+17 + ydoc fuzz 9/9 green; run-rust-checks PASS.
- R15 dep YRS-ABORT-SAFETY satisfied. Remaining cutover-gating: R15-REHEARSE
  (PR #186, in review — multi-round bot hardening of the cutover state machine:
  resume-precondition re-verification, live-db reset-identity proof,
  alias-escape fences, prove-zero-handles, Unix durability fsync ordering),
  then GATE6, then R15 (ICE checkpoint).

## 2026-07-18 — R15-REHEARSE merged (#186) · both cutover-gating shards done

- R15-REHEARSE #186 MERGED (squash; no migration). The cutover state machine,
  rehearsed SHADOW-ONLY against clone-marked fixture roots (never real data):
  not-started → settled → backed-up → moved-aside → initialized → capturing →
  complete (+ durable terminal failed), resumable from a temp-then-rename
  marker. Proves the fences the real R15 cutover reuses: rehearsal fence
  (SHADOW_CLONE marker AND a rehearsal token; validate_rehearsal_root the sole
  entry), prove-zero-handles move-aside (Windows exclusive no-share handles /
  POSIX flock through copy+verify on the engine.db/-wal/-shm triplet),
  restore-tested backup (VACUUM INTO + integrity_check + row-count + read-back
  hash-compare, into a recovery dir OUTSIDE the clone), rollback-proof swap
  (post-move verify errors route through fail_swap → live triplet restored),
  pre-reset HashPool inventory compared at capture, reset-identity proof, and a
  bounded per-root lock. The real signed --cutover tier is stubbed (R15/ICE).
- Cell: 2 independent adversarial fable reviewers (each reproduced its P1 with
  probe tests) + 8 CodeRabbit/Codex rounds — every finding real, converging on
  rarer edges each round. Highlights caught before merge:
  - CRITICAL — `read_dir` followed a symlinked moved-aside dir → the live
    triplet could be moved OUTSIDE the clone root. Fixed by a systematic
    alias-audit: shared require_real_file / require_real_dir gates + SQLITE_OPEN
    _NOFOLLOW on every read-only DB open, routed through EVERY fs touch (files,
    dirs, sidecars, manifests, state records, lock, inventory, backup-DB
    sidecars).
  - P1s — resume never re-verified the backup (BackupFingerprint recorded +
    re-checked before the destructive move); live engine.db shadow_clone binding
    never verified before move-aside (a real workspace with both markers dropped
    in would get its triplet moved) → verify_live_clone_binding; reused/stale
    same-clone DB passing resume → reset-identity uuid read from the BACKUP DB
    bytes (not the editable manifest); WAL/SHM in the directory backup / beside
    the backup DB → excluded/gated.
  - Durability — Unix fsync ordering (moved-triplet parents, staging tree,
    recovery dir, rollback dir, state dir) so a marker can't outlive the data;
    retryable-vs-terminal split so a transient backup-read failure stays
    recoverable. 71 lib tests; run-rust-checks PASS.
  - MSRV: reverted std File::try_lock (1.89) to fs4 (workspace MSRV 1.85).
- Documented non-blocking real-`--cutover` follow-ups (in-source): residual
  path-based check-then-use TOCTOU (fd-atomicity), Windows owner-only DACL,
  Windows hard-link detection, SQLite writer-quiescence gate, empty-manifest
  minimal-clone relaxation, new-unbacked-engine-file mid-run, and 3 crash-window
  resumability edges — all fail-closed, out of the shadow-rehearsal threat
  model, and re-reviewed by R15 proper with a human checkpoint.
- Cutover-gating COMPLETE: YRS-ABORT-SAFETY ✓ (#185) + R15-REHEARSE ✓ (#186).
  Remaining path to cutover: GATE6 (deps R14 ✓, R10b ✓, R15-REHEARSE ✓ — now
  unblocked), then R15 (ICE checkpoint: cutover scope + dogfood reset +
  member-share-reset semantics). Non-R15-blocking, still open:
  R10-CONFLICT-COMPLETE, BINCONFLICT, R13b-rest, tracked obligations.

## 2026-07-18 — HOTFIX #189 (2 real YRS-ABORT-SAFETY DoS) · BINCONFLICT merged (#190)

- HOTFIX #189 MERGED (squash; no migration). Surfaced when BINCONFLICT's full
  run-rust-checks (on the post-#185 main) went red. Two problems, BOTH in the
  merged YRS-ABORT-SAFETY code, neither caught by that shard's own "green x2":
  1. **A real decode-reachable OOM DoS** — `scan_content`'s `ContentDeleted`
     arm looped `for i in 0..len { record_identity(Tombstone) }` where `len` is
     a wire-declared u32 (up to ~4.29e9) with ZERO input bytes consumed per
     iteration. A ~15-byte hostile packet (`len = u32::MAX`) OOMs the engine on
     the `apply_remote_update` pre-validator path (`scan_v1` runs on fully
     untrusted bytes). Seed-dependent, so the 256-case fuzz gate passed for some
     seeds. Fixed: tombstones recorded as O(1) half-open `[clock,clock+len)`
     ranges (`tombstone_ranges` + `tombstone_covers`); the dead
     `ClockIdentity::Tombstone` variant removed. Parity semantics PRESERVED (all
     20 cross-engine differential tests pass unchanged) + 2 `u32::MAX`
     regressions. Verified under a 512 MiB Job-Object cap at 20k cases/property.
  2. **A quadratic-CPU DoS (CodeRabbit)** — `tombstone_covers` AND the
     pre-existing `delete_set_covers` linearly scanned attacker-controlled range
     vectors per established live clock → O(clocks x ranges) CPU exhaustion.
     Fixed: `scan_v1` normalizes (sort+coalesce) both range maps once; both
     queries binary-search (`partition_point`) → O(clocks x log ranges).
  3. Plus a `cargo fmt --check` drift (2 YRS-ABORT-SAFETY files). LESSON:
     rustfmt/gate nondeterminism + seed-dependent fuzz can pass "green x2" yet
     leave main red/vulnerable — a downstream shard's full-workspace gate caught
     both. Consider a large-corpus (PROPTEST_CASES) fuzz run in the pre-merge
     gate for decode-path shards.
- BINCONFLICT #190 MERGED (squash; migration ordinal 9 `v1-binary-conflict-
  sides`, ledger len 10). The binary conflict-side SUBSTRATE: `conflicts` table
  REBUILT (create->INSERT..SELECT->drop->rename->reindex) to add
  `{base,current,incoming}_binary_sha256 -> binary_blobs(sha256)` FKs; content-
  addressed `put_binary_blob_verified` hydrate; R06's fail-closed
  `binary_conflicts_unsupported` gate lifted at the OPEN/PERSIST layer only
  (requires the binary_blobs row pre-exist). Binary RESOLVE/APPLY stays fail-
  closed (R10-CONFLICT-COMPLETE). FIRST table-rebuild migration in the codebase.
- Cell: 2 adversarial fable reviewers (migration-correctness: NO P0/P1, verified
  43-col preservation + FK/STRICT + rollback-to-v8 with probes; fail-closed:
  found the P0) + Codex (2) + CodeRabbit (4, APPROVED after fixes). Findings:
  - P0 (fail-closed reviewer) — `resolve_text_conflict` gated binary only per-
    path (KeepCurrent gated NOTHING, ApplyIncoming checked incoming only), so a
    binary-BASE conflict RESOLVED locally, overstepping into R10 and causing
    unrecoverable origin/peer divergence. Fixed: any-side-binary guard before
    the live-state gate (matches sync `has_binary_side`).
  - Codex — `put_binary_blob_verified` hashed untrusted bytes BEFORE the size
    cap (now BlobTooLarge before hashing); binary validation ran AFTER the
    duplicate-id shortcut → invalid binary open on a dup id got logged+acked
    (moved validation before the shortcut; sync regression proves no log/ack).
  - CodeRabbit — `(None,None)` state-equality ignored path (REACHABLE via a
    replicated conflict.open with a divergent per-side path; now path-checked);
    an absent text side carrying a blob ref is now `state-corrupt`; dedup
    `put_binary_blob` reads back + re-verifies the canonical row (INSERT OR
    IGNORE left a corrupt row + returned success); reason-exact probe asserts.
- Wave 5 status: cutover-gating COMPLETE (YRS-ABORT-SAFETY, R15-REHEARSE).
  BINCONFLICT done. Remaining pre-cutover: R10-CONFLICT-COMPLETE (now unblocked
  for the binary apply path — its isBinaryState branch consumes BINCONFLICT's
  schema), R13b-rest, tracked obligations. Then GATE6 (deps R14/R10b/R15-
  REHEARSE all met), then R15 (ICE checkpoint).

## 2026-07-18 — R10-CONFLICT-COMPLETE merged (#192)

- R10-CONFLICT-COMPLETE #192 MERGED (squash; no migration). Completes R13's
  ACK-and-deferred mirrored-conflict-resolve. Scoping insight (Explore pass):
  for path-change/merged/stale-head the R13 `deferred` behavior ALREADY matches
  the TS oracle (`applyMirroredResolve` refuses+surfaces, does not auto-apply) —
  so those keep deferring; the genuine functional gap was BINARY incoming apply,
  which BINCONFLICT (#190) unblocked. Two deltas:
  - DELTA 1: the sync mirror now APPLIES a resolved binary incoming side (mirrors
    the TS isBinaryState branch) — integrity-verifies the sha via get_binary_blob
    BEFORE closing (absent -> defer BinaryUnhydrated; present-but-corrupt/storage
    error -> Err, envelope rolls back; never a doomed job over an advanced ack),
    writes via the existing materialization ledger inside a savepoint (helper
    failure -> rollback + defer BinaryApplyFailed), never hand-rolled disk writes.
  - DELTA 2: structured PendingResolve{remote/local_conflict_id,path,reason
    (PathChange/Merged/StaleHead/BinaryUnhydrated/BinaryApplyFailed/UnmatchedTarget)}
    replaces the bare deferred:bool at every defer site; deferred() is derived;
    the dormant adapter (replicated_conflict_json + actor.rs) emits both.
  - Invariants preserved throughout (R13): never Err-rollback the ack for a
    VALIDATION rejection (poison-pill class — fixed for text too, see below),
    never a wrong/divergent apply, ack always advances on defer; STORAGE/
    CORRUPTION errors DO propagate as Err (validation-vs-storage split via
    is_apply_rejection, applied to BOTH text and binary paths).
- Implemented via codex/gpt-5.6-sol (fable subagents hit their usage limit;
  codex's sandbox couldn't create the target dir so it never compiled — I ran
  the real gate + committed). Cell: 2 adversarial OPUS-4.8 reviewers + 2 Codex
  rounds + CodeRabbit. Reviews caught (all real):
  - P0-class (rev1) — the sibling TEXT apply (`apply_mirrored_write`/`_delete`)
    Err-rollbacked the ack (validate_write/delete_input `?`), so a mirrored text
    conflict on a reserved/ignored path or >MAX_TEXT_BYTES became an infinite-
    redelivery POISON PILL stalling the peer cursor. Fixed: savepoint->defer
    (TextApplyRejected) like the binary path; genuine storage errors still Err.
  - rev2 P2 (oracle parity) — incoming binary DELETE deferred instead of
    deleting (routed on kind before existence); fixed to existence-before-kind.
  - Codex R2 — my over-aggressive S2 (presence-only has_binary_blob) let a
    present-but-corrupt blob close the conflict + enqueue a doomed job; restored
    integrity-at-resolve. Non-sync hydrated binary was false-deferred
    BinaryUnhydrated; fixed to close. Unmatched resolve now surfaced
    (UnmatchedTarget, best-effort informational — documented as not crash-durable
    since there's no local state to reconcile). Declined a CR object-id-scoping
    finding as a verified false positive (file_objects.object_id is GLOBALLY
    unique per the canonical oracle schema).
- NEW OBLIG — BINARY CONTENT HEAD REPRESENTATION (firm GATE6/R15 blocker,
  DORMANT-only). Three R10CC gaps share one root cause: binary content has no
  in-db head/snapshot/moment (moments.after_blob_sha256 is a NOT-NULL FK to the
  TEXT blobs table). (1) M2 — the binary job's target_generation collides with
  the next moment because store::next_moment_order counts only moments, not
  materialization_jobs -> a stale binary can overwrite newer content on an
  out-of-order/retry drain; (2) the text-only live-state check reads a binary-
  occupied path (path_aliases, no snapshots row) as empty -> a mirrored resolve
  can wrongly pass the stale-head gate; (3) a later same-path text write becomes
  a spurious materialize-conflict. Fix = a binary-head schema change (migration);
  then un-ignore R10CC's binary_generation_is_not_reused_by_next_text_write.
- Wave 5 status: cutover-gating COMPLETE; BINCONFLICT + R10-CONFLICT-COMPLETE
  done. Remaining pre-cutover: R13b-rest, tracked obligations (binary-head,
  gate-perf, R14-deferred, fuzz coverage, shadow_fence harness-writer gating),
  then GATE6 (deps R14/R10b/R15-REHEARSE met), then R15 (ICE checkpoint).

## 2026-07-19 — BINHEAD merged (#194) · binary-content-head obligation DISCHARGED

- BINHEAD gives binary file content a real in-DB head — a `moment` +
  `snapshot` row with a `content_kind` discriminator and a separate nullable
  `binary_sha256 -> binary_blobs` FK (migration ordinal 10, BINHEAD) — rather
  than forcing binary through `moments.after_blob_sha256`'s NOT-NULL FK to the
  TEXT blobs table. This closes the binary-content-head class end to end:
  write/read_text/live-state, local + mirrored resolve, merge/version-compare,
  rollback, search, and normalize are all binary-head aware and fail closed
  wherever head identity is partial or absent.
- Discharges the firm GATE6/R15 obligation tracked on the R10-CONFLICT-COMPLETE
  row (M2 gen-collision + textless-live-state + post-apply-snapshot). Un-ignores
  R10CC's `binary_generation_is_not_reused_by_next_text_write` regression: the
  compensating/restore job now targets the write's own moment generation as a
  peer (G>G false), so a stale binary can no longer overwrite newer content.
- Five adversarial review rounds; every finding was a genuine correctness bug,
  not style. Notable defects caught and fixed before any real data:
  - Delete-that-doesn't-delete, stale-identity clobber, normalize masking, and
    empty-text/CHECK-constraint gaps on the first-classness sweep (rounds 1-2).
  - Disk resurrection on rollback — BOTH halves: the pending-job case (cancel)
    AND the completed-job case (enqueue a preimage-guarded compensating
    delete/restore job so the DB head and on-disk bytes can't diverge).
  - The pending-branch crash window: the materializer can crash at
    `MaterializeAfterRenameBeforeComplete` (bytes on disk, job still pending),
    so the compensating restore now runs UNCONDITIONALLY for a binary-write
    rollback (harmless no-op when bytes never landed) and additionally cancels
    the pending job. Fault-injection regression drives the real crash point.
  - Fail-closed partial binary identity: `(Some,None)`/`(None,Some)` no longer
    fall through to a legacy path+sha match that a recreated same-bytes head
    could satisfy — only `(None,None)` uses the legacy fallback, `(Some,Some)`
    requires strict object+moment equality, partial defers as StaleHead.
  - ACK-and-defer liveness: a mirrored binary resolve whose generated job/moment
    id collides with a caller moment id now prechecks `moment_exists` and returns
    `DuplicateMomentId` (a validation rejection -> ack-and-defer), instead of a
    fatal `PersistFailed` poison-pill that retried indefinitely.
  - Search correctness: a binary write over an already-indexed text file left a
    stale FTS row (the index freezes once healthy). Per the module's documented
    reader invariant (freeze, don't drop — every reader re-checks live state),
    `query_search_index` now drops a candidate whose current head is binary.
  - Rollback job lookup scoped to binary Write moments + SHA-matched, so a
    text/delete/rename rollback can never touch an unrelated same-id job.
- DEFERRED (A2, dormant display-only): `compare_version_files` projects binary
  heads into the text-only `TextSnapshot` (empty text), so binary-vs-binary
  diffs are lossy. Verified ZERO authority consumers — its only callers are
  `merge_conflicts.rs` tests; conflict/merge uses the fail-closed
  `compare_text_file_versions_in_db`, resolve/materialize use binary-aware
  `select_snapshot_by_path[_in_tx]`. Tracked to the A2 TextSnapshot ->
  content-aware-enum obligation, not refactored here to avoid scope creep.
- Gate: green x2 (independent) — fmt/clippy/build/test --workspace/cargo-deny.
  CodeRabbit APPROVED, Codex "didn't find any major issues" on `b4123aa2`.
- Wave 5 remaining pre-cutover: R13b-rest, remaining obligations (A2 display
  enum, gate-perf, R14-deferred, fuzz coverage, shadow_fence harness-writer
  gating), then GATE6, then R15 (ICE checkpoint — STOP).

## 2026-07-19 — obligation sweep: BlobChunk (#196), A2 (#197), fence (#198), fuzz (#199) merged

Four obligations discharged plus one verified-resolved. All dormant / test-only;
no live TS behavior change.

- **BlobChunk (#196, R13b-rest piece)** — real BlobChunk (frame type 2) streaming
  in the import-dead `apps/desktop/src/workspaces/engineClient.ts`, replacing the
  deferred `unsupported-frame` rejections. It parses untrusted peer bytes, so it
  went through 8 adversarial review rounds; every finding was a genuine
  hostile-input DoS or correctness bug, all fixed: clamp the negotiated
  `maxBlobChunkBytes` to a client cap (no peer-forced multi-GB alloc); per-stream,
  concurrent-stream, aggregate-byte, aggregate-chunk, and global-chunk caps
  (tiny-chunk floods can't amplify object overhead); enforce the cap DURING decode
  (inline `onFrame`, halts a coalesced flood mid-buffer); SHA-256 verify before
  dispatch; caller-id captured at blobStart (ordering-proof); intersection
  capability gate (`blobs` requested AND acked); reject empty non-final chunks,
  unknown-request streams, and out-of-order handling corrected to unique-not-
  ordered (active-only duplicate check — no completed-id set to leak or evict);
  abort-on-close; drop a failed request's streams. 50/50 vitest + tsc. Codex
  clean; CodeRabbit approved through round 5 then rate-limited — merged on the
  Codex-clean head plus this rationale.
- **A2 (#197)** — DISCHARGED. `SnapshotContent::{Text,Binary}` + `SnapshotView`
  replace the text-only `TextSnapshot` projection on the display/diff surfaces
  (`list_snapshots`, `list_fork_base_snapshots`, `compare_version_files`), so
  binary-vs-binary revisions are honest in diffs instead of empty-text masquerades;
  `compare_text_file_versions` fails closed on binary heads. Review added a
  symmetric fail-closed guard on the text branch (missing blob -> `StateCorrupt`).
  Display-only, zero authority consumers (authority paths keep the fail-closed
  in-db compare + binary-aware selects).
- **shadow_fence (#198)** — DISCHARGED. `write_shadow_marker_for_harness` was
  plain `pub`; production daemon code could manufacture shadow markers (defeating
  the fence). Gated `#[cfg(any(test, feature = "harness"))]` (matching
  `write_rehearsal_token_for_harness`), with a self dev-dependency so
  `tests/shadow_replay.rs` still compiles under the default gate.
- **fuzz coverage (#199)** — DISCHARGED. Audit confirmed the 3 cutover-blocking
  fuzz families (framing, ydoc ingestion, replication envelopes) + secrets are
  covered and gate-run. Added the two residual untrusted parsers as proptest
  surfaces (`fuzz/dohc-fuzz-targets/tests/{policy_parse,migration_open}.rs`):
  policy TOML/glob parsing and corrupted-DB-bytes-vs-open/migrate. No cargo-fuzz
  (windows-msvc), run by `cargo test --workspace`.
- **flaky Windows materializer test** — VERIFIED-RESOLVED, no change. No `#[ignore]`d
  or flaky-marked test exists workspace-wide; the only "flaky" symbol is
  `FlakyReplacer`, an intentional fault-injection double in
  `testkit/tests/materialize.rs` that proves the rename-over-open-file
  retry/backoff/fail-closed pipeline. `test --workspace` has been green across
  every gate run this session.

### R13b-rest — NARROWED (PROPOSED scope decision, needs ICE confirmation at R15)
Scoping found the composed R13 daemon (`crates/dohc-workspace-engine/src/lib.rs`)
exposes only 8 wire methods: `workspace.open/close`, `versionedText.write/read`,
`ydoc.apply`, `conflicts.list/open/resolve`, `search.query`. There is NO RPC
surface yet for chats, secrets, shares/replication, share-channels, or blob
capture — so R13b-rest's remaining owned surfaces (cli, mcp, sharedView,
sharedChannels, shareMounts, workspaceEngineCapture) cannot be wired to real,
exercisable behavior; wiring them now would be un-validatable scaffold, and
growing those RPCs is R13-dispatcher territory, not this shard. PROPOSAL: R13b-rest
delivers BlobChunk now (done, #196) and its remaining surfaces are deferred until
the daemon dispatcher grows the needed methods (a later R13-follow-up / part of
R15 wiring). Flagged for Ice at the R15 checkpoint.

Ownership gaps (unowned `@dohc/workspace-engine` consumers found by the shard-open
import scan, to fold into SHARDS on the next refinement):
`apps/desktop/src/agents/{chatDispatchService,runnerThreadContext}.ts`,
`apps/desktop/src/collab/ydocEngineProviderSession.ts` (the LIVE sibling),
`apps/desktop/src/ipc/engineHistoryIpc.ts`,
`apps/desktop/src/workspaces/{chatBookmarkProjectionWrite,dmChats,workspaceEnginePolicyFile}.ts`.

- Wave 5 remaining pre-cutover: R13b-rest rest (ICE scope decision), gate-perf
  redesign, R14-deferred (WatcherUnavailable prod wiring, open-after-close race,
  soak runner), then GATE6, then R15 (ICE checkpoint — STOP).
