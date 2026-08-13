---
name: rust-gate
description: >-
  Run the canonical Rust engine gate with the machine's build budget: disk
  preflight, build-slot queueing, capped cargo parallelism, and a verdict read
  from the summary block. Use before merging any change that matches the rust
  path filter, whenever a task says to run the Rust gate or cargo checks for
  the workspace, and before starting any long cargo build outside the gate.
---

# Run the Rust gate

The gate is one command. Run it from the root of the worktree you want
judged:

```
node tools/rust-engine-program/run-rust-checks.mjs
```

Do not run the cargo steps by hand and call the result a gate verdict. The
gate's evidence line is the only artifact the verifier
(`tools/rust-engine-program/require-ci-pass-verdict.mjs`) accepts.

## What the gate does for you

The gate enforces the machine's build budget itself (WINDOWS_DEV.md, "Build
economics"). You do not set these up:

- It refuses to start below 40 GB free disk. The error names the floor.
- It takes one of 4 build slots before any cargo runs. If all slots are
  held, it waits and prints who holds them.
- It caps `CARGO_BUILD_JOBS` and `RUST_TEST_THREADS` to its share of the
  cores, and turns incremental compilation off for the run.
- It records the caps it ran under in the evidence line.

## Read the verdict correctly

Read the `== summary ==` block. Do not trust the exit code alone: the gate
can exit 0 while its own summary says FAIL. The evidence line under
`EVIDENCE` is what you paste into
`docs/superpowers/plans/rust-engine/EXECUTION_LOG.md` when the program asks
for evidence.

Each summary row now carries its wall-clock seconds. If you change the gate
or the build configuration, compare the step times before and after, and put
the numbers in the PR.

## When the gate waits or refuses

- `waiting for a build slot` means other lanes are building. Let it queue.
  Do not delete another lane's slot directory while its owner is alive.
- A disk-floor refusal names the free space it saw. Prune stale target dirs
  under `C:\w\_targets` and stale worktree `target/` dirs, then rerun.
- If the gate's output goes quiet for more than 30 minutes inside one step,
  the step may be deadlocked. Investigate the step; do not kill unrelated
  processes.

## Cargo outside the gate

A long cargo build outside the gate must respect the same budget. Cap it
with `CARGO_BUILD_JOBS` (the gate's share is `cores / 4`), or run the gate
instead of ad-hoc steps. Never start parallel uncapped cargo builds across
lanes: that configuration has OOM-crashed this machine.
