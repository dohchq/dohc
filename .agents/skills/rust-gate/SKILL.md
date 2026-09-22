---
name: rust-gate
description: >-
  Run the canonical Rust engine gate within the host's build budget: disk
  preflight, build-slot queueing, capped cargo parallelism, and a verdict read
  from the summary block. Use for local Rust PR verification,
  whenever a task says to run the Rust gate or cargo checks for
  the workspace, and before starting any long cargo build outside the gate.
---

# Run the Rust gate

One verification owner runs the full engine gate for matching changes. Other agents reuse its evidence.
For PR verification, use `pnpm verify:pr --base <target-ref> --job rust` to include tool checks and evidence.

The gate is one command. Run it from the root of the worktree you want
judged:

```
node tools/rust-engine-program/run-rust-checks.mjs
```

Do not run the cargo steps by hand and call the result a gate verdict. The
gate's evidence line is the only artifact the verifier
(`tools/rust-engine-program/require-ci-pass-verdict.mjs`) accepts.

The test steps run through cargo-nextest. If the `test --workspace` step
fails with "no such command: nextest", install the version CI pins
(`.github/workflows/pr-checks.yml`, `CARGO_NEXTEST_VERSION`):

```
cargo install cargo-nextest --locked --version 0.9.143
```

The separate `doctests` row is required: nextest runs no doctests by
design, and that row is what proves the workspace's doctests still ran.

## What the gate does for you

On a host with a build-slot root, the gate enforces a shared build budget so
several worktrees can build at once without exhausting the machine. The root
comes from `DOHC_BUILD_SLOT_ROOT`; on Windows outside CI it defaults to
`C:\w\_locks`. A host with no slot root, such as a CI runner, runs uncapped.
You do not set these up:

- It refuses to start below 40 GB free disk. The error names the floor;
  `DOHC_GATE_DISK_FLOOR_GB` overrides it.
- It takes one of 4 build slots before any cargo runs. If all slots are
  held, it waits and prints who holds them.
- It caps cargo's build and test parallelism to its share of the cores,
  and turns incremental compilation off for the run.
- It records the caps it ran under in the evidence line.

## Read the verdict correctly

Read the `== summary ==` block. Do not trust the exit code alone: the gate
can exit 0 while its own summary says FAIL. The evidence line under
`EVIDENCE` is what you paste into the PR body.

Each summary row carries its wall-clock seconds. If you change the gate
or the build configuration, compare the step times before and after, and put
the numbers in the PR.

## When the gate waits or refuses

- `waiting for a build slot` means other worktrees are building. Let it queue.
  Do not delete another worktree's slot directory while its owner is alive.
- A disk-floor refusal names the free space it saw. Prune stale out-of-repo
  cargo target directories and stale worktree `target/` directories, then rerun.
- If the gate's output goes quiet for more than 30 minutes inside one step,
  the step may be deadlocked. Investigate the step; do not kill unrelated
  processes.

## Cargo outside the gate

A long cargo build outside the gate must respect the same budget. Cap it
with `CARGO_BUILD_JOBS` (the gate's share is `cores / 4`), or run the gate
instead of ad-hoc steps. Parallel uncapped cargo builds across worktrees can
exhaust memory on a shared host.
