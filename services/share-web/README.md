# share-web

This service is the public browser boundary for share links. It exchanges a
fragment secret with the sync relay, stores the returned relay capability in a
bounded in-memory session, and sends only an HttpOnly session cookie to the
browser.

Production operators must set four values:

- `DOHC_SHARE_WEB_RELAY_URL`: the internal relay origin that `share-web` calls.
- `DOHC_SHARE_WEB_PUBLIC_RELAY_URL`: the relay origin a desktop client can
  reach after an accepted handoff.
- `DOHC_SHARE_WEB_PUBLIC_HOSTS`: exact comma-separated HTTP `Host` values,
  including ports where required.
- `DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY`: the same workload secret configured as
  `DOHC_RELAY_EXCHANGE_KEY` on the relay, with at least 32 characters. Never
  expose it to the browser.

`DOHC_SHARE_WEB_PORT` defaults to `1790`.

## Public origin and proxy

Give the viewer one public HTTPS base origin, such as
`https://share.example.com`. Set `DOHC_SHARE_WEB_PUBLIC_HOSTS` to the exact
`Host` value that the proxy forwards, such as `share.example.com`. The service
rejects every other Host. Terminate TLS at the reverse proxy and forward the
original Host unchanged. Do not put a caching proxy in front of `share-web`.

Set `DOHC_SHARE_WEB_TRUSTED_PROXIES` to the exact network peer addresses of
proxies that may supply `X-Forwarded-For`. Leave it empty when no trusted proxy
connects to `share-web`. The service ignores `X-Forwarded-For` from an
untrusted peer. For a trusted peer, it scans the list from right to left and
uses the first address that is not a trusted proxy. The service sends that
derived address to its internal handler as `x-dohc-share-web-client-ip` for
pre-authentication rate limiting. The public proxy must not accept that
internal header from clients.

Link secrets reach the server only in a POST body or cookie; URL fragments stay
in the browser. Strip query strings from proxy access logs. Do not log request
bodies, `Cookie`, `Set-Cookie`, or the internal client-IP header. Disable body
capture in traces and error reports. `share-web` already sends
`private, no-store`; the proxy must not override or cache that response.

If the relay is unavailable or sends an invalid response to an authenticated
viewer request, `share-web` returns a generic 503 without relay details or
stale shared content. Restore the relay; the viewer can retry while its
in-memory session remains valid.

## Storage and recovery

The Phase 2 Compose deployment runs one `share-web` instance. Its viewer
sessions live only in memory. Restarting it signs viewers out. A viewer can
open the original share URL again to exchange the fragment secret and recover
access, unless the owner reset or ended the link. Do not run more than one
instance or enable horizontal scaling in v1 because the instances do not
share session state.

The sync relay stores its database in `dohc_self_host_sync_relay`. A separate
`dohc_self_host_relay_continuity` volume holds deployment configuration, the
writer lock, and continuity metadata. Keep that volume outside relay backups.
The configured paths belong to one physical deployment host. Cross-host takeover
and network filesystems are unsupported.

Before the first start, initialize a fresh deployment explicitly:

```sh
docker compose --env-file .env.self-host -f docker-compose.self-host.yml run --rm --no-deps sync-relay sh -c 'corepack enable && corepack prepare pnpm@11.20.0 --activate && pnpm install --frozen-lockfile && pnpm --filter @dohc/sync-relay deployment initialize --config /continuity/deployment.json --database /data/sync-relay.sqlite --continuity-directory /continuity/history'
```

Initialization refuses existing data. Ordinary startup never initializes missing
continuity metadata. Outside development and tests, `DOHC_RELAY_DEPLOYMENT_CONFIG`
must name the external configuration file. That file owns the database path;
`SYNC_RELAY_DB_PATH` cannot override it.

If fresh initialization is interrupted, preserve its partial configuration, relay
database, and continuity directory. Initialize with new, empty paths after inspecting
that failure. Do not reuse this procedure to replace an established deployment.
Set `DOHC_RELAY_DEPLOYMENT_CONFIG` in the Compose service to the new configuration path.

The relay can retire its storage handle at runtime and report HTTP 503 from `/health`.
Restart the service once. A confirmed rollback permits reopening; a continuity
refusal requires preserving both volumes and following the recovery limits below.

Stop `share-web` and `sync-relay` before backup or restore. Back up the complete
relay volume, including SQLite side files. Keep the original volume before
restoring into an empty replacement. The relay refuses startup if the restored
database is behind its independent continuity record, including a lost grant
revocation. Missing continuity also refuses startup.

This implementation does not provide automatic reconciliation of an older
backup. Keep the service stopped and preserve both volumes when continuity
refuses. Do not copy an older continuity record alongside a backup to make its
markers match. Host reprovisioning does not restore grant authority. Recovery
that discards or reconstructs intervening accepted work requires a separate
verified procedure; no reset or marker-repair command is provided here.

The relay does not persist viewer IP addresses. It keeps share and grant rows
until the owner deletes their containing share or grant. Retired link
credential history is bounded and older rows are pruned during rotation and
widening. Rotation and widening reset link usage; narrowing and revocation keep
the latest usage until the grant or share is deleted. Backups retain the rows
present when they were taken until the operator expires the backup. The relay
reads shared content in plaintext. A link secret hides the work from other
people, not from the relay operator.

## Device control connections

The optional `/api/device-control` endpoint lets a device register through an outbound WSS connection.
The relay authenticates its operator-provisioned credential and assigns a fresh connection ID.
Registration establishes control only. It creates no document binding, ticket, journal receipt, or live editing endpoint.

Set `DOHC_DEVICE_CONTROL_LIMITS` on both services to enable this endpoint.
Its JSON object requires every field below, with positive integer values and no additional fields.
The transport has no default limits.

| Fields | Bound |
| --- | --- |
| `maxConnections` | Active connections and pending upgrades per service |
| `maxHeaderBytes`, `maxCredentialBytes` | Raw header bytes and encoded Authorization bytes |
| `maxPayloadBytes`, `maxPendingBytes` | Message bytes and queued socket bytes; also bound document transport segments and in-flight bytes |
| `maxFragments`, `maxBufferedChunks` | WebSocket receiver fragments and buffered chunks |
| `handshakeTimeoutMs` | Time to receive registration |
| `heartbeatIntervalMs`, `heartbeatTimeoutMs` | Relay ping interval and device pong deadline |
| `closeTimeoutMs` | Time allowed for socket closure |

`maxPendingBytes` must exceed `maxPayloadBytes` by at least 16 bytes for frame headers.
Document throughput also depends on this window. A one-segment window waits for
each credit reply; size it for the intended bandwidth and round-trip delay.
`maxCredentialBytes` must not exceed `maxHeaderBytes`.
Each value and the combined heartbeat interval and deadline must fit a signed 32-bit integer.
These transport bounds do not select document admission or capacity limits.
The connection cap includes established connections and pending upgrades.
Set `maxConnections` to at least 2 to permit a reconnect while the previous connection remains open.

Set `DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION` on share-web to a JSON object with `capacity`, `refillPerSecond`, and `maxKeys`.
There are no admission defaults. Capacity and key count must be positive integers; refill rate must be a positive finite number.
Each client address gets a token bucket before share-web dials the relay.
Share-web derives that address from the socket and its existing trusted-proxy configuration.
Configure the terminating proxy and `X-Forwarded-For` as described in "Public origin and proxy" above.
Clients sharing a derived address share its admission bucket. An unlisted proxy can put every device in one bucket.
Repeated attempts from the same address can delay another device's reconnect.
Caller-supplied internal client-address headers cannot select a bucket.
The limiter bounds repeated attempts per retained address; it does not guarantee admission during a distributed flood.

Set `DOHC_RELAY_DEVICE_CONTROL_HOSTS` on the relay to its exact comma-separated internal Host values, including non-default ports.
Both services require their configured relay exchange key, including in development and tests.
The internal relay URL must be an HTTP or HTTPS origin without a path.
Share-web sends its configured exchange key and never forwards a caller's internal authentication headers.

Forward WebSocket upgrades through the public TLS proxy with the original Host and Authorization headers.
The proxy must send exactly `Connection: Upgrade` and `Upgrade: websocket` on this endpoint.
Keep Authorization out of proxy logs and traces.
Set the proxy's idle timeout above the configured heartbeat interval plus deadline.
The device command always verifies the public TLS certificate.

Use `pnpm --filter @dohc/sync-relay host:credential --help` for initial provisioning and permanent revocation.
Stop the relay before maintenance. Pass `--deployment-config` with its external
configuration path. Maintenance acquires the same lifetime writer lock and
refuses while the relay is running. A bare database path cannot open a configured
deployment for credential changes.
Place the resulting credential directory on the device with access restricted to its owner.
Build the relay package before running the outbound connector.
Run `pnpm --filter @dohc/sync-relay host:connect --help` for the outbound connector arguments.
The connector reads the existing credential and opens no listener or relay database.
Credential-file creation, reading, and the connector are unavailable on macOS until ACL validation is implemented.
It exits when its connection closes; rerunning it reconnects the same instance with a new server-generated connection ID.

Credential maintenance requires the running relay to stop and release deployment
ownership. After revocation, the next relay process refuses the revoked
credential. A runtime continuity failure closes active device connections before
the storage owner releases its lock.

The optional `--delivery-config` file enables the configured native document host.
It must include a positive integer `shutdownGraceMs`. On disconnect, the connector
closes native stdin and drains stdout. After that grace period, it sends `SIGTERM`.
If the child remains alive for another grace period, it sends `SIGKILL`.
On Windows, the first signal already terminates the child.
The connector waits for child stdio to close before reporting shutdown.

Document transport advertises the configured receive limits in its startup messages.
The bridge reduces each advertisement to its own limits. Senders retain bounded queues
and wait for byte credit when the receiver is full. Byte credit reports consumed
transport bytes; durable document acknowledgements still come from the native engine.

## Configured service-host integration

This private integration applies the relay's committed journal through a dedicated
engine daemon. It has no public editing route or shipping capacity defaults.

Stop the relay before initial provisioning. Run
`pnpm --filter @dohc/sync-relay deployment provision-service --config ABSOLUTE_DEPLOYMENT_CONFIG --host-id HOST_ID`.
The command preserves a matching provision. It refuses a different host or device mode.

Set `DOHC_RELAY_SERVICE_HOST_CONFIG` to an absolute, canonical JSON file path.
The file requires these fields; unknown fields are refused:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `engineExecutable` | Absolute canonical path to the configured-host engine executable |
| `hostId` | The provisioned service host ID |
| `instanceId` | A stable operator-assigned instance ID, reused after restart |
| `workspaces` | Nonempty array of `{root, workspaceId, maxRegistrations}` |
| `ingress` | `{aggregateBytes, applicationWorkingReserveBytes, maxUploads, uploadDeadlineMs}` for the daemon |
| `client` | `{aggregateBytes, maxUploads, connectTimeoutMs, requestDeadlineMs}` for the relay client |

Each root must be an existing canonical directory with the intended workspace
identity and main version initialized through the engine. Use dedicated service
roots. Do not point this integration at an active desktop workspace.
Workspace IDs and roots must be unique. Supply positive safe integers for limits;
the explicit application working reserve may be zero. Client budgets must also
meet the existing protocol's minimum upload allocation.

Startup verifies the daemon's namespace, host, and workspace handles before
opening admission. Shutdown closes the child before relay storage. A retired
connection cannot disconnect its replacement. Keep the instance ID across
restarts. This command cannot replace an instance at its current host epoch.
The optional `--delivery-config` file enables the configured native document host.
It must include a positive integer `shutdownGraceMs`. On disconnect, the connector
closes native stdin and drains stdout. After that grace period, it sends `SIGTERM`.
If the child remains alive for another grace period, it sends `SIGKILL`.
The connector waits for child stdio to close before reporting shutdown.

Document transport advertises the configured receive limits in its startup messages.
The bridge reduces each advertisement to its own limits. Senders retain bounded queues
and wait for byte credit when the receiver is full. Byte credit reports consumed
transport bytes; durable document acknowledgements still come from the native engine.

## Reserved later-phase deployment work

Phase 4 must define and test reverse-proxy WebSocket timeouts before browser
live editing ships. Phase 5 app publications require a separate registrable
domain from the viewer. They also require their own exact Host allowlist,
wildcard DNS, and wildcard TLS policy. Do not place app origins on subdomains
of the viewer's registrable domain.

Set `DOHC_SHARE_WEB_DEV=1` only with `NODE_ENV=development` or
`NODE_ENV=test`. Production startup fails when the viewer build is missing.
Run `pnpm --filter @dohc/share-web build` before production startup.

The session cookie always has the `Secure` attribute. Local development must
use `localhost`, where browsers accept Secure cookies without production TLS.
