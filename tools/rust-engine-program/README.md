# rust-engine-program — local runners

Tooling for the dohc Rust engine rewrite program. **GitHub CI is skipped for
this program** (Gate 0 decision, `docs/superpowers/plans/rust-engine/DECISIONS.md`):
evidence is produced locally on the dev machine and recorded in
`docs/superpowers/plans/rust-engine/EXECUTION_LOG.md`. These scripts are that
local evidence pipeline.

## Scripts

| Script | What it does |
| --- | --- |
| `run-rust-checks.mjs` | Rust policy gate: `fmt --check`, `clippy -D warnings`, `build --workspace`, `test --workspace`, plus `cargo deny check` / `cargo audit` when installed (skip-with-warning when absent). Prints a pass/fail summary and a pasteable evidence line. |
| `run-native-suite.mjs` | TS-NATIVE-CI local equivalent: runs the reference `@dohc/workspace-engine` `typecheck` + `test` suites natively, asserts host arch, prints an evidence line. This is the native evidence GATE0/TS-NATIVE-CI depends on. |
| `build-reviewer-packet.mjs` | (R01-ORACLE) assembles per-shard reviewer packets. Unrelated to the runners. |

## Requirements

- Node >= 22 (repo uses v24). Zero npm dependencies — run with `node` directly.
- Rust toolchain pinned by `rust-toolchain.toml` (channel 1.96.1, with
  `rustfmt` + `clippy`).
- `pnpm` on PATH for the native suite.
- Optional: `cargo install cargo-deny --locked` and
  `cargo install cargo-audit --locked` to enable the supply-chain checks.

## Usage

From the repo root, in **PowerShell or Git Bash** (Windows-first; both work):

```sh
node tools/rust-engine-program/run-rust-checks.mjs
node tools/rust-engine-program/run-native-suite.mjs
```

Each prints an `EVIDENCE (paste into EXECUTION_LOG.md)` line, e.g.:

```
- 2026-07-17T09:00:00.000Z | run-rust-checks | win32/x64 | PASS | fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=SKIP cargo-audit=SKIP
```

Copy that line into `EXECUTION_LOG.md` under the relevant shard entry.

## The local-evidence workflow (replaces GitHub CI)

Per Gate 0, the per-platform GitHub Actions matrix is retired. Evidence is
collected on the founder's machine:

1. **Windows x64 (native, primary).** Run both scripts in PowerShell or Git
   Bash on the dev machine. This is the primary dogfood platform and the one a
   cutover candidate may ship to.
2. **Linux x64 (via WSL).** Open WSL against the same checkout and run both
   scripts again:
   ```sh
   wsl
   cd /mnt/c/Users/ice/dev/dohc   # or the WSL-native clone
   node tools/rust-engine-program/run-native-suite.mjs
   node tools/rust-engine-program/run-rust-checks.mjs
   ```
   Record the resulting `linux/x64` evidence lines. (Prefer a WSL-native clone
   over `/mnt/c` for realistic filesystem semantics.)
3. **macOS x64 / arm64 — NOT covered during construction.** Producing macOS
   native evidence is a **mandatory pre-release obligation** before any Mac
   distribution (DECISIONS.md Gate 0 item 2). Until it exists, Gate 7's "every
   supported platform" claim is scoped to `{Windows, Linux-WSL}`.

Every native run asserts the host architecture so a cross-built or emulated
run cannot masquerade as native evidence. `run-native-suite.mjs` accepts
`--expect-arch=<x64|arm64>` to hard-pin which platform a given run represents.

## Rust policy enforced here

- `unsafe_code = "forbid"` is enforced at the workspace level (`Cargo.toml`
  `[workspace.lints]`); ordinary crates inherit it via `[lints] workspace = true`.
- Warnings-as-errors is applied in `run-rust-checks.mjs` (clippy `-D warnings`),
  **not** baked into `Cargo.toml`, so day-to-day `cargo build` stays ergonomic
  while the gate stays strict.
- Toolchain, edition, and lockfile are pinned/committed at the repo root.
