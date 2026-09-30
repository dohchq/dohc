# Back up and recover a self-hosted server

Use this procedure to preserve a deployment or recover files after a storage failure.
Run commands from the extracted self-host release directory or repository root.
Use the same environment file and Compose overrides as your running deployment.

## Choose the recovery operation

| Operation | What it preserves or restores | Limit |
| --- | --- | --- |
| `backup` | A standalone relay database and checksum manifest | Does not include authentication, live-host data, configuration or continuity |
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
pnpm --filter @dohc/sync-relay exec vitest run src/relayDeployment.test.ts src/relayDeploymentRecovery.test.ts src/relayContentSalvage.test.ts
node --test scripts/self-host/recovery.test.mjs
pnpm --filter @dohc/sync-relay build
DOHC_RECOVERY_TEST_IMAGE=YOUR_DOHC_IMAGE node --test scripts/self-host/recovery.docker.test.mjs
```

The Docker test uses isolated volumes and removes them afterward.
It proves cold snapshot repair after corruption, production reopen, salvage and private volume archival.
It does not prove arbitrary old-archive restoration or recovery of a lost physical host.
