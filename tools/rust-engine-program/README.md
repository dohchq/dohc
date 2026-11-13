# Rust engine program tooling

Scripts that run and guard the Rust workspace engine gate.
[`run-rust-checks.mjs`](run-rust-checks.mjs) is the gate itself; the rest
support it. The gate's steps are the rows of the evidence line under
[Usage](#usage).

- A required step that skips fails the verdict. `cargo deny check` and
  `cargo audit` skip with a warning when they are not installed.
- The `test --workspace` row runs `cargo nextest run`. The `doctests` row runs
  `cargo test --doc`, because nextest runs no doctests by design.
- The verdict verifier also requires the scratch cleanup row to pass.
- On a host with a build-slot root, the gate enforces the machine budget. The
  [`rust-gate` skill](../../.agents/skills/rust-gate/SKILL.md) says what to do
  when it waits or refuses.
- The daemon build runs after the tests and selects only
  `dohc-workspace-engine`, with its default production features. This leaves
  the production daemon ready for desktop preparation. Different compiler
  settings can still require a rebuild.
- The `reader tests` step runs every ignored test whose ignore reason is
  `READER_PHASE` in [`reader-tests.mjs`](reader-tests.mjs). A new Markdown
  reader regression joins by using that reason.

## Requirements

- Node >= 22 (repo uses v24). The runner scripts themselves import nothing
  from npm, but the fixture-drift step resolves the workspace's `yjs`/`tsx`
  packages. Run `pnpm install --frozen-lockfile` first; a missing dependency
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
- <timestamp> | run-rust-checks | win32/x64 (rust cfg x86_64/windows/msvc, jobs 8, test-threads 8, head <sha> clean, 11 reads) | PASS | tree provenance=PASS native target=PASS fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS test --workspace=PASS reader tests=PASS doctests=PASS build daemon=PASS cargo-deny=PASS cargo-audit=PASS scratch leak=PASS
```

Copy that line into the pull request.

`win32/x64` is Node's view of the host. The `rust cfg` field is what rustc
reported through cargo, and the run stops before any other step unless the two
agree. See [Native target](#native-target).

`head <sha> clean, 11 reads` is the tree the run examined. The gate reads
the tree before the first step and after each one, and reports how many
readings agreed. It is not a claim that the tree was watched between them: a
change made and undone inside one step is invisible to any number of readings.
A run whose tree moved between two readings reports `tree provenance=FAIL`,
names the step that straddled the change, and stamps `head UNATTRIBUTABLE`.
The named step is where the change was seen. Work that outlives a step's own
process is attributed to the next one.

`clean` and `dirty(N)` are different strengths of claim. A PASS over a clean
tree covers every path. A PASS over a dirty tree cannot prove that the `N`
already-dirty paths stayed unchanged, because a reading lists paths and status
codes, not contents.

## Where the gate runs

PR checks run the gate on Linux x64. When a change depends on Windows
behavior, also run it on native Windows x64, with `pnpm typecheck` and
`pnpm test`. macOS has no routine gate run; produce one before any Mac
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
Anything other than exactly one target fails too.
[`native-target.mjs`](native-target.mjs) holds the check and the reason it asks
rustc through cargo.

What it does **not** catch:

- **A fully emulated host**, Node and cargo alike. Both then report the emulated
  architecture and agree. Rust exposes no host-hardware fact to test that
  against.
- **An execution redirect.** The probe proves the target the code was *compiled*
  for. A `target.<triple>.runner` in cargo's config makes `cargo test` hand the
  test binary to another command, such as a wrapper, an emulator, or a remote
  shell, so a natively compiled suite can still execute somewhere else.

Both stay an operator responsibility.

## Rust policy enforced here

- `unsafe_code = "forbid"` is enforced at the workspace level (`Cargo.toml`
  `[workspace.lints]`); crates inherit it via `[lints] workspace = true`.
- Warnings-as-errors is applied in `run-rust-checks.mjs` (clippy `-D warnings`),
  **not** baked into `Cargo.toml`, so day-to-day `cargo build` stays ergonomic
  while the gate stays strict.
- Toolchain, edition, and lockfile are pinned/committed at the repo root.
