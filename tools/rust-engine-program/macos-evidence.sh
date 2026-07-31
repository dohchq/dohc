#!/usr/bin/env bash
# macOS evidence for the Rust engine rewrite (GATE6 / R15 cutover).
#
# Run this ON A MAC (from anywhere in the repo) to reproduce the full-workspace
# gate command and run either the cutoverBlocking soak or a clearly labelled
# quick smoke on macOS — a shipping platform the program's Windows + WSL-Linux
# evidence did not cover. Produces the same self-describing artifacts as the CI
# workflow (.github/workflows/rust-engine-macos-evidence.yml).
#
#   tools/rust-engine-program/macos-evidence.sh [full|quick]
#
#   full (default): a 60 min cutoverBlocking soak — the BANKABLE evidence.
#   quick:          short smoke. NON-GATING: the runner exits 0 with verdict
#                   PASS-SCENARIOS-ONLY(trend-not-evaluated); it CANNOT satisfy
#                   the GATE6 cutoverBlocking evidence. Use for a fast sanity run.
#
# Evidence integrity (a misleading artifact is worse than none for a cutover
# decision): refuses non-Darwin hosts, refuses unknown modes, requires a Node that
# satisfies package.json engines, pins cargo-deny, requires a canonical PASS
# verdict with cargo-deny actually run, and fails unless the soak wrote fresh JSON.
set -euo pipefail

# Pinned so gate results cannot drift; matches the version behind the canonical
# Windows gate cited in GATE6_PACKET.md.
CARGO_DENY_VERSION="0.20.2"

MODE="${1:-full}"
case "$MODE" in
  full|quick) ;;
  *)
    echo "ERROR: unknown mode '$MODE' (expected 'full' or 'quick')." >&2
    exit 2
    ;;
esac

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "ERROR: this produces macOS evidence but the host is '$OS', not Darwin." >&2
  echo "Run it on a Mac, or dispatch .github/workflows/rust-engine-macos-evidence.yml." >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"
echo "== macOS evidence ($MODE) — $(uname -mrs) =="

# package.json engines: >=24.14.0. This script certifies bankable macOS cutover
# evidence, so accepting a runtime the repo declares unsupported would let it
# vouch for a run nobody can reproduce. Kept in sync with the manifest by hand —
# there is no shared source, and this copy had already gone stale once.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ] \
  || { [ "$NODE_MAJOR" -eq 24 ] && [ "$NODE_MINOR" -lt 14 ]; }; then
  echo "ERROR: node $(node --version) does not satisfy package.json engines" >&2
  echo "       (>=24.14.0). The repo pins 24.14.0 in .node-version and .nvmrc." >&2
  exit 2
fi

if ! command -v cargo-deny >/dev/null 2>&1 \
   || ! cargo-deny --version 2>/dev/null | grep -q "$CARGO_DENY_VERSION"; then
  echo "== installing pinned cargo-deny $CARGO_DENY_VERSION =="
  cargo install cargo-deny --locked --version "$CARGO_DENY_VERSION"
fi
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
{ rustc --version; cargo --version; cargo-deny --version; node --version; } \
  | tee macos-toolversions.log

echo "== full-workspace gate =="
node tools/rust-engine-program/run-rust-checks.mjs 2>&1 | tee macos-gate.log
if grep -q "cargo-deny=SKIP" macos-gate.log; then
  echo "ERROR: gate log has cargo-deny=SKIP — not valid GATE6 evidence." >&2
  exit 1
fi
grep -E "run-rust-checks \| .* \| PASS \|" macos-gate.log \
  || { echo "ERROR: no PASS verdict line in the macOS gate log." >&2; exit 1; }

echo "== building both release binaries (soak resolves the daemon as a sibling) =="
cargo build --release --bin dohc-workspace-engine
cargo build --release --features harness --bin dohc-soak-runner

mkdir -p tools/rust-engine-program/soak-evidence
if [ "$MODE" = "full" ]; then
  EVIDENCE_TIER="cutoverBlocking"
  SOAK_ARGS=(--minutes 60 --cycles 1000)
else
  EVIDENCE_TIER="quick-smoke"
  echo "WARNING: quick mode is NON-GATING — it cannot satisfy the GATE6 cutoverBlocking evidence." >&2
  SOAK_ARGS=(--quick)
fi
echo "== $EVIDENCE_TIER soak ($MODE mode) =="
echo "WARNING: macOS handle/thread slack bounds are UNCALIBRATED for lsof/ps -M counters; see processSampling in the evidence JSON." >&2
OUT="tools/rust-engine-program/soak-evidence/macos-$(date -u +%Y-%m-%dT%H-%M-%SZ)-${EVIDENCE_TIER}.json"
[ ! -e "$OUT" ] || { echo "ERROR: refusing to overwrite existing evidence JSON at $OUT" >&2; exit 1; }
# Invoke the BUILT runner directly so its sibling-daemon resolution works.
./target/release/dohc-soak-runner "${SOAK_ARGS[@]}" --evidence "$OUT" 2>&1 | tee macos-soak.log
[ -s "$OUT" ] || { echo "ERROR: soak produced no evidence JSON at $OUT" >&2; exit 1; }

echo
echo "== macOS evidence written (mode: $MODE) =="
echo "  tool versions: macos-toolversions.log"
echo "  gate log:      macos-gate.log"
echo "  soak log:      macos-soak.log"
echo "  soak evidence: $OUT"
if [ "$MODE" != "full" ]; then
  echo "  NOTE: quick mode — NOT bankable GATE6 evidence. Re-run with 'full'."
fi
echo "  NOTE: macOS handle/thread slack bounds are UNCALIBRATED; the JSON records the counting methods and caveat."
if [ "$MODE" = "full" ]; then
  echo "Paste the run-rust-checks verdict line + the soak verdict line into"
  echo "EXECUTION_LOG.md and commit the evidence JSON beside the Windows one."
else
  echo "Do not cite or commit this quick-smoke artifact as cutoverBlocking evidence."
fi
