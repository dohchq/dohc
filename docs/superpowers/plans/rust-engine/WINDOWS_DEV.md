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

- **Local concurrency budget: max 3–4 lanes running cargo at once.** Other
  lanes sit in implement/review states. The orchestrator enforces this.
- sccache is shared across worktrees (`RUSTC_WRAPPER=sccache`).
- Windows Defender exclusions must cover `C:\w\_targets\` and each worktree
  (real-time scanning of target dirs multiplies build time and takes
  transient handles that break renames).
- Disk watermark: if free space on the worktree volume drops below 40 GB, no
  new builds start and the orchestrator prunes stale target dirs. (Bun hit
  disk exhaustion even with cgroup isolation; target dirs run 5–10 GB each.)

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
