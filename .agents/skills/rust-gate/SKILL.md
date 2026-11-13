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

Run the gate for a verdict. The verifier
(`tools/rust-engine-program/require-ci-pass-verdict.mjs`) accepts only the
gate's evidence line.

The test steps run through cargo-nextest. If the `test --workspace` step
fails with "no such command: nextest", install the version CI pins
(`.github/workflows/pr-checks.yml`, `CARGO_NEXTEST_VERSION`):

```
cargo install cargo-nextest --locked --version 0.9.143
```

The separate `doctests` row is required: nextest runs no doctests by
design, and that row is what proves the workspace's doctests still ran.

The `reader tests` row is required too. The workspace run skips the ignored
Markdown reader regressions. This row builds a reader and runs exactly those
regressions with it.

## What the gate does for you

On a host with a build-slot root, the gate keeps to a shared build budget, so
several worktrees can build at once without exhausting the machine. It checks
free disk, takes a build slot before any cargo runs, caps cargo's parallelism,
and records the caps in the evidence line. You set none of this up.
[`build-slot.mjs`](../../../tools/rust-engine-program/build-slot.mjs) holds the
slot count, the caps, and each host's default slot root, which
`DOHC_BUILD_SLOT_ROOT` overrides. A host with no slot root, such as a CI runner,
runs uncapped.

## Read the verdict correctly

Read the `== summary ==` block. Do not trust the exit code alone: the gate
can exit 0 while its own summary says FAIL. The evidence line under
`EVIDENCE` is what you paste into the PR body.

Each summary row carries its wall-clock seconds. If you change the gate
or the build configuration, compare the step times before and after, and put
the numbers in the PR.

## When the gate waits or refuses

- `waiting for a build slot` means other worktrees are building. Let it queue.
  It prints who holds the slots. Do not delete another worktree's slot
  directory while its owner is alive.
- The gate refuses to start below 40 GB free disk, and the refusal names the
  free space it saw. Prune stale out-of-repo cargo target directories and stale
  worktree `target/` directories, then rerun. `DOHC_GATE_DISK_FLOOR_GB`
  overrides the floor.
- If the gate's output goes quiet for more than 30 minutes inside one step,
  the step may be deadlocked. Investigate the step; do not kill unrelated
  processes.

## Cargo outside the gate

A long cargo build outside the gate must respect the same budget. Cap it
with `CARGO_BUILD_JOBS` (the gate's share is `cores / 4`), or run the gate
instead of ad-hoc steps. Parallel uncapped cargo builds across worktrees can
exhaust memory on a shared host.
