# Back up and recover a self-hosted server

Use this procedure to preserve a deployment or recover files after a storage failure.
Run commands from the extracted self-host release directory or repository root.
Use the same environment file and Compose overrides as your running deployment.

## Choose the recovery operation

| Operation | What it preserves or restores | Limit |
| --- | --- | --- |
| `backup` | A standalone relay database and checksum manifest | Stops the services. Does not include authentication, live-host data, configuration or continuity |
| `snapshot` | An encrypted relay snapshot of the running deployment, the same package the hourly job uploads | Same contents as `backup` |
| `verify` | Decrypts and checks an encrypted snapshot into a new directory | The output holds unencrypted relay data |
| `check-backup` | Checks snapshot integrity against current independent continuity | Requires the original host's continuity |
| `restore` | Repairs missing or corrupt relay storage from a matching snapshot | Refuses snapshots older than accepted relay writes |
| `archive` | All named deployment volumes, configuration, secrets and image identities | Preserves evidence; no full-deployment restore command |
| `salvage` | Exports settled tracked file contents from an old snapshot | Creates ordinary files; does not restore a running deployment |
| `move.mjs` | Starts the deployment on a new host from its attached data disk | Requires the data-disk layout; accounts move separately unless they are in an external database |

The relay keeps an independent continuity record outside its database volume.
Every accepted mutation advances that record, including permission changes and schema migrations.
A database older than the confirmed continuity stamp cannot start.
This prevents a restored backup from resurrecting revoked access.

Never replace current continuity with an older archived copy.
An archive does not prove that its server accepted no later work.
Losing the original continuity prevents supported deployment restoration.
You can still salvage available file contents from a completed relay snapshot.
After an interrupted write, start the relay normally.
Startup makes the committed database state durable, then settles its continuity record.
An unacknowledged write that committed may be kept.
The relay confirms continuity before returning a write or serving its result.
An older database still refuses startup, including a backup from before the last acknowledged write.
If startup still refuses, preserve its volumes.
Offline salvage requires an earlier completed relay snapshot; it cannot read the failed deployment or its archive directly.

Automation copies live in `dohc_self_host_host_data`, alongside their engine databases and run history.
A relay snapshot does not include their pending claims, schedule marks, or Group coverage.
Preserve this volume in a private archive before maintenance.
The bundle cannot restore or view archived run history.
The server can rebuild workspace files from the relay after a copy is lost or its sync identity changes.
A rebuilt copy cannot recover pending claims or Undo for earlier runs from those files.
Due times missed while no computer or server runs schedules do not run later.
Missed schedules produce a skipped-schedule notice; Group triggers start from the rejoin.
These rules do not make an older relay snapshot safe to restore.

If the server starts with empty host data and keeps its relay data, it rebuilds its copies from the relay.
The server loses this work with the host data:

- Run history, and Undo for runs on the server.
- Changes from automation runs that the server may not have sent to the relay.
  The relay records each run before the run changes the server's copy.
  It keeps that record until a sync that began after the run ended succeeds and the server has delivered every shared file update it queued.
  After the rebuild, each run that still has a record shows as failed in its automation's run history for 30 days.
  Try again does not run these runs.
  If the rebuilt server already ran one of them again, run history shows how that run went.
  The owner also gets one Notice for each automation with such runs, with how many runs it has.
  Some of these changes may have reached the relay, so check the records those runs changed.
- Button presses that the server accepted but had not finished.
  Each of these presses ends instead of running again.
  A press may have made some of its changes, so check them before pressing again.

An older host data archive does not get this protection.
Its copies lack the claims made after the archive, so presses accepted since then can run twice.
Do not put an older host data archive in place of newer host data.

## Keep a diverged live-editing copy

The server keeps a copy of each workspace that has live documents in `dohc_self_host_host_data`.
Each copy is a store directory named by a 64-character hash.
If a copy no longer matches the relay, the server stops live editing for that workspace.
The relay log then names the store and the workspace.
The server writes a `<store>.diverged` marker file beside the store.
The marker keeps the store detached after a restart.
Recovery is not automatic yet.
The store and every live edit in it stay unchanged.
Preserve the volume in a private archive before you change anything.
Keep the marker.
Without it the next relay start attaches the store again.
The server checks the copy against the relay before anyone can edit, finds that it still diverges, and writes the marker again.
Deleting the owner's server account removes the store and its marker.

## Save a relay snapshot

Choose a private backup parent directory outside the deployment's data volumes.
The maintenance container runs as UID 1000 and needs write access to that parent.
The operator running these commands also needs access because archival writes files on the host.
If the operator's UID is 1000, create a private directory:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/dohc-backups
node scripts/self-host/recovery.mjs backup /srv/dohc-backups/relay-before-upgrade
```

For a different operator UID, grant both identities access through a private group or ACL.
Do not make the backup directory publicly readable or writable.

The command stops the selected Compose project before taking the snapshot.
It resumes only services that were running before a successful snapshot.
Preflight failures leave running services unchanged.
Failures after the services stop leave them stopped for inspection.
The snapshot contains `relay.sqlite` and `manifest.json`.
Keep both files together.
Protect snapshot storage against unauthorized writes as well as reads.
Anyone who can rewrite a snapshot can define the relay contents restored from it.
If SQLite journals remain after an unclean shutdown, backup refuses before copying data.
Try a normal start and clean stop only if continuity permits it.
Otherwise, preserve a private deployment archive for further recovery work.

Use `--env-file PATH` for a different environment file.
Use `--compose-file PATH` for each additional Compose override.
Use `--project-name NAME` if your deployment overrides the Compose project name.
The shared configuration reader includes the private-network and data-disk overlays automatically.

## Take hourly off-site snapshots

The `relay-snapshot` service copies the relay database every hour while the server keeps running.
It opens the database read-only and does not mount continuity.
It encrypts each copy and uploads it to an S3-compatible bucket, such as Cloudflare R2 or Amazon S3.
The service stays off until you configure the bucket.

1. Create a private bucket for snapshots.
2. Add a bucket lifecycle rule that deletes objects 30 days after creation.
   The job never deletes snapshots, so the lifecycle rule controls retention.
   On Amazon S3, Object Lock turns on versioning, and that action alone keeps each snapshot as a noncurrent version.
   Add a second action to the same rule that permanently deletes noncurrent versions 1 day after they become noncurrent.
   S3 then removes the leftover delete markers itself, so each snapshot is gone about 31 days after it was taken.
3. Lock the bucket's objects for 30 days, the same length as the lifecycle rule.
   On Cloudflare R2, add a bucket lock rule.
   On Amazon S3, turn on Object Lock with a default retention in compliance mode.
   Governance mode also works if the snapshot credentials lack `s3:BypassGovernanceRetention`.
   R2 tokens cannot be limited to writing, and S3 write access can replace an object.
   The host holds these credentials, so without a lock an attacker who controls the host can delete or replace your snapshots.
4. Create credentials that can write objects to that bucket.
   The job does not read, list or delete objects.
5. Set these values in `.env.self-host`:

```dotenv
DOHC_SNAPSHOT_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
DOHC_SNAPSHOT_S3_REGION=auto
DOHC_SNAPSHOT_S3_BUCKET=dohc-snapshots
DOHC_SNAPSHOT_S3_ACCESS_KEY_ID=your-access-key-id
DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY=your-secret-access-key
DOHC_SNAPSHOT_ALERT_EMAIL=you@your-domain.com
```

For Amazon S3, use the regional endpoint, such as `https://s3.us-east-1.amazonaws.com`, and that region.
Cloudflare R2 uses the region `auto`.

6. Set `DOHC_SNAPSHOT_HEARTBEAT_URL` to an HTTPS monitoring URL, as described below.
7. Stop and start the deployment:

```sh
node tools/self-host/bootstrap.mjs stop
node tools/self-host/bootstrap.mjs start
```

The job takes the first snapshot after the relay is healthy, then one every hour.
Each upload uses a new object name under the deployment's namespace.
The storage provider can read each object name, which holds the deployment's namespace, the time and the stamp.
The stamp counts the relay's accepted writes.
An interrupted upload leaves no object under its name.
A single upload is limited to 5 GB. A larger snapshot fails; save it with `snapshot` instead.

If a snapshot fails, the job emails `DOHC_SNAPSHOT_ALERT_EMAIL` through the server's SMTP settings.
It sends at most one failure email a day, and one email when snapshots work again.
It keeps this record in the `dohc_self_host_snapshots` volume, so restarts do not repeat the email.
With a [data disk](self-host.md#keep-server-data-on-an-attached-disk), that volume is the `snapshots` folder on the disk.
If the job cannot save the record, for example because that disk is full, each restart of the job can send one more failure email.

Each snapshot is copied there before it is encrypted, usually on the same disk as the relay database.
Before it copies, the job checks free space on the relay's disk and on the disk that holds the snapshots folder.
Each disk needs twice the relay database's size, plus headroom for the relay's own writes.
The headroom is the database's size, capped at a tenth of the disk and never less than 1 GiB.
With less, the job takes no snapshot and sends the failure email, so a snapshot never takes the relay's space.
Only one snapshot runs at a time.
If a `snapshot` command is running when the hourly snapshot starts, that hour's snapshot fails like any other.

The job cannot email you when it stops.
A setting it refuses also stops it before the first snapshot, and Docker restarts it again and again without an email.
The heartbeat URL detects both.
The job requests that URL after each successful snapshot.
Configure the monitoring service to alert you when the requests stop.

Online snapshots need the running relay.
While the relay is stopped, the job fails; use `backup` instead.
Read the job's log for each result:

```sh
docker compose --env-file .env.self-host -f docker-compose.self-host.yml --profile snapshots logs relay-snapshot
```

## Keep the snapshot key away from the server

The bootstrap command writes `DOHC_SNAPSHOT_KEY` to `.env.self-host`.
Every snapshot is encrypted with this key, using AES-256-GCM over the database and its manifest.
Copy the key to a password manager or other storage that does not depend on this server.
If you lose the key, you cannot open any snapshot encrypted with it.
The hourly job, `snapshot` and `verify` refuse to run without it.
A deployment without snapshots does not need it.
If you replace the key, keep the old key until the lifecycle rule deletes its snapshots.

## Save an encrypted snapshot locally

```sh
node scripts/self-host/recovery.mjs snapshot /srv/dohc-backups/offsite
```

The command writes the same encrypted package that the hourly job uploads.
The services keep running.
It makes the same free-space check as the hourly job.
If the hourly job is taking a snapshot, the command refuses. Run it again after that snapshot finishes.
The directory can already exist; each run adds a new file and never replaces one.
A file ending in `.partial` is an incomplete copy.
The directory parent needs the same UID 1000 write access as a relay snapshot.

## Verify an encrypted snapshot

Download an off-site snapshot with your storage provider's tools first.
Then decrypt and check it into a new directory:

```sh
node scripts/self-host/recovery.mjs verify /srv/dohc-backups/relay-check \
  --snapshot /srv/dohc-backups/offsite/SNAPSHOT_FILE.dohc-snapshot
```

The command reads `DOHC_SNAPSHOT_KEY` from the environment file.
It refuses a snapshot that was changed, truncated or encrypted with a different key.
It also checks the database checksum, SQLite integrity and the manifest.
It reports the snapshot's namespace, generation, stamp, time and release.
The new directory contains `relay.sqlite` and `manifest.json`.
Use it with `check-backup`, `restore` or salvage like a relay snapshot.
Its contents are unencrypted. Restrict the directory and delete it after use.

Verification runs without network access and mounts no deployment volume.
On a replacement host, load the release image and restore `.env.self-host` before you verify.
If only the snapshot key survived, [create the configuration](self-host.md#create-the-configuration) on the new host.
Then set `DOHC_SNAPSHOT_KEY` in the new `.env.self-host` to the key you kept.

An hourly snapshot does not include authentication, live-host data, configuration or continuity.
Server accounts are stored in Postgres and need a separate backup.
With an [external database](#accounts-in-an-external-database), your provider's backups hold them.
Repair with `restore` still requires the snapshot stamp and nonce to equal current continuity.
An hourly snapshot usually falls behind within minutes, so it rarely qualifies.
Restoring a lost server from an off-site snapshot is not supported yet.
You can salvage files from a verified snapshot.
Work that the server accepted after the snapshot can be lost with the server.

## Check and repair relay storage

Use the original host, environment file, authentication store and live-host data.
Preserve the original continuity volume and server secrets.

```sh
node scripts/self-host/recovery.mjs check-backup /srv/dohc-backups/relay-before-upgrade
node scripts/self-host/recovery.mjs restore /srv/dohc-backups/relay-before-upgrade
```

After an interrupted write, start the relay once to settle continuity before backup, check-backup or restore.
Then stop it cleanly.
If the relay database is missing or corrupt, the relay can't start, so restore without this step.
The check requires the snapshot stamp and nonce to equal the current continuity record.
Newer accepted work makes that snapshot unsuitable for repair.
The restore command checks the copied candidate before replacing any existing relay files.
It preserves replaced database and SQLite side files under `/data/recovery-<id>`.
It leaves the services stopped and reports that directory.
Start the deployment through its normal launcher after inspecting the result.

If the operation is interrupted, preserve the reported recovery directory and all volumes.
Do not move a saved WAL file beside a different database.
Do not remove continuity to make startup succeed.
The restore command never replaces the authentication store or live-host volume.
Those stores can advance independently and need separate recovery guarantees.

## Preserve a complete private archive

```sh
node scripts/self-host/recovery.mjs archive /srv/dohc-backups/deployment-before-upgrade
```

The command stops the project and archives each named volume without modifying it.
This includes authentication, relay, live-host, continuity and TLS data declared by Compose.
With an [external database](self-host.md#keep-accounts-in-an-external-postgres), the archive does not include accounts.
It also saves the environment, resolved Compose configuration, bound configuration files and image identities.
Bound directories are refused because this procedure does not define their backup scope.
The command resumes previously running services after success.

Restrict the archive to the server operator.
It contains workspace contents, credentials, private keys and server secrets.
Copy it to your protected backup storage and verify its recorded checksums.
Keep `archive.json` with the archive files.
An absent `archive.json` means the archive did not complete.

This command provides preservation, not automatic disaster recovery.
Do not extract an old archive over a running deployment.
Restoring old authentication or continuity can revive revoked access.
Keep a separate relay snapshot for the supported repair and salvage commands.

## Salvage portable files from an old snapshot

Salvage works without the original deployment configuration or continuity.
It does not start a server or import old authority.
Run the bundled command from an available self-host image, with networking disabled:

```sh
docker run --rm --network none --user 1000:1000 \
  --mount type=bind,source=/srv/dohc-backups,target=/backups \
  --entrypoint node YOUR_DOHC_IMAGE \
  /app/services/sync-relay/dist/relay-deployment.js \
  salvage --directory /backups/relay-before-upgrade --output /backups/recovered-work
```

Replace `YOUR_DOHC_IMAGE` with your installed self-host image name.
The output directory must not exist.
From a source checkout, the equivalent command is:

```sh
pnpm --filter @dohc/sync-relay deployment salvage --directory /absolute/snapshot --output /absolute/recovered-work
```

Read `recovery.json` and `files.jsonl` before using the exported files.
The inventory maps each exported path to its original workspace, version, path and blob checksum.
Workspace and version directory names are hashes to avoid unsafe identifier paths.
Create a new local workspace from the selected files under `files`.
Recreate accounts and sharing deliberately on a fresh server if needed.

Salvage exports settled tracked files present in the snapshot's current file state.
It reports missing blobs, invalid checksums and unsupported paths as skipped entries.
Accepted app responses stored as tracked files are included.
It does not import app collection records, protected files, unsettled live edits, chats, discussions or history.
The `evidence` directory retains the original private SQLite snapshot unchanged.
Keep that evidence offline; it includes credentials and historical content.
Do not attach or serve the evidence database.
An absent `recovery.json` means the export did not complete.

## Upgrade without rolling back authority

Save a relay snapshot and complete private archive before upgrading.
Preserve existing volumes, environment values and server secrets during the upgrade.
If the new version changes the schema, its migration advances continuity.
The pre-upgrade snapshot can then be used for offline salvage, but not in-place rollback.
If an upgrade fails, keep its volumes and diagnose or install a corrected version.
Do not reset continuity or automatically restore an older deployment archive.

## Move to a new host

Use this procedure for a deployment that keeps its data on an [attached disk](self-host.md#keep-server-data-on-an-attached-disk).
It also recovers a server that stopped working while its disk survived.
The new host continues from the last write the relay committed to the disk. Nothing is rolled back.

Always move the live disk. Never start from a snapshot or copy of the disk.
A copy rolls back the relay database and its continuity record together, and the relay cannot detect that.

The disk carries the relay database, its continuity record, the session host and automation copies, and the snapshot job's state.
Bring these separately:

- `.env.self-host`, unchanged. It holds the configuration and the server secrets. Keep a private copy off the server.
- The same release bundle and image version that the old host ran.
- The accounts volume, which holds accounts and sign-in sessions.
  Docker names it `<DOHC_DEPLOYMENT_NAME>_dohc_self_host_postgres`, which is `dohc-self-host_dohc_self_host_postgres` by default.
  Copy the stopped volume to the new host before you start the deployment there.
  If the old host is lost, restore this volume from your own backup.
  An older copy brings back sessions and accounts that were removed after it was taken.
  It also loses accounts created after it was taken.
  Those people cannot open their workspaces, even after they sign up again, because they get new accounts.
  Without this volume, the new server has no accounts, and nobody can open the workspaces on the disk as their owner.
  The move command refuses to start until the volume holds an accounts database.
  With an [external database](#accounts-in-an-external-database), skip the accounts volume.
- Nothing for TLS. In public mode, Caddy obtains new certificates when the deployment starts on the new host.

Never copy the disk to run a second server.
Each copy would accept different work under the same deployment identity.

### Stop the old server for good

1. If the old host still responds, run `node tools/self-host/bootstrap.mjs stop` there.
2. On the old host, run `docker ps` and confirm that no dohc service is running.
3. With an external database, skip this step.
   Otherwise, on the old host, save the accounts volume to a file in a new private folder:

   ```sh
   (umask 077 && mkdir dohc-accounts && docker run --rm --network none \
     --mount type=volume,source=dohc-self-host_dohc_self_host_postgres,target=/pg,readonly \
     postgres:17.9-alpine tar -C /pg -czf - . > dohc-accounts/accounts.tar.gz)
   ```

   The file contains password hashes and sign-in sessions. Only your user can read the folder and the file.
   Copy the folder to the new host over a private channel and keep its permissions, for example with `scp -rp dohc-accounts NEW_HOST:`.
   Never put it in a shared or synced folder.
4. Shut down the old host.
5. Detach the disk from the old host.
6. In your provider's console, confirm that the old host is off and the disk has no attachment.

If the old host starts again without the disk, its relay cannot start because its data folder is missing.
With an external database, its sign-in service can still start and use that database. Keep the old host off.
Also remove the old host's address from your provider's allowlist, or change the database password and set the new one as `POSTGRES_PASSWORD` on the new host.

### Start the deployment on the new host

1. Prepare the new host as described in [Set up a dohc server](self-host.md#prepare-the-host).
2. Copy the release bundle and `.env.self-host` to the new host, then load the release image.
3. With an external database, copy its CA certificate to the path that `DOHC_POSTGRES_CA_FILE` names, and skip the rest of this step.
   If your provider limits which addresses can connect, allow the new host's address.
   Otherwise, from the folder that holds `dohc-accounts`, restore the accounts volume under the same name:

   ```sh
   docker volume create dohc-self-host_dohc_self_host_postgres
   docker run --rm -i --network none \
     --mount type=volume,source=dohc-self-host_dohc_self_host_postgres,target=/pg \
     postgres:17.9-alpine tar -C /pg -xzf - < dohc-accounts/accounts.tar.gz
   ```

   Then delete the `dohc-accounts` folder from both hosts, or keep it with your private backups.
4. Attach the disk and mount it so that `DOHC_DATA_DIRECTORY` names the deployment folder on it.
   If the mount path changed, update `DOHC_DATA_DIRECTORY` in `.env.self-host`.
5. For public access, point DNS for the server's domain to the new host.
6. For private access, remove the old machine from the tailnet.
   Give the new host the same Tailscale hostname, then follow `node tools/self-host/bootstrap.mjs network`.
7. From the bundle directory, run:

```sh
node scripts/self-host/move.mjs
```

The command refuses to start anything in these cases:

- A running container on this host, such as an old server on the same host, can write the deployment's storage.
- An existing deployment volume on this host keeps its data somewhere other than the disk.
- The accounts volume is missing or holds no database.
- With an external database, the database is unreachable or holds no dohc accounts.
- `deployment.json` or the relay database is missing from the disk. The command checks through the relay's own volumes.
- Docker cannot complete one of these checks.

Otherwise it starts the deployment and runs the same checks as `node scripts/check-self-host.mjs --running`.
Use `--env-file PATH` for a different environment file.
If you changed `DOHC_DEPLOYMENT_NAME`, use that name in the accounts volume commands.

If the command refuses, check the disk mount, `DOHC_DATA_DIRECTORY` and the accounts volume.
Never recreate the disk folders, and never start the deployment on an empty folder: setup would create a new deployment.
If the relay refuses its continuity, keep the services stopped and preserve the disk.
A host that stopped during a relay write can leave that state, as described above.

Devices need no changes if two conditions hold.
The accounts must be current: the latest copy of the accounts volume from the old host, or the external database unchanged.
The server's address must resolve to the new host.
After a restore from an older backup, devices that signed in after that backup must sign in again.
Sessions revoked after that backup become valid again.

### Accounts in an external database

With [`DOHC_POSTGRES_HOST` set](self-host.md#keep-accounts-in-an-external-postgres), accounts and sign-in sessions live in your provider's database.
A move needs no accounts copy: the new host connects to the same database.
Backups of the accounts are your provider's job. The recovery commands do not save or restore them.

Restore an older backup of that database only when the current one is lost.
An older backup brings back sessions and accounts that were removed after it was taken.
It also loses accounts created after it was taken.
Those people cannot open their workspaces, even after they sign up again, because they get new accounts.
Devices that signed in after the backup must sign in again.

If the database is lost and you have no backup, the server has no accounts.
Every start after the first refuses an empty database, so the deployment does not create new accounts by mistake.
Never start it with `--first-start` to get past this check: nobody could open the workspaces on the disk as their owner.

## Verify the recovery tooling

Run focused source checks after changing this procedure's commands:

```sh
pnpm --filter @dohc/sync-relay exec vitest run src/relayDeployment.test.ts src/relayDeploymentRecovery.test.ts src/relayContentSalvage.test.ts src/relaySnapshot.test.ts src/relaySnapshotJob.test.ts
node --test scripts/self-host/recovery.test.mjs scripts/self-host/move.test.mjs scripts/self-host-compose.test.mjs
pnpm --filter @dohc/app-backend-runtime build
pnpm --filter @dohc/sync-relay build
DOHC_RECOVERY_TEST_IMAGE=YOUR_DOHC_IMAGE node --test scripts/self-host/recovery.docker.test.mjs
DOHC_RECOVERY_TEST_IMAGE=YOUR_DOHC_IMAGE node --test scripts/self-host/drill.docker.test.mjs
DOHC_SNAPSHOT_DOCKER_TEST=1 node --test scripts/self-host/snapshot.docker.test.mjs
```

The Docker tests use isolated volumes and folders and remove them afterward.
Build the image from the same checkout.
The recovery test proves cold snapshot repair after corruption, production reopen, salvage and private volume archival.
It does not prove arbitrary old-archive restoration.

The drill needs a Linux Docker host.
It hard-kills a deployment that keeps its data in a folder, then starts a fresh Compose project on that folder.
It checks that the relay reopens the same deployment without moving continuity back.
It checks that documents, blobs, shares and accounts survive, and that the relay refuses an older copy of its database.
It also checks that a missing folder fails to start and that the move command refuses an empty folder.
It checks that the move command refuses existing volumes stored elsewhere and leaves them unchanged.
It carries the accounts volume over by name, so it does not prove the accounts volume copy commands.
A killed container does not lose the host's write cache, so the drill does not prove survival of a power loss.

The snapshot test runs on any Docker host with Linux containers and needs no dohc image.
It uses the bundles that `pnpm --filter @dohc/app-backend-runtime build` and `pnpm --filter @dohc/sync-relay build` write.
It takes online snapshots through a read-only relay mount while another container keeps writing.
It checks that each snapshot holds one complete transaction and passes `check-backup`'s check.
It checks that a snapshot refuses while another container holds the snapshot lock, and runs once that container is killed.
It checks that verification without network access or deployment volumes refuses a wrong key and a changed byte, and leaves no output.
