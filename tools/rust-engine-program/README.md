# Rust engine program tooling

Scripts that run and guard the Rust workspace engine gate. `run-rust-checks.mjs` is the gate itself; the rest support it.

## Scripts

| Script | What it does |
| --- | --- |
| `run-rust-checks.mjs` | The gate: tree provenance (the commit the run examined, read at every step boundary; a tree that moves between two readings fails the verdict and names the step, a tree already dirty at the start is recorded), native target, fixture drift, `fmt --check`, `clippy -D warnings`, `build --workspace`, `test --workspace` (`cargo nextest run`), `doctests` (`cargo test --doc`; nextest runs no doctests by design), the collab crash tier (`cargo nextest run -p dohc-engine-collab --features fault-injection`; those tests are compiled out of the plain workspace run), plus `cargo deny check` and `cargo audit` when installed (skip with a warning when absent). A required step that SKIPs fails the verdict. On a host with a build-slot root it enforces the machine budget: a 40 GB free-disk floor, one of 4 build slots, and capped jobs and test threads. Prints a pass/fail summary with per-step seconds and a pasteable evidence line. |
| `native-target.mjs` | The gate's first step, importable so it can be tested: asks rustc through cargo what it compiled for. See [Native target](#native-target). |

## Requirements

- Node >= 22 (repo uses v24). The runner scripts themselves import nothing
  from npm, but the fixture-drift step resolves the workspace's `yjs`/`tsx`
  packages — run `pnpm install --frozen-lockfile` first; a missing dependency
  fails the verdict (required steps may not skip).
- Rust toolchain pinned by `rust-toolchain.toml` (channel 1.96.1, with
  `rustfmt` + `clippy`).
- `pnpm` on PATH (for the JS workspace install above).
- `cargo install cargo-nextest --locked --version 0.9.143` (the CI pin;
  `.github/workflows/pr-checks.yml`, `CARGO_NEXTEST_VERSION`). The test
  rows run through nextest and fail without it.
- Optional: `cargo install cargo-deny --locked` and
  `cargo install cargo-audit --locked` to enable the supply-chain checks.

## Usage

From the repo root, in **PowerShell or Git Bash** (Windows-first; both work):

```sh
node tools/rust-engine-program/run-rust-checks.mjs
```

It prints an `EVIDENCE (paste into the pull request)` line, e.g.:

```
- 2026-08-13T14:55:16.852Z | run-rust-checks | win32/x64 (rust cfg x86_64/windows/msvc, jobs 8, test-threads 8, head b056a36b clean, 11 reads) | PASS | tree provenance=PASS native target=PASS fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS doctests=PASS test collab crash tier=PASS cargo-deny=PASS cargo-audit=PASS scratch leak=PASS
```

`win32/x64` is Node's view of the host. The `rust cfg` field is what rustc
reported through cargo, and the run stops before any other step unless the two
agree — see [Native target](#native-target).

`head b056a36b clean, 11 reads` is the tree the run examined. The gate reads
the tree before the first step and after each one, and reports how many
readings agreed. It is not a claim that the tree was watched between them: a
change made and undone inside one step is invisible to any number of readings.
A run whose tree moved between two readings reports `tree provenance=FAIL`,
names the step that straddled the change, and stamps `head UNATTRIBUTABLE`.
The named step is where the change was seen — work outliving a step's own
process is attributed to the next one.

`clean` and `dirty(N)` are different strengths of claim. A reading lists paths
and status codes, not contents, so a PASS over a dirty tree covers every path
except the `N` already listed: one of those can be rewritten under the run and
read the same. A PASS over a clean tree covers every path.

Copy that line into the pull request.

## Where the gate runs

CI is dispatch-only, so the gate runs locally. Run it on native Windows x64,
then again from WSL for Linux x64 (a WSL-native clone gives realistic
filesystem semantics; `/mnt/c` works). Run `pnpm typecheck` and `pnpm test`
on both as well. macOS has no native gate run; produce one before any Mac
distribution.

## Native target

The evidence line records a platform, so the gate verifies it. Its first step
runs

```sh
cargo rustc --locked -p dohc-engine-protocol --lib --profile check -- --print cfg
```

and compares the reported `target_arch`/`target_os` against the host Node
reports. On a mismatch the run stops before every other step and the verdict is
`FAIL`, so a cross-compiled run cannot be recorded as native evidence.

The question goes to rustc **through cargo**, which is what makes it complete.
Ten channels can set cargo's effective target — `CARGO_BUILD_TARGET`, seven
spellings of `[build].target` merged across cargo's config hierarchy up to
`CARGO_HOME`, and a `--target` injected through `RUSTFLAGS`. Asking the compiler
what it compiled for reflects all of them. Parsing `.cargo/config.toml` cannot
(no stable `cargo config get`), and watching for a `target/<triple>/` directory
cannot either (the `RUSTFLAGS` route never creates one).

Cargo can also be configured to build for several targets at once. The gate
counts the `target_arch` lines rather than the distinct values, because two
triples that share an arch and an os (`…-linux-gnu` and `…-linux-musl`) collapse
to one value each and would read as a single native target. Anything other than
exactly one target fails. On the pinned cargo 1.96.1 the probe never gets that
far: cargo refuses `cargo rustc -- <args>` under multiple targets and exits 101,
which fails the gate anyway. The count is therefore latent on this toolchain —
defense for a cargo that answers rather than refusing, not a reachable hole
today.

The check costs a check-build of one crate and its dependencies. Most of that
work is shared with later steps, but not all of it: the probe compiles
`dohc-engine-protocol` with its default features while `clippy` passes
`--all-features`, so tokio and its dependencies are checked once per feature
set. Measured, the guard's own cost is one extra tokio check-build — seconds on
a warm target dir.

What it does **not** catch:

- **A fully emulated host**, Node and cargo alike. Both then report the emulated
  architecture and agree. Rust exposes no host-hardware fact to test that
  against.
- **An execution redirect.** The probe proves the target the code was *compiled*
  for. A `target.<triple>.runner` in cargo's config makes `cargo test` hand the
  test binary to another command — a wrapper, an emulator, a remote shell — so a
  natively compiled suite can still execute somewhere else.

Both stay an operator responsibility.

`native-target.mjs` holds the guard, so it can be imported and tested;
`scripts/native-target-guard.test.mjs` covers the multi-target count, a
cross-compile, an unmappable host, and a failed probe.

The retired `run-native-suite.mjs` guard was not this. It accepted
`--expect-arch=<x64|arm64>` and compared `os.arch()`, the architecture *Node*
was built for, on a run that executed no cargo at all.

## Rust policy enforced here

- `unsafe_code = "forbid"` is enforced at the workspace level (`Cargo.toml`
  `[workspace.lints]`); crates inherit it via `[lints] workspace = true`.
- Warnings-as-errors is applied in `run-rust-checks.mjs` (clippy `-D warnings`),
  **not** baked into `Cargo.toml`, so day-to-day `cargo build` stays ergonomic
  while the gate stays strict.
- Toolchain, edition, and lockfile are pinned/committed at the repo root.
