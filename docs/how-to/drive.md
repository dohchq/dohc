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
| Disk watch | A second Healthchecks.io check, pinged every hour while the volume is less than 70% full |

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

1. **Operator:** Run the rehearsal as root, in a session that survives a dropped connection, such as `tmux`:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/rehearse.mjs --bundle /srv/dohc-release --image dohc-self-host:<release-revision> \
     --output /root/dohc-rehearsal
   ```

   The rehearsal refuses a server with a global IPv6 address. It also refuses when Docker already has containers or volumes.
2. **Operator:** Read the result. The rehearsal passed when it prints `[ok]` for each check and exits with status 0.
   If a check fails, stop and report the failure before you go on.
3. **Operator:** Rebuild the server before you go on if the rehearsal reports that cleanup left something, does not exit with status 0, or stops before it prints `Evidence:`.
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
5. **Provider:** Create a second Healthchecks.io check for the disk, with a period of 1 hour. Send its alerts to the operator.

The job takes a snapshot every hour after the first, and pings Healthchecks.io only after an upload succeeds.
A failed snapshot emails `DOHC_SNAPSHOT_ALERT_EMAIL` at most once a day.
Missing pings show a job that stopped or cannot email.
See [Take hourly off-site snapshots](self-host-recovery.md#take-hourly-off-site-snapshots) and [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot).

Snapshots omit accounts, host data, the configuration, and continuity.
An old snapshot supports file salvage. It does not restore a server.

No setting limits how much one account stores, so the disk check warns the operator before the volume fills.
Every hour, `drive.mjs disk-watch` pings the disk check while the volume is less than 70% full.
When the volume is 70% full or more, or is not mounted, it reports a failure, and Healthchecks.io alerts the operator at once.
Missing pings show a watch that stopped.

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
     --image dohc-self-host:<release-revision> --env-path /etc/dohc/drive.env
   ```

   The file belongs to root and has mode 0600. `drive.mjs` refuses it with any other owner or mode.
2. **Operator:** Copy each value from `/srv/dohc-drive/tools/drive/drive.env.example` into `/etc/dohc/drive.env`, and replace each placeholder.
3. **Operator:** Add the credentials to `/etc/dohc/drive.env` on the server only. Never put them in the repository, a ticket, or a chat:
   - `POSTGRES_PASSWORD`: the Neon role's password, in single quotes.
   - `DOHC_SMTP_USER` and `DOHC_SMTP_PASSWORD`: the Postmark server token, in both settings.
   - `DOHC_SNAPSHOT_S3_ACCESS_KEY_ID` and `DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY`: the R2 token for the snapshot bucket.
   - `DOHC_SNAPSHOT_ALERT_EMAIL`: the operator address for snapshot failures.
   - `DOHC_SNAPSHOT_HEARTBEAT_URL`: the snapshot check's Healthchecks.io ping URL.
   - `DOHC_DISK_HEARTBEAT_URL`: the disk check's Healthchecks.io ping URL.
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
   sudo node /srv/dohc-drive/tools/drive/drive.mjs check --bundle /srv/dohc-release --env-path /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   `drive.mjs` checks the release, the configuration file's owner and mode, the Drive settings, the CA and app certificate files, the image, and IPv6.
   It checks that one attached device has `<volume-uuid>`, that it is mounted at `/mnt/dohc-drive`, and the four folders' owner, mode, and filesystem.
   It then runs the release's `scripts/check-self-host.mjs`, which validates the settings and the Compose configuration.
   The check passed when it ends with `Self-host check summary` and equal numbers.
2. **Approval:** Start the deployment for the first time, only after approval:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs start --first-start --bundle /srv/dohc-release --env-path /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

   Before it starts anything, `drive.mjs` asks Neon whether it holds dohc accounts, and refuses if it does.
   A first start under existing accounts would create a deployment that none of them can use.
   The release then refuses a first start when any deployment folder holds data.
   Every later start uses `start` without `--first-start`. `drive.mjs` never adds it.
   If the first start fails after it created the deployment, run `start` without `--first-start`.
   If it fails after the release set up the accounts database but before it created the deployment, both starts refuse.
   Keep the volume and the database as they are, and report the failure. Rebuild only under an approved plan.
3. **Operator:** Install the disk watch, which runs at 17 minutes past each hour:

   ```sh
   sudo tee /etc/cron.d/dohc-drive-disk >/dev/null <<'EOF'
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   17 * * * * root node /srv/dohc-drive/tools/drive/drive.mjs disk-watch --env-path /etc/dohc/drive.env --volume-uuid <volume-uuid> >/dev/null 2>&1
   EOF
   ```

   The `PATH` line finds `node` where `sudo` finds it.
   The watch sends each failure's reason to Healthchecks.io, which shows it in the check's log.

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

The rehearsal does not test mail, snapshots, the heartbeat, the disk watch, a published app or its entries, or live editing.
After the first start, the operator tests each of them with the real providers.
Do the checks in order. If a check fails, stop and report it.

Write each result in the server's acceptance record, with the release revision.
Never record a key, password, token, cookie, or email address.

1. **Operator:** [Check that only Cloudflare reaches the origin](#check-that-only-cloudflare-reaches-the-origin).
   Record the exit status of each command.

### Account email

1. **Approval:** Send the first delivery test only after approval.
2. **Operator:** Connect a desktop to Drive, as in [Connect the desktop app](self-host.md#connect-the-desktop-app), with an approved address for its account.
   Its verification email is the delivery test. Open its link, approve the device, and turn on **Sync this workspace**.

The check passes when the account's email arrives, and the mail provider's delivery record shows that the receiving server accepted it over TLS.
If the record does not show the transport, open the received message's headers.
The `Received` header added by the receiving server must show TLS, such as `with ESMTPS`.

Record only the time the email arrived, the delivery status, and the TLS indicator: the provider's TLS field, or the `with ESMTPS` text from the `Received` header.
Record nothing else from the message or the delivery record. The message holds the account's verification link.

### App launch

1. **Operator:** From the desktop you connected in [Account email](#account-email), publish a small app and share it with a link.
2. **Operator:** Open the share link in a browser. The app opens on a host under `dohc.app`.
3. **Operator:** In the browser's developer tools, copy the launch host and the value of its `__Host-dohc-app` cookie.
4. **Operator:** Within 10 minutes, request the launch page again with that cookie:

   ```sh
   curl -sS -o /dev/null -D - --cookie '__Host-dohc-app=<cookie>' https://<launch-host>/bootstrap \
     | sed 's/__Host-dohc-app=[^;]*/__Host-dohc-app=<hidden>/'
   ```

   This request ends the browser's app session. Reopen the share link to continue.

The check passes when the app loads in the browser and the command shows status 200 with these headers:

- `cache-control: private, no-store`
- `content-security-policy`, ending with `frame-ancestors 'none'`
- `cross-origin-opener-policy: same-origin`
- `cross-origin-resource-policy: same-origin`
- `permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- `referrer-policy: no-referrer`
- `x-content-type-options: nosniff`
- `set-cookie: __Host-dohc-app=<hidden>`, with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`

The response must not show `cf-cache-status: HIT`.

Record the command's output. Its `sed` step hides the cookie.

### App entries

A published app saves its visitors' entries in the owner's Collection, through the actions the owner approves.
A form's link accepts entries from 1,000 different visitors, each able to submit more than once. The workspace's 2 GiB limit applies to the entries too.
This check uses the form that the desktop creates for a Collection.

1. **Operator:** On the desktop you connected in [Account email](#account-email), open a synced workspace.
   Choose **New collection** in the command palette (Ctrl+K, or Cmd+K on a Mac). Name it `Drive entry check` and the UTC date and time, such as `Drive entry check 20260115-0130`, so each run gets new folders. Turn on **Require Name**.
   If dohc says it doesn't know which computer keeps this workspace's Collections, choose **Use this computer**.
2. **Operator:** Choose **Create form** in the Collection's toolbar. Keep the Name field and choose **Create form**.
3. **Operator:** Choose **Review and open app**. Review its files and the access it requests, then choose **Approve and open**.
4. **Operator:** Open the app's review and choose **Publish on a link**, then **Share app folder**.
   Choose **Anyone with the link** and **View**, then **Create link**. Copy the link, and close sharing.
5. **Operator:** Open the app's review again and choose **Publish on a link**. Select the new link and choose **Prepare app**.
   In **Review app publication**, check that the link's actions are only the form's create action, and that the owner and helper actions are None.
   Then choose **Publish this revision**.
6. **Operator:** Open the link in a private browser window that is not signed in to Drive, and choose **Open app**.
   Enter `drive-entry-check-<UTC time>` as the Name, and choose **Submit**.
7. **Operator:** On the desktop, open the Collection and choose **Refresh**. Close the Collection and open it again.
8. **Operator:** Open the app's review and choose **Publish on a link**. Choose **Unpublish**, then **Unpublish app**.
   Choose **Share app folder**, then **End link**, and **End link** again.
   In the Collection's toolbar, choose **Manage Collection**, then **Archive**, then **Archive Collection**. Archiving keeps the test record and its history.
   Open the old link again. It must no longer open the app.

The check passes when the browser shows `Response received.` on a host under `dohc.app`, the Collection shows exactly one record with that Name before and after it opens again, and the old link no longer opens the app.

Record the times, the Name you entered, and the number of records before and after. Record nothing from the link.

Drive leaves the relay's collection-create setting off. It would let apps save visitors' entries as Markdown files in a shared folder, which everyone with the link can read.

### Live edit

1. **Operator:** Sign in to two approved accounts, one in each of two browsers.
2. **Operator:** From a desktop connected to Drive, share one page with both accounts, with edit access.
3. **Operator:** Open the page in both browsers. Type a different line in each browser.
4. **Operator:** Reload both browsers.

The check passes when each browser shows the other browser's line without a reload, and both lines remain after the reload.
The release check proves the connection descriptor, not live editing.

Record what each browser showed before and after the reload.

### Snapshot

Do this on a Linux host other than the Droplet, with the same release bundle and its loaded image.

1. **Provider:** Wait until Healthchecks.io shows the first ping. Then confirm that the R2 bucket holds the first snapshot.
2. **Operator:** Write the password manager copy of `drive.env` to `$HOME/drive-check/drive.env`, with mode 0600.
3. **Operator:** Download the newest snapshot from the R2 bucket into `$HOME/drive-check/offsite`.
4. **Operator:** Verify it, as in [Verify an encrypted snapshot](self-host-recovery.md#verify-an-encrypted-snapshot):

   ```sh
   cd <release-bundle>
   node scripts/self-host/recovery.mjs verify "$HOME/drive-check/verified" --snapshot "$HOME/drive-check/offsite/<snapshot-file>" \
     --env-path "$HOME/drive-check/drive.env"
   ```

5. **Operator:** Delete the folder whether the check passed or failed. It holds the configuration and unencrypted workspace data:

   ```sh
   rm -r "$HOME/drive-check"
   ```

The check passes when the verify command exits with status 0 and reports the snapshot's namespace, generation, stamp, time, and release.
A wrong or truncated key fails here.

Record the verify command's output. It holds no key material.

### Heartbeat

1. **Operator:** Stop the snapshot job on the Droplet:

   ```sh
   sudo docker stop $(sudo docker ps --quiet --filter label=com.docker.compose.service=relay-snapshot)
   ```

2. **Operator:** Wait until Healthchecks.io marks the check down and alerts the operator.
   This takes up to 1 hour plus the check's grace time.
3. **Operator:** Start the snapshot job again:

   ```sh
   sudo docker start $(sudo docker ps --all --quiet --filter label=com.docker.compose.service=relay-snapshot)
   ```

   The job takes a snapshot when it starts, then pings Healthchecks.io.

The check passes when the operator receives the down alert, and Healthchecks.io then marks the check up again.

Record the times when the job stopped, the alert arrived, the job started, and the check recovered.

### Disk watch

1. **Operator:** Run the watch with a limit of 1%, so that it reports a failure:

   ```sh
   sudo node /srv/dohc-drive/tools/drive/drive.mjs disk-watch --env-path /etc/dohc/drive.env --volume-uuid <volume-uuid> --limit 1
   ```

   It exits with status 1 and ends with `Reported this to the disk check.`
2. **Operator:** Wait until Healthchecks.io marks the disk check down and alerts the operator.
3. **Operator:** Run the watch again without `--limit`. It prints `Pinged the disk check.`
4. **Operator:** After the next run at 17 minutes past the hour, confirm that Healthchecks.io shows its ping.

The check passes when the operator receives the down alert, Healthchecks.io marks the check up again, and the hourly run pings it.

Record the volume's use that each run printed, and the times of the alert, the recovery, and the hourly ping.

The server is accepted when every check passes.

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
   sudo node /srv/dohc-drive/tools/drive/drive.mjs move --bundle /srv/dohc-release --env-path /etc/dohc/drive.env --volume-uuid <volume-uuid>
   ```

10. **Operator:** [Check that only Cloudflare reaches the origin](#check-that-only-cloudflare-reaches-the-origin).
11. **Operator:** Install the disk watch, as in step 3 of [Check and start](#check-and-start). Then run it once without `--limit`. It prints `Pinged the disk check.`

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
4. **Operator:** Follow [Back up and maintain the deployment](self-host.md#back-up-and-maintain-the-deployment), using `--env-path /etc/dohc/drive.env`.
5. **Operator:** Run `drive.mjs check` with the new bundle.
6. **Operator:** Replace the password manager copy of `/etc/dohc/drive.env`. The upgrade changes `DOHC_IMAGE`.

## Clean up

- Delete downloaded snapshots, verified copies, and salvage output after use. They hold unencrypted workspace data.
- After a move passes its checks, destroy the old Droplet. Never destroy or reformat the volume.
- Keep the previous release bundle until the next update passes its checks.
