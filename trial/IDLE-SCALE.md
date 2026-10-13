# Idle workspaces on one option A server

Written 2026-10-13 by `claude-opus-5-5` for Ice and the Drive design session. This test asks whether one release server keeps up as free accounts pile up, most of them idle. It follows the Cloudflare trial in [`FINDINGS.md`](FINDINGS.md).

## Result

Idle workspaces cost disk, not memory or startup time. With 9,957 workspaces the relay restarted at 146 MiB, the same as an empty server, and was ready in about 1 to 3 seconds. Nothing in the relay scans all workspaces at startup or on a timer. One A server can hold far more idle accounts than 10,000. The limits that do grow with data are disk, blobs kept inside one SQLite file, and one query that runs after writes.

## Setup

- The release image built from `56584a876` plus the trial scripts, under Docker Desktop on Windows 11, in private mode behind Tailscale. This is the same setup as the trial's baseline.
- Two owner accounts seeded workspaces through the release engine, as a desktop would. The first 391 workspaces have 20 files of 4 KiB each. The rest have 5. None are shared or hosted live.
- At each stage the test took a snapshot and restarted the relay. It took another snapshot after 60 idle seconds, then read every workspace's bootstrap and log once and took a third snapshot. Finally it ran an online backup (`VACUUM INTO`) of the relay database.

## Measurements

| Workspaces | Relay RSS after restart | Relay RSS after reading all | Read all (sequential) | Relay database | Online backup |
| --- | --- | --- | --- | --- | --- |
| 391 | not taken | not taken | 10.8 s | 74 MB | 1.2 s |
| 985 | 145 MiB | 157 MiB | 18.2 s | 100 MB | 0.5 s |
| 4,977 | 145 MiB | 417 MiB | 71.5 s | 278 MB | 1.5 s |
| 9,957 | 146 MiB | 431 MiB | 166.7 s | 500 MB | 6.2 s |

- **Memory.** An empty server's relay used 145 MiB in the trial's baseline. After a restart it stays there at every stage. Reading every workspace raised it to 431 MiB, and five minutes later it was back to 168 MiB. That was the JavaScript heap's high-water mark from a burst of requests, not memory kept per workspace. The trial's earlier figure of about 1 MiB per workspace was memory left over from seeding.
- **Startup.** A probe from the gateway container measured 0.9 s, 1.8 s, and 3.3 s from container start to `/ready` at 9,957 workspaces ([`restart-probe.sh`](measure/restart-probe.sh)). The relay's CPU in its first minute was 1.1 to 2.4 s at every stage. The script's own restart timings (2.0 to 13.0 s) are upper bounds, because its `docker exec` health probes stalled on a busy host.
- **Reads.** Two requests per workspace took 14 to 19 ms in total from 985 workspaces up. They did not slow with scale.
- **Disk.** Each 5-file workspace added about 43 KB to the relay database. Postgres stayed at 7.8 MiB, because it holds accounts, not workspaces.
- **Writes.** The relay took in about 1.5 new 5-file workspaces a second, whether 16 or 48 seeding lanes ran. The test did not find the bottleneck. On this host, SQLite commits with `synchronous=FULL` wait on an fsync that took 8 to 9 ms in the baseline, so they are a likely cause. Server NVMe should raise the ceiling. A few pushes out of thousands failed with "workspace operation failed"; the driver logged and skipped them.

## What grows with data

Code review found what grows with data, and found no per-workspace startup scan. It found:

- **The automation pass after writes scans every current file.** Each relay write schedules an automation pass. Each pass runs `wantedWorkspaces`, which scans all of `sync_relay_current_files` with a pattern no index can serve (`services/sync-relay/src/datasetAutomations.ts:80-86`, `automationReplicas.ts:512`). That is milliseconds at 50,000 files. It grows linearly, so at a million files each write burst costs a full table scan. Indexing the file name, or recording automation files as they are written, would remove it.
- **Blobs live inside the one SQLite file.** This test used small files. At 50 MB per workspace, 100,000 workspaces would make a 5 TB database, and copying, backing up, and restoring a file that size is the real limit. Content-addressed blobs in object storage remove it on any host.
- **One-time migrations** read every current file or log row once, on the first start after an upgrade that adds them (`storage/currentFiles.ts:30-36,68-73`, `storage/automationWorkspaces.ts:209-218`). At 100,000 workspaces they could take minutes, once.

## What this means for 100,000 accounts

- Memory and startup should stay flat, because nothing loads idle workspaces.
- Relay disk for small workspaces would be about 4 to 5 GB, and a backup about a minute. User content, not workspace count, sets the real size.
- Free accounts on A cost their stored bytes. Cloudflare's scale-to-zero would save little here, because an idle workspace on A already costs no compute.
- The changes that keep A healthy at that size are blobs in object storage, an index for the automation pass, and later more than one cell. They do not depend on Cloudflare.

## Evidence

[`trial/evidence/idle-scale/`](evidence/idle-scale/) holds the snapshots (`idle.jsonl`), stage events (`idle-events.jsonl`), the restart probe output, and the run log. A first attempt was discarded: two runs overlapped and restarted the relay under each other, and a driver bug ended seeding early. Its output is not used.
