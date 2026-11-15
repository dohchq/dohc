#!/usr/bin/env bash
# Time an engine store open on Linux for stores of several sizes: one quick_check, an ordinary open,
# and the first open after an update that added migrations. Each is timed with the file cache
# emptied first and again with it warm. Usage: store-open-cost.sh [megabytes...]
set -euo pipefail
cd "$(dirname "$0")/../.."
sizes=("$@")
[ $# -gt 0 ] || sizes=(64 256 1024)
# Beside the build output, so the stores sit on the checkout's disk and not on a memory-backed /tmp.
mkdir -p target
scratch=$(mktemp -d "$PWD/target/store-open.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

cargo test --release -p dohc-engine-storage --lib --no-run 2>&1 | tail -n 3
step() { # step <name> <store> [extra env...]
  local name=$1 store=$2; shift 2
  env DOHC_MEASURE_STEP="$name" DOHC_MEASURE_STORE="$store" "$@" \
    cargo test --release -p dohc-engine-storage --lib -- --ignored --exact --nocapture \
    schema::tests::store_open_cost_on_a_sized_store 2>/dev/null | grep STORE_OPEN_MEASUREMENT
}
# Asks the kernel to drop one file's cached pages, which needs no root.
cold() { sync; if dd if="$1" iflag=nocache count=0 status=none 2>/dev/null; then echo cold; else echo "warm (could not drop)"; fi; }

echo "machine: $(nproc) cores, $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo), $(findmnt -no FSTYPE,SOURCE -T "$scratch" | tr '\n' ' ')"
for megabytes in "${sizes[@]}"; do
  for pending in 0 2; do
    store=$scratch/store-$megabytes-$pending.db
    step build "$store" DOHC_MEASURE_MB="$megabytes" DOHC_MEASURE_PENDING="$pending"
    cp "$store" "$store.warm"
    echo "cache: $(cold "$store")"; step check "$store"
    echo "cache: $(cold "$store")"; step open "$store"
    echo "cache: warm"; step open "$store.warm"
    rm -f "$store" "$store.warm" "$store"-* "$store.warm"-*
  done
done
