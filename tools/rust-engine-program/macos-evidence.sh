#!/usr/bin/env bash
# macOS evidence for the Rust engine rewrite (GATE6 / R15 cutover).
#
# Run this on a Mac (from the repo root) to reproduce the full-workspace gate AND
# the cutoverBlocking soak on macOS — a shipping platform the program's Windows +
# WSL-Linux evidence did not cover. Produces the same self-describing artifacts as
# the CI workflow (.github/workflows/rust-engine-macos-evidence.yml): the
# run-rust-checks verdict log + the soak evidence JSON.
#
#   tools/rust-engine-program/macos-evidence.sh [quick|full]
#
#   quick (default): short smoke soak (~a minute), fast confidence.
#   full:            the 30-60 min cutoverBlocking soak (the banked-evidence tier).
#
# Requires: rustup (honors rust-toolchain.toml = channel 1.96.1 + rustfmt/clippy)
# and node. Exit code is non-zero if the gate or the soak fails.
set -euo pipefail

MODE="${1:-quick}"
cd "$(git rev-parse --show-toplevel)"

echo "== macOS evidence ($MODE) — $(uname -mrs) =="
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
rustc --version && cargo --version

echo "== full-workspace gate =="
node tools/rust-engine-program/run-rust-checks.mjs 2>&1 | tee macos-gate.log

echo "== cutoverBlocking soak =="
mkdir -p tools/rust-engine-program/soak-evidence
OUT="tools/rust-engine-program/soak-evidence/macos-$(date -u +%Y-%m-%dT%H-%M-%SZ)-cutoverBlocking.json"
if [ "$MODE" = "full" ]; then
  SOAK_ARGS=(--minutes 30 --cycles 1000)
else
  SOAK_ARGS=(--quick)
fi
cargo run --release --features harness --bin dohc-soak-runner -- \
  "${SOAK_ARGS[@]}" --evidence "$OUT" 2>&1 | tee macos-soak.log

echo
echo "== macOS evidence written =="
echo "  gate log:      macos-gate.log"
echo "  soak log:      macos-soak.log"
echo "  soak evidence: $OUT"
echo "Paste the run-rust-checks verdict line + the soak verdict line into"
echo "EXECUTION_LOG.md and commit the evidence JSON beside the Windows one."
