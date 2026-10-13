#!/usr/bin/env bash
# Runs the Q8a measurement scenario against the Cloudflare cell, mirroring
# baseline-scenario.sh, including its setup of one shared workspace with two live documents.
# Usage: DOHC_ORIGIN=https://... trial/measure/cf-scenario.sh (reads the trial key from .agent-artifacts/secrets/cf.env)
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
DOHC_TRIAL_KEY=$(grep '^TRIAL_KEY=' .agent-artifacts/secrets/cf.env | cut -d= -f2-)
export DOHC_TRIAL_KEY
out=.agent-artifacts/cf.jsonl
driver() { docker run --rm -v dohc-cf-trial-driver-cf:/state -e DOHC_ORIGIN -e DOHC_TRIAL_KEY dohc-cf-driver:trial "$@" 2>&1 | grep -E '"event"|Error' ; }
snap() { node trial/measure/cf-snapshot.mjs "$1" "$out"; }
idle() { snap "$1 idle-start"; sleep "$2"; snap "$1 idle-end"; }

driver accounts 2 4
driver seed 1 20 4096 2
driver share 1
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
