#!/usr/bin/env bash
# Step 5: one container per workspace (CELL_SHAPE=per-workspace, SLEEP_AFTER=2m).
# Four workspaces with four live documents each and two sync-only workspaces,
# each in its own WorkspaceCell. Reuses the accounts already in the driver volume.
# Usage: DOHC_ORIGIN=https://... trial/measure/cf-step5.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
DOHC_TRIAL_KEY=$(grep '^TRIAL_KEY=' .agent-artifacts/secrets/cf.env | cut -d= -f2-)
export DOHC_TRIAL_KEY
out=.agent-artifacts/cf-step5.jsonl
driver() { MSYS_NO_PATHCONV=1 docker run --rm -v dohc-cf-trial-driver-ws:/state -e DOHC_ORIGIN -e DOHC_TRIAL_KEY dohc-cf-driver:trial-verify "$@" 2>&1 | grep -E '"event"|Error' ; }
control() { curl -s -X POST -H "x-dohc-trial-key: $DOHC_TRIAL_KEY" "$DOHC_ORIGIN/__trial/control/$1"; echo; }
workspaces() { MSYS_NO_PATHCONV=1 docker run --rm -v dohc-cf-trial-driver-ws:/state --entrypoint node dohc-cf-driver:trial-verify -e \
  'const s=JSON.parse(require("fs").readFileSync("/state/state.json","utf8"));console.log(s.workspaces.map(w=>w.id+":"+(w.live.length?"live":"sync")).join(" "))'; }
snapAll() { for entry in $(workspaces); do MSYS_NO_PATHCONV=1 node trial/measure/cf-snapshot.mjs "$1 ${entry#*:} ${entry%%:*}" "$out" "/__trial/ws/${entry%%:*}/stats"; done; }
states() { for entry in $(workspaces); do echo "${entry#*:} ${entry%%:*} $(control "state/${entry%%:*}" | head -c 400)"; done; }

time curl -s -o /dev/null -w 'home wake %{http_code} %{time_total}s\n' -H "x-dohc-trial-key: $DOHC_TRIAL_KEY" "$DOHC_ORIGIN/__trial/stats"
if [ -z "$(workspaces)" ]; then
  driver seed 4 20 4096 4
  driver seed 2 20 4096 0
  driver share 4
fi
for entry in $(workspaces); do control "reset/${entry%%:*}" > /dev/null; done
snapAll "W idle-start"; sleep 120; snapAll "W idle-end"
echo "== counters after idle"; states
driver edit 8 2 60
snapAll "W edit-end"
echo "== waiting 200 s with no client traffic"; sleep 200
echo "== states after quiet period"; states
driver verify
echo "== states after verify (wakes everything)"; states
driver status | tail -1
echo step5-complete
