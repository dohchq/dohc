# Run the dohc Drive server

Use this runbook to run dohc Drive's first server from a self-host release.
Drive runs the same release as any [self-hosted server](self-host.md), with the settings in [`tools/drive/drive.env.example`](../../tools/drive/drive.env.example).
[`tools/drive/drive.mjs`](../../tools/drive/drive.mjs) checks the host and then runs the release's own check, start, and move commands.

Each step names who acts:

- **Operator**: the person who runs commands on the server and keeps its secrets.
- **Provider**: an action in the DigitalOcean, Neon, Cloudflare, Postmark, or Healthchecks.io console.
- **Approval**: a step that needs the release owner's approval before it runs. Approve each one separately.

The approval steps are the first start, DNS publication, the snapshot bucket lock, the first mail delivery test, a rebuild after total loss, each update, and each change to the sign-up list.

## What Drive uses

| Part | Service |
| --- | --- |
| Server | A DigitalOcean Droplet in New York, with IPv4 only |
| Relay data | One DigitalOcean volume in the same datacenter, mounted by its filesystem UUID |
| Accounts | Neon Postgres 17 in AWS us-east-1, through its direct endpoint |
| Edge | Cloudflare, proxying `drive.dohc.computer` and `*.dohc.app` |
| Mail | Postmark SMTP on port 2525 with STARTTLS |
| Snapshots | Cloudflare R2, with a Healthchecks.io heartbeat |

The server's origin is `https://drive.dohc.computer`.
The relay accepts live editing on `drive.dohc.computer,sync-relay:1788`. The release derives that list from `DOHC_PUBLIC_HOST`.
Published apps use the app domain `dohc.app`.

## Prepare the server

1. **Provider:** Create a Droplet in a New York datacenter with Docker, Docker Compose 2.24.4 or newer, and Node.js 24.16 or newer.
   Keep IPv6 off. `drive.mjs` refuses a host with a public IPv6 address, because Docker publishes ports 80 and 443 on IPv6 too.
2. **Provider:** Create a Cloud Firewall and apply it to the Droplet:
   - Permit inbound TCP 80 and 443 only from Cloudflare's IPv4 ranges, as listed in the bundle's `tools/self-host/cloudflare-proxies.caddy`.
   - Permit inbound TCP 22 only from the operator's approved addresses.
   - Permit no other inbound traffic. Do not open UDP 443, even though Compose publishes it.
   Docker's published ports bypass ufw, so the Cloud Firewall is the origin's only filter.
   Cloudflare's ranges also admit other Cloudflare customers. The firewall does not prove that a request came through Drive's zone.
3. **Provider:** Create a volume in the same datacenter and attach it to the Droplet.

### Prepare a new volume

Do these steps once, for a new and empty volume only.
Never format a volume that could hold a deployment. `drive.mjs` never formats a disk.

1. **Operator:** Find the volume and its device:

   ```sh
   lsblk -o NAME,SIZE,FSTYPE,UUID,MOUNTPOINT
   ```

2. **Operator:** If the new volume has no filesystem, format it as ext4. Replace `<volume-device>` with its device, such as `/dev/sda`:

   ```sh
   sudo mkfs.ext4 -L dohc-drive <volume-device>
   ```

3. **Operator:** Record the volume's filesystem UUID from `lsblk`. This runbook calls it `<volume-uuid>`. Keep it with the server's private notes.
4. **Operator:** Mount the volume by its UUID, and make the mount persist:

   ```sh
   sudo install -d -m 0755 /mnt/dohc-drive
   echo 'UUID=<volume-uuid> /mnt/dohc-drive ext4 defaults,nofail,noatime,nodev,nosuid,noexec,x-systemd.before=docker.service 0 2' | sudo tee -a /etc/fstab
   sudo mount /mnt/dohc-drive
   findmnt -o TARGET,SOURCE,UUID /mnt/dohc-drive
   ```

   `findmnt` must show `<volume-uuid>`. If it shows another UUID or nothing, stop and check the volume.
5. **Operator:** Create the deployment folders on the mounted volume. The services run as UID 1000:

   ```sh
   sudo install -d -m 0700 -o 1000 -g 1000 /mnt/dohc-drive/dohc/sync-relay /mnt/dohc-drive/dohc/continuity \
     /mnt/dohc-drive/dohc/host-data /mnt/dohc-drive/dohc/snapshots
   ```

Create these folders only here. After the first start, a missing folder means the wrong volume. Recreating it would start an empty deployment.

## Build and copy the release

1. **Operator:** On a build machine, check out the release commit and build the bundle as described in [Build the deployment bundle](self-host.md#build-the-deployment-bundle):

   ```sh
   node tools/self-host/release.mjs --image dohc-self-host:<release-revision> --output ../dohc-release --archive
   ```

   Use the full commit ID as `<release-revision>`. `drive.mjs` refuses a bundle built from uncommitted source.
2. **Operator:** Copy the Drive recipe from the same commit beside the bundle:

   ```sh
   mkdir ../dohc-drive
   git archive <release-revision> tools/drive docs/how-to/drive.md | tar -x -C ../dohc-drive
   ```

3. **Operator:** Copy both folders to the server, at `/srv/dohc-release` and `/srv/dohc-drive`.
4. **Operator:** Load the image on the server:

   ```sh
   sudo docker image load -i /srv/dohc-release/services.tar
   ```

`drive.mjs` checks that `release.json` records a clean build for `linux/amd64`, that every bundled file is present, and that the loaded image has the recorded ID and revision.

## Create the configuration

1. **Operator:** Create the configuration with fresh secrets:

   ```sh
   cd /srv/dohc-release
   sudo install -d -m 0755 /etc/dohc
   sudo node tools/self-host/bootstrap.mjs init --origin https://drive.dohc.computer --name "dohc Drive" \
     --image dohc-self-host:<release-revision> --env-file /etc/dohc/drive.env
   ```

   The file belongs to root and has mode 0600. `drive.mjs` refuses it with any other owner or mode.
2. **Operator:** Copy each value from `/srv/dohc-drive/tools/drive/drive.env.example` into `/etc/dohc/drive.env`, and replace each placeholder.
3. **Operator:** Add the credentials to `/etc/dohc/drive.env` on the server only. Never put them in the repository, a ticket, or a chat:
   - `POSTGRES_PASSWORD`: the Neon role's password, in single quotes.
   - `DOHC_SMTP_USER` and `DOHC_SMTP_PASSWORD`: the Postmark server token, in both settings.
   - `DOHC_SNAPSHOT_S3_ACCESS_KEY_ID` and `DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY`: the R2 token for the snapshot bucket.
   - `DOHC_SNAPSHOT_ALERT_EMAIL`: the operator address for snapshot failures.
   - `DOHC_SNAPSHOT_HEARTBEAT_URL`: the Healthchecks.io ping URL.
   - `DOHC_SIGN_UP_EMAILS`: the approved addresses.

### Keep the keys away from the server

**Operator:** Copy `/etc/dohc/drive.env` to the operator's password manager before the first start.
Check that the copy holds `DOHC_SNAPSHOT_KEY` and `DOHC_RELAY_LINK_KEY`.
Without the snapshot key, nobody can open a snapshot.
The release cannot rotate the relay link key, and a replacement server needs the same key to continue the deployment.
Keep both keys out of evidence, logs, and public text.

### Accounts in Neon

1. **Provider:** Create a Neon project in AWS us-east-1 with Postgres 17, a database for Drive only, and a role that owns it.
2. **Provider:** Use the project's direct endpoint as `DOHC_POSTGRES_HOST`, not the pooled endpoint, whose host name contains `-pooler`.
3. **Operator:** Install Neon's CA file on the server:

   ```sh
   sudo install -D -m 0644 isrg-root-x1.pem /etc/dohc/postgres-ca.pem
   ```

The release connects to an external database only with `sslmode=verify-full`, so it needs a CA file to check Neon's certificate and host name.
Neon's certificates chain to ISRG Root X1.
Download its PEM from the link in Neon's [secure connections guide](https://neon.com/docs/connect/connect-securely).
The release has no setting to skip this check.

Neon's backups are the only backups of Drive's accounts.
Restore an older Neon state only when the current database is lost.
An older state brings back sessions that were revoked after it. Revoke them again after such a restore.

### Mail through Postmark

DigitalOcean blocks outbound ports 25, 465, and 587 on new Droplets.
Postmark accepts STARTTLS on port 2525, so Drive sends mail through `smtp.postmarkapp.com` on port 2525 with `DOHC_SMTP_SECURE=false`.
The release's mail sender requires STARTTLS for a remote host when `DOHC_SMTP_SECURE=false`, so mail is never sent unencrypted.

1. **Provider:** In Postmark, verify the sender domain `drive.dohc.computer` and create a server token.
2. **Operator:** Check the connection from the Droplet. The output must show the server's certificate after STARTTLS:

   ```sh
   openssl s_client -starttls smtp -connect smtp.postmarkapp.com:2525 -crlf -quit
   ```

3. **Approval:** Send the first delivery test only after approval. Create a test account with an approved address, and check that its email arrives.

### Choose who can sign up

Drive keeps sign-up private. `drive.mjs` refuses an empty `DOHC_SIGN_UP_EMAILS`.
The server also accepts an address that has a pending share invite.
A share sent to an address without an account creates that invite. Revoking the share removes it.
See [Choose who can create an account](self-host.md#choose-who-can-create-an-account).

**Approval:** Each change to `DOHC_SIGN_UP_EMAILS` needs approval. Stop and start the deployment to apply it.

## Publish DNS and TLS

These steps make the server reachable. **Approval:** Do them only after approval.

1. **Provider:** In Cloudflare, add a proxied A record for `drive.dohc.computer` with the Droplet's IPv4 address.
2. **Provider:** Add a proxied A record for `*.dohc.app` with the same address. Add no AAAA record for either name.
   Use the `dohc.app` apex for published apps only.
3. **Provider:** Set the SSL/TLS encryption mode to Full (strict) for both zones. Universal SSL covers both names at the edge.
4. **Provider:** Create a Cloudflare Origin CA certificate for `*.dohc.app`, and install it as described in [Serve published apps behind Cloudflare](self-host.md#serve-published-apps-behind-cloudflare).
   The Origin CA certificate serves only the app hosts. It is not the edge certificate, and browsers do not trust it.
5. **Provider:** Bypass the cache for both names. Turn off bot challenges for both names.
6. **Provider:** Keep Always Use HTTPS off for `drive.dohc.computer`, or exclude `/.well-known/acme-challenge/*` with a rule.
   Caddy gets the viewer's certificate through a challenge on port 80, and redirects every other HTTP request itself.

The viewer's certificate path through Cloudflare is not yet proven.
The first rehearsal on a real Droplet must show that Caddy obtains and renews it through proxied port 80.
If it does not, stop and report before changing the certificate setup.

## Check and start

1. **Operator:** Run the check. It changes nothing:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs check --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   `drive.mjs` checks the release, the configuration file's owner and mode, the Drive settings, the CA and app certificate files, the image, IPv6, the volume's UUID at `/mnt/dohc-drive`, and the four folders' owner, mode, and filesystem.
   It then runs the release's `scripts/check-self-host.mjs`, which validates the settings and the Compose configuration.
   The check passed when it ends with `Self-host check summary` and equal numbers.
2. **Approval:** Start the deployment for the first time, only after approval:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs start --first-start --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   The release refuses a first start when any deployment folder holds data.
   Every later start uses `start` without `--first-start`. `drive.mjs` never adds it.
3. **Operator:** After DNS is live, open an Edit link and share a document with a named recipient. Edit it live in a real browser.
   The release check proves the connection descriptor, not live editing.

## Take hourly snapshots

1. **Provider:** Create a private R2 bucket and a lifecycle rule that deletes objects 30 days after creation.
2. **Approval:** Add an R2 bucket lock rule of 30 days. A locked snapshot cannot be deleted before the lock ends.
3. **Provider:** Create an R2 token with Object Read & Write permission for that bucket only.
   R2 tokens cannot be limited to writing. The bucket lock keeps a token on a compromised server from deleting snapshots.
4. **Provider:** Create a Healthchecks.io check with a period of 1 hour. Send its alerts to the operator.

The snapshot settings come from `drive.env.example` and the credentials step above.
The job takes a snapshot after the relay is healthy, then one every hour, and pings Healthchecks.io only after an upload succeeds.
A failed snapshot emails `DOHC_SNAPSHOT_ALERT_EMAIL` at most once a day.
Missing pings show a job that stopped or cannot email.
See [Take hourly off-site snapshots](self-host-recovery.md#take-hourly-off-site-snapshots) and [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot).

Snapshots omit accounts, host data, the configuration, and continuity.
An old snapshot supports file salvage. It does not restore a server.

## Replace a dead server

Use this procedure when the Droplet fails and its volume survives.
The replacement continues from the last write on the volume. Nothing is rolled back.

Never restore a DigitalOcean volume snapshot, and never copy the volume.
A copy rolls back the relay database and its continuity record together, and the relay cannot detect that.

1. **Operator:** Fence the old Droplet:
   - Power it off in DigitalOcean, and detach the volume.
   - Reset the Neon role's password, so the old server's sign-in service cannot use the database.
   - Confirm in DigitalOcean that the old Droplet is off and the volume has no attachment.
2. **Provider:** Create a replacement Droplet in the same New York datacenter, prepared as in [Prepare the server](#prepare-the-server). Apply the same Cloud Firewall.
3. **Provider:** Attach the volume to the replacement Droplet. `drive.mjs` never attaches a volume.
4. **Operator:** Copy the same release bundle and Drive recipe to the replacement, and load the same image.
5. **Operator:** Restore `/etc/dohc/drive.env` from the password manager, with root as owner and mode 0600.
   Set the new Neon password in `POSTGRES_PASSWORD`. Keep every other value, including the origin and all keys.
6. **Operator:** Install the Neon CA file and the app certificate and key at the same paths.
7. **Operator:** Create the empty mount point, and add the same `/etc/fstab` line as in [Prepare a new volume](#prepare-a-new-volume):

   ```sh
   sudo install -d -m 0755 /mnt/dohc-drive
   ```

8. **Approval:** Point both A records at the replacement's IPv4 address.
9. **Operator:** Run the move:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs move --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

The move mounts the volume by `<volume-uuid>` at `/mnt/dohc-drive` if it is not mounted.
It refuses when no attached volume has that UUID, when the mount point is missing or not empty, or when another filesystem is mounted there.
It refuses when a deployment folder is missing, and never creates one.
The release move then refuses when a running container can write the deployment's storage, when Neon holds no dohc accounts, or when the relay deployment is missing from the volume.
Otherwise it starts the deployment and runs the release checks.

The replacement keeps the same origin, relay link key, snapshot key, sign-in and exchange secrets, Neon database, and image.
Devices need no changes.

## Recover from total loss

If the volume is lost, Drive cannot restore its server.
Salvage the files from the latest snapshot:

1. **Operator:** Download the latest snapshot from R2 to a private folder on a host with the release image.
2. **Operator:** Verify it with the snapshot key, as in [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot).
3. **Operator:** Export its files, as in [Salvage portable files from an old snapshot](self-host-recovery.md#salvage-portable-files-from-an-old-snapshot).

**Approval:** A new deployment after total loss is a rebuild. Plan it, including what happens to the Neon database, and get approval before any first start.

## Update the server

**Approval:** Each update needs approval.
Build the new release and copy the Drive recipe from the same commit, as in [Build and copy the release](#build-and-copy-the-release).
Follow [Back up and maintain the deployment](self-host.md#back-up-and-maintain-the-deployment), using `--env-file /etc/dohc/drive.env`.
Run `drive.mjs check` with the new bundle after the upgrade.

## Clean up

- Delete downloaded snapshots, verified copies, and salvage output after use. They hold unencrypted workspace data.
- After a move passes its checks, destroy the old Droplet. Never destroy or reformat the volume.
- Keep the previous release bundle until the next update passes its checks.

## Rehearse without accounts

`tools/drive/rehearse.mjs` runs the recipe on a disposable Linux VM with IPv4 only.
Run it as root from a checkout of the release commit, with the release bundle and its loaded image:

```sh
sudo node tools/drive/rehearse.mjs --bundle /srv/recipe-bundle --image dohc-self-host:recipe --output /srv/recipe-evidence
```

The rehearsal uses loop-device volumes with real filesystem UUIDs, a local CA, and a TLS-only Postgres from `tools/drive/compose.rehearsal.yml` in place of Neon.
It checks:

- `drive.mjs check`, `start`, and `start --first-start` against a mounted and an unmounted volume.
- Migrations refuse a database certificate from another CA, and a database name that its certificate does not cover.
- The app domain's certificate, routing, and refusals at the gateway.
- `drive.mjs move` refusals: a running deployment, a wrong UUID, a detached volume, a mount point that is not empty, and a volume with empty deployment folders.
- A move that mounts the volume by UUID and continues the same relay deployment and accounts.
- No command or output shows a secret.

It writes its commands and assertions to a JSON file in the output folder, and removes everything else it created.

The release check's public HTTPS steps need public DNS and a browser-trusted viewer certificate, so the rehearsal expects only those steps to fail.
The release has no setting to trust a local CA for mail, snapshot storage, or the heartbeat.
The rehearsal therefore does not test mail delivery, snapshot upload, or the heartbeat. The snapshot Docker test covers the snapshot job against a local store.
It also does not test live editing in a browser.

The rehearsal does not prove Neon's certificate chain, Postmark delivery, Cloudflare edge behavior, the viewer's certificate through Cloudflare, DigitalOcean firewall enforcement, volume attachment, power-loss durability, or an R2 bucket lock.
Those need checks against the real providers and a rehearsal on a real Droplet.
