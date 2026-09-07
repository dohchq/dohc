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

The sync relay stores its SQLite database in the
`dohc_self_host_sync_relay` volume. Stop `share-web` and `sync-relay` before a
backup or restore. Back up the complete volume, not only one SQLite file.
Restore into an empty relay volume, then start the relay before `share-web`.
Test the restore on a separate deployment before relying on the backup.

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
| `maxPayloadBytes`, `maxPendingBytes` | Control message bytes and queued socket bytes |
| `maxFragments`, `maxBufferedChunks` | WebSocket receiver fragments and buffered chunks |
| `handshakeTimeoutMs` | Time to receive registration |
| `heartbeatIntervalMs`, `heartbeatTimeoutMs` | Relay ping interval and device pong deadline |
| `closeTimeoutMs` | Time allowed for socket closure |

`maxPendingBytes` must exceed `maxPayloadBytes` by at least 16 bytes for frame headers.
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
Place the resulting credential directory on the device with access restricted to its owner.
Build the relay package before running the outbound connector.
Run `pnpm --filter @dohc/sync-relay host:connect --help` for the outbound connector arguments.
The connector reads the existing credential and opens no listener or relay database.
Credential-file creation, reading, and the connector are unavailable on macOS until ACL validation is implemented.
It exits when its connection closes; rerunning it reconnects the same instance with a new server-generated connection ID.

Revocation through a separate SQLite connection blocks later registration transactions.
The active connection closes when a heartbeat observes the changed durable host coordinate.
That observation is not a synchronous notification from the operator's transaction.

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
