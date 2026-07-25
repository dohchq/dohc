# Rust engine rewrite — handoff to finish (100%)

You are a Claude Fable-5 session taking over an in-progress, multi-week program
that rewrites dohc's TypeScript workspace engine in Rust, built **dormant /
shadow-only**, merged to `main` incrementally, with an atomic authority cutover
at the very end (R15). Your job is to **drive the remaining work to 100%
autonomously**, through the established review→merge workflow, **stopping only at
R15 (the cutover), which is Ice's checkpoint and resets real user data.**
Everything before R15 is yours to drive without stopping.

Repo: `C:/Users/ice/dev/dohc` (Windows, PowerShell primary + Git-Bash tool).
Ice = Iestyn de Vera, the founder. "Ice-decision" items must be surfaced, never
decided by you.

---

## 0. READ THESE FIRST (canonical, in-repo)

Read in this order before doing anything:

1. `docs/superpowers/plans/rust-engine/SHARDS.tsv` — the machine-readable program
   state (one row per shard: status, deps, owned paths, PR). Load first, every
   session. `gate passed` = done.
2. `docs/superpowers/plans/rust-engine/EXECUTION_LOG.md` — append-only narrative.
   Read the **2026-07-19 entries** in full: they cover the obligation sweep, the
   R15-checkpoint decisions, and the files-composition program you are continuing.
3. `docs/superpowers/plans/rust-engine/DECISIONS.md` — Ice-ratified decisions
   (protocol, CI matrix, cutover scope, dogfood duration, etc.).
4. `docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md` — the master plan.
5. `docs/superpowers/plans/rust-engine/TEST_ORACLE.md`,
   `LANGUAGE_SEMANTICS_MATRIX.md`, `PORTING.md`, `STATE_OWNERSHIP.tsv` — the
   behavioral oracle + approved deltas the Rust port must honor.
6. `AGENTS.md` + `CLAUDE.md` (repo root) — product invariants, brand rules,
   model-selection table, PR/merge conventions.
7. Your auto-memory index: `C:/Users/ice/.claude/projects/C--Users-ice-dev-dohc/memory/MEMORY.md`
   and the files it points to — especially `rust-engine-orchestration-gotchas.md`.

---

## 1. STATE — what is done, in flight, and remaining

### Done and merged (this program run)
All correctness-critical pre-cutover work is landed:
- BINHEAD (#194/#195) — binary content as a first-class in-DB head (migration
  ordinal 10). Discharged the last R15-blocking correctness obligation.
- BlobChunk (#196) — dormant wire codec, hardened over 8 review rounds.
- A2 (#197) — content-aware snapshot views on display/diff surfaces.
- shadow_fence gating (#198), fuzz surfaces (#199 — policy + migration proptest).
- open-after-close race (#201) — supervisor-level `begin_close`/`WorkspaceClose`
  fix; cancellation- and multi-service-safe.
- flaky-Windows-materializer — VERIFIED-RESOLVED (no such test exists;
  `FlakyReplacer` is an intentional fault-injection double). No action.
- Integrator sweeps (#200, #203) recorded the above + the R15-checkpoint status.
- **Files-composition sub-shard A (#204) — MERGED.** The domain capture-write
  primitive (`capture_ingest`/`capture_retire`) + actor commands + blocking
  variants. Its id scheme took 3 review rounds to harden — see §3.

### In flight
- **Files-composition sub-shard B — PR #205 OPEN, CHANGES_REQUESTED.** The
  `StoreCaptureSink` (text path). Branch `codex/rust-engine-files-composition-b`,
  worktree `C:/w/fcompB`. It has ~11 open review findings you must address before
  merge (see §5). Gate was green before the review round.

### Remaining (the ordered path to R15)
Ice approved this sequence on 2026-07-19 ("continue with the order you'd go"):
1. **Finish the files-into-daemon composition** (the big piece — §3). Sub-shards
   remaining after B: **B-binary** (binary capture primitive), **B-secret**
   (secret capture primitive), **C** (watcher+reconcile driver + open/close
   lifecycle), **D** (WatcherUnavailable/degraded supervision — discharges an
   R14-deferred obligation), **E** (status/flush RPCs + capture differential vs
   the TS oracle + shadow-scope acceptance test).
2. **Full soak runner** — the `cutoverBlocking` tier in
   `tools/rust-engine-program/soak-config.json` has no runner yet; the
   watcher-storm scenarios need C+D composed. Build the runner (test harness in
   `tools/rust-engine-program/`, OS-specific metric sampling).
3. **Grow daemon RPCs for the cutover-needed desktop surfaces** (chats, shares,
   capture) → unblocks R13b-rest's remaining surfaces (cli/mcp/shares). The R13
   daemon exposes only 8 wire methods today; grow by what the app actually calls.
4. **GATE6** — release-candidate evidence packet. Its formal deps (R14, R10b,
   R15-REHEARSE) are all gate-passed. Convene it once watcher + full-soak land.
5. **macOS build + smoke evidence** — you cannot run macOS from the Windows host;
   this needs a macOS CI/build run. Flag it; produce everything else.
6. **R15 (STOP — Ice checkpoint).** See §7.

---

## 2. Ice decisions already made (2026-07-19) — do NOT relitigate

- **gate-perf: DEFERRED.** PR #202 was CLOSED. The cached-replay-base
  optimization is correct but doesn't meet its O(N) goal (`advance()` re-encodes
  the whole doc per append → still O(N²); a constant-factor win only). Revisit
  ONLY post-cutover if dogfood profiling shows the replay-parity gate is hot.
  Branch `codex/rust-engine-oblig-gateperf` retained on origin for reference.
- **Files-into-daemon composition: IN SCOPE, pre-cutover.** The watcher/reconcile
  layer is core local-first behavior; a cutover without it is incomplete. Build
  it as the composition program (§3). This also discharges the R14-deferred
  WatcherUnavailable-wiring obligation (as sub-shard D).
- **R13b-rest remaining surfaces: defer scaffold; grow RPCs by cutover need**
  (item 3 above). BlobChunk (the one dormant-actionable piece) is done.
- **Cutover scope: full composed engine including files/watcher** — not a hybrid.
- **Dogfood duration: ≥ 2 weeks** (DECISIONS #8).

---

## 3. THE FILES-INTO-DAEMON COMPOSITION (your current main task)

Goal: compose the filesystem watcher + reconcile + capture layer into the
shadow-only Rust daemon so the engine notices external file changes on disk and
records them — matching what `apps/desktop/src/workspaces/workspaceEngineCapture.ts`
(the read-only TS oracle) does. The watcher/reconcile/materialize **primitives**
already exist and are gate-passed (`crates/dohc-engine-files/**`, R07+R14); the
gap is composition. A full implementation-ready plan is in the 2026-07-19
EXECUTION_LOG; the key facts:

- **The capture loop is INTERNAL** — once composed, the watcher drives
  reconcile→apply autonomously; no RPC is needed for it to function. RPCs (§E)
  only surface status/flush to the desktop adapter.
- **Single-writer coordination:** the store actor's command queue IS the
  serialization point. Capture writes funnel through the same `ActorHandle` as
  ydoc/versionedText writes — **no new lock**. The content-equality no-op
  (`deduped`) is the interleave-safety guarantee.
- **Sync/async bridge:** `apply_reconcile_plan`/`CaptureSink` are sync;
  `ActorHandle::capture_ingest` has a `_blocking` variant (added in A). The
  driver runs the apply phase under `spawn_blocking`.
- **Shadow-scope (the #1 dormancy invariant):** spawn the files layer against
  `validated.root` **after** `bind_shadow_clone` succeeds in `workspace_open`
  (`crates/dohc-workspace-engine/src/lib.rs`). A regression test must assert an
  unmarked root spawns NO watcher/files-actor. The capture writes go only through
  the shadow-bound store actor.

### The LOCKED, HARDENED id scheme (from sub-shard A — reuse it verbatim)
Autonomous capture must derive `object_id`/`moment_id` itself (no caller supplies
them). After 3 review rounds this is the correct scheme — **use it for
B-binary/B-secret too**:
- `object_id` = `object-` + hex(sha256(**length-framed** workspace_id, version_id,
  path)). Length-framed = each field written as `u64-LE len || bytes` (bare NUL
  separators are ambiguous). On a capture with no alias: **reuse an existing
  `file_objects` row ONLY if it has no live `path_aliases` row anywhere**
  (`object_has_live_alias`); if the derived object is still live elsewhere (a
  rename collision), mint a fresh **order-disambiguated** id (append
  `next_moment_order` to the framed inputs).
- `moment_id` = `moment-` + hex(sha256(length-framed workspace_id, object_id,
  `next_moment_order`)). `next_moment_order` is the **global** `MAX(moment_order)+1`
  — monotonic, never reused, so it is unique across the entire create→delete→
  recreate→rename lifecycle and deterministic under shadow-replay. A **real**
  (release-safe, not `debug_assert`) `StateCorrupt` check pins the reserved order
  equal to the order `write_text_in_tx`/`delete_text_in_tx` actually persists.
- Ids need NOT match the TS oracle's random UUIDs — the acceptance differential
  (§E) compares content/structure per path, not id strings, and the domain only
  `non_empty`-checks ids. A migration (ordinal 11) added
  `idx_path_aliases_workspace_object` for the reverse-alias lookup.

### Sub-shards remaining
- **B (in review, #205):** `StoreCaptureSink` text path. Finish per §5.
- **B-binary:** a `capture_ingest_binary` domain primitive (mirror `capture_ingest`
  but write via BINHEAD's `write_binary_file_in_tx`, same framed id scheme) +
  actor command + blocking variant; route `CurrentContent::Binary` in the sink to
  it (replaces the `DEFERRED_CAPTURE_BINARY` marker). Also: **when a path flips
  text→binary, retire the stale text head** (a #205 finding).
- **B-secret:** a `capture_secret` domain primitive (derive `moment_id` via the
  framed scheme, call `SecretFileStore::write_secret_file`) + actor command +
  blocking variant; route `PathFloor::Secret` in the sink to it (replaces
  `DEFERRED_CAPTURE_SECRET`).
- **C (driver + lifecycle):** extend `OpenWorkspace` to own the `FilesActor`,
  `NativeWatcher`, and a driver task (loop: `reconcile_if_dirty` →
  `apply_reconcile_plan(&mut StoreCaptureSink)` → `acknowledge_capture`). Spawn in
  `workspace_open` after `bind_shadow_clone` (use `FilesActor::spawn_async`, you're
  in the tokio runtime). Teardown order in `workspace_close`/`close_all`/`Drop`:
  **watcher.stop() → driver cancel+join → files.close() → supervisor.close()** —
  respect the open-after-close serialization already in `lib.rs`. Lifecycle tests:
  no thread leak, drain-before-close, unmarked-root spawns nothing.
- **D (supervision, R14-deferred obligation):** a health task reading
  `watcher.is_unavailable()`/`is_degraded()`; on unavailable → bounded watcher
  restart (`NativeWatcher::start` re-seeds via its initial reconcile), escalate to
  `WorkspaceSupervisor::restart` on repeated failure; surface `degraded`. The
  TODO at `crates/dohc-engine-files/src/watch.rs:249-257` documents this exact
  obligation.
- **E (RPCs + acceptance):** add thin `watcher.status` + `capture.flush`
  (+ binary-ingest) RPCs to `EngineService::dispatch`. Build the **capture
  differential**: same fixture mutations through the TS oracle
  (`workspaceEngineCapture`, via the native-suite/reviewer-packet harness in
  `tools/rust-engine-program/`) and the composed Rust `EngineService`, asserting
  equal moment/snapshot state per path (add/update/delete, rapid-write coalesce,
  untracked/policy retire, secret routing, binary, symlink refusal, false-delete
  gate). Plus the shadow-only + clean-lifecycle tests. E hands the soak shard its
  observable seams.

Recommended order: **B → B-binary → B-secret → C → D → E**, each a clean PR
against `main` (they're sequential — later shards call earlier APIs, so merge
each before starting the next; do NOT stack a 5-deep PR chain).

---

## 4. WORKFLOW CONVENTIONS (follow exactly — they are load-bearing)

**Per shard:** implement → adversarial review + bots → gate green → merge --squash
→ delete remote branch → integrator note.

- **Implement with codex (gpt-5.6-sol)** for spec-clear porting; use a Claude
  agent (opus/fable) for design-heavy pieces. Codex is reached via
  `codex exec --full-auto --cd <worktree> "<prompt>" < /dev/null` — the
  **`< /dev/null` is REQUIRED** (without it codex hangs forever "Reading
  additional input from stdin" on Windows; a prior run hung 35 min). Run codex in
  the background; it can exceed 10 min. Codex's sandbox cannot write to
  `C:/w/_targets/**`, so **it self-checks in its own temp target but YOU run the
  authoritative gate.**
- **The authoritative gate is `node tools/rust-engine-program/run-rust-checks.mjs`**
  (fmt/clippy -D warnings/build --workspace/test --workspace/cargo-deny). ALWAYS
  run the FULL-workspace gate yourself — codex's scoped `-p <crate>` checks miss
  cross-crate breakage (e.g. a sibling migration-ledger-length assertion in
  another crate; happened on sub-shard A). Set
  `CARGO_TARGET_DIR=C:/w/_targets/<shard>` and `CARGO_BUILD_JOBS=4` in the env.
- **BUILD CONCURRENCY CAP — HARD RULE: at most 2 agents/gates building Rust at
  once.** A prior session crashed the machine at 64 GB RAM from concurrent
  full-workspace builds. Keep `CARGO_TARGET_DIR` OUT of the repo tree
  (`C:/w/_targets/<shard>`). Delete target dirs + remove worktrees after each
  merge. Use `git worktree add C:/w/<name> -b <branch> origin/main` per shard.
- **Review:** the bots (CodeRabbit + Codex) auto-review every PR; re-trigger with
  a PR comment containing `@coderabbitai review` and `@codex review`. For
  correctness-critical or hostile-input code, ALSO dispatch an independent
  adversarial Claude reviewer (opus) before merge. Treat every finding as real
  until disproven; fix or refute with a documented reason. Bots can be
  rate-limited ("Review rate limit exceeded" is transient, not a real finding);
  for a trivial/docs PR where one bot is rate-limited and the other is clean, you
  may merge with a documented rationale. Do NOT merge substantive PRs on a stale
  approval — verify the current HEAD was reviewed.
- **Merge:** `gh pr merge <n> --squash --delete-branch`. On Windows the local
  branch delete often fails ("checked out at C:/w/..."); then run
  `git push origin --delete <branch>` and clean the worktree manually. Verify the
  remote ref is gone. After merge, flip the shard to `gate passed` in SHARDS.tsv
  and append EXECUTION_LOG (integrator PR — docs-only, mergeable past the
  CodeRabbit rate-limit status).
- **The dormant / shadow-only rule remains the default, with two explicit,
  reviewed exceptions.** R13b-rest is the cutover adapter shard and MAY change
  live TypeScript behavior, but only in its owned live surfaces:
  `apps/desktop/src/main.ts`, `apps/desktop/src/cli/**`, `packages/mcp/**`,
  `apps/desktop/src/workspaces/{sharedView,sharedChannels,shareMounts,workspaceFiles,workspaceSearch,workspaceGraph}*`,
  and
  `apps/desktop/src/workspaces/{workspaceEngineCapture,workspaceActivity,relaySyncEngine}*`.
  PR #240 (`YDOC-SERIALIZER-DELIMITERS`) is the other deliberate exception and
  MAY edit only `packages/ydoc-projection/src/import-export.ts` plus its
  `import-export.test.ts` regression coverage. The read-only-oracle rule still
  binds every other shard: `workspaceEngineCapture.ts` and all other live
  TypeScript files outside those exact allocations must not be edited; flag any
  such PR.
- End every commit with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (adjust to your
  model), and the Claude-Session line if present. End PR bodies with the
  "Generated with Claude Code" footer.

**Model selection (from CLAUDE.md):** bulk/spec-clear implementation → gpt-5.6-sol
(codex); reviews/design → fable-5 or opus-4.8; never Haiku. codex is only
reachable via the Codex CLI. Claude agents run via the Agent/Workflow model param.

---

## 5. Sub-shard B (#205) — the open findings to address before merge

Worktree `C:/w/fcompB`, branch `codex/rust-engine-files-composition-b`. Read the
live PR comments (`gh api repos/dohc-ai/dohc/pulls/205/comments`) — the key ones:
- **P1 symlink reopen (capture_sink.rs:65):** the sink re-reads the file with
  plain `fs::read`; it must refuse symlinks on the reopen (lstat/`symlink_metadata`
  BEFORE read), mirroring the TS lstat refusal. (There is a symlink guard but the
  reviewers found a gap / no symlink test — add both.)
- **P1 path namespace (capture_sink.rs:85):** ensure the disk path and the durable
  path use the SAME namespace/normalization (a scanned path must map to the same
  path the domain stores/aliases — no separator/normalization drift).
- **P2 honor files.toml tracked=false (capture_sink.rs:114):** `classify_engine_file_path`
  is only the HARD floor; the sink must ALSO apply `.dohc/files.toml`
  narrowing (parse via the policy module) before ingesting a Tracked path.
- **P2 use media_type (capture_sink.rs:109):** don't blindly UTF-8-sniff; consult
  the plan's `media_type` for the text/binary decision.
- **P2 retire stale text on binary defer (capture_sink.rs:132):** if a path that
  was text becomes binary (deferred), retire the stale text head so the engine
  doesn't keep stale-but-authoritative content.
- **P2 don't acknowledge deferred/retired ops (capture_sink.rs:120,127):**
  returning `Ok(())` for a deferred secret/binary or a retired-then-ingested path
  makes `apply_reconcile_plan` ACK it (clears dirty) even though nothing durable
  happened — so it never retries when the follow-up shard lands. Return a
  contained `CaptureError` (or otherwise leave it dirty) for deferrals instead of
  a clean ack.
- Trivial: replace `eprintln!` deferred markers with the crate's logging;
  add a symlink test; note (don't fix) the no-timeout-on-blocking-actor-call
  (revisit when C wires it in).

Fix these, re-gate (full workspace), push, re-trigger bots, merge.

---

## 6. Gotchas (from prior sessions / auto-memory)

- codex classifier sometimes REFUSES CRDT/byte/panic-adjacent work ("security");
  when it does, implement directly with a Claude agent.
- codex-wrapper agents idle-return (launch codex in background then return); poll
  the codex log / process yourself, or run `codex exec` directly via Bash
  (preferred — with `< /dev/null`).
- Migration ordinals: append-only, checksum-gated; ordinal 14 is consumed by
  R15-1a / #233 (merged), and ordinal 15 is consumed by R15-1b / #236 (in
  review). The NEXT free ordinal is **16**. Schema-touching shards serialize
  through the migration append one at a time — do not develop or merge two
  ordinal appends concurrently. Every new migration must also update the
  ledger-length assertions in BOTH `crates/dohc-engine-storage/src/migration.rs`
  AND `crates/dohc-engine-testkit/tests/durability.rs`.
- "Green ×2" can still miss rustfmt nondeterminism + seed-dependent fuzz OOM;
  a hostile-input parser deserves an extra adversarial pass.
- Full `test --workspace` is the real gate — scoped `-p` runs miss cross-crate
  assertions.

---

## 7. R15 — STOP HERE. Hand these decisions to Ice.

R15 is the atomic cutover that resets real dogfood data. **Do NOT execute it.**
When you reach it (after GATE6 + macOS evidence), present to Ice:
- Cutover scope (recommended: full composed engine incl files/watcher).
- Dogfood-data reset confirmation — recommend confirming only AFTER one more
  R15-REHEARSE run on a fresh clone of current dogfood data.
- Min dogfood duration (≥ 2 weeks, DECISIONS #8).
- member-share-log-across-epoch-reset semantics (Ice-decision; the lean is
  "preserve the share log" but lay out the options).
- macOS build + smoke evidence (needs a macOS host you don't have).

R15's formal deps in SHARDS.tsv: GATE6, R15-REHEARSE, GATE-COMPLETE,
YRS-ABORT-SAFETY — the last three are gate-passed; GATE6 is what remains.

---

## 8. First moves for you

1. Read §0 docs + the 2026-07-19 EXECUTION_LOG.
2. Pick up sub-shard B (#205): address the §5 findings in `C:/w/fcompB`, re-gate,
   push, merge.
3. Then B-binary → B-secret → C → D → E, then full-soak → RPC-growth → GATE6 →
   macOS, stopping at R15.
4. Keep SHARDS.tsv + EXECUTION_LOG current; use the review→gate→merge workflow and
   the ≤2-Rust-build cap on every shard.

You have full autonomy to the R15 checkpoint. Drive it to done.
