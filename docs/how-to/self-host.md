# Set up a dohc server

Use this guide to run sync and sharing for your own devices and collaborators.
Local work in dohc does not need a server or account.
dohc Drive, the managed service, is coming soon.

## Choose who can reach the server

For public access, use a server with a domain name and inbound HTTPS access.
Recipients can open your share links without joining your network.
Workspace permissions still control their access.

For private access, use Tailscale on the server and each device that needs access.
Sign each device into the intended tailnet.
Enable MagicDNS and HTTPS certificates for the server's Tailscale hostname.
Recipients need permission to reach the server through Tailscale before opening a share link.
Tailscale does not grant access to a dohc workspace.

Both choices run the same dohc services.
Keep the server running while other devices need sync or browser access.
Local work remains available when the server is offline.

App publishing is disabled in the default self-host bundle.
It needs a separate HTTPS app domain and additional relay limits.
The app domain can be a registrable domain or a private suffix you control from the Public Suffix List.
Use an app domain you control.
Keep the viewer outside the app domain.
The app domain must not be the viewer's registrable domain or a host under it.
Launch hosts must not be public suffixes.
Follow the [share-web operations reference](../../services/share-web/README.md) before enabling it.
Apps use their approved datasets when `DOHC_RELAY_APP_PUBLICATIONS=1` is enabled.
Set `DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT` to change the default limit of 1,000 submitting participants per app and share grant.
Reading an app does not consume this limit. Uploads and write operations do. Workspace storage quotas still apply.
The release includes the isolated app runtime. The release build checks its compiled child and Wasm dependencies before creating the image.

## Prepare the host

Install Docker Engine with Linux container support, Docker Compose 2.24.4 or newer, and Node.js 24.16 or newer.
Have an SMTP service ready for verification and password reset emails.
The SMTP service must support TLS.

## Build the deployment bundle

The build machine needs Git and at least 40 GB of free disk space.
Clone dohc and select the release you intend to deploy.
From that clean checkout, build an image and deployment bundle:

```sh
node tools/self-host/release.mjs --image dohc-self-host:VERSION --output ../dohc-server --archive
```

Replace `VERSION` with the release or commit you are deploying.
The command builds the services into an image; running containers do not need the source checkout or pnpm.
The bundle records its source commit, image ID, and platform in `release.json`.
It contains no deployment secrets.

Copy the bundle to your server.
Check that the bundle's Linux architecture in `release.json` matches the deployment host.
Open a terminal in the bundle directory, then load its image:

```sh
docker image load -i services.tar
```

If you built on the deployment host, use the image already loaded there.
Keep the bundle's configuration and persistent volumes when you update dohc.

## Create the configuration

For public access, run this command with your domain:

```sh
node tools/self-host/bootstrap.mjs init --origin https://dohc.your-domain.com --name "My dohc server" --image dohc-self-host:VERSION
```

For private access, use your server's Tailscale HTTPS hostname:

```sh
node tools/self-host/bootstrap.mjs init --origin https://your-server.your-tailnet.ts.net --mode private --name "My dohc server" --image dohc-self-host:VERSION
```

The command creates `.env.self-host` and generates the deployment secrets.
It refuses to replace an existing configuration.
Restrict access to this file; it contains credentials.

Edit these SMTP settings in `.env.self-host`:

```dotenv
DOHC_SMTP_HOST=smtp.your-provider.com
DOHC_SMTP_PORT=587
DOHC_SMTP_SECURE=false
DOHC_SMTP_USER=your-smtp-user
DOHC_SMTP_PASSWORD=your-smtp-password
DOHC_SMTP_FROM=dohc <dohc@your-domain.com>
```

Port 587 uses STARTTLS. For implicit TLS, use port 465 and `DOHC_SMTP_SECURE=true`.
Use a sender address accepted by your SMTP provider.

Print the network setup instructions:

```sh
node tools/self-host/bootstrap.mjs network
```

For public access, point your domain at the server and permit inbound TCP ports 80 and 443.
Caddy obtains and renews the HTTPS certificate.

For private access, follow the printed Tailscale Serve instructions on the deployment host.
Check existing routes before changing them.
The setup tool does not change your Tailscale configuration.
The configured HTTPS address must also work from inside the relay container.
The readiness check tests that connection and reports DNS, TLS, or routing failures.
If you add your own proxy in front of the relay, do not let it log the `Authorization` header.
That header carries sign-in credentials and the credential your server syncs with to run your automations.

`DOHC_GATEWAY_ADDRESS` and `DOHC_SHARE_WEB_ADDRESS` in `.env.self-host` are the Docker network addresses of the gateway and `share-web`.
If you change them, keep each one a single IPv4 address inside `DOHC_NETWORK_SUBNET`, with no hostname, CIDR range, or port.
The bundle passes them to `DOHC_AUTH_TRUSTED_PROXIES` and `DOHC_SHARE_WEB_TRUSTED_PROXIES`.
The sign-in service, `workspace-api`, trusts `X-Forwarded-For` from both addresses, and `share-web` trusts it only from the gateway.
Each service refuses to start when a trusted proxy entry is not an IP address.

`workspace-api` compares addresses in the same canonical form as `share-web`.
It uses the connection's peer address unless that peer is a trusted proxy.
For a trusted peer, it reads `X-Forwarded-For` from right to left and uses the first address that is not a trusted proxy.
It uses the peer address instead when the header is missing, is longer than 4,096 characters, has more than 32 entries, has an empty entry or any entry that is not an IP address, or names only trusted proxies.
It answers 400 to a connection without an IP address.
The [proxy section of the share-web operations reference](../../services/share-web/README.md#public-origin-and-proxy) describes the `share-web` rules.

## Choose who can create an account

By default, anyone who can reach the server can create an account on it.
To close sign-up, list the approved email addresses in `.env.self-host`, separated by commas:

```dotenv
DOHC_SIGN_UP_EMAILS=you@your-domain.com,colleague@your-domain.com
```

Include your own address.
With a list, the server also accepts an address that has a pending invite.
A pending invite exists when someone shares work with an email address that has no verified account on the server.
Revoking that share removes the invite.
The server ignores case and surrounding spaces when it compares addresses.

With a list, the sign-up page asks for no password.
The server emails a link instead, and the person chooses their password there.
Opening that link also verifies the address and signs out every session of the account.
Until then, nobody can sign in to the account.
An existing account that never verified its address works the same way: select **Forgot your password?** to get the link.
When the server starts with a list, it signs out everyone whose email is not verified.
To sign in again, they choose a password from an emailed link.
People with a verified email stay signed in.
Run one account service per database: an instance still running with open sign-up could issue new unverified sessions after this sign-out.

Any other address gets a message that the server creates accounts only for approved or invited addresses.
Share links need no account, so closed sign-up does not change them.
The server checks eligibility when it creates the account.
Removing an address from the list later does not remove its account.
Revoking an invite after its account exists does not remove that account either.
Stop and start the deployment to apply a changed list.
Leave `DOHC_SIGN_UP_EMAILS` empty to open sign-up again.

`workspace-api` asks `sync-relay` about pending invites over the internal Docker network.
If the relay does not answer, an address outside the list gets a message to try again.
Listed addresses can still sign up.
Outside the self-host bundle, set `WORKSPACE_API_RELAY_URL` on `workspace-api` to the relay's internal origin.
Both services must use the same `BETTER_AUTH_SECRET`.

## Keep server data on an attached disk

To keep server data on an attached disk, set it up before the first start.
You can then [move the server to a new host](self-host-recovery.md#move-to-a-new-host) by moving the disk.
The disk holds the relay database with its files, the continuity record, and the server's session host and automation copies.
Caddy's certificates stay in a Docker volume on the host.
Accounts stay in a Docker volume on the host too, unless you [keep them in an external Postgres](#keep-accounts-in-an-external-postgres).
Docker names the accounts volume `<DOHC_DEPLOYMENT_NAME>_dohc_self_host_postgres`, which is `dohc-self-host_dohc_self_host_postgres` by default.

Mount the disk on the host, for example at `/mnt/dohc-data`, and make the mount persist across restarts.
Create a deployment folder on the mounted disk with one folder for each kind of data.
The services run as UID 1000 and need to own these folders:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /mnt/dohc-data/dohc/sync-relay /mnt/dohc-data/dohc/continuity /mnt/dohc-data/dohc/host-data
```

Set the deployment folder in `.env.self-host`:

```dotenv
DOHC_DATA_DIRECTORY=/mnt/dohc-data/dohc
```

Name a folder on the disk, not the mount point.
If the disk is not mounted, that folder is missing and the deployment fails to start.
If a folder is missing, mount the disk. Never recreate the folders: a start on empty folders would create a new deployment.
The setup and recovery commands add the data-disk Compose overlay when `DOHC_DATA_DIRECTORY` is set.
Leave it empty to keep all data in Docker volumes on the host.

Set `DOHC_DATA_DIRECTORY` before the first start, and do not change it afterward.
Docker keeps a volume's storage from when it created the volume.
If an existing volume keeps its data elsewhere, the setup and move commands refuse to start.
Restore the previous setting. Never remove the volume: it holds the deployment's data.
This guide does not move existing volumes onto a disk.

## Keep accounts in an external Postgres

By default, the deployment runs its own Postgres for accounts and sign-in sessions, in a Docker volume on the host.
To keep them in a managed Postgres instead, set it up before the first start.
A lost host or disk then loses no accounts.
Relay data stays on the host or its attached disk either way.

The database must accept TLS connections.
Every service verifies the database's certificate and host name against your provider's CA certificate.
The setup has no option to turn this check off.

1. Create a database for this deployment only, and a user that owns it.
   If your provider limits which addresses can connect, allow the server's address.
2. Download your provider's CA certificate to the server.
   The services run as UID 1000 and need to read it:

   ```sh
   sudo install -D -m 0644 provider-ca.pem /etc/dohc/postgres-ca.pem
   ```

3. Set the database in `.env.self-host`:

   ```dotenv
   DOHC_POSTGRES_HOST=db.your-provider.com
   DOHC_POSTGRES_PORT=5432
   DOHC_POSTGRES_CA_FILE=/etc/dohc/postgres-ca.pem
   POSTGRES_DB=dohc
   POSTGRES_USER=dohc
   POSTGRES_PASSWORD=your-database-password
   ```

   Use the host name that the provider's certificate names.
   `POSTGRES_DB` and `POSTGRES_USER` can contain only letters, digits, underscores, hyphens and dots.
   `POSTGRES_PASSWORD` replaces the password that `init` generated.

With `DOHC_POSTGRES_HOST` set, the setup and recovery commands add the external-database Compose overlay.
The deployment then does not start the bundled Postgres or create its volume.
Migrations run against your database.
Leave `DOHC_POSTGRES_HOST`, `DOHC_POSTGRES_PORT` and `DOHC_POSTGRES_CA_FILE` empty to use the bundled database.

Your provider's backups are the only backups of these accounts.
A deployment archive does not include them.
This guide does not move accounts from the bundled database to an external one.

## Start and check the server

```sh
node scripts/check-self-host.mjs --start
```

With `DOHC_DATA_DIRECTORY` or `DOHC_POSTGRES_HOST` set, add `--first-start` for the first start only.
After that, every start and upgrade refuses to run in these cases:

- With `DOHC_DATA_DIRECTORY` set, the disk does not hold the relay deployment.
- With `DOHC_POSTGRES_HOST` set, the external database is unreachable or holds no dohc accounts.
- With only `DOHC_DATA_DIRECTORY` set, the accounts volume on the host holds no accounts database.

The accounts check accepts any database that holds dohc accounts, including another deployment's, so check that `POSTGRES_DB` names this deployment's database.

A first start refuses unless the disk folders are empty.
With `DOHC_POSTGRES_HOST` set and no data disk, a first start refuses if the relay's Docker volumes already hold relay data.
A start also refuses when Docker cannot complete these checks.

The deployment initializes fresh storage, applies authentication migrations, and starts the services.
Keep the deployment secrets and volumes across restarts.
Do not rerun fresh initialization against an existing deployment.

## Run automations on the server

The self-host bundle enables server automations with `DOHC_RELAY_AUTOMATIONS=1`.
Schedules, Group messages, and button presses trigger automations while the desktop app is closed.
The workspace must have synced, and the server must be its automation host.
In the desktop app, choose **This server** under **Settings > Advanced > Schedules run on**.
Automatically placed hosts move to the server at their next check-in, if the server has room.
A computer the owner chose as host keeps that role until the owner changes it.
Hosts recorded before automatic placement was introduced also stay where they are.
Due times missed while no computer or server runs schedules do not run later.

Reserve additional disk space for each hosted workspace, about the size of that workspace again.
The default workspace storage quota is 2 GiB.
Server copies, engine databases, and run history contain unencrypted workspace content.
Protect the `dohc_self_host_host_data` volume like the relay database.
After a host move, an unused copy closes after one day and remains for 30 more days for run history.

The server hosts at most 64 workspaces and runs at most 4 automations concurrently, one per workspace.
Each workspace can start a burst of 120 runs, then one run every 10 seconds, or 360 an hour.
Excess runs wait. The owner receives a notice at most once a day when the workspace reaches its run limit.
At the workspace limit, newly assigned schedules run on the owner's computer.

To turn server automations off, set `DOHC_RELAY_AUTOMATIONS=0` in `.env.self-host`.
Stop and start the deployment to apply the setting:

```sh
node tools/self-host/bootstrap.mjs stop
node tools/self-host/bootstrap.mjs start
```

Turning automations off deletes all server automation copies and their local claims and run history at startup.
Save a private deployment archive first if you need to preserve that history.
The bundle cannot restore or view archived run history.
The synced workspace files remain in the relay.
At the owner's next desktop check-in, schedules move back to that computer.
Set `DOHC_RELAY_AUTOMATIONS=1` and restart to enable server automations again.

Check a running deployment with `node scripts/check-self-host.mjs --running`.
The automation check reports whether the engine daemon is up and a replica pass has completed.
Individual workspace failures appear in the sync-relay logs with their workspace IDs and do not take the server offline.
An unavailable automation host fails this check even when sync and sharing remain available.
If it fails, inspect the sync-relay logs and verify disk space and the relay's public HTTPS route.

## Connect the desktop app

1. Open **Settings → Sync and sharing** and select **Connect server**.
2. Enter the HTTPS address you configured above.
3. Follow the browser sign-in flow.
4. Create an account on your server and open the link in the email it sends.
5. Approve the device after checking the displayed code.
6. Return to dohc. Settings opens on **Sync and sharing**; turn on **Sync this workspace**.

The server account belongs to your server.
A dohc Drive account is not required.
The connection applies to this dohc installation; workspace permissions still determine what it can access.

On another device, connect to the same server and sign in to the same account.
Copy the workspace code from **Settings → Sync and sharing**, then use it to join the existing workspace in a local folder.

## Share work

Use the workspace's sharing controls to choose the work and the recipient's permissions.
Share the resulting link.
Anonymous access works only when the share permits it.

For a private server, recipients also need Tailscale network access.
For a public server, the share link provides the browser entry point.
Changing the network route does not change a share's permissions.

## Check before inviting other people

Create a test account and confirm that verification and password reset emails arrive.
Connect a second desktop and confirm that an edit reaches it.
Open a share link in a separate browser profile and check its permissions.
Restart the services and confirm that the workspace remains available.

Keep a local copy of important work while testing your deployment.
See the [browser service operations reference](../../services/share-web/README.md) for storage and permission boundaries.

## Disable a published app

If a published app is unsafe, run this command from the deployment bundle directory on the server:

```sh
docker compose --env-file .env.self-host -f docker-compose.self-host.yml exec -T sync-relay \
  node /app/services/sync-relay/dist/app-publication-takedown.js \
  --publication-id PUBLICATION_ID --reason "Phishing reported and confirmed"
```

Use the publication ID from the owner's publication list or the app URL's `app` parameter.
The command disables that one publication. The owner sees the reason and cannot reactivate that publication.
The owner can still publish the app under a new share link or after rotating the grant.
Watch for new publications of the same app.
The relay records the actor as "operator", the time, and the reason durably.
It immediately refuses serving, new launches, and writes, including requests from existing launches.

The command uses a private socket inside the running relay container. Other publications, sync, and sharing keep running.
Use Compose's `--env-file`, `-f`, or `--project-name` options when selecting a custom deployment.
Exit codes are 0 for success, 2 for bad input, 3 for not found, and 1 for connection or operation failures.
The client times out after 10 seconds. Retries preserve the first takedown record.

Restoring a backup taken before the takedown brings that publication back.
Run the takedown command again after restoring such a backup.

## Back up and maintain the deployment

Follow the [backup and recovery procedure](self-host-recovery.md) before changing your deployment.
Recovery must preserve revoked access; replacing current databases with an older snapshot is not a supported rollback.

Stop the services without removing data:

```sh
node tools/self-host/bootstrap.mjs stop
```

Start them again and check readiness:

```sh
node tools/self-host/bootstrap.mjs start
```

Each server release serves a range of relay API versions, and `GET /ready` on the relay reports it as `apiVersions`.
A desktop newer than that range tells its user that the server runs an older version of dohc.
Upgrade the server to serve that desktop again.

For an upgrade, stop the deployment and save a snapshot and private archive.
Replace the shipped Compose files, scripts, and documentation with the new release bundle.
Keep your `.env.self-host`, including `DOHC_DEPLOYMENT_NAME`, and all existing data volumes.
Do not rerun `init`.
Load the new release image, then select it:

```sh
node tools/self-host/bootstrap.mjs upgrade --image dohc-self-host:NEW_VERSION
```

The upgrade preserves volumes and secrets and saves the previous configuration privately.
It can apply database migrations. If it fails, preserve the data and follow the recovery procedure.
