#!/usr/bin/env bash
# Times relay restarts from the container's start to the first /ready 200, polled
# from the gateway container on the same network. docker exec health probes add
# seconds of their own on a loaded host, so idle-scale.sh's restartMs is an upper bound.
# Usage: trial/measure/restart-probe.sh <label> [runs]
set -euo pipefail
export MSYS_NO_PATHCONV=1
relay=dohc-idle-scale-sync-relay-1 gateway=dohc-idle-scale-gateway-1
for run in $(seq 1 "${2:-3}"); do
  docker restart -t 30 $relay > /dev/null
  started=$(docker inspect -f '{{.State.StartedAt}}' $relay)
  docker exec $gateway sh -c 'until wget -q -T 1 -O /dev/null http://sync-relay:1788/ready 2>/dev/null; do sleep 0.1; done'
  ready=$(date -u +%FT%T.%3NZ)
  listening=$(docker logs -t --since "$started" $relay 2>&1 | grep -m1 'listening on' | cut -d' ' -f1)
  node -e '
    const ms = value => Date.parse(value.replace(/(\.\d{3})\d*Z$/, "$1Z"));
    const [label, run, started, listening, ready] = process.argv.slice(1);
    console.log(JSON.stringify({ label, run: +run, listeningMs: listening ? ms(listening) - ms(started) : null, readyMs: ms(ready) - ms(started) }));' \
    "$1" "$run" "$started" "$listening" "$ready"
done
