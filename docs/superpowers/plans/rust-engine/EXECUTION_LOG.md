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

## 2026-07-19 — R14-deferred open-after-close race merged (#201); AUTONOMOUS PRE-CUTOVER WORK COMPLETE — R15 CHECKPOINT

### #201 (R14-deferred: open-after-close race) — DISCHARGED
`workspace_close` did not serialize against `workspace_open`, so a concurrent
reopen of the same root could receive an actor being torn down (ops then fail
`ActorUnavailable` while the workspace reports open). Fix: a new
`WorkspaceSupervisor::begin_close` installs the global `Closing` marker
synchronously under the registry lock BEFORE the handle is removed; the close
finishes on a detached blocking task (cancellation-safe; `WorkspaceClose::Drop`
is the backstop, `finish()` takes the actor so Drop never double-closes).
`workspace_open`'s idempotent short-circuit now rejects a differing workspace id
first, then validates the bound actor's lifecycle (a dead actor is stale ->
reopen). Four review rounds; tests: 128-cycle interleaving, cancellation, and a
best-effort two-service regression. Documented as OUT OF SCOPE: full correctness
for two `EngineService` instances sharing the global supervisor for one root —
not a production configuration (the sidecar is one process, one service, one
registry).

### Autonomous pre-cutover status — everything tractable is DONE
Merged this program run: BINHEAD (#194/#195), BlobChunk (#196), A2 (#197),
shadow_fence gating (#198), fuzz surfaces (#199), integrator sweep (#200),
open-after-close race (#201). Verified-resolved without change:
flaky-Windows-materializer (no ignored/flaky test exists; `FlakyReplacer` is an
intentional fault-injection double). All correctness-critical, cutover-relevant
work is landed.

### R15 CHECKPOINT — the following need ICE decisions before the path to R15 can proceed
1. **gate-perf (#202, DRAFT — held for scope call).** The cached-base
   implementation is correct (independent adversarial review: no staleness
   hole; cross-process `Resumed`/base-claim invalidation + LRU cap added) but
   does NOT meet the asymptotic goal: `advance()` re-runs `encode_full_state()`
   + `scan_v1()` (O(doc)) per append, so it RELOCATED rather than eliminated the
   O(doc) cost — a session is still O(N^2). It is a constant-factor win (no
   per-append disk reconstruct). DECIDE: (a) invest in the harder incremental-
   base redesign to hit O(N); (b) ship the constant-factor version (fix the two
   remaining minor items); (c) defer — it's a dormant perf item, not
   cutover-blocking.
2. **WatcherUnavailable prod wiring + full soak runner (R14-deferred) — BLOCKED
   on a missing composition.** The daemon does NOT compose the files/watcher
   layer at all (`supervisor.open` spawns only the engine-STORE actor;
   `dohc_engine_files::NativeWatcher` has zero daemon consumers; watch.rs's own
   TODO says it has "no home until the composition shard wires files actor +
   watcher into the daemon"). Composing that is SHARD-SIZED (like R13), not a
   small obligation — the same blocked-on-missing-composition pattern as
   R13b-rest. DECIDE: is a files-into-daemon composition shard in scope pre-
   cutover? The full soak's watcher-storm scenarios depend on it; a partial soak
   (open/close, crash/restart, workspace-switch) is buildable now if wanted.
3. **R13b-rest remaining surfaces — BLOCKED on daemon RPC surface.** The
   composed R13 daemon exposes 8 wire methods; cli/mcp/shares/capture need
   chats/secrets/shares/blob-capture RPCs that don't exist (R13-dispatcher
   growth). BlobChunk (the one dormant-actionable piece) is done. DECIDE: same
   files/RPC composition question as (2).
4. **GATE6 formal deps (R14, R10b, R15-REHEARSE) ARE all gate-passed** — GATE6 is
   formally convenable. But the R14-deferred quality obligations above (watcher,
   full soak) are open (blocked on the composition). DECIDE whether GATE6 passes
   with those documented-open, or whether they must land first.
5. **R15 cutover decisions (from the plan):** cutover scope, dogfood-data reset
   confirmation, min dogfood duration (>= 2 weeks, DECISIONS #8), member-share-
   log-across-epoch-reset semantics, macOS build evidence (DECISIONS #2 deferred).

Per the standing directive, the autonomous run STOPS here at the R15 checkpoint.
The above are handed back to Ice.

## 2026-07-19 — Files-composition B merged (#205): StoreCaptureSink (text path)

`StoreCaptureSink` bridges files-crate reconcile plans to the actor-owned
domain capture primitives (A, #204). FIVE review rounds (CodeRabbit + Codex +
an independent adversarial Claude reviewer, who independently converged with
Codex on the manifest-desync bug); every finding fixed or refuted with a
documented, ratified reason. What landed:

- **Honest capture receipts (contract change, files crate).**
  `CaptureSink::ingest` returns `IngestOutcome::{Captured{size,sha256},
  NotOwned}`: the manifest records the bytes ACTUALLY persisted (never the
  scan-time hash — kills a rapid-write lost-capture), and `NotOwned`
  acknowledges but FORGETS the path (policy-untracked, non-ownable content,
  store-refused names, and the interim binary/secret deferrals — re-offered by
  every later scan, so the follow-up sub-shards need no state migration).
  `acknowledge_capture` fails closed (`InvalidCaptureReceipt`) on a receipt
  claiming an applied ingest without its captured identity. Kills two
  review-found lost-capture bugs: flip-to-binary-and-revert manifest desync,
  and stale-scan-hash recording.
- **Symlink/TOCTOU defense with strict scanner parity.** Descriptor-bound
  no-follow reopen (O_NOFOLLOW|O_NONBLOCK on Unix — a swapped-in FIFO cannot
  hang the worker; FILE_FLAG_OPEN_REPARSE_POINT + reparse-attribute refusal on
  Windows, junctions included). Containment is STRICT EQUALITY pre- and
  post-open: the canonical parent/path must equal the canonical root joined
  with the lexical segments, so a symlinked ancestor is refused even when it
  resolves INSIDE the root (in-root aliasing = content under a path the
  scanner would never enumerate). Unix additionally pins the descriptor's
  (dev,ino) to the lexical location. Residual documented honestly: a
  Windows-only double-swap inside the open window (symlink privilege
  required; identity-by-handle needs non-std APIs) — candidate hardening in C.
- **Domain-store alignment.** Namespace guard: names whose canonical key
  differs (literal `a%2fb.md`) are neither captured nor retired; store-refused
  names (`..` substring, byte-1 colon) settle as NotOwned instead of
  poisoning runs as degraded. `CaptureRetire.only_if_text_head` (domain seam):
  the sink's binary-deferral retire is a no-op on a live binary head —
  mirrored-resolve/BINHEAD state is never the plaintext sink's to delete.
  Retires confirm absence at APPLY time (TS `pathConfirmedAbsentOnDisk`
  parity): a reappeared regular file refuses and stays dirty.
- **Policy + media routing.** `.dohc/files.toml` tracked=false narrowing above
  the hard floor (broken policy → floor-only per WS-F); `isTextMediaType`
  ported byte-for-byte into `dohc-engine-files::media` (sqlite shapes,
  site-source paths) and consulted BEFORE UTF-8 sniffing;
  `MAX_CAPTURE_BINARY_BYTES` (5 MiB) mirrors `MAX_VERSIONED_BINARY_FILE_BYTES`.
- **Deferred with mechanism (owned by sub-shard C):** policy-flip convergence
  for UNCHANGED files (no diff op is emitted; the driver rebuilds the
  controller with an empty manifest on a policy-snapshot change — `.dohc` is
  unwatched, matching the TS oracle). **Refuted with ratified citations:**
  retire-above-scan-cap (contradicts the CAL-3 retained_over_cap false-delete
  defense, BEHAVIOR_DELTA.md §7.1) and legacy retire idempotency hashes (the
  dormant capture path has no recorded rows anywhere; R15 resets shadow data).
- Dormant throughout: no live TS behavior change; TS files read-only oracles.
- Gate (every pushed head): fmt/clippy -D warnings/build --workspace/
  test --workspace/cargo-deny PASS. Final:
  - 2026-07-19T16:04:44.113Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
- Bots on the merged head 0bb1d14b: Codex "didn't find any major issues",
  CodeRabbit APPROVED.
- Next: B-binary (capture_ingest_binary via the BINHEAD write path, framed id
  scheme; open design question: whether capture-from-disk enqueues the binary
  materialization job or skips it — decide against the TS oracle + the
  rollback-compensator invariants at store.rs:365-460), then B-secret → C →
  D → E → full-soak → RPC-growth → GATE6 → R15 (ICE checkpoint — STOP).

## 2026-07-19 — Files-composition B-binary merged (#208): autonomous binary capture

`capture_ingest_binary` + actor wiring + sink routing: binary content on disk
now captures as a first-class BINHEAD binary head (replacing #205's interim
deferral). Two bot rounds + an independent adversarial Claude review (clean:
no P1/P2 across six probed surfaces). What landed:

- The locked framed id scheme, now factored into ONE shared implementation
  (`resolve_capture_object`) used by the text and binary primitives.
- Capture is JOBLESS-in-effect but records a COMPLETED materialization job
  marker ("these bytes are already on disk" — literally true). The marker
  drives the materializer's staleness gate — three review-found regressions
  killed: (1) a stale older pending job whose preimage matches the
  just-captured bytes can no longer run and regress disk behind the head
  (codex P1); (2) recapture-after-rollback reclaims the surviving marker row
  via UPSERT with a documented remnant proof, instead of wedging on the
  primary key; (3) DEDUPED captures mark the confirmed head's generation
  (flipping the creating write's own still-pending job complete — its
  postcondition was just verified), immunizing verified bytes.
- The BINHEAD rollback compensator now restores disk for binary write
  moments with NO job row (fail-safe arm; the marker makes it practically
  unreachable) — previously a jobless rollback left disk/DB/manifest in
  silent permanent divergence.
- `WriteBinaryFile` restructured (moment_id, metadata_origin, author_json,
  materialize: Option<Preimage>); the moments/snapshots/journal triple
  extracted into shared `persist_binary_head_in_tx`; mirrored-resolve output
  byte-identical ("sync" + Some(preimage)).
- Sink: `CurrentContent::Binary(bytes)` captures for real; text→binary flips
  replace the head in one transaction; receipts carry the scanner-equal
  content identity so the manifest converges.
- Gate: full-workspace PASS on every pushed head; final:
  - 2026-07-19T18:06:39.604Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
- Bots on merged head 0cf26191: Codex clean, CodeRabbit APPROVED (+"Review
  finished", zero findings on the final push).
- Next: B-secret (capture_secret via SecretFileStore, framed moment ids) →
  C → D → E → full-soak → RPC-growth → GATE6 → R15 (ICE checkpoint — STOP).

## 2026-07-19 — Files-composition B-secret merged (#210): autonomous secret capture

`.env`-family content now captures into the ENCRYPTED store end-to-end
(sink → actor → SecretFileStore), replacing the interim NotOwned deferral.
SEVEN review rounds (CodeRabbit + Codex + an independent adversarial Claude
review, which was clean on all probed surfaces including plaintext
containment and the order-pin); every finding fixed or refuted with a
documented reason. What landed:

- **TS-parity key custody, heavily hardened.** `load_key_file` /
  `create_key_file` port `loadSecretDataKey`: minted on FIRST secret
  capture, never over existing encrypted state (the sink asks the actor
  `has_secret_state` and fails closed — a backup restored without its key
  can never be silently stranded under a fresh key). The mint is a DURABLE
  no-clobber publish: temp (0600) + fsync + HARD-LINK (a concurrent minter
  can never replace a published key; losers adopt the winner), parent-dir
  fsync failures fail the mint, 0700 key directory, canonical-dir
  verification (`verify_key_dir`) on BOTH load and mint. Reads are
  descriptor-bound (O_NOFOLLOW|O_NONBLOCK on unix via a unix-only libc dep;
  reparse-refusal on Windows), bounded (4 KiB), with a VERIFIED
  descriptor-bound chmod that fails closed if the mode stays lax. Every
  buffer holding serialized key material zeroizes. The residual TOCTOU
  depth (ancestor swap inside a syscall window) is documented ONCE as the
  same openat/dirfd-class residual as the capture sink; codex's final
  micro-refinement round was dispositioned per-finding on the PR.
- **Domain:** `SecretFileStore::capture_secret` (framed derived ids tagged
  capture-secret-write, reserved-order pin, TS summaries "Updated/Deleted
  {basename}", origin local-file per the store's WRITE_ORIGINS);
  `capture_secret_retire` is KEYLESS (delete never decrypts).
  `SecretDiskIntent::{Materialize,AlreadyOnDisk}`: capture records the
  COMPLETED materialization marker (never runnable — bytes came FROM disk),
  deduped captures mark the confirmed tip, and capture retires record the
  marker at the delete's generation so stale pending secret jobs can never
  re-write retired plaintext. (The secret-aware decrypting EXECUTOR is not
  yet in the Rust materializer — it lands with the composition driver.)
- **Sink:** mirrors `readDiskSecretState` exactly (text rules, no media
  heuristic, non-UTF-8 is UNTRACKED and retires the stale tip), canonical
  secret names enforced both ways, apply-time absence confirmation on
  retire; plaintext never lands in plaintext-store tables (asserted).
- Gate: full-workspace PASS on every pushed head; final:
  - 2026-07-19T20:32:39.700Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
- Verdicts on merged head f1dd7c14: CodeRabbit APPROVED (+"Review finished",
  zero findings on the final push), Codex non-blocking P2s dispositioned.
- Next: C (composition driver: FilesActor + NativeWatcher + reconcile loop
  into workspace open/close, policy-flip re-offer obligation, secret-aware
  materializer executor) → D → E → full-soak → RPC-growth → GATE6 → R15
  (ICE checkpoint — STOP).

## 2026-07-20 — Files-composition C merged (#212): the composition driver — capture is AUTONOMOUS

Once a shadow-bound workspace is open, the daemon notices external disk
changes and records them (text → plaintext store, binary → BINHEAD head,
secret → encrypted store) with NO RPC involved, matching what
`workspaceEngineCapture.ts` does for the live desktop. The files layer spawns
only after `bind_shadow_clone` succeeds, so an unmarked root can never grow a
watcher.

**Structure.** The driver TASK owns the `FilesActor` + `NativeWatcher` and the
reconcile→apply→acknowledge loop; the daemon holds a cancel token, join handle,
and an observable `DriverStatus` (the E-shard `watcher.status` seam). Applies
run a FRESH `StoreCaptureSink` per cycle on a dedicated plain thread (the
sink's blocking actor calls forbid tokio context; the uncancellable await IS
the drain-before-close property). Captures target the ACTIVE version.

**THE CENTRAL OUTCOME — a capture OWNERSHIP model.** Composing disk-driven
capture onto a store other writers can mutate created a question the engine
did not previously have: *when may capture overwrite or delete a head?* The
answer, now enforced uniformly across text/binary/secret and both
ingest/retire:
- Capture owns only what IT wrote (`metadata_origin`).
- It may claim a foreign head ONLY on a disk transition it OBSERVED
  (`IngestReason::Changed`); on first sight (`Added`, e.g. a reset manifest)
  stale disk bytes are indistinguishable from a user edit, so the foreign head
  is left intact while the path is still TRACKED — the next genuine edit then
  arrives as `Changed` and captures normally.
- A claimed PLAINTEXT/BINARY dedupe TRANSFERS ownership (else later retires
  stay blocked). Secret dedupes deliberately do NOT transfer — a secret
  tip's origin lives on its MOMENT, so transferring would rewrite history
  or append a no-op moment; the claimed-but-deduped foreign tip stays
  foreign (preserved, never retired) until the GATE6 marker column. Pinned
  by a tripwire test.
- Retires never touch a foreign head (`only_if_capture_origin`,
  `only_if_own_origin` for secrets).
- `capture` is a RESERVED metadata origin: `VersionedTextStore::write_text`
  (the public door the RPC calls) rejects it, so ownership cannot be forged
  from outside. Capture's own primitive reaches `write_text_in_tx` beneath it.

**Rehydration + policy convergence.** `capture_manifest_seed` seeds each fresh
layer from the domain's CAPTURE-ORIGIN state (text blob sha/size, binary
sha/size, secrets by sentinel), so a file deleted while the daemon was down
RETIRES instead of surviving forever. Policy-narrowed entries seed with a
sentinel hash — still-on-disk re-offers and retires via the sink; deleted
offline diffs as removed — which is what converges an offline files.toml edit.
Over-cap narrowed paths (never in the diff by CAL-3 §7.1) retire through a
dedicated `retire_policy_excluded` that skips absence confirmation and REPORTS
into the receipt so the manifest forgets them.

**Lifecycle.** Strict files-then-actor teardown on PER-WORKSPACE close and
stale-actor eviction. Whole-DAEMON exit is deliberately the REVERSE: the
transport's close hook closes actors first, so in-flight capture writes fail
CONTAINED (never acked; the next start re-offers from the dirty baseline),
and the post-transport drain then joins the watcher/files threads. Close stays #201-cancellation-safe (driver cancelled
synchronously; a detached task owns drain+finish). `workspace.open` holds a
BARRIER until the startup baseline settles (bounded retries) so a caller's
first write cannot be overwritten by a later capture of stale closed-period
bytes; `OpenGuard` closes the actor if open is cancelled mid-barrier.

**Review.** 34 findings across nine rounds of CodeRabbit, Codex, and an
independent adversarial Claude review, plus 5 caught by the gate. Nearly all
were genuine correctness bugs in the ownership/convergence family, including
three data-loss paths (foreign secret retire, DB-only content retire,
flip-and-revert lost capture) and two guards placed on layers the real call
path never reached. The final rounds extracted the shared secret-tip-origin
query and pinned the DELIBERATE secret-dedupe non-transfer with a tripwire
test (claiming a foreign tip with identical plaintext must dedupe without
conferring ownership — flipping that behavior must break a test, not slip
through).

**RESIDUAL carried to GATE6 (not papered over):** secret ownership keys on
`local-file`, which is ALSO a legitimate API origin (TS parity forces capture
to use it), so secrets cannot get the reserved-origin treatment without a
dedicated ownership-marker column. Plaintext/binary ownership is
non-spoofable; SECRET ownership remains heuristic. Adding the marker is a
migration — cheap before R15's reset, expensive after — so it is an explicit
Ice decision at GATE6.

- Gate: full-workspace PASS on every pushed head (19 runs; 5 caught real
  defects). Final (round 9, head 16564026):
  - 2026-07-20T10:20:05.544Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
- Next: D (bounded watcher-restart backoff + escalation on the seam C built),
  then E (status/flush RPCs + the TS capture differential), full-soak,
  RPC-growth, GATE6, R15 (ICE checkpoint — STOP).


## 2026-07-21 — Files-composition D merged (#214): watcher supervision — and the status became ONE WORD

Capture now SUPERVISES its files layer instead of blindly retrying: an
escalating backoff (500ms -> 8s cap) between rebuilds for every failure mode
(failed start, dead watch, dead files actor, persistently failing
reconcile), a TERMINAL report after 8 consecutive failures (~30s), and a 30s
recovery probe so a root that comes back is picked up without a
close/reopen. A policy-edit DEBOUNCE (a new fingerprint must hold one tick)
stops an agent rewriting files.toml at 2Hz from driving a full rescan every
500ms; an UNREADABLE files.toml makes ownership UNKNOWN — capture holds
(fail, stay dirty, retry) rather than widening over user exclusions or
retiring heads the policy may still track (malformed stays WS-F floor-only —
that split is by DiagnosticReason). Recovery from an unknown-policy window
re-offers everything that was held, even when the recovered bytes equal the
layer's fingerprint, and holds observed only inside the apply window arm the
same trigger deterministically (the sink reports them through its channel).

DELIBERATE DEVIATION from the R14 sketch, argued in the PR: no escalation to
WorkspaceSupervisor::restart. A store-actor restart cannot fix a dead OS
watch and would drop in-flight RPC work for a healthy RPC surface;
escalation is a SIGNAL (terminal via watcher.status) for the product layer
— which OWNS the remaining obligation at cutover: surface a persistent
warning while terminal (capture must never appear active over a dead
watch), preserve the dirty workspace state, and offer recovery
(close/reopen) driven by watcher.status.

THE REVIEW STORY (12 rounds; CodeRabbit APPROVED, Codex clean at r12 after
SEVEN consecutive rounds of real findings, plus 4 independent adversarial
Claude reviews): nearly every fix round's own fixes contained defects the
next round caught. The compounding lesson became structure:

- Tests were repeatedly TRUE-BY-CONSTRUCTION (asserting on the tracker while
  the defect lived in the loop; a fake whose fidelity gap hid an infinite
  rebuild). The loop is now generic over a DriverEnv seam and the tests
  drive the REAL loop under paused virtual time, asserting what it actually
  WAITS on — with mutation evidence: every defect-restoring mutation kills
  at least one test (several previously survived the whole suite).
- The running&&terminal contradiction survived FOUR rounds of store-order
  fixes because writer-side ordering can never stop a READER from sampling
  across a two-atomic transition. DriverStatus is now ONE AtomicU8 bitfield
  with a snapshot() API: reads are consistent snapshots, transitions are
  single stores, and the whole ordering dance is deleted. Multi-flag
  consumers MUST use the snapshot (per-flag getters are single-flag only).
- Also fixed on the way: converged-with-quarantine read as health (the
  controller parks persistently failing paths and stops self-forcing scans,
  so "nothing dirty" is not "recovered" — FilesStats now exposes the
  quarantine), a failed over-cap retire that was invisible and unretried,
  and a pre-existing gate flake (migration tempdirs keyed on pid+clock;
  Windows clock granularity let parallel tests share one engine.db).

- Gate: full-workspace PASS on every pushed head (13 runs). Final:
  - 2026-07-20T18:31:28.392Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
- SOAK (cutoverBlocking tier; runner lands with E #215): the first full
  30-minute run —
  - 2026-07-20T18:33:44Z | soak-cutoverBlocking | windows/x86_64 | PASS | cycles=4914 crashes=819 durationSecs=1804 rssSlopeB/s=0.0 handles 109->109 threads 38->38
  — is WITHDRAWN as leak evidence: review found the crash cadence cleared
  the sample series every ~6 cycles, so the 0.0 slope was fit over a
  seconds-long tail and no process was soaked long enough for a trend
  (scenario-correctness results stand: 819 crash/restart recoveries all
  settled; handles/threads at baseline). The runner was restructured
  (two phases; tri-state trend verdict that cannot pass vacuously), and
  after #215's nine review rounds hardened it further (recorded
  tolerances, unmeasuredAssertions in-artifact, exit-status-checked
  cleanShutdown, bounded requests, scenarios that PROVE what they count),
  the run was REPEATED on the settled runner — then again after the
  assertion KEYS were renamed to say what they check
  (handlesWithinRecordedSlack / threadsWithinRecordedSlack /
  rssSlopeWithinThreshold — a reviewer reading the booleans must never
  infer an exact-baseline or zero-slope claim the tolerances block would
  contradict). The GATE6 artifact:
  - 2026-07-21T12:44:01Z | soak-cutoverBlocking | windows/x86_64 | PASS | cycles=5564 crashes=83 durationSecs=1803 rssSlopeB/s=13183.3 handles 105->107 threads 38->37
  Sample series COMMITTED:
  tools/rust-engine-program/soak-evidence/2026-07-21-cutoverBlocking.json
  (293 samples over ~1795s, trendEvaluated:true, rssDisposition:PASS,
  cleanShutdown:true, 83/83 crash cycles CAPTURE-PROVEN via exact-content
  probes, cancellations observed and counted, switch overlaps tallied,
  unmeasuredAssertions named in the artifact). FIVE independent
  30-minute runs measured the same decelerating warmup shape
  (12.5 / 13.5 / 13.0 / 13.7 / 13.2 KiB/s whole-run slopes; interim
  artifacts are superseded formats, not withdrawn results). GATE6 disposition, stated
  precisely: scenario correctness + handles/threads baseline + clean
  shutdown = PASS; MEMORY = PASS-WITH-FLAG (slope 13.0 KiB/s against the
  20 KiB/s threshold, warmup-shaped and reproducible), conditional on
  dogfood-period monitoring — NOT an unconditional leak-freedom claim.
  Real usage is orders of magnitude quieter than the soak's ~2.8
  cycles/sec.
- Next: E (#215, in review: capture RPCs + the TS-vs-Rust differential —
  10 scenarios green + tamper-verified — + the soak runner + RPC_GAP.md),
  then RPC-A per RPC_GAP.md -> GATE6 -> R15 (ICE checkpoint — STOP).

## 2026-07-21 — Files-composition E merged (#215): capture RPCs, the differential, the soak runner

- E completes FCOMP (merged 10:11Z as 126d79eb; squash). The shard:
  `watcher.status` + `capture.flush` RPCs (the determinism seam), the
  TS-vs-Rust capture DIFFERENTIAL (10 scenarios, goldens committed,
  tamper-verified — corrupt either side and the compare fails), shadow-scope
  acceptance for the E surface, and the cutoverBlocking SOAK RUNNER (GATE6's
  evidence instrument).
- The flush contract, hardened across the rounds: drives to QUIESCENCE
  (MAX_FLUSH_CYCLES bound), TickIo::Cancelled distinct from Converged
  (teardown races answer settled:false), flush-polling can neither defeat
  the restart backoff nor starve the rebuild (persistent sleep_until
  deadline; paused-time mutation test with a 3–5 start-attempt window),
  settled is REFUSED over a non-empty quarantine (share-locked-file E2E,
  mutation-verified) and over a mid-debounce files.toml edit (PolicyChangedIdle
  paused-time test, mutation-verified), and capture.flush honors
  cancellation AND deadlines (OperationCancellation arms its token from
  ctx.deadline; DEADLINE_EXCEEDED vs CANCELLED split preserved for
  embedded callers).
- The runner's evidence is honest BY CONSTRUCTION: recorded tolerances,
  tri-state rssDisposition AND the tri-state
  assertions.rssSlopeWithinThreshold (null when unevaluated; the key was
  later renamed from noMonotonicRssSlope to state its actual check), unmeasuredAssertions named IN the artifact, cleanShutdown
  requires a successful exit status, cyclesCompleted counts phase-2
  workload only, the final RSS sample joins the fit, per-request 60s and
  handshake 30s bounds with pending-drain on daemon death, scenarios that
  PROVE what they count (storm/crash probes read back exact content;
  switch overlap tallied separately; cancellations observed and counted;
  the cancel-storm recovery probe reads back a per-cycle seeded write —
  the strict probe exposed that the old .ok()'d read on an empty
  workspace had been proving nothing), cross-platform sampling
  (win32 / linux /proc / macos ps+lsof, loud panic elsewhere), and exit
  codes CI can trust (only PASS, or a REQUESTED --quick smoke's
  PASS-SCENARIOS-ONLY, exit 0; hard-cap and a cut-short crash prelude
  degrade the verdict).
- THE REVIEW STORY (9 fix rounds): Codex posted real findings on six
  consecutive heads (flush-cancel contract; masked non-zero daemon exits,
  reader-death hangs, unbounded awaits, env leak, config-vs-measured gap;
  flush-polling backoff bypass — whose NAIVE fix would have livelocked the
  rebuild; scenario-proof gaps; probe null-reads, deadline plumbing,
  policy-debounce settle) and came back clean on the 9th. CodeRabbit
  APPROVED at r3 and posted two later actionables (quick-run exit code;
  the quarantined-flush E2E), both landed. A 3-minute --quick smoke ran
  before EVERY runner-affecting push and caught three of my own fix bugs
  pre-push (a DOP1 64 KiB string-limit trip, a consumed-oneshot
  double-await, and the nothing-proving recovery read). RPC_GAP.md moved
  wholly to this PR (#216) mid-review — a stale draft on #215 would have
  conflicted at merge.
- Gate (merge head): 2026-07-21T09:59:06.362Z | run-rust-checks |
  win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS
  build --workspace=PASS test --workspace=PASS cargo-deny=PASS
  cargo-audit=SKIP
- SHARDS: FCOMP row -> E done. NEXT: RPC-A (rebased onto the merged main,
  in review) -> RPC-B -> RPC-C (design v2 adversarially reviewed) ->
  RPC-D per RPC_GAP.md, then GATE6 packet -> macOS evidence -> R15 (ICE
  checkpoint — STOP).


## 2026-07-21 — RPC-A merged (#217, 19 rounds): the read surface, hardened to fixed points

- RPC-A merged 17:14Z as 2d9c9837 (squash; no migration): 8 NEW read
  RPCs plus the pre-existing versionedText.read hardened in place —
  versions.active (null on nothing-versioned)/versions.list (cursor),
  versionedText.list (paged zero-hydration metadata query),
  versionedBinary.read + versionedText.read (ONE-TURN in-band caps),
  moments.list/get (hydrated like the oracle's momentSelectSql, parsed
  fail-closed authors, byte-budgeted pages), secrets.list (domain-paged) +
  secrets.materialize (one-turn capped decrypt; withheld tips still
  AUTHENTICATE; absent answers before any key work).
- THE REVIEW ARC (19 rounds; CodeRabbit APPROVED + Codex clean at r19;
  1 opus adversarial pre-review): design (the wire-limit discovery — the
  InProcessTransport harness structurally cannot see encode failures) ->
  failure paths -> ORACLE CORRECTIONS (the moments-payload decline was
  WRONG — cited getMoment's body without reading momentSelectSql's blob
  joins; owned publicly; write paths now RE-READ their own moments in-tx
  so mutation results equal reads forever) -> one-turn caps (no
  probe-then-load window anywhere; recorded==actual at every trusted
  length; verbatim resolution: everything a listing returns is a valid
  input) -> a phantom-edit catch (a commit message claimed edits an
  aborted script never wrote; Codex checked claims against the diff).
- DISCOVERIES for the R15 decision list: (1) the oracle's
  payload_before_*/before-snapshot-identity moment columns were never
  ported (schema obligation, cheap pre-reset, pairs with the secret
  ownership column); (2) cross-engine secret path SPELLING delta (TS
  normalize-stores, Rust stores verbatim with a disguise-proof
  classification gate — moot for data post-reset, parity suites must
  expect it); (3) the blob-chunk streaming obligation for content past the
  in-band caps — precisely: the 48 KiB INBAND_CONTENT_CAP_BYTES on
  text/binary/secret BODIES (one-turn SQL cap), all inside DOP1's 64 KiB
  per-string wire limit (BlobStart exists, no daemon producer).
- SHARDS: RPC-A done (#217). RPC-B open (#218, codex-implemented,
  adversarially pre-reviewed). NEXT: RPC-C (design v2 reviewed) -> RPC-D
  and RPC-B2 (production chat follow-ups; both GATE6 deps) -> GATE6 -> R15
  (ICE STOP).


## 2026-07-22 — RPC-B merged (#218, 17 rounds) + RPC-C merged (#220, 21 rounds); RPC-D in flight

- RPC-B merged 05:01Z as 99579b13 (squash): 23 chat daemon methods over
  LinkedChatStore (channels/threads/messages/read-state/follows/feed/
  bookmarks/dispatch), server-side workspace scoping throughout. The
  standing identity posture (chat RPC identity params sit in the main
  process's trust position; per-user socket auth is R15+) is recorded in
  RPC_GAP.md and was declined-with-citation four times before being
  accepted as recorded posture.
- RPC-C merged 06:52Z as 82d34c02 (squash): daemon-owned CANONICAL live
  Y.Doc sessions — ydoc.open/recordUpdate/settle/close/resync plus the
  ydoc.remoteUpdate event. Endgame architecture: root-scoped self-write
  suppression + lease registry, ordered multi-sha suppression, deferred
  ydoc drains that apply -> project -> clear markers LAST with real
  (origin,seq) moment coordinates, collision-free session ids
  (pid-bootms-instance-seq), a recordUpdate idempotency ledger, prune-close
  refusal on pending ydoc materialization, and startup replay at
  workspace.open that compensates conflicted ydoc jobs.
- CROSS-ENGINE OBLIGATION recorded in RPC_GAP.md (#218 r12, declined on
  oracle parity): well-known channel wire-id backfills are journal-less in
  BOTH engines (oracle linkedChatStore.ts:2241-2250 records the mapping
  without journalLocalReplicationOp; Rust mirrors). A backfilled wire id
  stays peer-invisible until an authoritative create arrives. Owned by
  RPC-E/sync; any fix lands in both engines or is scoped post-cutover.
- AGENTS.md product-philosophy refresh merged as 7d2b9eaf (#221, Ice's
  edits, committed on request).
- RPC-D IN FLIGHT (codex/rust-engine-rpc-d): steps 1-7 committed and
  gate-passed (full mutating text/version/secret surface — widened
  writes, binary write with active-version-gated materialization,
  rename/delete/rollback with lease guards, merge/compare + compareFiles
  DB-level keyset, atomic createNamed+secret-fork, full-record version
  RPCs, readBlob 48 KiB split, cross-mutation requestId ledger, the whole
  secrets RPC surface with verbatim-ciphertext apply/restore,
  moments inbandLimitBytes, search.ensureIndex). Step 8 (client typed
  wrappers + loopback parity) building; then adversarial pre-review ->
  PR -> review loop. NEXT after RPC-D: RPC-B2 -> GATE6 packet -> macOS
  evidence -> R15 go/no-go package (ICE STOP).


## 2026-07-23 — RPC-D merged (#223): the mutating text/version/secret daemon surface

- MERGED 00:29Z as a5b3a484 (squash; migration 13 = engine_requests.kind
  + provable backfill). The largest shard of the program: ~25 wire
  contracts (versionedText write/rename/delete/rollback/read/list,
  versionedBinary write/read/readBlob, versions
  createNamed+fork/setActive/ensureMain/active/merge/compare/
  compareFiles, the full secrets surface with three-way apply and
  verbatim-ciphertext restore, moments inband caps, search.ensureIndex)
  plus the typed client contract and a high-fidelity loopback engine.
- THE REVIEW ARC: fable-5 adversarial pre-review (15 findings,
  FIX-FIRST — headline: secrets.apply is the oracle's THREE-WAY MERGE;
  RPC body normalization was CORRUPTING file/secret bodies; a
  versions.active null-parity regression), then 16 codex rounds, 7
  CodeRabbit rounds, and 4 local claude rounds to quiet. Standouts:
  paths flow VERBATIM (the PR's own NFC normalization was wrong);
  workspace-scoped + fail-closed blob reads; binary-write requestId
  ledger; session_ops-serialized lease checks (write-behind-editor race
  closed); version-gated materialization across all 14 enqueue sites +
  merge draining its own jobs; rollback cancelling stale pending jobs
  across version switches; cross-history moment-id uniqueness;
  kind-scoped ledger purge (discharges the GATE6 shared-ledger
  obligation IN-PR); empty fork bases merging. Declines that survived:
  identity posture (recorded), CAL-1 compound reachability (converted
  to a per-database documents-table proof).
- Every supervision-grade guard carries a named MUTATION test;
  orchestrator mutation-verified the critical ones by restoring each
  bug and watching the named test fail (apply no-op, fork-base guard,
  workspace scoping, kind-scoped purge, version gate, lease
  canonicalization, cross-table ids, FTS replay guard).
- REMAINING toward GATE6: RPC-B2 (production chat follow-ups), RPC-D2
  (blob-chunk egress + the secret-aware disk executor + slash-spelling
  ruling), GATE6 packet, macOS evidence, R15 rehearsal + go/no-go (ICE
  STOP).


## 2026-07-23 — RPC-B2 merged (#225): the production chat follow-up surface

- MERGED 22:19Z as 4513bf9c (squash). The production-called chat reads +
  the reactions/decisions/mentions/follows/bookmarks/dispatch domain
  work over the daemon chats surface: file-linked threads/projection,
  thread attachments, channel wire-id verify, plus the LinkedChatStore
  parity for reactions, decisions, mentions, follows, bookmarks, and the
  desktop dispatch store — 40 behaviors.
- THE REVIEW ARC: fable-5 build + review rounds (through 48becef1), then
  the fable-5 credit exhaustion mid-review; the remainder (from 4260dd47)
  was Opus-4.8-orchestrated with codex (gpt-5.6-sol) still doing the
  implementation, all logged for fable-5 retro-review. 8 codex rounds, 6
  CodeRabbit rounds, 5 local-claude rounds, and 1 fresh-context opus-4.8
  adversarial pass to quiet. THE THROUGHLINE — cross-engine
  representability: the apply must bound any field a typed client decoder
  or read mapper bounds, because values beyond the JS-safe range cannot
  round-trip the DOP1 wire. Standouts:
  - Every imported cell/structural timestamp (reaction/decision/feed-read
    at_ms, attachment/message/channel createdAtMs, follow at_ms) bounded
    on apply with is_persisted_safe_integer — stricter than the oracle's
    isFinite-only apply, matching the wire. Recorded as a CROSS-ENGINE
    DELTA.
  - Linked-thread timestamp REJECT-ON-APPLY (a half-linked
    chat.thread.create is refused), deliberately stricter than the
    oracle's accept-then-brick — the one reversal of the arc (declined in
    r7, reversed in r6/CR after both bots pushed on the inconsistency).
  - Local mints kept replicable: control-char linked objectIds refused;
    channel-thread start guards the stored channelSlug/channelWireId with
    bounds byte-identical to the apply validator; follow at_ms bounded.
  - Loopback fidelity: null-proto decoder maps (proto-pollution);
    normalized per-method idempotency fingerprints omitting now_ms;
    message body stored via the daemon's normalize_body (CRLF->LF +
    trimEnd + 64 KiB cap) instead of NFC-trim-both.
  - Mention-backfill completion marker in engine_requests (kind
    chat-mention-backfill), committing atomically with the last batch.
- Declines that survived (all bug-for-bug oracle parity, adversarial-only,
  moot post-R15, recorded in RPC_GAP): attachment identity (peer
  attachmentId trusted when objectId absent) + attachment objectId control
  chars on replicated apply; bookmark requeue timestamps carrying safe
  negatives verbatim; the local set_follow/set_feed_read now_ms honesty
  assumption. The distinguishing criterion held throughout: REJECT only
  when the op is unrenderable on both engines; otherwise MATCH the oracle.
- Every supervision-grade guard carries a named MUTATION test; the
  orchestrator mutation-verified the critical ones (control-char objectId
  refusal, channel-identity guard, follow at_ms bound, loopback body
  normalization) by restoring each bug and watching the named test fail.
  Full-workspace gate green each pushed head (fmt/clippy/build/test/
  cargo-deny). NOTE: the review triage, decline rulings, and commit
  authorship from 4260dd47 onward were Opus-4.8 (documented for fable-5
  retro-review per the standing model rule).
- REMAINING toward GATE6: RPC-D2 (blob-chunk egress producer + the
  secret-aware disk executor + secret slash-spelling ruling), GATE6
  packet, macOS evidence, R15 rehearsal + go/no-go (ICE STOP).


## 2026-07-24 — RPC-D2 merged (#227): blob egress + the secret-aware disk executor — LAST IMPLEMENTATION SHARD

- MERGED as 391bea2f (squash). The three GATE6-blocking obligations left
  by RPC-D: SF1 blob-chunk egress producer (over-cap versionedBinary.readBlob
  streams BlobStart + 256 KiB BlobChunk frames + FIN, capability-gated on
  negotiated `blobs`, workspace-scoped, cancellation/deadline-checked,
  byte-budget-bounded); SF2 the secret-aware disk executor; SF3 secret path
  slash normalization to the oracle canonical key (resolves the RPC-D-era
  slash-spelling delta).
- THE REVIEW ARC — the most heavily-reviewed shard of the program: 8 codex
  build/fix rounds + 4 adversarial pre-review passes (3 opus + CodeRabbit) +
  orchestrator mutation-verification, ending CodeRabbit APPROVED + codex clean.
  The pre-PR adversarial passes and the bots caught a chain of real defects
  the gate alone passed over, each mutation-verified: (1) a version-agnostic
  fence that let a NON-active-version secret mutation rewrite/delete the
  ACTIVE version's on-disk secret — fixed by scoping the executor to the
  active version (disk = active-version projection, non-active is DB-only,
  mirroring versionedText); (2) deleted- AND restored-to-absent secret disk
  REMANENCE (completed markers left the plaintext on disk) — fixed by
  enqueuing pending delete jobs with adopt-current-disk removal; (3) a
  per-job BRICK/DoS (a symlink/directory/decrypt failure aborted the whole
  workspace.open) — fixed by per-job tolerance matching the generic replay
  contract + the oracle's per-file skip, while KEEPING fail-closed (no
  plaintext from unauthenticated bytes); (4) two SYMLINK-escape vectors on
  plaintext writes (symlinked-ancestor traversal + predictable-temp
  symlink-follow) — fixed by a root→target symlink-free ancestor walk and an
  exclusive O_NOFOLLOW/reparse-not-followed temp create with crash-recovery;
  (5) a conflict-path plaintext-temp LEAK on a failed best-effort remove;
  (6) a LOST-on-activation secret (non-active jobs marked complete discarded
  the only future disk intent) — fixed by leaving them pending + orphan
  handling for deleted versions.
- Every supervision-grade guard carries a named MUTATION test; the
  orchestrator mutation-verified the critical ones (active-version scoping,
  fail-closed, no-brick, delete/restore disk-removal, symlink safety, temp
  recovery, plaintext-leak) and added Windows-runnable security tests when it
  found the symlink tests were unix-only with no CI to run them.
- ACCEPTED RESIDUAL (documented, not a no-op): the ancestor rename-TOCTOU is
  narrowed but path-based, not fd-relative — a potential secret-disclosure/
  overwrite risk accepted only under the single-user/local-first/owner-only/
  no-sharing assumption; dirfd/openat2 + renameat closure REQUIRED before any
  shared-secret model (BEHAVIOR_DELTA.md).
- GAP recorded (RPC_GAP.md): daemon secret re-materialization on a MID-SESSION
  version SWITCH is missing (SetActiveVersion is DB-only; only open-replay
  materializes) — R13/GATE6 daemon-composition scope, not the secret executor.
  Also 3 marginal P2 declines recorded (stale-plaintext-on-decrypt, single-
  client id-reservation, tests-only in-process egress).
- ALL RPC SHARDS ARE NOW DONE (A/B/C/D/B2/D2). Remaining to 100%: GATE6
  release-candidate packet, macOS evidence, R15 rehearsal + go/no-go package
  with SIX decisions (ICE STOP — the one mandatory human stop), R16 legacy
  deletion (post-cutover).


## 2026-07-24 — GATE6 packet ASSEMBLED — gate NOT closed (pending rehearsal evidence + Ice authorization)

- GATE6's EVIDENCE PACKET is assembled (GATE6_PACKET.md); the GATE ITSELF IS NOT
  CLOSED. Two plan-required criteria remain: (1) an end-to-end clone-reset REHEARSAL
  on REAL dogfood workspace byte-clones (machinery built + gate-verified by its
  rehearsal-on-clones suite, but NOT yet run against Ice's data), and (2) EXPLICIT
  ICE AUTHORIZATION at the R15 go/no-go. Do not treat SHARDS.tsv as gate-closed.
- WHAT THE PACKET ASSERTS: the engine is FEATURE-COMPLETE for GATE6's scope (no
  GATE6-blocking implementation shard remains) and EVIDENCED (gate/soak/differential
  green) — a release CANDIDATE. DEFERRED implementation still exists and is NOT
  code-complete: R13b-rest (desktop-adapter remainder), RPC-E (relay/replication
  cutover scope), switch-time re-materialization wiring, and richdoc full-fidelity
  projection if that option is chosen.
  WHAT GATE6 DOES NOT ASSERT: cutover-READINESS. Several items are CUTOVER-GATING
  and are resolved at the R15 go/no-go, NOT here: (a) mid-session version-switch
  secret re-materialization — SetActiveVersion is DB-only, so disk secrets stay
  STALE (potentially wrong) until the next open; a faithful switch UX must wire a
  switch-time rebuild OR the stale-until-reopen behavior must be explicitly
  accepted; (b) richdoc→markdown fidelity — the Rust projection is a
  paragraphs+bold/italic subset that DROPS unsupported richdoc content, so
  full-fidelity projection (or disabling richdoc editing) must land before cutover;
  (c) the secret rename-TOCTOU single-user residual — its owner-only/no-sharing
  assumption must be ENFORCED (sharing kept off) while the residual is open;
  (d) the pre-R15 migration (secret-ownership + moments-provenance). Every GATE6
  dependency (R14, R10b, R15-REHEARSE, RPC-A/B/C/D/B2/D2) is done/gate-passed.
- Evidence packet: docs/superpowers/plans/rust-engine/GATE6_PACKET.md — every claim
  carries its evidence and limitations. Headlines:
  - Canonical full-workspace gate on main (19fc994b), clean-worktree rebuild:
    `2026-07-24T14:02:58Z | run-rust-checks | win32/x64 | PASS |
    fmt/clippy -D warnings/build/test --workspace/cargo-deny all PASS`.
  - Soak (cutoverBlocking tier) v3 = PASS (rssDisposition PASS, 5564 cycles, clean
    shutdown), with the honest monitored-not-proven memory flag.
  - Differential TS-vs-Rust capture: 10/10 green both engines, tamper-checked (#215).
  - Migration ledger AT PACKET ASSEMBLY: 14 migrations, ordinals 0-13,
    monotone (12 = v1-ydoc-deferred-updates, 13 = v1-engine-request-kind).
    **CORRECTED 2026-07-25:** ordinal 14 is consumed by R15-1a / #233 (merged)
    and ordinal 15 by R15-1b / #236 (in review).
    **CORRECTED 2026-07-26:** ordinal 16 is consumed by RPC-E-1 / #242
    (replication_pending_resolves); #244's chat migration must renumber to 17
    at its rebase. NEXT ORDINAL = **17**.
    Schema-touching shards serialize through the append one at a time; two
    concurrent migration appends must never claim the same next ordinal.
  - Gate discipline: full-workspace gate on EVERY pushed head program-wide; every
    supervision-grade guard carries a named MUTATION test, criticals
    orchestrator-mutation-verified per shard.
- All cross-engine deltas and accepted residuals are recorded (RPC_GAP.md /
  BEHAVIOR_DELTA.md): structural-timestamp bounds, linked-timestamp reject,
  mention-handle/attachment/bookmark deltas, secret slash-spelling (RESOLVED by D2),
  secret open-replay per-job tolerance, the secret rename-TOCTOU accepted
  single-user residual (dirfd/openat2 closure REQUIRED before shared secrets), and
  the mid-session switch-materialization gap (R13/composition scope).
- SIX open decisions are handed to the R15 go/no-go package (GATE6_PACKET §7):
  the pre-R15 migration PR (secret-ownership + moments-provenance), macOS evidence
  path, RPC-E cutover scope, richdoc-at-cutover, TOCTOU-closure timing, and the
  R15 go/no-go itself.
- REMAINING to 100%: macOS evidence, R15 rehearsal + go/no-go (ICE STOP — the one
  mandatory human stop, resets Ice's dogfood data), R16 legacy deletion (post-cutover).


## 2026-07-25 — R15 GO/NO-GO PACKAGE assembled — ICE STOP (awaiting authorization)

- The program has reached its ONE MANDATORY HUMAN STOP. R15_GONOGO.md presents the
  SIX decisions; nothing flips and no data is reset without Ice's explicit go.
- Program state: all GATE6-blocking implementation done (RPC-A/B/C/D/B2/D2 merged);
  evidence green (canonical main gate PASS, soak v3 PASS, differential 10/10,
  14-migration ledger 0-13); GATE6 packet assembled (#229) but the GATE IS NOT
  CLOSED — it still requires (1) the clone-reset rehearsal on REAL dogfood
  byte-clones (machinery built + gate-verified, never run on Ice's data) and
  (2) Ice's authorization. Both are resolved by this stop.
- NOT code-complete by design: R13b-rest, RPC-E, switch-time re-materialization
  wiring, and richdoc full-fidelity projection are deferred/decision-gated.
- The six decisions: (1) pre-R15 migration at ordinal 14 (secret-ownership +
  moments-provenance; cheap before the reset); (2) macOS evidence path (tooling
  shipped + hardened; run `full` before the flip); (3) richdoc at cutover
  (CUTOVER-GATING — the projection subset silently drops content);
  (4) version-switch re-materialization (CUTOVER-GATING — stale/wrong on-disk
  secrets until reopen); (5) secret rename-TOCTOU (CUTOVER-GATING — enforce the
  single-user assumption in code/config, or land the dirfd/openat2 closure);
  (6) cutover scope (RPC-E, R13b-rest) + the go/no-go itself (dogfood reset,
  >=2-week dogfood plan, share-log-across-epoch-reset semantics).
- Recommended order on a go: decisions 1-5 land -> rehearsal on real byte-clones ->
  Ice authorization (closes GATE6) -> flip -> >=2-week dogfood -> R16 deletion.


## 2026-07-25 — R15 execution phase: migration 14 landed; cutover shards in review

- Ice's six R15 go/no-go decisions are recorded (#232): RPC-E and R13b-rest are
  in pre-cutover scope, the flip/data wipe is authorized after the remaining
  work + real-clone rehearsal, and the >=2-week dogfood window still precedes
  R16. GATE6 still awaits the real dogfood byte-clone rehearsal; authorization
  is no longer the missing criterion.
- **LANDED / gate passed:** R15-1a #233
  (`codex/rust-engine-r15-1-secret-ownership`) merged migration ordinal 14,
  replacing spoofable `metadata_origin == "local-file"` ownership with the
  engine-stamped secret capture-ownership column. This is the ONLY new shard in
  this phase marked `gate passed`.
- **IN REVIEW (all GitHub states re-verified OPEN 2026-07-25):**
  - R15-1b #236, moment payload provenance, consumes migration ordinal 15.
  - R15-2 #235, Blacksmith macOS evidence tooling; the full final evidence run
    has not yet been banked.
  - R15-3 #238, full-fidelity richdoc projection; #240, the separate deliberate
    live-TypeScript serializer delimiter fix.
  - R15-4 #239, switch-time re-materialization; R15-5 #237, secret ancestor
    redirection TOCTOU closure; daemon auth hardening #241.
  - RPC-E-1 #242 (router + missing appliers), RPC-E-2 #243
    (`moment.append`, stacked on -1), RPC-E-3 #246 (HTTP transport, stacked on
    -2), chat replication validation #244 and refusal disposition #245 (both
    stacked on -1). The nine chat gaps and refusal disposition are NOT merged.
- **IN PROGRESS, NO PR:** RPC-E-4 daemon RPC surface on
  `codex/rust-engine-rpc-e-daemon-rpc`, stacked after RPC-E-3. Its concrete
  owned/test paths remain unknown until implementation opens the shard.
- Migration control is now explicit: ordinal 14 is consumed by #233, ordinal 15
  by open #236, so the NEXT ordinal is **16**. Schema-touching shards run one at
  a time through the append-only ledger and update both length assertions;
  parallel ordinal claims are forbidden after two shards nearly collided.
- The live-TypeScript read-only rule is SCOPED, not deleted. R13b-rest may edit
  only its allocated desktop/CLI/MCP/workspace adapter surfaces. #240 may edit
  only `packages/ydoc-projection/src/import-export.ts` plus its regression test.
  Every other shard still treats live TypeScript, including
  `workspaceEngineCapture.ts`, as a read-only oracle.
- #239 leaves two durable R13b obligations: quiesce live Y.Doc sessions before
  switching, and reconcile unreconciled disk edits into the version being left.
  `capture.flush` is insufficient for the latter because
  `reconcile_if_dirty` may return `Converged` without a scan; the oracle always
  scans and hard-fails on degradation. Capture also resolves the active version
  at apply time, so an apply can straddle the set-active transaction.
- RPC-E-3 exposed an **OPEN Ice sequencing decision**: after
  epoch-identity adoption, `enforceWorkspaceIdentity` permanently 409s
  identity-less requests and the TypeScript client never sends identity.
  TypeScript and Rust relay clients cannot share that workspace; all
  relay-using clients/devices must move together.
- Soak evidence qualification: handle/thread slack (48/8) is calibrated on
  Windows only. WSL-Linux and future macOS runs reporting within those same
  bounds do not produce a bankable platform-specific resource-leak verdict
  without per-platform calibration; the WSL result is scenario/portability
  evidence under that caveat.

## 2026-07-26 / 2026-07-27 — the R15-6 stretch, and an honest state of the program

Twenty-two PRs merged since the last entry and none were recorded here. The
table below covers the fourteen that changed program state; the remainder are
the R15-1a/-1b/-2/-3/-4/-5 decision shards (#233, #235-#241, #247) which the
previous entry had listed as IN REVIEW and which all landed 2026-07-25. That gap
mattered: an audit on 2026-07-27 found no document on `main` was a reliable
index of program state, while `SHARDS.tsv` still pointed two rows at closed PRs
and marked three merged shards "in review". This entry closes the gap.

### Merged since the last entry

| PR | what it actually fixed |
|---|---|
| #242 | RPC-E part 1: central replication router + three missing appliers |
| #243 | RPC-E part 2: `moment.append` replication apply |
| #244 | Nine chat gaps where the replicated path skipped the local rule |
| #249 | R13b-rest stage 1: launch and supervise the engine daemon |
| #250 | Desktop suite green on Windows (21 machine-dependent failures) |
| #252 | R13b-S0: live chats + versioned daemon adapters (90 methods, 27 decoders) |
| #253 | R13b-SW: fence version switches and forks from live writes (#239 deferrals) |
| #255 | Recorded the R13b-rest OPEN decisions (MCP transport, key custody) |
| #256 | macOS SUN_LEN bind failure in the special-target materialize test |
| #260 | Actor condvar two-mutex violation, caught by the macOS evidence run |
| #261 | `engine.db` files too small to be a database opened as FRESH (macOS/Linux data loss) |
| #262 | `PROPTEST_CASES` silently ignored on the last two fuzz targets |
| #264 | `SQLITE_OPEN_NOFOLLOW` refusing symlinked ANCESTORS — would fail the cutover backup |
| #266 | The yjs<->yrs replay-parity gate |

Four of these (#256, #260, #261, #264) exist only because the macOS gate was
dispatched early rather than saved for the end. #261 is the sharpest: a
1-byte-truncated `engine.db` was reported as size 0 by SQLite's unix VFS, opened
as a fresh database, and had a new schema built over it — destroying exactly the
restore evidence the cutover depends on.

### State of R15-6, stated plainly

R15-6 scoped RPC-E and R13b-rest INTO the pre-flip work. Neither is close.

- **RPC-E:** parts 1 and 2 merged (#242, #243). Parts 3 and 4 are unmerged,
  carried by #263 after #246/#248 were closed. `crates/dohc-engine-sync-http`
  does not exist on `main`, and the daemon dispatch table on `main` has no
  `sync.*` / `keys.*` / `share.*` arms. **The desktop cannot drive replication
  through the daemon at all today.**
- **`main` is in a bad intermediate state.** #242/#244 landed the validation
  guards; #245 landed the refuse-and-ack disposition that pairs with them and is
  still unmerged. Until it lands, a rejected replicated op is a permanent wedge.
- **R13b-rest:** ZERO call-site migration shards have merged. Substrate only
  (#249, #252, #253). Open: #254 (S1), #265 (S2/S3/S4), #258 (S5), #257 (S6),
  #268 (S8 partial, stacked on #263's branch rather than `main`).
- **Five surfaces had no branch and no PR:** `sharedChannels.ts`,
  `shareMounts.ts`, `workspaceFiles.ts`, `workspaceSearch.ts`,
  `workspaceGraph.ts` (~2,485 lines), all still importing `@dohc/workspace-engine`
  directly. That line count badly overstates the work: **84% of it (2,083
  lines) is three files whose ONLY engine import is
  `classifyEngineFilePathForRead`**, a compatibility re-export of
  `@dohc/security-contract`. Those are a one-line redirect each, not a daemon
  migration -- done in #272. The genuine remainder is `sharedChannels.ts`
  (nothing to do once #268 lands) and `shareMounts.ts` (one field on
  `versionedText.list`, plus a shadow-marker decision).

### The cutover blocker, restated because it gates everything else

`packages/mcp/src/tools.ts` opens the engine stores per tool call
(`withEngineStores`, `:2540`) and performs agent WRITES from a separate
process -- `startChannelThread` (`:2830`) and `sendMessage` (`:2874`).
After the flip the daemon owns that database. Flipping without resolving the MCP
transport decision puts a second writer on the daemon-owned `engine.db` —
landing on top of a freshly wiped dogfood dataset. This is the single most
direct route to corrupting real data post-flip and it is decision-gated on Ice.

This was NOT previously unrecorded -- `DECISIONS.md:193` has carried "MCP
transport to the daemon -- OPEN" since #255. An earlier revision of this entry
claimed otherwise while its own merge table credited #255 for writing it. What
was missing was a SHARDS row, so nothing keyed off it; that is now R13b-S9.

### Review state, measured rather than assumed

An independent read-only triage re-checked every unresolved review thread on the
seven `main`-based PRs against their branch heads, discarding threads already
fixed. Result: **27 P1s genuinely open** (#263: 10, #257: 7, #245: 5, #258: 2,
#254/#259/#265: 1 each), measured at the time of the sweep. The PRs were
gate-green, not review-clean; those are different things and had been
conflated. #265's and #245's and #263's have since been closed and
mutation-proven, so the SHARDS rows and this count deliberately disagree --
the count is a snapshot of the sweep, not a live tally.

### macOS soak: diagnosed, not closed

Ten completed runs of `rust-engine-macos-evidence.yml`, ten failures, always on
the RSS bound. A 90-minute run showed quarter slopes halving
(72.8 -> 35.4 -> 16.9 -> 6.7 KB/s), RSS ending below its peak, threads ending
lower than they started — an allocator plateau, not a constant-rate leak.
#267 therefore evaluates the post-warm-up tail against the unchanged 20 KiB/s
bound, and records the question as an OPEN decision on that branch (it is not
on `main` until #267 lands).

`GATE6_PACKET.md` §1b was briefly marked RESOLVED on that basis. **That was an
overclaim and has been retracted.** No macOS soak has ever concluded `success`,
and moving the verdict window is a change to the criterion Ice authorized, not a
fix to a defect in it. It is now an OPEN decision in `DECISIONS.md`. Separately,
no macOS evidence JSON has ever been banked — every artifact upload hit the
GitHub storage quota, so the only banked soak evidence is the Windows run.

### Two guards that were not guarding

- `native_watcher_stop_joins_and_no_notification_arrives_after_return` was
  recorded as a `/mnt/c` inotify artifact to be ignored. It fails on native
  ext4 too. Experiment settled it: the watcher genuinely joins and no post-stop
  notification arrives; the TEST never drains the legitimate final pre-stop
  flush, so it trips wherever a startup burst is still pending — and passes
  vacuously wherever one is not. A recorded excuse was masking a hollow guard.
- `apps/site` has been failing `tsc --noEmit` on `main`: the demo passes the
  desktop `ActivityBar` a `chats` prop that `eb2c578b` removed. A broken site
  typecheck reads as noise from whichever PR is being run, which made a clean
  typecheck useless as a merge gate for all nine open PRs (fixed in #269).

### Residual worth carrying forward

There is no CI guard regenerating the richdoc fixtures against the TypeScript
oracle. `gen-fixtures.mjs` imports the live TS source, but nothing re-runs it,
so if `packages/ydoc-projection` changes again the Rust projection will drift
silently while the byte-for-byte parity test keeps passing against frozen
expectations.

## 2026-07-27 (later) — RPC-E and R13b-S8 land; the CI gap closes

**RPC-E is done.** #263 merged: `crates/dohc-engine-sync-http` plus the
`sync.*` / `keys.*` / `share.*` daemon dispatch arms. Until this landed the
daemon had NO replication methods and the desktop could not drive replication
through it at all.

**R13b-S8 is done.** #280 merged. #268 was auto-closed by GitHub when #263's
branch was deleted on merge (its base disappeared) -- the trap the handoff warns
about. Recovered by extracting #268's unique 2,964-line delta and applying it to
post-#263 `main` rather than rebasing, because #268's branch *contained* #263's
content without descending from it. Both conflicts were resolved by KEEPING
BEHAVIOUR: in `lib.rs` each side had added a different test, so taking either
wholesale would have dropped coverage with no failure to reveal it.

**The repository now has pull-request CI** (#275, in review). Before it, PRs had
no automated checks at all: Desktop Release was `state=disabled_manually` since
2026-07-01, the engine-tests workflow was registered but its file no longer
existed on `main`, and the macOS run was dispatch-only. On its FIRST run the new
gate independently reproduced two defects found by hand that day, and shortly
after found a third nobody had found: see below.

### The Linux inode-reuse bug (#279)

A workspace root replaced underneath a running watcher left the watch bound to a
dead inode while `disruption_count` read 0 and `is_unavailable` read false -- a
dead watch that reports healthy, which defeats the capture driver's supervision
loop because that loop polls exactly those two signals.

Cause: on ext4, `rmdir` followed immediately by `mkdir` at the same path reuses
the SAME inode number (5/5 in a direct probe). The identity check was therefore
a use-after-free of an identifier. `WatchedRoot` now holds the root open on
Unix, so the kernel cannot recycle it. Unix-only by design -- on Windows an open
handle would block the very `rmdir` being observed.

This was invisible to the canonical gate, which is Windows-only. It failed
**0/20 on Linux**. An earlier note in this program had recorded the symptom as a
`/mnt/c` artifact to ignore; that note was wrong and cost real time.

### R15 re-verified by mutation, not by reading

After R15-3 was found falsely marked done (#274), the other decisions were
re-checked by BREAKING each guarantee and confirming a named test noticed.
R15-4 passed cleanly (all four mutations caught). R15-1 and R15-5 did not, and
#276 closed both gaps: ordinal 14's backfill had no test at all -- it could be
inverted in the SECURITY direction, granting secret disk-ownership with no
materialization proof, and ~450 tests stayed green -- and R15-5's Linux
`RESOLVE_NO_SYMLINKS` refusal could be deleted with nothing noticing.

The lesson is worth keeping: an earlier careful audit READ all of this code and
concluded DONE for all three. Reading cannot find this class of defect.

### Decisions resolved

Ice ruled on 2026-07-27: the steady-state tail slope satisfies R15-2 (recorded
with the basis, since the same run is over the bound on the whole-run fit); MCP
proxies through desktop main; key-envelope custody stays desktop-side. Those were
the last decision-shaped blockers on R15-6.

## 2026-07-27 (close) — R13b complete; what still gates the flip

**Every R13b call-site shard is merged.** S0, SW, S1, S2/S3/S4, S5, S6, S8, S9, S10.
With RPC-E (#263) that is both halves of what R15-6 named.

Twenty-nine PRs merged today. The nine that were NOT in the handoff are worth listing,
because they were all found by looking rather than by being told:

| what | why it mattered |
|---|---|
| #269 | `apps/site` typecheck broken on main, making a clean typecheck useless as a merge gate |
| #271 | the watcher stop test was vacuous on Windows and red on Linux behind a wrong recorded excuse |
| #272 | 2,083 of the 2,485 "unmigrated" lines had never called the engine |
| #273 | `packages/cli` 10 tests red on Windows — and the obvious fix was hollow |
| #274 | **R15-3 was falsely marked done**; Rust still shipped the lossy serializer |
| #276 | R15-1 and R15-5 were marked done with unguarded guarantees |
| #279 | **a replaced workspace root left a dead watch reporting healthy** (Linux inode reuse) |
| #283 | RUSTSEC-2026-0009, hidden behind a `cargo-audit=SKIP` |
| #287 | main red from three PRs that were each green alone |

### The PR gate

This repository had NO automated checks on pull requests before today. It has now
caught two real regressions on its first day: the Linux inode-reuse bug and #287's
three-way integration break. Neither was findable from a single PR's gate.

### What still gates the flip

1. **No valid clone-reset rehearsal evidence.** The banked run predates 25 merges and
   the traversal hardening; a fresh run REFUSES on three pnpm hard links in
   `vendor/dohc-sdk` whose twins are all inside the source tree. Recorded as an OPEN
   decision — relaxing a fail-closed check on real data is Ice's call.
2. **macOS evidence still has never been banked.** A run finally got past the gate
   today only after #284 fixed a macOS-only `-D warnings` failure that neither the
   Windows gate (never compiles `cfg(unix)`) nor Linux CI (genuinely uses the
   parameter) could see.
3. **`DOHC_RUST_ENGINE_ADAPTER` is still present** — six call sites in `main.ts`.
   Deleting it makes the TypeScript path unreachable, which IS the flip.

### The pattern worth carrying forward

Seven separate defects today were checks that reported green while verifying nothing:
a SKIP step, frozen fixtures, an untested backfill, a vacuous test, tautological
assertions, a self-skipping suite, and a drift check that skips without node_modules.
**Reading never found these** — a careful audit read the same R15 code and passed all
three items, two of which were unguarded. Mutation did.

## 2026-07-27 (final) — the engine work is done; two evidence gates remain

**32 PRs merged.** RPC-E and all nine R13b shards are on `main`, MCP no longer opens
the engine database, every review loop is closed with mutation-proven fixes, and `main`
is fully green: canonical gate PASS on every step (including `fixture drift` and
`cargo-audit`, both of which were silently SKIPping this morning), desktop 178 files,
MCP 4/4, CLI 4/4.

**The flip itself is built and gate-green, held unmerged in #290.** The
`DOHC_RUST_ENGINE_ADAPTER` flag is deleted at all six call sites; `relayTransportModeForRoot`
lost only its flag parameter and kept all three real runtime conditions (null root,
absent marker, malformed marker).

### What still gates it

1. **R15-2 is NOT satisfied on final main.** The macOS soak fails at
   `rssSlopeTailB/s=21171.3` against the unchanged 20480 bound — under the tail
   methodology, not merely the old whole-run fit. Recorded in GATE6 §1c. Deliberately
   NOT attributed to today's merges: one sample on each side cannot separate a
   regression from runner variance, and this program has already made and retracted one
   confident claim from insufficient data. A repeat run is in flight.
2. **The clone-reset rehearsal.** Blocked on three pnpm hard links whose twins are all
   inside the source tree; the harness fails closed on any link count above one. Being
   narrowed to refuse only OUTSIDE-tree twins, proven in both directions.

### What made the difference today

The handoff described the remaining work as merging PRs and running a cutover. The work
actually consisted of discovering that several things marked DONE were not:

- **R15-3** was recorded done while Rust still shipped the lossy serializer, because the
  parity fixtures were frozen against an oracle that had moved.
- **R15-1's** ordinal-14 backfill could be inverted in the SECURITY direction with ~450
  tests still green.
- **R15-5's** Linux `RESOLVE_NO_SYMLINKS` refusal could be deleted with nothing noticing.
- **A replaced workspace root left a dead watch reporting healthy** — `disruption_count`
  0 and `is_unavailable` false — defeating the capture driver's supervision loop, which
  polls exactly those signals. Linux reuses inode numbers; the identity check was a
  use-after-free of an identifier.
- **A real DoS advisory** sat on `main` behind a `cargo-audit=SKIP`.

Seven of the day's findings share one shape: **a check that reports green while
verifying nothing.** A careful reading audit had passed the very R15 items that turned
out unguarded. Mutation found them; reading did not.

The repository also had **no automated checks on pull requests at all** until today. The
gate added in #275 has already caught two real regressions — the Linux inode-reuse bug,
and a three-way integration break where each PR was green alone and `main` was red.


## 2026-07-28 — both evidence gates re-examined; one closed, one voided and rebuilt

Neither remaining gate was closed by running it again. Both turned out to be measuring
something other than what they claimed.

### The rehearsal gate — CLOSED (#292)

`clone_tree` failed closed on any source file with `link_count > 1`, so the clone-reset
rehearsal could not run at all on a workspace containing a JS project: pnpm hard-links by
default. Three files under `sites/dohc-workspace-demo/vendor/dohc-sdk` tripped it, and
every twin resolved inside the source tree.

Narrowed to what is actually unsafe. An inside-tree twin is not an aliasing escape — the
clone copies bytes and each name gets its own copy. An outside twin still fails closed,
and Unix still fails closed because `nlink` exposes that aliases exist but not where, and
faking containment would be worse than refusing.

Evidence, reproduced across two independent runs against the real dogfood workspace:

```
outcome: complete    paths 27/27    records 27/27
content_identities_verified 27     mismatches []     projections_settled true
source_unchanged.verified true     sha256 identical before and after
hard_linked_source_file_count 3    inside 3    outside 0
```

`backup-reuse-foreign-clone` on a repeat run is correct behaviour, not a defect: the check
fires in `Settled`, before the destructive move-aside in `BackedUp`, so a stale recovery
dir refuses before anything is destroyed. Repeat rehearsals need a fresh recovery dir.

### The soak gate — the FAIL and the PASS were both void (#293)

The macOS soak failed the tail bound at 21,171 B/s. A repeat of the same commit passed at
16,996 B/s. Same code, same workload, opposite verdicts — which is what a measurement of
the wrong thing looks like.

Every phase-2 scenario keyed its object and path identities on the raw cycle counter, so
each cycle created a NEW permanent object, path, blob and FTS entry: ~92 KiB of durable
content per switch cycle, 25 permanent files per storm cycle, past 57,000 files. Opening a
workspace builds a manifest of every captured entry, so the process grew because the
workload grew. Measured directly: workspace `a` reached a 106 MB `engine.db` (34.8 MB
`blobs.text`, 35.0 MB FTS) while workspace `b` — its partner in the same scenario, opened
and closed but never written — stayed at 774 KB.

The recorded "quarter slopes halve, so it is an asymptotic plateau" diagnosis was the
daemon slowing down. Bytes per SECOND fell only because the cycle rate fell 65% as each
reopen re-enumerated a linearly growing tree; per unit of work, growth was flat-to-RISING
(16355, 19792, 9562, 20095 bytes/cycle, worst in the final quarter).

Two false starts worth recording, because both were plausible:

- **Durable bytes are the wrong bound.** The first fix gated on them and reported INVALID
  on itself — 70 MB over 7,804 cycles. `moments` is append-only and every write needs a
  fresh `momentId`, so bytes grow whenever the workload works. Bytes also do not drive
  RSS: no `cache_size` pragma is set anywhere, so SQLite's page cache stays at its 2 MB
  default and a larger database is not a larger process.
- **Two of four candidate causes did not survive checking.** `moments` is NOT unindexed
  (`idx_moments_workspace_order`, plus `UNIQUE(workspace_id, moment_order)`), and
  `PRAGMA quick_check` does NOT run on every open — `probe_integrity_ok` fires only in the
  unrecognized-`user_version` arm of `classify_fingerprint`.

The bound is now the LIVE WORKING SET in user files, which is what the manifest scales
with, and is structural rather than a function of machine speed and run length. A/B on one
machine, same runner and budget:

```
unbounded   userFileGrowth +26,525   RSS tail 9,984 B/s   end 44.3 MB
bounded     userFileGrowth +25       RSS tail 1,859 B/s   end 21.8 MB
```

The runner now records its own precondition and serializes `rssDisposition` and both RSS
assertions as `null` when it fails, so such a trend can be cited in neither direction. A
genuine daemon failure still reports FAIL, since a workload cannot invalidate a handle
leak or a dirty shutdown.

### Found while auditing

- **#294** — the stale-actor eviction path removed the handle and its Y.Doc sessions but
  left the handle's pending cursors, which nothing could then remove: `consume_pending_cursor`
  matches on the handle and every rebind mints a fresh one. Not consumable, just permanent.
  The normal close path three lines away always dropped them. The program's recurring shape:
  enforced on the normal path, skipped on the error path beside it.
- **#295** — CI had never run `cargo-audit`. The workflow did not install it, so the gate
  probed, reported SKIP, and `requiredSteps` did not object. Both halves fixed together,
  because either alone still reads green.
- **The only end-to-end test of the TypeScript desktop capture path against a real daemon
  has never run in CI** — `it.skipIf(!existsSync(binaryPath))` against a hardcoded `.exe`,
  which CI never builds and Linux cannot match. It FAILS when forced to run, on `main` as
  well as on the flip branch, and not for want of retry budget. Under investigation; the
  cutover makes that path the only path.

### Gate evidence

```
2026-07-27T15:38:41.002Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS
fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS
cargo-deny=PASS cargo-audit=PASS
```

First fully-green canonical gate of the program with **no SKIP rows**: `fixture drift` and
`cargo-audit` had both been skipping.

### The pattern, restated

Ten instances in two days of a check reporting green while verifying nothing. The two
newest are the most expensive: a cutover-blocking soak that measured its own workload, and
the cutover's only end-to-end test skipping itself out of existence.

Two rules earned today:

- **A check that reverses on identical code is evidence in NEITHER direction.** When a
  re-run flips red to green, that is not luck to bank — it is proof the check is not
  measuring the code.
- **Normalize per unit of work.** Bytes per second falls when throughput falls, so the
  bound is flattered exactly when things are getting worse.

## 2026-07-28 — Full post-cutover audit: the engine core held; the edges did not

A 25-agent audit (completeness, test-quality, eight subsystem reviews, every
serious finding independently re-derived by an adversarial verifier) ran
against `edaeb575`, alongside direct evidence runs: canonical Windows gate
PASS, desktop suite 176 files / 2,257 tests green, and all four real-daemon
e2e suites passing — including relay push/pull between two replicas.

What held under hostile review: the yrs decode pre-validation (all 53 call
sites), the refuse-and-ack transaction shape, #294's eviction completeness,
migration-drift impossibility (no separate fresh-create path), the daemon
handshake, and the cutover itself — no fallback-to-legacy path exists.

What did not: **eleven confirmed P1s**, every one an instance of the program's
two known shapes (a guarantee skipped on the sibling path; a check that checks
nothing). The tracker gained one `AUDIT-*` row per finding; headline set:

- Replicated chat applies skip chat FTS (apply.rs:1198) — synced messages
  permanently unsearchable. Capture ingest/retire/binary and ydoc settle skip
  file FTS (actor.rs:9373) — search rots on the primary editing paths.
- One refused ydoc recordUpdate poisons settle AND close (silent edit loss, a
  leaked daemon lease); applyLocalUpdate applies renderer-first and drops
  edits on non-reconnect errors.
- conflicts.list is the one unpaged read — an over-frame response kills the
  daemon session in a loop. Rolled-back binary delete/rename never restores
  disk, and the next open capture-retires the restored head.
- Ordinary materialization follows symlinked ancestors (secret paths walk;
  ordinary paths do not). Desktop search still opens a second WRITABLE
  connection to the daemon-owned engine.db. The SHADOW_CLONE relay-mode sniff
  races the daemon's own marker write. CLI daemon reads collide with the
  desktop's Full-mode handle. The collab crash/exactly-once test family is
  compiled out of every gate (all 17 pass when forced — today).

The most expensive discovery was operational, not code: **every workflow was
disabled** (#300, for cost) — the PR gate built in #275 never ran again, and
the R16 groups merged "verified locally with CI disabled". #306 re-fits the
gate inside Blacksmith's free tier (3,000 x64-2vCPU-min/month): rust-cache,
prebuilt pinned deny/audit (compiling them from source had cost more than the
rest of the gate), and a paths filter. Same checks, verbatim honesty
machinery; measured cost to be posted on the PR before merge.

Ledger corrections in this commit: REPLICATION-REFUSAL and R15-2 rows flipped
to their real states (both had been left open after closing), RPC-E parent
closed, the R13b-S10/R13b-rest contradiction resolved, the GATE6 packet header
updated to the closure, the macOS soak evidence banked in-repo before its run
logs expire, RPC_GAP's removed retry-budget paragraph corrected to the shipped
never-ack-without-progress semantics, and DECISIONS.md reconciled (hard-link
relaxation executed-pending-ratification; relay sequencing resolved-by-events
with the key-envelope residual moved to AUDIT-KEYENV; the member-share-log
epoch question recorded as a sharing-milestone prerequisite).

## 2026-07-28 — Audit fix campaign: eleven P1s closed across twelve PRs

The full post-cutover audit (entry above) is discharged. Every confirmed P1
now has a merged or in-flight fix, each landed the same way: implementation by
gpt-5.6-sol (codex) or directly by the orchestrator, then an independent
canonical-gate run on the exact tree, at least one orchestrator-run mutation
proof (delete/invert the fix, watch the named test fail behaviorally,
restore), and a codex re-review anchored to the final head. No shard merged on
its implementer's word.

Merged this campaign: #306 (CI refit; superseded by Ice's #318 — the PR gate
is deliberately dispatch-only pre-launch, so the local canonical gate is the
merge authority), #307 (integrator reconciliation), #309 (syncFolder deflake —
the "flake" was a real design property: same-millisecond moments rank by
ciphertext bytes), #310 FTSCHAT, #311 KEYENV, #312 MARKERRACE, #313 FTSFILES,
#314 YDOCLOSS (six review rounds; the fifth found a silent-swallow latch worse
than the original bug, the sixth a leaked daemon lease on refused replacement
opens), #315 SEARCHRPC (four rounds; the last second-writer connection to
engine.db is gone, search pages through generation-pinned keyset RPC), #317
CONFLPAGE (paging bound moved into the domain SQL after round 1 left full-table
hydration behind the serializer). In flight at this entry: #316 BINROLLBACK
(review rounds keep finding real generation/namespace/scoping defects — the
watermark, job-identity, and version-fence family), #319 FAULTGATE (the three
crash/exactly-once tests were compiled out of every gate run; the gate now runs
the collab crash tier and a skipped required step fails the verdict — including
the independent evidence validator), #320 SYMLINKMAT (ordinary materialization
now walks every below-root ancestor like the secret path), #322 CLIMODE (CLI
reads join the live binding as non-owning attachments).

### The two rules this campaign earned

1. **`gh pr merge --delete-branch` deletes the remote branch even when the
   merge fails.** GitHub then refuses to reopen the auto-closed PR (#308 died
   this way and was reborn as #314). Merge first, read `state`, only then
   delete the branch.
2. **A check that reverses on identical code is evidence in neither
   direction.** The CI flake that blocked three PRs was a deterministic design
   property, not luck. Root-cause flakes; never retry them into submission.

### Gate evidence (final heads)

- #314: desktop typecheck clean; workspaceEngineYDocRestart 9/9; mutation —
  markDead(failed)->markDead(null) fails 3 tests.
- #315: 2026-07-28T11:09:18Z | run-rust-checks | win32/x64 | PASS (all rows) +
  JS typecheck/test suites PASS; mutation — short-only source budget fails
  regular_fts_file_page_bounds_source_before_materializing_all_hits.
- #317: 2026-07-28T10:01:30Z | run-rust-checks | win32/x64 | PASS (all rows;
  the first run caught a clippy failure codex's targeted tests missed);
  mutation — dropping the SQL LIMIT hydrates the poisoned row.

### The audit P2 backlog — held for Ice's call

The audit's ~10 unverified P2s are deliberately NOT riding this campaign
(P1s only). Recommendation: hold them for the dogfood window and open them as
one triaged shard batch, re-verifying each against post-campaign main first —
at least two (desktop search second connection @ main.ts, sharedView mixed
connections) look partially or wholly discharged by #315 and need re-checking
before any work is dispatched. The list, verbatim from the audit: foreign
user_version=2 adoption (schema.rs:274); dispatch write paths accepting
unvalidated now_ms (chats.rs:5438); local-only close CRDT prune window
(durable.rs:979); refused-and-acked redelivery wedge (moment_apply.rs:315);
malformed blob-sha wedging a pull pass (relay.rs:1411); concurrent same-path
creation stalling the inbound lane (ydoc_apply.rs:667); writeBlob copy-by-sha
without egress budget (lib.rs:2184); sync.commitCursor one-shot token order
(lib.rs:1701); relay adapter retrying non-idempotent recoverOrigin
(engineRelayClient.ts:474); frozen cross-engine security-contract fixture with
no drift guard (gen-fixtures.mjs); no Windows CI leg for cfg(windows) tests
(pr-checks.yml — interacts with Ice's #318 dispatch-only decision).

### Additional deferred items surfaced by the campaign's own reviews

The layered reviews of the in-flight shards surfaced issues beyond their
scope; recorded here beside the audit P2s so they ride the same triage:

- **Rollback of a Blocked/pending settle moment orphans its ydoc-mat_ job and
  voids the CRDT prune guard** (medium; the pending-job EXISTS joins moments,
  rollback deletes the moment, and the rollback cancellation block never
  covers ydoc-mat_ ids — exposure pre-existed via the transient-Err settle
  arm). Rollback-domain surgery; intersects the AUDIT-BINROLLBACK family.
- A blocked-then-recovered ydoc settle leaves one stale self-write
  suppression entry (low; self-healing — equal-content ingest dedupes and the
  next settle drains it). The settle test's recorder counts are deliberately
  unpinned until this is resolved.
- `JobOutcome::Blocked` reports as `Skipped` over the post-commit wire —
  callers cannot distinguish "pending, retry after containment restored" from
  "nothing to do" (low; protocol addition).
- CLI read attachments have no reaper: a failed CLI-side close leaves the
  attachment for the owner's lifetime, bounded by the 64-handle cap (low).
- The symlink/junction test fixtures skip silently where alias creation is
  unavailable (file symlinks need Developer Mode on Windows; dir aliases fall
  back to junctions). The WSL leg of the gate covers them — the known
  Windows blind-spot rule applies.
- Pre-existing: `ensure_secret_target_symlink_free` is referenced only under
  cfg(not(any(unix, windows))) and defined nowhere — exotic-platform builds
  cannot compile; harmless today, worth a cleanup.

### Campaign completion addendum (2026-07-28 afternoon)

The four in-flight PRs from the entry above are merged:

- #319 FAULTGATE (4 rounds; the round-2 review caught the fix's own blind spot
  — the independent evidence validator still accepted crash-tier-less PASS
  lines; final delta docs-only).
- #322 CLIMODE (3 rounds; the local adversarial review found the write-
  isolation mode line had NO test killing its mutant — the repo had never
  asserted the read-only gate's refusal at all; now mutation-pinned).
- #320 SYMLINKMAT (3 rounds + two local adversarial reviews; round 2 replaced
  the batch-aborting refusal with JobOutcome::Blocked after review showed one
  user symlink stalled every other path's materialization; round 3 made
  Blocked crash-consistent at the ydoc settle sites).
- #316 BINROLLBACK — the campaign's deepest shard (10 rounds). Every round's
  findings were real: generation watermarks poisoned by projection
  timestamps, spoofable job identities, capture seeds crossing version
  boundaries, workspace-unscoped fences and backfills, an inverted legacy
  sentinel, ENAMETOOLONG from coordinate-bearing IDs, and finally the
  inactive-rename reconcile gap. Merged on gate PASS + mutation proofs +
  layered review of the final round.

Codex's GitHub review bot degraded through the afternoon (tags served with
40-120 min latency, then not at all); the compensating control was local
fable-5 adversarial reviewers with falsification briefs, whose findings are
dispositioned on the PRs and whose deferred items are recorded above.

## 2026-07-29 — The manual dogfood window, replaced by machine verification

Ice declined the program's "use it daily for ~2 weeks" phase. This campaign ran in
its place: the full automated suites, a full-suite Playwright e2e baseline (the
first complete run in the project's history), a 60-minute cutoverBlocking soak,
and five gpt-5.6-sol computer-use journeys driving the REAL app through scripted
user days — with every finding triaged by fan-out agents and every fix carried
through the audit campaign's method (mutation proof + layered adversarial review
+ gate). Base `6eec9d08`; final `0c78d3b6` after eight merged PRs.

### Evidence

Canonical gate on final main, every row:

    2026-07-28T21:27:07.862Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS
    fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS
    test collab crash tier=PASS cargo-deny=PASS cargo-audit=PASS

60-minute cutoverBlocking soak (evidence banked beside this entry as
`soak-evidence/windows-2026-07-28T21-28-34Z-cutoverBlocking.json`):

    2026-07-28T22:30:47Z | soak-cutoverBlocking | windows/x86_64 | PASS | cycles=17164
    crashes=83 durationSecs=3732 rssDisposition=PASS rssSlopeWholeB/s=2024.4
    rssSlopeTailB/s=1978.8 warmupDominatedWholeRunFit=false drain=RETAINED
    rssDrain 27303936->27217920 min=27217920 drop=86016 (0.5% of run growth)
    handles 110->110 threads 38->34 handleThreadSlackCalibration=CALIBRATED
    workingSetBounded=true userFileGrowth=25 durableGrowthBytes=126857781

The JS side of final main is green too — `pnpm run typecheck` clean and
`pnpm run test` at **3,666 tests across 268 files, zero failures**. Getting
that number honestly took three fixes, because the suite had several tests
whose green depended on a quiet machine: a FileInspector test invoked a toggle
through an optional chain that silently no-ops until the component registers it
(#339); the sync-relay integration suite spawned a real relay whose own port
wait allows 15s inside vitest's stock 5s per-test ceiling (#340); and a
lifecycle test slept 30ms hoping an internal 20ms reset timer — scheduled after
the launch it follows — had already fired (#341). Each failed under the
parallel run and passed alone, which is precisely the shape this program treats
as evidence in neither direction until it is root-caused.

Desktop e2e went **28 passed / 30 failed** at campaign start to **49 passed /
8 failed** on final main. The suite had never run to completion anywhere: CI runs
only the vitest daemon e2e, and a fresh worktree cannot launch the app at all
without a debug daemon staged at `apps/desktop/target/debug/` — the first full run
was 100% invalid for that reason alone.

### What the suites found, and what shipped

**The engine editor had never worked in the shipped app** (#327). Three defects
stacked: `RelayConfiguredDaemonClient` implemented only `sendRequest`/`close`, so
the wrapper main.ts puts around every daemon client silently dropped `onEvent` —
the Y.Doc open path gates on it, threw, and a bare `catch` turned that into
`available:false`, permanently pinning every rich doc to the legacy editor. With
that unblocked, the desktop never passed `contentKind`, and the daemon defaults an
unspecified session to PLAINTEXT: docs opened EMPTY, typed edits journaled into a
root the projection never read, and each settle wrote the pre-edit file back while
the UI said "Saved". Beneath that, a stale C1-era guard refused richdoc settle in
`ydoc.settle`, `ydoc.close`'s default, and the version fence — a residue of the
era before #238 landed the full-fidelity projection *so that* richdoc could settle.
Review round two added: settled local richdocs prune at close like plaintext (a
persisted CRDT shadowed external .md edits and wedged later settles on
`ConflictStaleTarget`); bare markers no longer let a remembered default override an
explicit kind (~3 weeks of the dead path minted plaintext markers for rich .md
paths); and a close whose settle failed but whose release SUCCEEDED no longer
leaves the path's capture deferred forever.

Also fixed: opted-out workspaces grew engine stores through an ungated dispatch
scan (#326, a graded invariant; eligibility now snapshots at open); the Rust
bootstrap named the main version `main` while TS, replication, and every UI
fallback said `Main` — seven specs died at step zero and locally-bootstrapped
state genuinely diverged from replication-bootstrapped state (#325, with an
ordinal-25 backfill and a collision guard); the conflict panel — #317's surface,
getting its first e2e coverage — died on a two-field wire-decode gap (#332, panel
and resolution now green end to end); daemon capture stamped no moment metadata and
never told the renderer a moment landed (#331); agent-sandbox was broken on Windows
by a `split(":")` on PATH (#324).

Five e2e specs were rot, not product: they seeded `engine.db` through TS stores
that the daemon now refuses. They were converted to seed through the real daemon
over RPC (#332's `daemonSeed.ts`), including the switch-race spec's full
1,000-moment corpus.

### The journeys

Five scripted user days. The soak and the suites say the engine is sound; the
journeys are what a person would actually hit, and they found what the suites
could not:

- **A document over 48 KiB never reaches disk, silently.** `INBAND_CONTENT_CAP_BYTES`
  is 48 KiB; the settle refuses `ydoc-settle-exceeds-inband-cap` on every debounce;
  the provider routes that to `onSessionError`, which the desktop wires to
  `requestReconnect`, which ignores non-reconnect errors — no log, no UI. The editor
  shows the full document and "Saved" while the .md is 0 bytes. Three independent
  journeys reproduced it.
- Hard-killing the daemon mid-typing surfaced an uncaught EPIPE dialog and a dead
  editor on the first kill, and content typed before the third kill was lost from
  both app and disk. Whole-app kills, by contrast, lost nothing — even at ~0.5 s.
- A rolled-back binary left a stale Open Editors tab across restart, and reopening a
  bulk merge after a binary rollback fails `binary-head-not-text` — the same
  unimplemented WS-G1 binary-conflict contract the e2e suite hits.
- After a workspace switch the accessibility tree kept exposing the previous
  workspace's document for ~4 s. The visible surface was correct (the capture
  records "no WS-A document pixels visible"), so this is stale retained DOM, not the
  repaint invariant — but it is the other workspace's content, still readable.

What held: adversarial pastes (control characters, a fence whose info string carries
a backtick, astral emoji) never broke saving; restart persistence; rapid version
switching with no cross-version leak (12 switches, 225–251 ms); binary rollbacks
byte-correct on disk; 30 conflicts paging without killing the daemon; junction
containment with the outside tree byte-identical and the write queue still live for
unrelated paths (#320's point, confirmed under a real hostile filesystem); a
watcher storm of 200 external files indexed and settled; double-launch
focus-existing.

### The cloud surface

Every remaining e2e failure is the opt-in cloud surface, and the triage found why:
file writes never replicate at all (the daemon fills `replication_journal`; nothing
drains it into `replication_log`, so only chat ops and replicated ydoc lineages
reach the relay); a second machine cannot join a synced workspace because no
identity-adoption path exists anywhere; `cloudEnableSync` and share materialization
still open the v2 daemon store with the v1-only TS `secretFileStore` and fail
`state-corrupt`; the owner's sync in the multiuser flow is terminally refused
`relay-origin-diverged`. These are design-level gaps in an unfinished surface, not
regressions from the rewrite — and note they mean those flows are *already* broken
against daemon stores today, so R16 does not make them worse.

### Verdict

For the local-first product — the thing AGENTS.md says dohc IS — the rewrite is
verified well past what one person's fortnight would have covered, and the campaign
found and fixed defects a human dogfood would likely have suffered silently
(an editor that never engaged; typing that settled back to the pre-edit file while
claiming "Saved"). R16 is GO for the local core once the journeys' open P1s land.
The cloud punch-list above is Ice's to sequence; it is tracked, not silent.

### Addendum, same day: the journeys' P1s, and what fixing them exposed

The entry above said R16 was GO for the local core "once the journeys' open P1s land".
They landed, and the landing was the most instructive part of the campaign.

**The daemon-kill pair (#343, three rounds).** The uncaught EPIPE was never the
daemon's stdin: main's own `console.error` throws synchronously on a broken
stderr pipe, and it threw *inside* the catch handler reporting the daemon's
death, turning a recoverable event into an unhandled rejection that aborted the
in-flight rebind. The lost text was `EngineClient` forgetting *why* it closed —
`fail()` recorded `transport-error` but later requests reported a bare
`"closed"`, so `isTransportError()`, the sole gate on "the daemon may be
relaunching, retry", read false. Review round two found the fix was wired into
`applyLocalUpdate` only, so a revived session's text was still discarded by
`close()` — including the settling close at quit, which is exactly the journey's
scenario (the user stopped typing before the kill). Round three found that the
resulting fix burned 2,579 ms of the 3,000 ms `will-quit` budget, leaving too
little for the SQLite closes chained behind it; bounded, it now costs 117 ms and
still recovers a daemon that returns mid-relaunch, because
`retryTransportErrors: false` is two attempts 100 ms apart — which happens to
match the supervisor's own first-relaunch delay.

**The silent-save fix (#345, five rounds) walked into the bug beneath it.** The
48 KiB cap was only a response-encoding constraint, so the file could be
materialized from a projection the daemon already held. But making over-cap
documents actually reach disk created a state nothing had produced before, and
the capture sink retires anything past its 128 KiB ownership limit. Self-write
suppression could not prevent it: suppression matches a *write* by sha, while
this is a *retire* on a size classification that never consults it. The result
would have been the exact inverse of the bug being fixed — an honest "Saved",
then the record retired, then "Couldn't save" on a document that genuinely
saved. It was caught because the orchestrator ran the canonical gate itself
rather than accepting a reported one; the test failed only in the parallel
workspace run and passed 3/3 in isolation.

**Two invariants were written down as true and were not.** The save-sequence
mechanism — built specifically to stop a settle vouching for edits it never
carried — twice relied on completion ordering, and twice the ordering claim was
false: first because one scalar cannot hold several in-flight settles, then
because a settle that aborts before the barrier announces itself and never joins
the queue it was assumed to join. Both were found by replaying the real
provider's callback stream rather than by reading the code. It now pairs on an
explicit token, so correctness no longer depends on which paths queue where.

**Three JS tests were green because the machine was quiet** (#339, #340, #341),
and one of those fixes was itself fake: it polled a variable initialised to
`null` with `toBeDefined()`, which passes immediately, so the guard never waited
(#351). That fix had survived a merge, a citation in this log, and a rebase
before anyone checked the assertion itself. Agent worktrees also silently voided
whole test runs — they check out inside the repo, so an excluded crate attaches
to the outer manifest, and because the root test script bails on first failure
the entire JS suite died in about two seconds before `apps/desktop` ran (#348).
That is the mechanism behind one subagent's reported-green run that had executed
nothing.

Local-first suites on final main: canonical Rust gate PASS on every row, JS
typecheck clean with 3,666 tests across 268 files, and the desktop e2e at
**54 passed / 7 failed / 5 skipped** — from 28 passed / 30 failed when the
campaign began. Every remaining failure maps to a filed issue: the
win32-disabled CLI, five cloud-surface gaps (#335), and the binary-merge
contract (#336). No unexplained failure remains.

R16 stays GO for the local core. The cloud punch-list (#335) is unchanged and
still Ice'''s to sequence.


## 2026-07-30 — R16 closeout: fourteen PRs, and a commit message that described work that was reverted

The closeout items (A–E) are done and the program's two open decisions are
answered. What follows is the part worth keeping: three green results that were
not green, and one false record that reached `main`.

### The record on `main` is wrong for #375, and cannot be repaired in place

`e7116799` ("retire the native-suite runner, and keep the arch pin it was
carrying") carries the commit message from that PR's **first** iteration. Three
of the four changes it describes are not in its diff:

- the `--expect-arch` pin "moved there instead of being lost" into
  `run-rust-checks.mjs` — **not done**; that file is not in the diff;
- the two `pnpm --filter @dohc/workspace-engine` steps removed from
  `desktop-release.yml` — **not done**, deliberately;
- `DECISIONS.md` recording the move — **not done**; that file is append-only and
  the edit was a revert.

Its closing "Verified: the moved pin aborts with exit 2 on `--expect-arch=arm64`"
describes a guard that does not exist in the merged tree. So `main`'s history now
advertises an architecture check the repo does not have — the same false
assurance that PR existed to delete. Squash-merging took the stale body because
the message was written before the reverts and never rewritten.

It is recorded here rather than fixed because the only repair is a force-push to
`main`, which is worse than the defect. **The rule this earns: when a PR's
approach is abandoned mid-review, rewrite the commit message before merging, not
the PR description.** The description is what reviewers read; the message is what
survives.

Why the pin was abandoned, since the message argues the opposite: it compared
`os.arch()`, the architecture *Node* was built for, and never consulted the Rust
toolchain. Ten distinct channels can set cargo's effective target, and a
`--target` injected through `RUSTFLAGS` reaches rustc while cargo still writes to
`target/debug` — invisible to config parsing and to `target/<triple>/` watching
alike. The retired guard could not do its job, so no replacement was faked. The
README now states plainly that there is no architecture guard and that a run's
platform is whatever the operator asserts when pasting an evidence line.

### Both blocking decisions are answered

- **Kernel sidecar accelerator: retired** (#376). The crates, the client, the
  `fallbackReconcileScan` branching and the `cargo fetch --manifest-path
  crates/workspace-kernel` CI step went together. `fixtures/workspace-kernel/`
  was kept — live input to `dohc-engine-files/tests/differential.rs`.
- **Native-evidence gate: retired** (#375), with the correction above.

Steps 2 and 6 of #362's decomposition are therefore unblocked.

### Three failures that were the harness, not the code

Each looked like a defect and was not. All three were mine, and ruling them out
mattered more than finding them, because two of them pointed at a merged PR.

**A rebase across a new package subpath needs a re-install.** After rebasing onto
a main that contained #377, two sync-relay files failed collection with
`Failed to load url @dohc/workspace-contracts/relay`. That reads exactly like a
missing file and looked like #377 had broken `main`. The worktree's
`node_modules` predated the merge, so the new subpath was absent from the linked
package. `pnpm install --frozen-lockfile` resolved it.

**An assertion failure on a stale tree is not a finding.** An
`engineDaemonLifecycle` test failed with `expected [] to have a length of 1`
under that same stale install, and passed in isolation. It does not recur on a
clean run. Different base and different install means it was never evidence.

**Surveying the shared checkout reports another session's branch.**
`packages/workspace-kernel-client` appeared still tracked, which would have meant
#376's deletion never took. The primary checkout had been switched to an
unrelated branch by a concurrent session. #376 deleted it correctly. **Read
`origin/<ref>` explicitly, or work in a dedicated worktree; never survey the
shared tree.** The same hazard silently killed a PR watcher earlier in the
program.

### Scoping this campaign with grep does not work

Restating it because it keeps costing time. A `@dohc/workspace-engine` grep over
`apps/desktop/src/workspaces/` matches 40 files but only 27 import the legacy
package — the rest import `@dohc/workspace-engine-client`, a different package.
An exact-string grep including the closing quote finds 45 across the repo, and
that is a **floor**: `scripts/engine-sync-folder.ts` imports
`packages/workspace-engine/src/syncFolder` by deep relative path, bypassing the
`exports` map, and is invisible to any such search.

### The packaging port, landed reduced

`engineClient.ts`, `engineDaemonLifecycle.ts` and `engineWorkspaceSessions.ts`
moved into `packages/workspace-engine-client/src/daemon/` so `services/sync-relay`
can drive a real daemon. `engineRelayClient.ts` **stayed** in `apps/desktop`:
it needs `probeRelayWorkspace`, which lives in a 974-line legacy `syncRelay.ts`
that drags `versionedTextStore`, `syncReplication`, `syncApply` and the legacy
`EngineSqliteDb` behind it, and its wrapper binds the route `mode: "typescript"`
explicitly — a deliberate legacy leg, not a missing shim. Moving it would have
made the new shared package depend on the package R16 deletes.

A reduced port that keeps the new package legacy-free beats a complete port that
entrenches the dependency. Tracked as #383, with a cheaper route than the daemon
work recorded there: inject the probe, since its types already live in
`@dohc/workspace-contracts/relay`.

Key custody was verified unchanged: all moved modules are Electron-free and touch
no raw key material, `workspaceKeyEnvelopeEnrollment.ts` and its raw
`.dohc/engine/secret.key` read stay desktop-side, and the mutation-guarded
sentinel test changed only its import specifiers.

### Gate evidence

#375 final head `2928f6ecd0`, all rows PASS, summary block parsed rather than the
exit code (the gate can exit 0 while its summary says FAIL):

- 2026-07-30T07:42:58.725Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS test collab crash tier=PASS cargo-deny=PASS cargo-audit=PASS

JS suites on that head: `pnpm run typecheck` exit 0, `pnpm run test` exit 0, zero
failures.

### The port's own results, and a layering inversion the move created

Port suites on the port head: `pnpm run typecheck` exit 0, `pnpm run test` exit 0,
zero failures — 274 files and 3,701 tests passing across 20 packages.

The move quietly created a defect worth naming, because the shape recurs whenever
a test travels with its subject. `engineDaemonLifecycle.test.ts` moved into the
shared package still carrying one test that climbed
`resolve(..., "../../../../apps/desktop")` to assert on three Electron packaging
artifacts — `scripts/require-workspace-engine.mjs`, `electron-builder.yml`, and
`.github/workflows/desktop-release.yml`. It passed, so nothing failed; a
shared-package test asserting on the Electron app's packaging config and a repo
workflow is simply the dependency arrow pointing the wrong way. It also
reintroduced the four-level climb out of `packages/` that the port banned in
source — the guard grep only forbade `../../../../packages/`, so a climb into
`apps/` walked straight through it.

Fixed in the same PR rather than deferred, since the port caused it: that one test
moved to `apps/desktop/src/enginePackagingGate.test.ts`, and the package's
lifecycle suite lost its `desktopDir` and four now-unused imports. Counts confirm
the test moved rather than vanished — the package went from 293 to 292 tests and
desktop from 2,249 to 2,250.

**Mutation-verified rather than assumed green:** rewriting `electron-builder.yml`'s
`beforePack:` to a different hook makes it fail, so it genuinely guards that
config. The mutation was reverted in a separate command, because a compound
`mutate && test && restore` never reaches its restore leg when the middle step
times out.

## 2026-07-30/31 — the fallback was never reachable, and I said the opposite for hours

Seven more PRs landed: #401, #406, #410, #411, #413, #414, #415. The through-line is that
the legacy engine's remaining hold on the product turned out to be entirely test-shaped,
and that I got the central fact backwards and had to retract it.

### The claim I got wrong

I recorded on #391, emphatically, that the `useRustEngine === false` branch is "NOT dead
code — it is the daemon-unavailable production fallback", and escalated a product decision
to Ice: when the Rust daemon cannot start, should a workspace show a capture failure or
keep silently recording through the old engine?

**There was no decision to make.** `startRustEngineDaemon` shows "The desktop cannot start
without the Rust engine.", stops the lifecycle, nulls all three engine handles and calls
`app.quit()`. The `app.whenReady` continuation returns early on its false result, so IPC is
never registered and no workspace is opened. And `rustEngineWorkspaceSessions` has exactly
two writes: set on success, nulled on that failure path immediately before the quit. A
running workspace cannot reach the capture gate without a daemon.

Precision matters on one point, because I first wrote this as "no window is created" and
that is FALSE — codex caught it reviewing this entry. The `open-file` and `second-instance`
handlers are registered OUTSIDE `whenReady`, and both call `showOrCreateMainWindow()` when
`app.isReady()`, which can be true while `startRustEngineDaemon` is still awaiting. So a
window CAN appear before the gate resolves. The capture-reachability conclusion survives —
IPC and capture are what the gate protects — but the reasoning I published was wrong in a
way that hid a partially-initialized-window race, filed separately.

Two independent investigations — one via codex, one a separate opus-5 pass — both opened by
correcting the premise rather than answering the question. I then verified it in `main.ts`
myself before accepting it, which is the only reason this reads as a retraction and not a
second wrong turn.

What makes it worse, and worth writing down: `cliServer.ts` had already deleted its own
copy of the same branch, with a comment explaining exactly this reasoning — "main.ts quits
the app if startRustEngineDaemon fails, before the CLI server is even registered — so the
legacy branch here … was unreachable." The answer was in the repo, beside the same shape of
code, and I traced `engineCaptureGate.ts` and a nullable variable and stopped one level
short of the thing that decides it.

**The lesson is not "read more".** I read plenty. It is that a nullable handle plus a
conditional spread *looks* exactly like a supported configuration, and looking like one was
enough for me to build an escalation on top of it. When a type says a degraded mode exists,
check whether anything can reach it before believing the type.

#411 makes the type stop lying: the daemon is required, and the two call sites narrow
through `requireEngineSessions()` in the shape `linkedChatStoreFor` already used.

### The mid-session case, which is the question I should have asked

The narrower version of my question is real: what happens when the daemon dies *mid-session*
and exhausts its restart budget. That is already handled honestly. The five-second capture
health poll reports `ok: false` even on a thrown task, reaching the existing notice —
"History paused … Your files are safe on disk, but recent changes may be missing from
History."

And that claim is TRUE, which is what matters against the durability rule. The daemon's
startup reconcile rehydrates its baseline from **recorded history** rather than a scan
cache, so any gap — app closed, daemon down, capture failing — is backfilled on the next
successful open. What is permanently lost is **granularity, not content**: N saves during a
gap collapse into one "Reconciled offline edits" moment. A file created and deleted entirely
inside the gap leaves no trace.

One qualification I first left out, and codex caught it reviewing this entry: the
deletion half of that depends on the rehydration SUCCEEDING. `capture_manifest_seed`
failures degrade to `None` via `.ok().flatten()`, and the code's own comment says what that
costs — "against an EMPTY baseline a file deleted while the daemon was down could never emit
a Retire and its stale head would stay readable forever." The degradation is deliberate and
biased safely (over-capture, never data loss) rather than blocking start, but "deletions
during the gap emit a Retire" is only true when the seed works, and an unqualified
durability claim is the one kind this log must not carry.

Filed #412 for two real supervision defects found while establishing this: a daemon
crashing every 31 seconds restarts forever without reaching `terminal`, so the "engine
stopped" dialog never appears; and a daemon that is alive but wedged is never restarted at
all, because only process *exit* triggers the restart path.

### Ten review rounds on one guard, and what they were actually finding

#402 is a ratchet pinning the legacy package's production importers at two. It took ten
rounds, and every single one found a real hole — **all of them in the detector, none in the
allowlist**:

1. A lazy regex clause spanning statements: a file opening with `import type { … } from
   "@dohc/workspace-core"` produced a clause starting with `type`, so a 1,134-character run
   containing two real value imports was waved through.
2. Dynamic import and `require` bypassed it entirely.
3. `createRequire` aliases — the worst, because `workspaceDatabase.ts` documents that
   production deliberately avoids the name `require` (a bundler's CommonJS shim injects its
   own `const require`, so a second declaration is a load-time SyntaxError). The guard was
   open along the path the codebase *prefers*.
4. Template-literal specifiers, relative paths into the package's source, `module.require`,
   `.d.mts`/`.d.cts`, and `.tsx` files parsed as `.ts` — where JSX fails to parse and hides
   every import after it. 111 files were in that state.
5. Const-bound and concatenated specifiers; the config exclusion unanchored.
6. Shadowed bindings, where a file-wide map let the last declaration decide — a false
   negative, the one direction a ratchet must not have.
7. Worker bodies passed as source with `eval: true`, which `cliServer.ts` really does use.
8. **My vacuity guard could itself go vacuous.** It checked the raw walk output, so a
   regression making `isProductionSource` reject everything would empty the importer list
   while the sentinels survived — and once the allowlist reaches zero, which is the entire
   goal, both assertions would pass forever.

The last one is the one to remember. I had been arguing for two rounds that the remaining
surface was adversarial-only and it was time to land. It was not: the defect was in the
assertion everything else rests on, and it was reachable by ordinary regression rather than
by an attacker.

**The transferable rule**: for any "nothing may depend on X" guard, use the AST and
enumerate the spellings FIRST — static import, bare side-effect import, value re-export,
`import = require`, dynamic import, `require`, aliased require, `createRequire` stored /
invoked directly / imported under another name, `module.require`, template-literal and
const-bound and concatenated specifiers, erased expression wrappers, relative paths into
the target, per-extension script kind, and eval-worker bodies. I started with a regex and
paid for it ten times.

### The migrations, and two fakes caught being less faithful than the daemon

`sharedView.test.ts` is now completely free of the legacy package. Generated-text (9 sites)
and restore (12 sites) run on the daemon capture path. #413 extracted the `mockLiveSessions`
harness so each migration stops growing its own — a per-suite copy is how fixtures drift
apart and start disagreeing about what the daemon does, which is the failure #398 froze the
capture goldens against.

Two findings worth more than the migrations themselves:

**The loopback silently dropped `metadata.summary` and `metadata.correlationId`**, which the
daemon persists and returns and the desktop sends. So a loopback-backed test could certify
history the real daemon carries and the fake did not. Fixed for MOMENT responses, mirroring
the daemon — including its dedup, which hashes both fields into `payload_hash`, read in the
Rust rather than inferred.

Scoped deliberately, and codex was right to make me say so: the daemon also carries the pair
on file HEADS, so on snapshots, and the loopback still does not. Nothing reads it today, and
the gap is recorded in the loopback beside the fix rather than quietly closed over — a
loopback-backed test that asserted snapshot metadata could still certify something the fake
does not model. Then codex caught **my own report being wrong about the scope**: I wrote that all
six `makeMoment` call sites were covered including binary write; binary write was not, so
the fingerprints counted metadata as part of a binary write's identity while its moment
dropped it. I checked all eight sites rather than the one reported.

**My prescribed mutation for one suite was simply wrong.** I told an agent to starve
`versionedText.list` and expect failures. That suite never calls it — a method probe showed
77 reads, 45 `versions.active`, 18 writes, zero `list` — so the acceptance criterion I set
could not have failed no matter how bad the migration was. Same class of mistake as the
checks this campaign exists to unpick. The standing instruction now is: probe which methods
a suite actually sends, then starve those. Also run an INVERSE mutation, because a test
asserting an ABSENCE cannot be falsified by starvation — only by an over-permissive store.

Mutation testing also exposed **two assertions that had been vacuous all along**, on the
legacy path too: `moments.every(...)` is trivially true on an empty page, and
`expect(fileObjectIdForPath(...)).toBe(objectId)` reduces to `null === null` when reads are
starved. Both are stronger now than before the migration.

### Where the legacy package still lives

Production runtime importers: **two**, both on the `useRustEngine === false` branch — the
store factories in `workspaceEngineCapture.ts`, and the legacy provider session that branch
selects. Eleven further production files name the package but import only types. Both numbers are
still a MANUAL inventory at the time of writing — #402 is the guard that would make them
mechanical and it has not landed, so nothing enforces this boundary yet. codex caught me
writing "#402 now confirms" while it was still open, which would have left a reader believing
a dependency boundary was enforced when it was not.

The branch itself is held up by roughly 100 test call sites across four remaining files that
construct capture with neither sessions nor a store. Three fixture-only tests stay legacy
deliberately, each commented: the on-disk assertion that a mount's pull state lands INSIDE
the mount folder is the only proof of that nesting contract, and two others must refuse
before any store opens.

Also settled, and it was a genuine blocker: deleting the package does NOT delete the
recipient-side secret-path gate. The Rust replay refuses secret-classified paths in
`enforce_share_view_boundary`, tested with a `.env` inside the share — refused on
classification alone — and the classifier itself lives in `@dohc/security-contract`, not in
the package being deleted. Cross-language conformance is proven against a fixture generated
from that contract. #409 records the one real gap: no end-to-end share-view-pull test with a
secret path, which matters most for DELETE ops because the write-sink floor deliberately
admits secret paths for deletes, leaving the boundary check as the only gate.

## 2026-07-31 — checking the preconditions before deleting, and finding two

Six more suites moved onto the daemon path (#414, #415, #417, #423, #424, #426) and the import
ratchet landed (#402). The legacy package is down to two production runtime importers, both on
one branch, with a guard that fails if anything adds a third.

Then the plan was to delete it. The order was: verify the parity baseline first, because that is
the only step that could change the plan. It did — but not where expected.

### The 114 tests that ran nowhere now run, and they pass

`packages/workspace-engine` has 114 tests gated on `process.platform === "linux"`, and the PR
gate is dispatch-only, so on a Windows dev machine they always skipped and a local run reported
`19 passed` with 114 quiet skips. They are the port's parity baseline, so every "the daemon
matches legacy behaviour here" claim rested on tests nobody had executed.

Executed on Linux at `a8be8dd1`: **128 passed, 5 skipped** against Windows' 19 passed, 114
skipped. **All 114 pass.** I first wrote "109 of 114, the other 5 are win32-only" and that
arithmetic is wrong — codex caught it reviewing this entry. The suite is 133 tests; the 5 Linux
skips are win32-only tests drawn from the **19 that pass on Windows**, not from the 114. So
Linux ran 114 Linux-gated plus 14 always-run = 128. Nothing failed. I understated my own
result, which is a more interesting error than overstating it: the check I ran was better than
the number I published. #420 records the recipe.

**The setup was the whole difficulty, and the first attempt produced a spectacular false
negative.** WSL had Node 18 and no version manager and no passwordless sudo; Node 18 cannot run
these tests at all, because the legacy engine reaches `node:sqlite` through `createRequire`. A
no-sudo tarball install of Node **22.14** then produced `25 files failed / 408 failed | 29
passed` — which looks exactly like catastrophic product breakage and is nothing of the kind. The
cause was `no such module: fts5`: that tarball's bundled SQLite lacks FTS5. So the run was a false
negative about the product and, at the same time, a true positive about the repository — 22.14 was
a version the root `package.json` claimed to support, which makes this a compatibility failure the
repo owned, not an error by whoever installed it. That half is fixed below.

**Match the version the repo pins, which is 24.14.0** — `.node-version`, `.nvmrc`,
`docs/development/local-dev.md` and the desktop-release workflow all say so. The evidence above
was produced on 24.16.0, which is what this machine happens to run; an earlier draft of this
entry told the reader to match 24.16.0 "exactly", which would have sent them to a
non-canonical environment. Verified the FTS5 difference directly with a two-line
`CREATE VIRTUAL TABLE ... USING fts5` probe.

**And "use the pin" was not enough, because the repo's own declaration disagreed with it.** The
root `package.json` claimed `"node": "^20.19.0 || ^22.13.0 || >=24.0.0"`, so a developer on a
version it advertises could not run this suite — that is a broken supported-version contract, not
a false negative on their part. It is broken more deeply than FTS5: `node:sqlite` does not exist
at all in Node 20, and it is reached from **production** code, so the Node 20 arm never described a
working install of anything. Narrowed to `">=24.14.0"`, matching every other place the version is
written down. Deleting the legacy package does not make the old range correct again, since the
production `node:sqlite` callers outlive it.

The callers, corrected twice. An earlier draft named `apps/desktop/src/main.ts`, which contains only
a *comment* mentioning `node:sqlite`, not a call. Review caught that; the replacement list was then
still incomplete, and review caught that too. Every production caller reaches it through
`createRequire`, which is why a plain import grep finds nothing at all. The complete set outside the
package being deleted, five of them:

- `apps/desktop/src/workspaces/workspaceDatabase.ts:37`
- `apps/desktop/src/cli/cliServer.ts:232`
- `packages/mcp/src/tools.ts:410`
- `services/sync-relay/src/storage.ts:246`
- `services/sqlite-worker/src/sqliteEngine.ts:68`

(plus `crates/yrs-spike/scripts/harvest.mjs:24`, a dev script, not shipped.) All five outlive the
legacy package, which is the point: the Node floor is not a consequence of the package being
deleted. Two rounds of getting this list wrong is the argument for enumerating it here rather than
naming an example and trusting the reader to re-derive it.

**And the floor is a support policy, not a measured failure boundary — worth stating plainly,
because the two are easy to confuse.** The only versions actually measured are 22.14, which fails
(`no such module: fts5`), and 24.16, which passes. Nothing here shows Node 24.0-24.13 failing. The
floor is set at the pinned 24.14.0 because supporting versions the repo does not pin, does not run
in any workflow, and does not ship is exactly what produced this bug: a declared range nobody had
ever executed. If someone needs a lower 24.x, the honest move is to measure it and lower the floor
to what was measured, not to widen the declaration back to a guess.

**Narrowing one manifest is not the whole change, because the range was copied into five places.**
Review found the self-host Compose stack still on `node:22-bookworm-slim` for all three JavaScript
containers, each running the root `pnpm install` — so the declaration made the repo's own documented
self-host runtime unsupported. And `tools/rust-engine-program/macos-evidence.sh` carried its own
hand-written copy of the old range, which would have kept certifying bankable macOS evidence on a
runtime the repo no longer supports. Two workflow comments and `crates/yrs-spike/scripts/harvest.mjs`
held stale copies too, the last of which asserted the range "allows Node 20", now false. All five
updated; a grep for the old range across `*.sh`, `*.mjs`, `*.json` and `*.yml` now returns nothing.

The lesson is the duplication, not the versions: a declared constraint with five hand-maintained
copies will be wrong in at least one of them, and the copy inside an evidence-certifying script is
the expensive one.

### The blocker that verification found instead

The three secret-capture tests that cannot migrate — they read raw `engine.db` bytes to prove
plaintext never lands on disk — were slated to die with the package. Auditing what would be lost
found that most of it has no Rust equivalent:

- the **merge path** on-disk proof: covered nowhere at all
- **"secrets never create conflict records"**: nowhere in Rust; asserted only in the test being deleted
- the **base64-of-plaintext** form: nowhere, and it is a distinct claim — ciphertext is stored as
  base64 TEXT, so a buggy implementation that base64ed the plaintext would evade the utf8 scan
- the **version switch** proof: only in a Playwright spec that neither `pnpm test` nor CI runs,
  which is a demotion rather than a migration

Only the plain-write case genuinely survives in `cargo test`. Filed as #425.

### And then the crypto audit, which is the serious one

The at-rest cryptography proofs — IV freshness, tamper detection, AAD binding, wrong-key
rejection, key custody — live in `secretFileStore.test.ts`, inside the package being deleted. A
property-by-property audit against the Rust crates: 19 properties, **11 covered at equal-or-
greater strength**, and Rust is stronger on tag tampering, which the TS file never tested despite a
test title implying it.

One overstatement in that audit, caught reviewing this entry: I recorded Rust as also stronger
on IV-verbatim copying "on fork". The direct IV-equality assertions cover cross-version **apply
and restore**; `fork_copies_secret_tips_verbatim` only decrypts the destination to the same
plaintext and checks a fork-base row exists, so **re-encrypting during a fork would satisfy both
assertions**. Fork IV-verbatim is not directly asserted on either side, and retiring the TS proof
would leave it unpinned.

**But nothing in Rust asserts IV/nonce FRESHNESS.** TS asserts it directly by writing the same
plaintext three times and comparing rows. Rust does have IV assertions — a length check,
`assert_eq!(sealed.iv().len(), SECRET_IV_BYTES)`, and equality assertions that prove verbatim
copying on apply and restore — but **none asserts that two seals of the same plaintext produce
different IVs**, which is the property that matters.

Being exact about this took two corrections, both fair for a security audit. An earlier draft
said "the only IV assertion anywhere is a length check", which contradicted the very next
sentence acknowledging the equality assertions. It also cited "43 `assert_ne!` hits, none on an
IV or ciphertext". The real count is **50**, and a naive grep appears to find four IV matches —
all substring artifacts of *derive*, *driver* and *receive*. The accurate claim is the narrow
one: of 50 `assert_ne!` calls, **zero assert IV or ciphertext difference**. A number that is
wrong in an audit cannot support deleting the proof it is auditing.

Nonce reuse under AES-GCM with one key always leaks the XOR of the two plaintexts, so it reveals
their differences outright; where they are identical it reveals that too, which for a secret means
an observer of the database learns the value did not change. Depending on the records it can also
enable GHASH-key recovery or tag forgery, though the reused-nonce-with-identical-plaintext case
this test compares yields identical records and on its own reveals no key. That qualification does
not soften the blocker: it is catastrophic **and silent**, because encryption still succeeds and
every existing test stays green. There is a real structural mitigation — one public sealing entry, always
`getrandom`, the deterministic variant feature-gated — which is why it survived. **A structural
guarantee is not a test.** Treating it as a hard blocker on deletion.

The audit also produced a trap worth recording for whoever writes the replacement: a store-level
AAD splice test must copy `byte_length` along with the sealed fields, or use equal-length
plaintexts. `SealedSecret::from_base64` has a length precheck that returns `InvalidBase64` on a
mismatch, so the test would pass for the wrong reason. Assert the exact code, not `is_err()`.

### Six fakes disagreeing with the engine, and the symmetry I had missed

The migrations found six places where `VersionedLoopbackEngine` and the daemon disagreed about
something a test relied on. **Not one was found by reading the fake** — every one surfaced as a
test failing, a mutation surviving, or a reviewer disagreeing.

Five had the fake modelling **less** than the daemon: dropped moment metadata (text), the same
again for binary writes, the same again for *every secret path*, dropped moment authorship — which
meant the **agent-attribution tests were passing against a fixture that cannot represent an
author** — and no `DaemonRefusalError` shape at all, so error-code assertions were checking the
fake's invention.

One had it modelling **more**: my own fix copied a moment author raw, and `AgentAuthor` permits
extension fields the daemon normalises away, so the fake's own response failed the client's strict
parser. A write that works against the real engine broke against the fixture.

**A fake is wrong in both directions**, and I had only been watching one.

### Three corrections to my own fixes, in a row, on one field

Worth recording as a sequence because each looked right when made:

1. The loopback hardcoded `author: null`. Fixed by carrying it.
2. That fix copied the author **raw** — making the fake stricter than the daemon. Fixed by normalising.
3. That normalisation mirrored `parsed_moment_author` — the **read** path, for malformed historical
   rows. The write path is `validated_author`, which **refuses**. So the fake accepted writes
   production rejects, and the test I had written to lock in `{ corrupt: true }` was wrong with it.

And separately, twice: **parse before you commit, not where the value is used.** Author validation
ran after the mutation on one PR; secret metadata did the same on another, so a malformed
`summary` left the secret changed, recorded no moment, and still returned a refusal. Two
occurrences is a habit, not an accident.

### Measurement lying, three times

- `grep -c` **exits 1 when it finds zero matches**, so a verification chain ending in a
  failure-count grep reported a fully green monorepo as failed.
- `^ *×` **misses pnpm's package-prefixed output**, so a recursive run reported `1 failed` while
  the check said `0`. That hidden failure was real: a stale staged daemon binary predating a Rust
  fix — which is the new e2e guard doing exactly its job, across worktrees.
- The Node/FTS5 false negative above.

Scoped narrowly, because the general version of this lesson is dangerous: for the canonical
JavaScript job, `pnpm run test`'s **nonzero exit IS the verdict**, and setup scripts or
non-Vitest tests can fail without ever emitting a per-package `Tests` line. "Read the Tests
line, not the exit code" would therefore discard real failures. The correct rules are narrower:
**do not put a failure-counting `grep` last in a pipeline** (it inverts the exit status), **use
a pnpm-prefix-aware pattern** when counting failures, and **for the Rust gate specifically**,
read the `== summary ==` block, because that gate can exit 0 while its own summary says FAIL.

### The import ratchet, and why it stops where it does

#402 took **thirteen review rounds**, every finding in the detector and none in the allowlist: a
regex clause spanning statements, dynamic `import()`, `createRequire` aliases (the worst, because
the repo *documents* that production deliberately avoids the name `require`), template literals,
relative paths into the package, `module.require`, `.d.mts`, `.tsx` parsed as `.ts` (111 files),
shadowed bindings, eval-worker bodies, and — after I had twice argued the surface was
adversarial-only — **a vacuity guard that could itself go vacuous** once the allowlist reached
zero.

The finding count per round went 2, 4, 5, 6, 7, 9, 10, 15. That is divergence, not diminishing
returns, and it is inherent: every spelling of "load a module" is a new finding. Landed at
thirteen with seven deferred and reasoned, and filed #421 proposing a module-graph check instead.

**#421 must NOT be closed as superseded, and that is my third position on it.** I first said
the graph check matters most once the allowlist reaches zero; then that deletion supersedes it,
because importing a deleted package fails at build time. **Both were wrong, and codex caught the
second one reviewing this entry.**

The compiler only resolves STATIC imports. The guard exists because thirteen rounds established
that the interesting forms are not static — `createRequire(...)`, const-bound and computed dynamic
imports, and specifiers embedded in evaluated worker source. TypeScript does not resolve those
module strings at typecheck, so they compile cleanly and fail only when a user executes the path.
Deleting the package AND the guard would let the dependency return as a runtime-only regression —
exactly the class the guard was built for, and exactly the class the compiler cannot see.

So the guard should survive the deletion, re-pointed at "nothing may load this name" rather than
"this package has two importers". Twice I reasoned from "the compiler will catch it" without
asking which forms the compiler actually resolves.
