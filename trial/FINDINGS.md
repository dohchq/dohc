# Drive on Cloudflare Containers: trial findings

Written 2026-10-13 by `claude-opus-5-5` for Ice and the Drive design session. This note answers Q8a for option B. It lives on the throwaway branch `drive/cloudflare-trial`, based on `56584a876`. The trial removed its Cloudflare deployment, apart from the account's workers.dev subdomain (see [Teardown](#teardown)).

"Cell" means one container or machine set that holds a set of workspaces. It is not a glossary term yet.

## Recommendation

Keep option A for launch. The release runs on Cloudflare Containers without code changes, but today it costs more than A and is less safe:

- **Cost.** The cost model below puts one always-awake Cloudflare cell at about $107 a month per 1,000 accounts, against about $43 for a Hetzner CPX32. A container per workspace comes to about $2,840, because every workspace with a hosted live share stays awake all month. These are models built on measured inputs, not bills.
- **Durability.** A Cloudflare container's disk is gone when it stops. A crash that skips the save rolls back every write the relay acknowledged since the last save, and nothing detects it. The trial reproduced this.
- **Sleep.** The session host polls its relay through the public origin about once every 0.25 to 3 seconds per hosted workspace. Each poll renews the container's sleep timer, so a cell that hosts any live document never sleeps.

Two release changes help A as much as B, so make them whatever Drive decides. The session host should long-poll its relay, and it should reach the relay without leaving the host. Revisit B only after the release acknowledges writes once they are durable outside the container. Even then, the cheapest B shape modeled here, a container per workspace whose session host stops when nobody works, comes to about four times A at 1,000 accounts.

Option C models at about $65, between A and B, but it means rewriting the relay as Durable Objects. That breaks Q1, and live hosting would still need the Rust engine in containers.

## Activity profile and cost per 1,000 accounts

Each account owns one workspace. On a given day 10% of workspaces are active, each for 2 hours, plus a 10-minute sleep timer. 10% of workspaces keep a live share with 4 live documents hosted by the server. Each workspace stores 50 MB. Active workspaces make 3,600 requests an hour through the edge. Prices are the published Workers Paid, Durable Objects, R2, and Containers rates fetched on 2026-10-13, and Hetzner's CPX32 at $41.99 after the June 2026 change.

| Option | Modeled monthly cost | What dominates |
| --- | --- | --- |
| A: one Hetzner CPX32 | $42.59 | The server. Memory for this profile is 2.83 GiB of 8. |
| B1: the same cell as one Cloudflare container (standard-2) | $107.45 | Memory all month ($38.66), session host polls as Worker and Durable Object requests ($48.56) |
| B2: one container per workspace, with measured inputs | $2,844.35 | 100 hosted workspaces awake all month: CPU $1,112, memory $726, Durable Object duration $448, requests $473 |
| B2 projected after the session host changes below, including on-demand hosting | $166.45 | Memory ($84, of which the home cell is $26), Durable Object duration ($37) |
| C: relay as Durable Objects (paper) | $65.00 | Home cell and engine containers ($38), SQLite storage ($9) |

[`trial/measure/cost.mjs`](measure/cost.mjs) computes every row from the inputs above, so a reader can change the profile and rerun it.

Caveats:

- **These are models, not bills.** The Cloudflare rows leave out Postgres (Neon in the trial; A runs it on the server), Worker CPU time, and R2 operations. The last two should fall inside the plan's allowances at this profile, but the trial did not show it. B1 applies idle CPU measured with 16 hosted workspaces to 100, and no row adds CPU for editing beyond its idle or active rate. A's memory mixes local figures with the Cloudflare relay's per-document figure.
- **B2 after the changes assumes hosted shares sleep when nobody works,** and wake like any other workspace. That needs the on-demand session host change, which the trial did not build.
- **A's capacity is software-limited today.** This profile needs 100 hosted workspaces and 400 live documents. The session host stops at 16 workspaces and 64 documents per relay (`services/sync-relay/src/storage/serviceHostEnrollment.ts:15-16`). Q6's session host work must raise those caps before one A server holds 1,000 accounts of this profile. Its idle polling CPU beyond 16 hosted workspaces is unmeasured.
- **Durable Object duration is an assumption.** The model bills a container's Durable Object for every second its container runs. Cloudflare's pricing page says each container has its own Durable Object and bills both. The trial did not read the billed duration back. If the assumption is wrong, B2 drops by $448 and B2 after the changes drops by $37.
- **B1 uses standard-2.** The measured cell ran on standard-1, but this profile's 2.8 GiB and editing peaks would crowd its 4 GiB and 1/2 vCPU.
- **The editing CPU is an estimate.** The model charges a workspace container 0.05 vCPU while people work. The trial measured 0.005 to 0.016 vCPU per editor.

## Cold starts

The first table's times come from the Worker's own `startAndWaitForPorts` log. The client was in Manila, the containers were pinned to the EU, and Postgres was Neon in Frankfurt.

| Container | First start | Wake with restore |
| --- | --- | --- |
| Full cell: three services, Caddy, and Mailpit (standard-1) | 5.8 to 6.0 s; 12.0 s for the first start after the image push | 7.8 to 9.7 s with archives from 48 KB to 5.5 MB |
| Workspace container: relay and session host only (basic) | 3.0 to 6.0 s | 3.0 to 3.4 s with a 66 KB archive |
| Home cell with no workspaces (standard-1) | 5.6 s | 5.3 s |

Inside the full cell, port 8080 opened 4.3 to 6.1 s after the process started. Restore took 0.1 to 0.8 s, Postgres migration 0.3 to 1.3 s, relay initialization under 0.3 s, and service readiness about 3.5 s. Locally, the same cell opened in 3.7 s.

Restore time grows with workspace size. These runs used incompressible bytes in one workspace container's relay directory, on a basic instance (1/4 vCPU). Save and restore times come from the cell's own log. The wake column is the client's HTTP time from Manila, which includes the round trip to the EU. The Worker measured 3.0 to 3.4 s for the same 66 KB wakes.

| Archive | Save | Restore | Wake, end to end |
| --- | --- | --- | --- |
| 66 KB | 0.16 to 0.30 s | 0.2 to 2.3 s | 8.0 s |
| 256 MiB | 22.9 s | 4.8 s | 8.6 s |
| 1 GiB | 125.9 s | 23.6 s | 32.7 s |

The full cell (standard-1) saved its 5.5 MB compressible archive in 1.2 s and restored it in 0.7 s. Saving ran at 8 to 12 MB/s, which is consistent with a single gzip stream limited by 1/4 vCPU. A container gets 15 minutes after SIGTERM, so a rough extrapolation puts the limit near 7 GB. Parallel parts and skipping compression for incompressible blobs may raise it.

## Memory per live document

| Per live document | Local Compose | Cloudflare cell |
| --- | --- | --- |
| Session host RSS | 0.96 MiB | 0.63 MiB |
| Relay RSS | 2.2 MiB | 2.9 MiB |
| Session host disk | 0.63 MiB | 0.64 MiB |

The seeded documents were small Markdown files, so larger documents will cost more. Memory does not set today's 64-document cap. At about 4 MiB per document across relay and session host, 64 documents need about 250 MiB. These limits may bind first:

- **Idle polling CPU**, described below.
- **The live validation pool.** It has two worker threads. When both are busy, the relay answers `admission-unavailable` and the client drops the session (`services/sync-relay/src/liveValidation.ts:99-113`, `packages/ydoc-projection/src/namedLiveProvider.ts:239-241`). Every editor run, local and on Cloudflare, dropped sessions. A local rerun that recorded the reason showed `admission-unavailable` for all 4 drops, with 8 sessions on 8 different documents. Contention on the validation pool is a possible cause, not a proven one.
- **The socket caps** in `selfHostLiveProfile.ts`: 32 per relay, 16 per grant, 8 per principal, and 4 per session.

## Q8a measurements

### Local Compose baseline (option A)

The baseline ran the release image `dohc-self-host:trial-56584a876` under Docker Desktop on Windows 11. The bundle used private mode behind Tailscale, because the engine needs a WebPKI certificate.

- **Startup and idle memory.** Compose came up in 21 s from cold. An idle server with no accounts used about 350 MiB, of which the relay was 145 MiB.
- **Per synced workspace.** A workspace of 20 files of 4 KiB cost about 1.0 MiB of relay RSS and 0.2 MiB of relay disk. Postgres was unchanged.
- **At the caps.** With 16 hosted workspaces and 62 live documents, the relay was 427 MiB and the session host 110 MiB. After three editor runs the relay was at 593 MiB and did not shrink.
- **Idle CPU while hosting.** The sync-relay container used 0.35 cores with 2 documents and 0.57 to 0.61 cores with 14 to 62. The relay and the session host engine took about half each.
- **Editors.** Each session sent 2 edits a second and waited for each acknowledgement before the next.

  | Sessions | Sent / acknowledged | Connect p50 | Acknowledged p50 / p95 | Sessions dropped |
  | --- | --- | --- | --- | --- |
  | 8 | 260 / 256 | 2.6 s | 0.64 / 1.9 s | 4 |
  | 16 | 370 / 360 | 3.2 s | 1.6 / 3.9 s | 10 |
  | 32 | 279 / 276 | 7.4 s | 5.9 / 8.7 s | 3 |

  Server CPU per editor, net of idle hosting: 0.004 to 0.009 cores.
- **Share to ready.** The first share took 2.6 s and later ones 5.6 to 11 s, because the session host restarts on every change.
- **Disk.** A 4 KiB write and fsync took 8.4 to 8.8 ms at p50 on the Docker Desktop volume.

### Cloudflare, one cell (B1 shape)

Everything ran in one standard-1 container (1/2 vCPU, 4 GiB), with the same scenario and data.

- **Idle VM memory.** The VM used 560 to 600 MiB at start, 781 MiB (525 MiB anonymous) at the caps, and 981 MiB (688 anonymous) after the editor runs.
- **Idle CPU.** The VM used 0.17 vCPU with 2 documents and 0.25 to 0.27 vCPU with 14 to 62. That is lower than locally, which is consistent with each session host poll waiting for a round trip through the Worker.
- **Session host polls.** With 16 hosted workspaces, the Durable Object counted 5.75 log polls a second through the edge.
- **Editors from Manila.** 8, 16, and 32 sessions sent 125, 143, and 188 edits. Connect p50 was 4.1, 9.6, and 13.1 s. Acknowledgement p50 was 0.56, 2.7, and 4.6 s. Server CPU per editor was 0.005 to 0.016 vCPU. The client waited for each acknowledgement over a Manila-to-EU link, so latencies are not comparable with the local run.
- **Share to ready.** The first share took 3.7 s and later ones 4.5 to 12.5 s.
- **Round trips from the container.** Writing 4 KiB to its Durable Object took 50 ms at p50 and 59 ms at p95. A 4 KiB R2 put took 133 ms at p50.

### Cloudflare, one container per workspace (B2 shape)

Each workspace ran in its own basic container (1/4 vCPU, 1 GiB) with only the relay and session host. A home cell kept accounts, share-web, and the global routes.

- **A workspace with 4 hosted documents** used 0.20 to 0.23 vCPU while idle, most of a basic instance. VM memory was 392 to 404 MiB, the relay 244 to 249 MiB, and the session host 47 to 48 MiB. Its own daemon polled 3.3 to 4.9 times a second, 10 times the per-workspace rate in the shared cell. None of these containers slept during a 200 s quiet period.
- **A sync-only workspace** used 348 MiB of VM memory, 216 MiB of it relay. It slept 2 minutes after its last request, saved 66 KB in 0.2 s, and woke with all its data.
- **Fixed cost.** The relay's fixed cost of about 215 MiB is paid once per workspace, against about 1 MiB per workspace in a shared cell.
- **Editors.** 8 sessions across 4 workspace containers sent 174 edits and had 170 acknowledged. Connect p50 was 3.6 s. Acknowledgement p50 was 1.2 s and p95 2.3 s.

## Sleep, wake, and confirmed writes

The trial saved the container's relay, continuity, and session host directories to R2 when the container stopped, and restored them before any service started. The cell's Durable Object records each saved generation and the relay's continuity stamp. A wake refuses an archive whose stamp differs from that record.

That guard only stops an older archive from a single writer. The stamp is a counter, so two containers that restored the same generation and made the same number of writes end with equal stamps. Parts sit at fixed keys that a second writer can overwrite after a commit, and a missing record reads as a fresh cell. A release version needs a save ID or content hash in each commit, parts at write-once keys, the generation the saving container restored from, and an error when the record is missing but archives exist.

- **Graceful sleep lost nothing in the one run.** 47 workspaces held 2,166 relay log entries before a stop. The stop saved 5.46 MB in 1.2 s, and the wake took 8.2 s. All 2,166 entries were readable afterwards, and all 62 live documents were hosted again on the first status check.
- **A crash that skips the save rolls back acknowledged writes silently.** One new workspace pushed 20 entries and the relay acknowledged them. Killing the container then skipped the save. After the wake, that workspace returned 404. The restore accepted the older generation, because it matched the Durable Object's record.
- **A stamp-mismatched archive is refused.** Locally, with [`fake-state.mjs`](measure/fake-state.mjs) standing in for the Worker, a record that claimed stamp 99 over an archive with stamp 14 failed at boot with `Restored relay stamp 14 is not the recorded 99` ([log](evidence/local-guard-test.txt)).

The relay's own continuity guard cannot help here. It compares the relay database with a separate continuity store (`services/sync-relay/src/relayDeployment.ts:140-183`). A container rollback restores both together.

On Cloudflare, a write is confirmed only when it is durable outside the container before the relay acknowledges it. Today the relay acknowledges after a local SQLite commit with `synchronous=FULL`. On Cloudflare's ephemeral disk, fsync took 0.15 ms at p50, which means nothing for durability. The trial's 4 KiB probes suggest the price of durability outside the container: a round trip to the cell's Durable Object took about 50 ms and an R2 put about 133 ms. The trial did not build a durable acknowledgement path, and one could batch commits.

## What broke or needed changes

The release's service code ran unchanged: nothing in `services/` or `crates/` changed. The trial wrapped it in the Cloudflare deployment adapters listed here.

| Problem | What the trial did | Where |
| --- | --- | --- |
| Compose runs three services, Postgres, and Caddy as separate containers that address each other. Cloudflare containers cannot. | One container runs every service under a supervisor, with Caddy as the path router. Services bind to loopback and trust 127.0.0.1. | `trial/cloudflare/container/cell.mjs`, `Caddyfile` |
| Postgres is a Compose service. | Neon, through `POSTGRES_URL`. `entrypoint.mjs` only rewrites the URL when `POSTGRES_PASSWORD` is set. | `cell.mjs` |
| Services trust only IP literals as proxies. | The Worker sets `X-Forwarded-For` from `CF-Connecting-IP`, and Caddy forwards that one address. | `src/index.ts`, `Caddyfile` |
| Release engine builds accept only HTTPS with WebPKI roots (`crates/dohc-engine-sync-http/src/lib.rs:1174-1199`). Cloudflare's HTTPS interception needs its own CA. | The session host reaches its relay through the public workers.dev origin and back through the Worker. This is the hairpin that keeps cells awake. | |
| SMTP requires TLS unless the host is loopback (`packages/workspace-auth/src/smtp.ts:114`). | Mailpit on 127.0.0.1 inside the container. | `cell.mjs` |
| The container's disk does not survive a stop. | Save to R2 on SIGTERM and restore on start, guarded by the Durable Object's generation record. | `cell.mjs`, `src/index.ts` |
| The account had no workers.dev subdomain, and only the dashboard creates one (error 10063). | Ice opened Workers and Pages once. | |
| Durable Objects start next to their first caller. A cell first reached from Manila put its object in Asia and its container in the EU, so every container-to-object round trip took 157 ms. | Pin both namespaces with `jurisdiction("eu")`, which brought it to 50 ms. | `src/index.ts` |
| With `max_instances: 1`, a new Durable Object got "There is no container instance that can be provided" until the old instance finished stopping. | Kill the old cell first. | |
| Deploy success means a rollout started. For about 80 s, new starts used the previous image. A container-backed Durable Object keeps its old code until its container stops. | Use `--containers-rollout=immediate` and restart cells after Durable Object changes. | |
| Containers are VMs without cgroup files. | Stats read VM-level `/proc`. | `cell.mjs` |
| `wrangler tail` drops events under load. It showed 9 of 16 requests. | Count requests in each Durable Object. | `src/index.ts` |
| Deleting a container application sends SIGTERM, and the instance keeps writing through its outbound handler for minutes, even after the Worker is deleted. | Purge R2 only after the uploads stop. | [Teardown](#teardown) |

## Release changes B requires

"Release" means the change ships to self-host as well, under Q1.

| Change | Release or Drive | Size | Also helps A |
| --- | --- | --- | --- |
| Acknowledge a write only once it is durable outside the container: a commit hook or WAL shipping to Durable Object storage or R2, with the continuity stamp kept outside the container | Release (self-host could use it for off-site backups) | Large | Yes, for Q8c backups |
| Session host replication long-polls with `hold`. Today the engine's workspace pull sends only `since` and `limit` (`crates/dohc-engine-sync-http/src/lib.rs:728-742`). The relay supports `hold` for accounts (`services/sync-relay/src/workspaceReplicationRoutes.ts:172-183`), but its service-host path builds its routes with a no-op wait and passes no reauthentication, so it never holds (`services/sync-relay/src/serviceHostReplication.ts:18,33`). | Release | Medium | Yes. A's idle hosting CPU is 0.6 cores today. |
| An explicit internal relay URL for the session host and automation replicas, with release engines accepting configured loopback HTTP (`selfHostedLiveHost.ts:41-42`, `serviceOrdinaryReplication.ts:43`, `automationReplicas.ts:96`, `crates/dohc-engine-sync-http/src/lib.rs:1187-1196`). The desktop runs the same engine, so only the relay's own service-host configuration may enable it, never a URL from a server or a share link. | Release; needs a security review | Small to medium | Yes. No public round trip. |
| A session host that can stop when no live session is open and restart on demand | Release and Drive edge | Medium | |
| Configurable session host caps (`serviceHostEnrollment.ts:15-16`) | Release | Small | Yes, and needed by Q6 |
| A larger live validation pool, or admission that queues instead of dropping the session | Release | Small to medium | Yes |

A container per workspace (B2) needs more. These come from a code map of the relay, with spot checks:

- **A routing directory.** Share IDs, grant IDs, link secrets, capabilities, handoff codes, publications, and live session IDs carry no workspace. The relay could emit directory entries when it mints them. That part is a medium release change, and the Worker side is large and Drive-only. The trial routed shares and desktop sessions by reading relay responses. A production directory should come from the relay itself.
- **An account-level service for share listings and notices.** These read across all of a person's workspaces (`services/sync-relay/src/storage/shares.ts:723-734`, `storage/notices.ts:768-793`). Drive-only and large, or a large release change if notices leave the relay.
- **Edge rate limits.** Each relay process keeps its own in-memory limits, so the budgets multiply by the number of containers. Drive-only, medium.
- **A configurable Postgres pool size.** Small release change.
- **Durable Object alarms to wake containers for the relay's hourly cleanup.** Drive-only, small.
- **A tool to split today's shared relay store by workspace,** keeping the namespace and counters. Drive-only, large.
- **Workspace-scoped credentials.** Every workspace container in the trial held the deployment's Postgres URL, auth secret, and link and exchange keys. A compromised workspace relay or engine would reach every account. Scoping those to one workspace is a large release change.

## Risks

- **Silent rollback.** Until acknowledged writes are durable outside the container, a host failure, out-of-memory kill, drain overrun, failed save, or child process that hangs on SIGTERM can roll them back without detection. The trial's supervisor never escalates a hung child to SIGKILL.
- **Cost runaway.** One hosted share keeps its container and Durable Object awake and polling. Nothing fails, so only the bill shows it.
- **Unauthenticated wakes.** The edge routes `/sync/<workspace>` before the relay checks a token, so any request with a new workspace ID starts a container and leaves an archive in R2 when it stops. The trial's `max_instances` capped it. The edge must check the bearer or a workspace directory before it wakes a container.
- **No tenant isolation.** A container per workspace separates load, not tenants, until credentials are scoped to the workspace.
- **Path handling.** The Worker gates on the encoded path while Caddy routes on the cleaned path, so a crafted `/sync/..%2f` path may reach routes behind the gate. This is untested. The edge must normalize paths the way the router does.
- **Mixed versions.** Worker code updates at once, while images and Durable Object code follow later. Releases must tolerate old images under new Worker code for minutes.
- **Placement.** Durable Objects default to their first caller's region. Every namespace needs an explicit jurisdiction, and container-to-object round trips are still 50 ms inside the EU.
- **Wake latency.** People wait 3 to 10 s when a workspace wakes, and over 30 s for a 1 GiB workspace on a basic instance.
- **Unverified billing.** The Durable Object duration assumption decides whether B2 is expensive or very expensive.
- **Q1 drift.** B2's routing directory and account service are Drive-only code that no self-hoster runs. They also change where notices and share listings live.

## Option C on paper

C rewrites the relay as one Durable Object per workspace, with SQLite storage and hibernating WebSockets. Under the same profile the model puts it at about $65 a month per 1,000 accounts. That covers $38 of container time for a home cell (accounts and share-web) and for engine containers that host live documents only while people work, $9 of SQLite storage above the 5 GB included, request charges under $7, $6 of Durable Object duration, and the $5 Workers Paid plan. It assumes relay objects hibernate 90% of the time people work.

C's real cost is reimplementing about 33,000 lines of relay TypeScript, its storage format, and its permission checks in Worker code. Q1 rules that out, and so did the trial's own authorization. Settlement and live hosting stay in the Rust engine, so C does not remove containers.

## How to reproduce

- **Image.** `node tools/self-host/release.mjs --image dohc-self-host:trial-56584a876 --output <dir> --archive` built an 865 MB image in 5 minutes. The cell wrapper is 938 MB. It fits a lite instance's 2 GB disk, but the cell's idle memory needs at least basic.
- **Baseline.** Run [`trial/measure/baseline-scenario.sh`](measure/baseline-scenario.sh) against the bundle with [`trial/baseline/compose.trial.yml`](baseline/compose.trial.yml). [`snapshot.mjs`](measure/snapshot.mjs) and [`analyze.mjs`](measure/analyze.mjs) produce the numbers.
- **Cloudflare.**
  - `trial/cloudflare` holds the Worker and the cell image. `CELL_SHAPE` switches between one cell and a container per workspace.
  - Run [`cf-scenario.sh`](measure/cf-scenario.sh) and [`cf-step5.sh`](measure/cf-step5.sh), which use [`cf-snapshot.mjs`](measure/cf-snapshot.mjs).
  - The load driver is [`trial/load/driver.ts`](load/driver.ts). Its commands are `accounts`, `seed`, `share`, `edit`, `status`, and `verify`.
- **Cost.** `node trial/measure/cost.mjs`.

[`trial/evidence/`](evidence/) holds the measurement output behind every number here: snapshots, analyses, the cost model output, the sleep and crash log, cold starts, restore times, request counters, probes, and the teardown log. Worker traces stayed local. The driver state held account tokens and was deleted with its volumes.

## Teardown

Done on 2026-10-13 between 05:16 and 05:21 UTC:

- **Cloudflare, deleted:**
  - Worker `dohc-cloudflare-trial` and its secrets.
  - Both container applications.
  - All six registry images.
  - Both Durable Object namespaces. The API reported zero namespaces afterwards.
  - The EU R2 bucket `dohc-cloudflare-trial-state`, after purging 56 objects.
  - The temporary purge Worker.
  - Wrangler's login.
- **Cloudflare, left in place:**
  - The account's workers.dev subdomain `dohc.workers.dev`. Cloudflare can rename it but not delete it.
  - The Neon database, which Ice owns. It still holds the trial's accounts and tables.
- **Local, removed:** the Compose project and its volumes, the driver volumes, and Tailscale route 8446.

## Review

- **GPT-6.1 Sol, the other model family, for correctness and simplification.**
  - Round 1, at `1fabe2fa0`, found nine problems, eight of them blocking. All were accepted and fixed in `6659f75a4`. Sol recomputed the A, B1, and B2 rows by hand.
  - Round 2, at `6659f75a4`, found no remaining blocking problems.
  - The first round 1 attempt stalled, because Codex file reads on this host wait for approval. It was cancelled and resent with the evidence inline.
- **Opus 5.5, for durability, security, and isolation.**
  - Round 1, at `2e1af63d2`, found eight problems, three of them blocking. All were accepted and fixed in `6659f75a4`.
  - Round 2, at `6659f75a4`, found no remaining blocking problems. Its four non-blocking wording fixes are applied in the commit that adds this section.
