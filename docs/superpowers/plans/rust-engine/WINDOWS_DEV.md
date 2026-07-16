# Windows development rules for the Rust rewrite

The dev machine is Windows 11 (the founder's daily driver). Every agent
running cargo locally follows these rules.

## Worktrees and paths

- Worktrees live under a short root: `C:\w\<shard-id>` (long-path limits bite
  with deep `target/` trees; do not nest worktrees under the repo).
- One writer per worktree. Never run two agents in one worktree.
- Each worktree sets its own `CARGO_TARGET_DIR` (default
  `C:\w\_targets\<shard-id>`) so `cargo` and rust-analyzer never contend on
  file locks across lanes.

## Build economics

- **Local concurrency budget: max 4 lanes running cargo at once**, enforced
  mechanically, not by convention: a lane acquires a slot by creating one of
  `C:\w\_locks\build-slot-{1..4}` (directory-create is atomic) before any
  cargo invocation and removes it after. Each slot dir contains an
  `owner.json` (lane/shard id, pid, start time) whose mtime the owner
  touches as a heartbeat at least every 5 minutes while building.
  Reclamation is owner-safe, not age-guessed: a slot is reclaimable only
  when its heartbeat is >30 minutes stale AND the owner pid (and its child
  process tree — cargo spawns rustc children) is dead; reclamation renames
  the slot dir to a tombstone (atomic — a racing owner's next heartbeat
  fails loudly instead of silently sharing a slot) before deleting it.
  Denied acquisitions and reclaims are appended to `EXECUTION_LOG.md`.
- Free-space preflight with hysteresis: before acquiring a slot, check free
  space on the worktree volume — **pause new builds below 40 GB, resume at
  60 GB**; while paused, the orchestrator prunes the oldest stale target
  dirs and logs each deletion. (Bun hit disk exhaustion even with cgroup
  isolation; target dirs run 5–10 GB each.)
- sccache is shared across worktrees (`RUSTC_WRAPPER=sccache`).
- Windows Defender exclusions cover **build/cache directories only**:
  `C:\w\_targets\` and the sccache cache dir (real-time scanning there
  multiplies build time and takes transient handles that break renames).
  Source worktrees stay scanned; any source-tree exclusion requires explicit
  Ice approval recorded in `DECISIONS.md`.

## Windows semantics that will bite

- Rename over an open file fails (sharing violation). Materialization uses
  `ReplaceFile`/`MoveFileEx` semantics with bounded retry/backoff, then fails
  closed. AV/indexers take transient handles on fresh `.db`/`.wal`/`.shm`
  files — retry, never one-shot.
- Prove-zero-handles before moving `engine.db` triplets (exclusive-open
  probe with bounded retries).
- Junctions, case-insensitivity, drive/UNC forms, trailing dot/space: see
  `LANGUAGE_SEMANTICS_MATRIX.md`; every difference has a conformance fixture.

## Safety fences (mandatory, all shard work)

- Shadow-only builds refuse workspace roots without a harness-written
  `.dohc/engine/SHADOW_CLONE` marker and refuse v1-fingerprint databases for
  writing.
- The test harness denylists the founder's real workspace roots; every
  fixture path is asserted outside them. Reading a real `engine.db` for
  fixture harvesting is done on a **copy**, never the live file.
