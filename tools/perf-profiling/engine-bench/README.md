# Engine Phase-B benchmarks

This harness measures engine hypotheses C1, C2, and C3 from `DISCOVERY-R2.md`.
It drives the daemon through the framed workspace-engine client. B2 and B3 use
the same real relay and two-daemon path as `twoDaemonSync.e2e.test.ts`.

The reader is the next agent preparing an orchestrator-scheduled engine run.

## Run the full benchmarks

Use Node 24.14 or newer and pnpm 11.20.0. Build the debug and release engines
from the same commit before the run.

Run this command from the repository root:

```powershell
node tools/perf-profiling/engine-bench/run-engine-bench.mjs `
  --debug-engine C:/path/to/debug/dohc-workspace-engine.exe `
  --release-engine C:/path/to/release/dohc-workspace-engine.exe `
  --relay-tls-cert C:/path/to/relay-cert.pem `
  --relay-tls-key C:/path/to/relay-key.pem `
  --relay-tls-host loopback.example.test `
  --output test-results/engine-bench
```

Do not run another benchmark, build, test, or desktop process at the same time.
The runner executes every engine and curve point serially. It stops every
daemon, relay, and proxy process it starts.

The runner does not build either engine. You can also set
`DOHC_BENCH_DEBUG_ENGINE`, `DOHC_BENCH_RELEASE_ENGINE`,
`DOHC_BENCH_RELAY_TLS_CERT`, `DOHC_BENCH_RELAY_TLS_KEY`, and
`DOHC_BENCH_RELAY_TLS_HOST` instead of passing the corresponding flags.

If the host interrupts a run between benchmark phases, rerun the same command
with `--benches b2,b3` (or another comma-separated subset). The runner reuses
omitted per-benchmark JSON only when its schema, pass status, commit, scale, and
engine hashes match. It then writes a complete combined summary. Do not use
phase selection to overlap benchmark processes.

The release engine requires HTTPS and uses its built-in public CA roots. The
TLS certificate must be publicly trusted and valid for the supplied hostname.
The hostname must resolve to `127.0.0.1`. A self-signed certificate and a local
trust-store change do not satisfy the release transport. The runner terminates
TLS in a local proxy and forwards every request to the real HTTP relay. It
records the certificate fingerprint and validity period, but never the key.
Set `--relay-latency-ms` to delay each proxied relay response by that many
milliseconds. Omit the flag, or set it to `0`, to leave responses unchanged.

## Check the plumbing

Run a reduced curve after harness changes:

```powershell
node tools/perf-profiling/engine-bench/run-engine-bench.mjs `
  --debug-engine C:/path/to/debug/dohc-workspace-engine.exe `
  --release-engine C:/path/to/release/dohc-workspace-engine.exe `
  --relay-tls-cert C:/path/to/relay-cert.pem `
  --relay-tls-key C:/path/to/relay-key.pem `
  --relay-tls-host loopback.example.test `
  --output test-results/engine-bench-tiny `
  --tiny
```

Tiny mode proves the daemon, relay, proxy, cleanup, and JSON plumbing. Its
numbers are not comparable with a full run.

## What each benchmark measures

- B1 keeps one plaintext Y.Doc session open per engine. It grows the encoded
  state through 100 KiB, 1 MiB, 5 MiB, and 15 MiB, then records 64 one-character
  appends at each band. Debug versus release isolates the debug replay oracle.
  The release size curve measures the full-document parity cost. The runner
  gives each measured record RPC a 10-minute deadline so the daemon's default
  30-second deadline does not truncate the largest curve point.
- B2 establishes one shared lineage, holds the reader's live session lease,
  and admits remote deltas one at a time. It times one probe admission after
  1, 8, 32, and 128 queued predecessors. Closing the live session measures the
  complete drain. A read-only SQLite check proves each queue depth.
- B3 places 10, 50, and 200 distinct Y.Doc update blobs in one relay page. A
  reader with an empty local store catches up through the real relay. A local
  forwarding proxy counts relay blob GETs during the timed pull.

Each benchmark uses fresh workspace roots. B2 and B3 use fresh relay storage
for each curve point.

## Read the output

The output directory contains these untracked files:

- `append-cost.json` with every append sample and its percentile summary;
- `deferred-admission.json` with predecessor admissions, the K-probe latency,
  queue counts, and drain time;
- `relay-catch-up.json` with catch-up time and observed relay request counts;
- `engine-bench-summary.json` with the three report-ready curves.

`status: "pass"` means the full curve completed and every scenario invariant
held. It is not a performance threshold. Interpret the curve shape against the
hypothesis under test.

The harness is a standalone script outside every package test include. Root
and desktop default test suites do not run it.
