#!/usr/bin/env bash
# Runs the Q8a measurement scenario against the local Compose baseline.
# Starts from one workspace with two live documents (already shared).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
out=.agent-artifacts/baseline.jsonl
driver() { docker run --rm -v dohc-cf-trial-driver-baseline:/state -e DOHC_ORIGIN=https://ice-pc.tail5d1c03.ts.net:8446 dohc-cf-driver:trial "$@" 2>&1 | grep -E '"event"|Error' ; }
snap() { node trial/measure/snapshot.mjs "$1" "$out"; }
idle() { snap "$1 idle-start"; sleep "$2"; snap "$1 idle-end"; }

idle "I0 1ws-2live" 120
driver seed 15 20 4096 0; snap "S16 sync-only"
driver seed 16 20 4096 0; snap "S32 sync-only"
driver seed 15 20 4096 4; snap "L seeded 15ws-4live unshared"
driver share 3; idle "L4 4ws-14live" 120
driver share 4; idle "L8 8ws-30live" 120
driver share 8; idle "L16 16ws-62live" 120
for sessions in 8 16 32; do
  snap "E$sessions start"
  driver edit "$sessions" 2 60
  snap "E$sessions end"
done
driver status | tail -1
echo scenario-complete
