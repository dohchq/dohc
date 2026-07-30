# rust-engine-program — local runners

Tooling for the dohc Rust engine rewrite program. **GitHub CI is skipped for
this program** (Gate 0 decision, `docs/superpowers/plans/rust-engine/DECISIONS.md`):
evidence is produced locally on the dev machine and recorded in
`docs/superpowers/plans/rust-engine/EXECUTION_LOG.md`. These scripts are that
local evidence pipeline.

## Scripts

| Script | What it does |
| --- | --- |
| `run-rust-checks.mjs` | Rust policy gate: fixture drift, `fmt --check`, `clippy -D warnings`, `build --workspace`, `test --workspace`, the collab crash tier (`cargo test -p dohc-engine-collab --features fault-injection` — those tests are compiled out of the plain workspace run), plus `cargo deny check` / `cargo audit` when installed (skip-with-warning when absent). A required step that SKIPs fails the verdict. Prints a pass/fail summary and a pasteable evidence line. |
| `build-reviewer-packet.mjs` | (R01-ORACLE) assembles per-shard reviewer packets. Unrelated to the runners. |

Banked soak artifacts live in `soak-evidence/`; see
[`soak-evidence/README.md`](soak-evidence/README.md) for the provenance block
every artifact carries, which files predate it, and the residual gap.

## Requirements

- Node >= 22 (repo uses v24). The runner scripts themselves import nothing
  from npm, but the fixture-drift step resolves the workspace's `yjs`/`tsx`
  packages — run `pnpm install --frozen-lockfile` first; a missing dependency
  fails the verdict (required steps may not skip).
- Rust toolchain pinned by `rust-toolchain.toml` (channel 1.96.1, with
  `rustfmt` + `clippy`).
- `pnpm` on PATH (for the JS workspace install above).
- Optional: `cargo install cargo-deny --locked` and
  `cargo install cargo-audit --locked` to enable the supply-chain checks.

## Usage

From the repo root, in **PowerShell or Git Bash** (Windows-first; both work):

```sh
node tools/rust-engine-program/run-rust-checks.mjs
```

It prints an `EVIDENCE (paste into EXECUTION_LOG.md)` line, e.g.:

```
- 2026-07-28T10:11:10.183Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS test collab crash tier=PASS cargo-deny=PASS cargo-audit=PASS
```

Copy that line into `EXECUTION_LOG.md` under the relevant shard entry.

## The local-evidence workflow (replaces GitHub CI)

Per Gate 0, the per-platform GitHub Actions matrix is retired. Evidence is
collected on the founder's machine:

1. **Windows x64 (native, primary).** Run the gate in PowerShell or Git
   Bash on the dev machine. This is the primary dogfood platform and the one a
   cutover candidate may ship to.
2. **Linux x64 (via WSL).** Open WSL against the same checkout and run it
   again:
   ```sh
   wsl
   cd /mnt/c/Users/ice/dev/dohc   # or the WSL-native clone
   node tools/rust-engine-program/run-rust-checks.mjs
   ```
   Record the resulting `linux/x64` evidence line. (Prefer a WSL-native clone
   over `/mnt/c` for realistic filesystem semantics.)
3. **macOS x64 / arm64 — NOT covered during construction.** Producing macOS
   native evidence is a **mandatory pre-release obligation** before any Mac
   distribution (DECISIONS.md Gate 0 item 2). Until it exists, Gate 7's "every
   supported platform" claim is scoped to `{Windows, Linux-WSL}`.

**There is no architecture guard on this gate — and the retired runner's one did not
work either.** `run-native-suite.mjs` accepted `--expect-arch=<x64|arm64>` and compared
`os.arch()`, the architecture *Node* was built for, while every check it ran was a
`cargo` command. Cargo takes its target from channels Node knows nothing about, so the
capability that left with that runner was a check that could not do its job.

Rebuilding it properly is tracked separately. Ten distinct channels can set cargo's
effective target, and neither parsing `.cargo/config.toml` nor watching for
`target/<triple>/` directories covers all of them — a `--target` injected through
`RUSTFLAGS` reaches rustc while cargo still writes to `target/debug`, so it is invisible
to both.

Until that lands, **a run's platform is whatever the operator asserts when pasting the
evidence line.** The gate prints `platform()/arch()` from Node and does not verify it.

## Rust policy enforced here

- `unsafe_code = "forbid"` is enforced at the workspace level (`Cargo.toml`
  `[workspace.lints]`); ordinary crates inherit it via `[lints] workspace = true`.
- Warnings-as-errors is applied in `run-rust-checks.mjs` (clippy `-D warnings`),
  **not** baked into `Cargo.toml`, so day-to-day `cargo build` stays ergonomic
  while the gate stays strict.
- Toolchain, edition, and lockfile are pinned/committed at the repo root.
