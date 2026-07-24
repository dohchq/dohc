#!/usr/bin/env bash
# macOS evidence for the Rust engine rewrite (GATE6 / R15 cutover).
#
# Run this ON A MAC (from anywhere in the repo) to reproduce the full-workspace
# gate AND the cutoverBlocking soak on macOS — a shipping platform the program's
# Windows + WSL-Linux evidence did not cover. Produces the same self-describing
# artifacts as the CI workflow (.github/workflows/rust-engine-macos-evidence.yml).
#
#   tools/rust-engine-program/macos-evidence.sh [full|quick]
#
#   full (default): the 30-60 min cutoverBlocking soak — the BANKABLE evidence.
#   quick:          short smoke. NON-GATING: the runner exits 0 with verdict
#                   PASS-SCENARIOS-ONLY(trend-not-evaluated); it CANNOT satisfy
#                   the GATE6 cutoverBlocking evidence. Use for a fast sanity run.
#
# Evidence integrity: refuses non-Darwin hosts (so a WSL/Linux run can never
# masquerade as macOS proof), refuses a gate log that skipped cargo-deny, and
# builds BOTH release binaries because the soak runner resolves the daemon as a
# SIBLING `dohc-workspace-engine` in its own directory.
set -euo pipefail

MODE="${1:-full}"

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "ERROR: this produces macOS evidence but the host is '$OS', not Darwin." >&2
  echo "Run it on a Mac, or dispatch .github/workflows/rust-engine-macos-evidence.yml." >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"
echo "== macOS evidence ($MODE) — $(uname -mrs) =="

command -v cargo-deny >/dev/null 2>&1 || {
  echo "== installing cargo-deny (the gate counts cargo-deny=PASS as evidence) =="
  cargo install cargo-deny --locked
}
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
rustc --version && cargo --version

echo "== full-workspace gate =="
node tools/rust-engine-program/run-rust-checks.mjs 2>&1 | tee macos-gate.log
if grep -q "cargo-deny=SKIP" macos-gate.log; then
  echo "ERROR: gate log has cargo-deny=SKIP — not valid GATE6 evidence." >&2
  exit 1
fi

echo "== building both release binaries (soak resolves the daemon as a sibling) =="
cargo build --release --bin dohc-workspace-engine
cargo build --release --features harness --bin dohc-soak-runner

echo "== cutoverBlocking soak ($MODE) =="
mkdir -p tools/rust-engine-program/soak-evidence
OUT="tools/rust-engine-program/soak-evidence/macos-$(date -u +%Y-%m-%dT%H-%M-%SZ)-cutoverBlocking.json"
if [ "$MODE" = "full" ]; then
  SOAK_ARGS=(--minutes 30 --cycles 1000)
else
  echo "WARNING: quick mode is NON-GATING — it cannot satisfy GATE6 evidence." >&2
  SOAK_ARGS=(--quick)
fi
# Invoke the BUILT runner directly so its sibling-daemon resolution works.
./target/release/dohc-soak-runner "${SOAK_ARGS[@]}" --evidence "$OUT" 2>&1 | tee macos-soak.log

echo
echo "== macOS evidence written (mode: $MODE) =="
echo "  gate log:      macos-gate.log"
echo "  soak log:      macos-soak.log"
echo "  soak evidence: $OUT"
if [ "$MODE" != "full" ]; then
  echo "  NOTE: quick mode — NOT bankable GATE6 evidence. Re-run with 'full'."
fi
echo "Paste the run-rust-checks verdict line + the soak verdict line into"
echo "EXECUTION_LOG.md and commit the evidence JSON beside the Windows one."
