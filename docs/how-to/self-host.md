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
Follow the [share-web operations reference](../../services/share-web/README.md) before enabling it.
For apps with private data, also set `DOHC_RELAY_APP_BACKENDS=1` after enabling `DOHC_RELAY_APP_PUBLICATIONS=1`.
The release includes the isolated app runtime. The release build checks its compiled child and Wasm dependencies before creating the image.

## Prepare the host

Install Docker Engine with Linux container support, Docker Compose 2.24.4 or newer, and Node.js 24.14 or newer.
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

## Start and check the server

```sh
node scripts/check-self-host.mjs --start
```

The deployment initializes fresh storage, applies authentication migrations, and starts the services.
Keep the deployment secrets and volumes across restarts.
Do not rerun fresh initialization against an existing deployment.

## Connect the desktop app

1. Open **Settings → Sync and sharing**.
2. Enter the HTTPS address you configured above.
3. Follow the browser sign-in flow.
4. Create an account on your server and verify your email.
5. Approve the device after checking the displayed code.
6. Return to dohc and select **Sync this workspace**.

The server account belongs to your server.
A dohc Drive account is not required.
The connection applies to this dohc installation; workspace permissions still determine what it can access.

On another device, connect to the same server and sign in to the same account.
Use the workspace's sync code to join the existing workspace in a local folder.

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
