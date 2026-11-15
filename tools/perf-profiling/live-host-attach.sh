#!/usr/bin/env bash
# On Linux, attach a workspace with a large store to a real engine through the relay's request queue, with the
# store's file cache emptied first: once as the relay asked before it asked for progress, and once asking for it.
# Usage: live-host-attach.sh [megabytes] [deadline ms]
set -euo pipefail
cd "$(dirname "$0")/../.."
megabytes=${1:-1024} deadline=${2:-30000}
cargo build --release -p dohc-workspace-engine 2>&1 | tail -n 2
cargo test --release -p dohc-engine-storage --lib --no-run 2>&1 | tail -n 2
engine=$PWD/target/release/dohc-workspace-engine
# Beside the build output, so the store sits on the checkout's disk and not on a memory-backed /tmp.
scratch=$(mktemp -d "$PWD/target/live-host-attach.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
root=$scratch/workspace store=$scratch/workspace/.dohc/engine/engine.db
mkdir -p "$root"
probe=$PWD/tools/perf-profiling/live-host-attach.mts
attach() {
  local out=$scratch/attach.txt
  pnpm --filter @dohc/sync-relay exec tsx "$probe" "$engine" "$root" "$deadline" "$@" >"$out" 2>&1 || true
  grep LIVE_HOST_ATTACH "$out" || { tail -n 30 "$out"; exit 1; }
}
# Asks the kernel to drop one file's cached pages, which needs no root.
cold() { sync; if dd if="$store" iflag=nocache count=0 status=none 2>/dev/null; then echo cold; else echo "warm (could not drop)"; fi; }

echo "machine: $(nproc) cores, $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo), $(findmnt -no FSTYPE,SOURCE -T "$scratch" | tr '\n' ' ')"
echo "a new workspace:"; attach
out=$scratch/fill.txt
if DOHC_MEASURE_STEP=fill DOHC_MEASURE_STORE="$store" DOHC_MEASURE_MB="$megabytes" \
  cargo test --release -p dohc-engine-storage --lib -- --ignored --exact --nocapture \
  schema::tests::store_open_cost_on_a_sized_store >"$out" 2>&1; then
  grep STORE_OPEN_MEASUREMENT "$out"
else
  tail -n 30 "$out"; exit 1
fi
echo "cache: warm, asks for progress:"; attach
echo "cache: $(cold), as before:"; attach --no-progress
echo "cache: $(cold), asks for progress:"; attach
echo "cache: $(cold), asks for progress, a second time:"; attach
