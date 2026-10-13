#!/usr/bin/env bash
# Idle-scale test of option A: how relay memory, startup, disk, backup, and read
# latency change as idle workspaces grow. Stages are cumulative targets.
# Usage: ORIGIN=https://... [SEED_FILES=5] trial/measure/idle-scale.sh 1000 5000 10000
# Run one instance at a time: a second run would restart the relay under the first.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PROJECT=dohc-idle-scale SEED_CONCURRENCY=${SEED_CONCURRENCY:-16}
art=.agent-artifacts
out=$art/idle.jsonl events=$art/idle-events.jsonl
relay=$PROJECT-sync-relay-1
compose() { (cd $art/server-bundle && MSYS_NO_PATHCONV=1 docker compose -p $PROJECT --env-file .env.self-host \
  -f docker-compose.self-host.yml -f tools/self-host/compose.private.yml -f compose.trial.yml "$@"); }
driver() { MSYS_NO_PATHCONV=1 docker run --rm -v dohc-idle-scale-driver:/state -e DOHC_ORIGIN="$ORIGIN" \
  -e SEED_CONCURRENCY -e SEED_DISCARD_LOCAL=1 dohc-idle-driver "$@" 2>&1 | grep -E '"event":"(account|verify|summary)"|Error' || true; }
snap() { node trial/measure/snapshot.mjs "$1" "$out"; }
event() { echo "{\"at\":\"$(date -u +%FT%TZ)\",$1}" | tee -a $events; }
count() { MSYS_NO_PATHCONV=1 docker run --rm -v dohc-idle-scale-driver:/state --entrypoint node dohc-idle-driver \
  -e 'try{console.log(JSON.parse(require("fs").readFileSync("/state/state.json","utf8")).workspaces.length)}catch{console.log(0)}'; }
ms() { echo $(( $(date +%s%N) / 1000000 )); }

# The relay is ready when its own health check passes inside the container.
cold_restart() {
  local begun; begun=$(ms)
  compose restart sync-relay > /dev/null
  until MSYS_NO_PATHCONV=1 docker exec $relay node /app/tools/self-host/health.mjs sync-relay > /dev/null 2>&1; do sleep 0.25; done
  event "\"stage\":$1,\"restartMs\":$(( $(ms) - begun ))"
}

# Online backup while the relay runs, the way a nightly job would copy it.
backup() {
  MSYS_NO_PATHCONV=1 docker exec $relay node -e '
    const { DatabaseSync } = require("node:sqlite"); const fs = require("node:fs");
    const target = "/data/.idle-backup-probe.sqlite"; fs.rmSync(target, { force: true });
    const begun = performance.now(); const db = new DatabaseSync("/data/sync-relay.sqlite", { readOnly: true });
    db.exec(`VACUUM INTO \x27${target}\x27`); db.close();
    const ms = Math.round(performance.now() - begun), bytes = fs.statSync(target).size; fs.rmSync(target);
    console.log(JSON.stringify({ backupMs: ms, backupBytes: bytes, dbBytes: fs.statSync("/data/sync-relay.sqlite").size }));' \
  | while read -r line; do event "\"stage\":$1,${line:1:${#line}-2}"; done
}

for target in "$@"; do
  have=$(count)
  if [ "$have" -lt "$target" ]; then
    begun=$(ms); driver seed $(( target - have )) ${SEED_FILES:-5} 4096 0
    event "\"stage\":$target,\"requested\":$(( target - have )),\"workspaces\":$(count),\"seedMs\":$(( $(ms) - begun )),\"concurrency\":$SEED_CONCURRENCY,\"files\":${SEED_FILES:-5}"
  fi
  snap "$target seeded"
  cold_restart "$target"
  sleep 60
  snap "$target cold-idle"
  begun=$(ms); driver verify
  event "\"stage\":$target,\"readAllMs\":$(( $(ms) - begun ))"
  snap "$target after-read"
  backup "$target"
done
echo idle-scale-complete
