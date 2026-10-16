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

The relay keeps an independent continuity record outside its database volume.
Every accepted mutation advances that record, including permission changes and schema migrations.
A database with an older stamp cannot start against the current record.
This prevents a restored backup from resurrecting revoked access.

Never replace current continuity with an older archived copy.
An archive does not prove that its server accepted no later work.
Losing the original continuity prevents supported deployment restoration.
You can still salvage available file contents from a completed relay snapshot.
An interrupted write can reserve a continuity stamp before the relay transaction commits.
That state also refuses startup and cannot be repaired from an older snapshot.
Preserve its volumes.
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
The shared configuration reader includes the private-network overlay automatically.

## Take hourly off-site snapshots

The `relay-snapshot` service copies the relay database every hour while the server keeps running.
It opens the database read-only and does not mount continuity.
It encrypts each copy and uploads it to an S3-compatible bucket, such as Cloudflare R2 or Amazon S3.
The service stays off until you configure the bucket.

1. Create a private bucket for snapshots.
2. Add a bucket lifecycle rule that deletes objects 30 days after creation.
   The job never deletes snapshots, so the lifecycle rule controls retention.
3. Create credentials that can write objects to that bucket.
   The job does not read, list or delete objects.
4. Set these values in `.env.self-host`:

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

5. Stop and start the deployment:

```sh
node tools/self-host/bootstrap.mjs stop
node tools/self-host/bootstrap.mjs start
```

The job takes the first snapshot after the relay is healthy, then one every hour.
Each upload uses a new object name under the deployment's namespace.
An interrupted upload leaves no object under its name.
A single upload is limited to 5 GB. A larger snapshot fails; save it with `snapshot` instead.

If a snapshot fails, the job emails `DOHC_SNAPSHOT_ALERT_EMAIL` through the server's SMTP settings.
It sends at most one failure email a day, and one email when snapshots work again.
It keeps this record in the `dohc_self_host_snapshots` volume, so restarts do not repeat the email.
A stopped job cannot send email.
To detect that, set `DOHC_SNAPSHOT_HEARTBEAT_URL` to an HTTPS monitoring URL.
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
If you replace the key, keep the old key until the lifecycle rule deletes its snapshots.

## Save an encrypted snapshot locally

```sh
node scripts/self-host/recovery.mjs snapshot /srv/dohc-backups/offsite
```

The command writes the same encrypted package that the hourly job uploads.
The services keep running.
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

An hourly snapshot does not include authentication, live-host data, configuration or continuity.
Server accounts are stored in Postgres and need a separate backup.
Repair with `restore` still requires the snapshot stamp to equal current continuity.
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

The check requires the snapshot stamp to equal the current continuity stamp.
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

## Verify the recovery tooling

Run focused source checks after changing this procedure's commands:

```sh
pnpm --filter @dohc/sync-relay exec vitest run src/relayDeployment.test.ts src/relayDeploymentRecovery.test.ts src/relayContentSalvage.test.ts src/relaySnapshot.test.ts src/relaySnapshotJob.test.ts
node --test scripts/self-host/recovery.test.mjs scripts/self-host-compose.test.mjs
pnpm --filter @dohc/sync-relay build
DOHC_RECOVERY_TEST_IMAGE=YOUR_DOHC_IMAGE node --test scripts/self-host/recovery.docker.test.mjs
```

The Docker test uses isolated volumes and removes them afterward.
It proves cold snapshot repair after corruption, production reopen, salvage and private volume archival.
It does not prove arbitrary old-archive restoration or recovery of a lost physical host.
