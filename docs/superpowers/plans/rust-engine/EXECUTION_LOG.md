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
