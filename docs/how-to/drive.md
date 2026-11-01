# Run the dohc Drive server

Use this runbook to run dohc Drive's first server from a self-host release.
Drive runs the same release as any [self-hosted server](self-host.md), with the settings in [`tools/drive/drive.env.example`](../../tools/drive/drive.env.example).
[`tools/drive/drive.mjs`](../../tools/drive/drive.mjs) checks the host and then runs the release's own check, start, and move commands.
Follow the sections in order. Each step names who acts:

- **Operator**: the person who runs commands on the server and keeps its secrets.
- **Provider**: an action in the DigitalOcean, Neon, Cloudflare, Postmark, or Healthchecks.io console.
- **Approval**: a step that needs the release owner's approval before it runs. Approve each one separately.

The approval steps are the snapshot bucket lock, DNS publication, the first start, the first mail delivery test, a rebuild after total loss, each update, and each change to the sign-up list.

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
   Create it with IPv6 off. `drive.mjs` and the rehearsal refuse a host with a global IPv6 address, because Docker publishes ports 80 and 443 on IPv6 too.
   Do not create or attach a volume yet.
2. **Provider:** Create a Cloud Firewall and apply it to the Droplet:
   - Permit inbound TCP 80 and 443 only from Cloudflare's IPv4 ranges, as listed in the bundle's `tools/self-host/cloudflare-proxies.caddy`.
   - Permit inbound TCP 22 only from the operator's approved addresses.
   - Permit no other inbound traffic. Do not open UDP 443, even though Compose publishes it.
   Docker's published ports bypass ufw, so the Cloud Firewall is the origin's only filter.
   Cloudflare's ranges also admit other Cloudflare customers. The firewall does not prove that a request came through Drive's zone.
3. **Provider:** Confirm in DigitalOcean that the Cloud Firewall lists the Droplet.

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
   Keep a copy of both folders off the server. A replacement server needs the same bundle.
4. **Operator:** Load the image on the server:

   ```sh
   sudo docker image load -i /srv/dohc-release/services.tar
   ```

`drive.mjs` checks that `release.json` records a clean build for `linux/amd64`, that every bundled file is present, and that the loaded image has the recorded ID and revision.

## Rehearse on the new server

The rehearsal is the server's first step. It needs no provider accounts.
It runs before the volume, the accounts, and the configuration exist, so nothing it leaves behind can reach them.

1. **Operator:** Run the rehearsal as root:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/rehearse.mjs --bundle /srv/dohc-release --image dohc-self-host:<release-revision> \
     --output /root/dohc-rehearsal
   ```

   The rehearsal refuses a server with a global IPv6 address. It also refuses when Docker already has containers or volumes.
2. **Operator:** Read the result. The rehearsal passed when it prints `[ok]` for each check and exits with status 0.
   If a check fails, stop and report the failure before you go on.
3. **Operator:** If the rehearsal reports that cleanup left something, rebuild the server before you go on.
   Destroy the Droplet, then start again from [Prepare the server](#prepare-the-server).
   A leftover mount, loop device, container, or volume must never meet the deployment.
4. **Operator:** Copy the evidence file that the rehearsal names after `Evidence:` off the server. Then delete its folder:

   ```sh
   sudo rm -r /root/dohc-rehearsal
   ```

   The evidence file holds the rehearsal's commands and assertions. It holds no secrets.

The rehearsal uses loop-device volumes with real filesystem UUIDs, a local CA, and a TLS-only Postgres from `tools/drive/compose.rehearsal.yml` in place of Neon.
It checks:

- `drive.mjs check`, `start`, and `start --first-start` against a mounted and an unmounted volume.
- Migrations refuse a database certificate from another CA, and a database name that its certificate does not cover.
- The first start passes every release check except the two public HTTPS checks, including the server automations check.
- The app domain's certificate, routing, and refusals at the gateway.
- `drive.mjs move` refusals: a running deployment, a wrong UUID, a detached volume, a mount point that is not empty, and a volume with empty deployment folders.
- A move that mounts the volume by UUID and continues the same relay deployment and accounts.
- No command or output shows a secret.

The release check's public HTTPS steps need public DNS and a browser-trusted viewer certificate, so the rehearsal expects only those steps to fail.
The release has no setting to trust a local CA for mail, snapshot storage, or the heartbeat, so the rehearsal does not test them.
It also does not test a valid app launch or live editing in a browser.
[Accept the server](#accept-the-server) tests each of these with the real providers.
The rehearsal does not prove Neon's certificate chain, Cloudflare edge behavior, the viewer's certificate through Cloudflare, DigitalOcean firewall enforcement, volume attachment, power-loss durability, or an R2 bucket lock.

## Prepare the volume

1. **Provider:** Create a volume in the same datacenter and attach it to the Droplet.
   Attach no other copy of it. `drive.mjs` refuses when two attached devices have the volume's filesystem UUID, as a restored volume snapshot does.

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
4. **Operator:** Mount the volume by its UUID, and make the mount persist.
   The mount options make Docker wait for the volume at boot, and fail to start without it:

   ```sh
   sudo install -d -m 0755 /mnt/dohc-drive
   echo 'UUID=<volume-uuid> /mnt/dohc-drive ext4 defaults,nofail,noatime,nodev,nosuid,noexec,x-systemd.before=docker.service,x-systemd.required-by=docker.service 0 2' | sudo tee -a /etc/fstab
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

## Set up the providers

Do these steps before the configuration and the first start. The configuration needs their values, and the first start uses each of them.

### Accounts in Neon

1. **Provider:** Create a Neon project in AWS us-east-1 with Postgres 17, a database for Drive only, and a role that owns it.
2. **Provider:** Use the project's direct endpoint as `DOHC_POSTGRES_HOST`, not the pooled endpoint, whose host name contains `-pooler`.
3. **Operator:** Install Neon's CA file on the server. `drive.mjs` requires root as its owner and mode 0644:

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
2. **Operator:** Check the connection from the Droplet:

   ```sh
   openssl s_client -starttls smtp -connect smtp.postmarkapp.com:2525 -servername smtp.postmarkapp.com \
     -verify_hostname smtp.postmarkapp.com -verify_return_error </dev/null
   ```

   The check passed when the output shows `Verify return code: 0 (ok)`.
   If the certificate or its host name fails verification, `openssl` stops with an error and no session.

The first delivery test comes after the first start, in [Accept the server](#accept-the-server).

### Snapshot storage and heartbeat

The job takes its first snapshot as soon as the relay is healthy after the first start. Create its bucket, lock, and check first.

1. **Provider:** Create a private R2 bucket and a lifecycle rule that deletes objects 30 days after creation.
2. **Approval:** Add an R2 bucket lock rule of 30 days. A locked snapshot cannot be deleted before the lock ends.
3. **Provider:** Create an R2 token with Object Read & Write permission for that bucket only.
   R2 tokens cannot be limited to writing. The bucket lock keeps a token on a compromised server from deleting snapshots.
4. **Provider:** Create a Healthchecks.io check with a period of 1 hour. Send its alerts to the operator.

The job takes a snapshot every hour after the first, and pings Healthchecks.io only after an upload succeeds.
A failed snapshot emails `DOHC_SNAPSHOT_ALERT_EMAIL` at most once a day.
Missing pings show a job that stopped or cannot email.
See [Take hourly off-site snapshots](self-host-recovery.md#take-hourly-off-site-snapshots) and [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot).

Snapshots omit accounts, host data, the configuration, and continuity.
An old snapshot supports file salvage. It does not restore a server.

### App certificate

1. **Provider:** Create a Cloudflare Origin CA certificate for `*.dohc.app`, and install it as described in [Serve published apps behind Cloudflare](self-host.md#serve-published-apps-behind-cloudflare).
   `drive.mjs` requires root as the owner of both files, with mode 0644 for the certificate and 0600 for the key.

The Origin CA certificate serves only the app hosts. It is not the edge certificate, and browsers do not trust it.

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

   Keep each value on one line. `drive.mjs` refuses a secret setting that spans lines, because it could not hide that secret in its output.
4. **Operator:** Copy `/etc/dohc/drive.env` to the operator's password manager, as described in the next section.

### Keep the keys away from the server

**Operator:** Keep a copy of `/etc/dohc/drive.env` in the operator's password manager.
After each change to `/etc/dohc/drive.env`, replace the copy. Each step that changes the file says so.
Check that the copy holds `DOHC_SNAPSHOT_KEY` and `DOHC_RELAY_LINK_KEY`.
Without the snapshot key, nobody can open a snapshot.
The release cannot rotate the relay link key, and a replacement server needs the same key to continue the deployment.
A replacement server uses this copy. An old copy can name an older image than the data needs.
Keep both keys out of evidence, logs, and public text.

### Choose who can sign up

Drive keeps sign-up private. `drive.mjs` refuses an empty `DOHC_SIGN_UP_EMAILS`.
The server also accepts an address that has a pending share invite.
A share sent to an address without an account creates that invite. Revoking the share removes it.
See [Choose who can create an account](self-host.md#choose-who-can-create-an-account).

**Approval:** Each change to `DOHC_SIGN_UP_EMAILS` needs approval. Stop and start the deployment to apply it.
Then replace the password manager copy of `/etc/dohc/drive.env`.

## Publish DNS and TLS

These steps make the server reachable. **Approval:** Do them only after approval.

1. **Provider:** In Cloudflare, add a proxied A record for `drive.dohc.computer` with the Droplet's IPv4 address.
2. **Provider:** Add a proxied A record for `*.dohc.app` with the same address. Add no AAAA record for either name.
   Use the `dohc.app` apex for published apps only.
3. **Provider:** Set the SSL/TLS encryption mode to Full (strict) for both zones. Universal SSL covers both names at the edge.
4. **Provider:** Bypass the cache for both names. Turn off bot challenges for both names.
5. **Provider:** Keep Always Use HTTPS off for `drive.dohc.computer`, or exclude `/.well-known/acme-challenge/*` with a rule.
   Caddy gets the viewer's certificate through a challenge on port 80, and redirects every other HTTP request itself.

The viewer's certificate path through Cloudflare is not yet proven.
The first start must show that Caddy obtains it through proxied port 80. Renewal must work the same way.
If it does not, stop and report before changing the certificate setup.

## Check and start

1. **Operator:** Run the check. It changes nothing:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs check --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   `drive.mjs` checks the release, the configuration file's owner and mode, the Drive settings, the CA and app certificate files, the image, and IPv6.
   It checks that one attached device has `<volume-uuid>`, that it is mounted at `/mnt/dohc-drive`, and the four folders' owner, mode, and filesystem.
   It then runs the release's `scripts/check-self-host.mjs`, which validates the settings and the Compose configuration.
   The check passed when it ends with `Self-host check summary` and equal numbers.
2. **Approval:** Start the deployment for the first time, only after approval:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs start --first-start --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   Before it starts anything, `drive.mjs` asks Neon whether it holds dohc accounts, and refuses if it does.
   A first start under existing accounts would create a deployment that none of them can use.
   The release then refuses a first start when any deployment folder holds data.
   Every later start uses `start` without `--first-start`. `drive.mjs` never adds it.

### Check that only Cloudflare reaches the origin

Do this after the first start and after each move.

1. **Operator:** From a host outside Cloudflare and outside the approved SSH addresses, connect to the Droplet's IPv4 address:

   ```sh
   curl -sk --connect-timeout 5 https://<droplet-ipv4>/
   curl -s --connect-timeout 5 http://<droplet-ipv4>/
   nc -vz -w 5 <droplet-ipv4> 22
   ```

   Each command must time out. `curl` exits with status 28 when it times out.
2. **Provider:** Confirm in DigitalOcean that the Cloud Firewall lists the Droplet.

If any command connects, apply the Cloud Firewall to the Droplet at once, then check again.

## Accept the server

The rehearsal cannot test mail, snapshots, the heartbeat, a published app, or live editing. Test them here with the real providers.
Do the steps in order. If a step fails, stop and report it.

1. **Operator:** [Check that only Cloudflare reaches the origin](#check-that-only-cloudflare-reaches-the-origin).
2. **Approval:** Send the first delivery test only after approval. Create a test account with an approved address, and check that its email arrives.
3. **Operator:** From a desktop connected to Drive, share a document with an Edit link. Open the link in two browsers.
   Edit the document in each browser. Each edit must appear in the other browser without a reload.
   Repeat with a named recipient who signs in.
   The release check proves the connection descriptor, not live editing.
4. **Operator:** Publish a small app to Drive from the desktop, and open its share link in a browser.
   The app opens on a host under `dohc.app`. In the browser's developer tools, check the first response from that host:
   - `Set-Cookie` names `__Host-dohc-app`, with `Secure`, `HttpOnly`, and `SameSite=Strict`.
   - `Cache-Control` is `private, no-store`.
   - `Content-Security-Policy` is present. `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are `same-origin`.
   - `cf-cache-status` is not `HIT`.
5. **Operator:** Verify the first snapshot with the key from the password manager, on a Linux host other than the Droplet.
   The host needs the same release bundle and its loaded image. Wait until Healthchecks.io shows the first ping.
   1. Write the password manager copy of `drive.env` to `$HOME/drive-check/drive.env`, with mode 0600.
   2. Download the newest snapshot from the R2 bucket into `$HOME/drive-check/offsite`.
   3. Verify it, as in [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot):

      ```sh
      cd <release-bundle>
      node scripts/self-host/recovery.mjs verify "$HOME/drive-check/verified" --snapshot "$HOME/drive-check/offsite/<snapshot-file>" \
        --env-file "$HOME/drive-check/drive.env"
      ```

      The command must report the snapshot's namespace, stamp, and time. A wrong or truncated key fails here.
   4. Delete the folder. It holds the configuration and unencrypted workspace data:

      ```sh
      rm -r "$HOME/drive-check"
      ```

6. **Operator:** Stop the snapshot job on the Droplet:

   ```sh
   sudo docker stop $(sudo docker ps --quiet --filter label=com.docker.compose.service=relay-snapshot)
   ```

   Wait until Healthchecks.io marks the check down and alerts the operator. This takes up to 1 hour plus the check's grace time.
7. **Operator:** Start the snapshot job again:

   ```sh
   sudo docker start $(sudo docker ps --all --quiet --filter label=com.docker.compose.service=relay-snapshot)
   ```

   The job takes a snapshot when it starts. Healthchecks.io must mark the check up after its ping.

The server is accepted when every step passes. Record the results with the release revision.

## Replace a dead server

Use this procedure when the Droplet fails and its volume survives.
The replacement continues from the last write on the volume. Nothing is rolled back.

Never restore a DigitalOcean volume snapshot, and never copy the volume.
A copy rolls back the relay database and its continuity record together, and the relay cannot detect that.

1. **Operator:** Fence the old Droplet:
   - Power it off in DigitalOcean, and detach the volume.
   - Reset the Neon role's password, so the old server's sign-in service cannot use the database.
   - Confirm in DigitalOcean that the old Droplet is off and the volume has no attachment.
2. **Provider:** Create a replacement Droplet as in [Prepare the server](#prepare-the-server), with IPv6 off and the same Cloud Firewall.
3. **Provider:** Attach the volume to the replacement Droplet. Attach no copy of it. `drive.mjs` never attaches a volume.
4. **Operator:** Copy the release bundle from the last approved update and the Drive recipe from the same commit to the replacement. Load its image.
5. **Operator:** Restore `/etc/dohc/drive.env` from the password manager, with root as owner and mode 0600.
   Set the new Neon password in `POSTGRES_PASSWORD`. Keep every other value, including the origin and all keys.
   Then replace the password manager copy.
6. **Operator:** Install the Neon CA file and the app certificate and key at the same paths, with the same owner and modes.
7. **Operator:** Create the empty mount point, and add the same `/etc/fstab` line as in [Prepare a new volume](#prepare-a-new-volume):

   ```sh
   sudo install -d -m 0755 /mnt/dohc-drive
   ```

8. **Approval:** Point both A records at the replacement's IPv4 address.
9. **Operator:** Run the move:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs move --bundle /srv/dohc-release --env-file /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

10. **Operator:** [Check that only Cloudflare reaches the origin](#check-that-only-cloudflare-reaches-the-origin).

The move mounts the volume by `<volume-uuid>` at `/mnt/dohc-drive` if it is not mounted.
It refuses when no attached volume has that UUID, when two attached devices have it, when the mount point is missing or not empty, or when another filesystem is mounted there.
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
`drive.mjs start --first-start` refuses while Neon holds dohc accounts.

## Update the server

**Approval:** Each update needs approval.

1. **Operator:** Run `drive.mjs check` with the current bundle. Update only a server that passes it.
2. **Operator:** Build the new release and copy the Drive recipe from the same commit, as in [Build and copy the release](#build-and-copy-the-release).
3. **Provider:** If the new bundle's `tools/self-host/cloudflare-proxies.caddy` changed, update the Cloud Firewall's Cloudflare ranges to match.
4. **Operator:** Follow [Back up and maintain the deployment](self-host.md#back-up-and-maintain-the-deployment), using `--env-file /etc/dohc/drive.env`.
5. **Operator:** Run `drive.mjs check` with the new bundle.
6. **Operator:** Replace the password manager copy of `/etc/dohc/drive.env`. The upgrade changes `DOHC_IMAGE`.

## Clean up

- Delete downloaded snapshots, verified copies, and salvage output after use. They hold unencrypted workspace data.
- After a move passes its checks, destroy the old Droplet. Never destroy or reformat the volume.
- Keep the previous release bundle until the next update passes its checks.
