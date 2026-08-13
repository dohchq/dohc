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
  mechanically by `tools/rust-engine-program/build-slot.mjs`: a lane acquires
  a slot by creating one of `C:\w\_locks\build-slot-{1..4}` (directory-create
  is atomic) before any cargo invocation and removes it after. The gate
  (`run-rust-checks.mjs`) acquires and releases its slot itself; concurrent
  gate runs queue on the slots. Each slot dir contains an `owner.json` (pid,
  start time) whose mtime the owner touches as a heartbeat every minute while
  building. Reclamation is owner-safe, not age-guessed: a slot is reclaimable
  only when its heartbeat (the owner file's mtime) is >30 minutes stale and
  any readable owner pid is dead; a slot whose owner file is missing or
  unreadable that long has no working heartbeat and is reclaimed too.
  Reclamation renames the slot dir to a tombstone (atomic — the slot name is
  freed in one step and can never be shared) before deleting it, and sweeps
  are serialized through `reclaim.lock` so two waiters cannot judge one slot
  together. Denied acquisitions and reclaims are appended to
  `C:\w\_locks\events.log`, not to a tracked file — a mid-run write to the
  repo would fail the gate's own tree-provenance row.
- **A slot is a share of the cores, not just admission.** A slot holder caps
  its compiler and test parallelism to `cores / 4` (`CARGO_BUILD_JOBS` and
  `RUST_TEST_THREADS`; the gate sets both). The OOM crash that created this
  budget came from lanes at default jobs — each cargo asking for every
  logical core — not from the lane count.
- Free-space preflight: before acquiring a slot, check free space on the
  worktree volume — **refuse new builds below 40 GB** (a cold workspace
  build runs ~20 GB). The gate enforces this floor itself
  (`DOHC_GATE_DISK_FLOOR_GB` overrides it); when a build is refused, prune
  the oldest stale target dirs under `C:\w\_targets` and stale worktree
  `target/` dirs, and log each deletion. (Bun hit disk exhaustion even with
  cgroup isolation; target dirs run 5–20 GB each.)
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
