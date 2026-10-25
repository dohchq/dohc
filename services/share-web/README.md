# share-web

This service is the public browser boundary for share links. For public links,
it exchanges a fragment secret with the sync relay, stores the returned relay capability in a
bounded in-memory session, and sends only an HttpOnly session cookie to the
browser.

Production operators must set five values:

- `DOHC_SHARE_WEB_RELAY_URL`: the internal relay origin that `share-web` calls.
- `DOHC_SHARE_WEB_PUBLIC_RELAY_URL`: the relay origin a desktop client can
  reach after an accepted handoff.
- `DOHC_SHARE_WEB_PUBLIC_HOSTS`: exact comma-separated HTTP `Host` values,
  including ports where required.
- `DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY`: the same workload secret configured as
  `DOHC_RELAY_EXCHANGE_KEY` on the relay, with at least 32 characters. Never
  expose it to the browser.
- `DOHC_SHARE_WEB_INTERNAL_HOSTS`: exact comma-separated HTTP `Host` values
  for internal deletion calls, such as `share-web:1790`. Startup requires this
  list when the relay exchange key is configured. The public proxy must answer
  404 for `/internal/*`.

`DOHC_SHARE_WEB_PORT` defaults to `1790`.

## Remote MCP for shared links

Agents can use `/mcp` over Streamable HTTP. It supports current per-request MCP and older stateless clients.
The share page advertises `/api/mcp` through its HTTP `Link` header. That endpoint describes authentication.

1. Take the secret after `#` in the share URL.
2. POST `{"secret":"<secret>"}` as JSON to `/api/mcp/exchange` on the same origin.
3. Connect the MCP client to `/mcp` with `Authorization: Bearer <bearer>` from the exchange response.
4. Keep and reuse the bearer for that agent. Each exchange creates a separate link identity.

The agent can list files and read settled content. It sees the same conversation as a person with the link in the viewer.
On a Group share that is the Group's channel, read with `dohc_read_channel`.
A read-write link also gets `dohc_post_channel`, which posts there as its link holder; the owner sees the post marked as from a link holder.
On any other share it is the share discussion, which Comment and Edit links can also post to.
The relay checks the grant again for every action, and a refusal arrives as a sentence the agent can act on.
If a post's answer is lost, the tool says the post may have landed. Send it again with the same `idempotencyKey`; it posts once.
Live document tools require the existing Public Edit release and live-link configuration described below.
They support existing `.md` documents on main while the document host is online.
The edit tool replaces one exact text occurrence inside a single formatting run. It preserves unrelated document content and frontmatter.
Supply `find` as document text without Markdown syntax. For `Hello **world**.`, use `world`, not `**world**`.

An `applied` edit includes the durable host acknowledgement. Markdown settlement can happen later.
If the outcome is `unknown`, read the live document before retrying.

Edit links on main also expose `dohc_write_collection_files`, the same write the viewer's **Edit file** makes for `collection.yaml` and `automations.yaml`.
It edits a Collection's schema, creates or replaces its automations, or creates a Collection with up to 500 Markdown records.
It needs the Public Edit release, not the document host. The relay names the link as the author and applies the checks it applies to a named recipient.
`accepted` means the relay recorded the change in the owner's history. The owner's computer applies it at its next sync.
An MCP request that carries a write may be up to 9 MiB, room for 4 MiB of text that JSON escapes in two bytes. A file can go as base64 instead of text, as the viewer sends it in a request of up to 7 MiB.
A write goes in an MCP request of its own, never in a batch.
Share-web holds one such body per link and four in all, across both. Other MCP requests stay at 32 KiB.
Settled file reads can lag live documents. File reads are limited to 256 KiB; other tool results are limited to 1 MiB.

The bearer uses the same bounded, in-memory session store as browser links.
Restarting share-web or evicting the session invalidates it. Re-exchange the link to start a new agent identity.
Browser cookies cannot authenticate MCP requests. The bearer never contains the relay workload key or a browser account credential.
Do not log `Authorization` headers, exchange bodies, or bearer responses.

Each edit opens a fresh live connection and adds a Yjs client clock to the document.
This implementation is for bounded edits, not high-frequency automated rewriting.
The existing state-vector and update limits also apply to agents.

## App publication storage

Set `DOHC_RELAY_APP_PUBLICATIONS=1` on the relay to enable immutable app publications.
Leave it unset or set it to `0` to keep these routes unavailable.
Invalid values stop the relay before it opens storage.

This enables authenticated owners to publish, list, inspect, and withdraw app builds.
Link holders can read a publication within their current share grant when the
relay also has `DOHC_RELAY_LINK_KEY` configured.
The setting does not enable public Edit or app collection writes.
For app collection responses, also set `DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT`
on the relay to a positive integer. This limits accepted creates over each grant's lifetime.
Leave it unset or set it to `0` to disable collection access. Owners must approve each app's collection capability.
Disabling collection access still lets owners revoke an existing approval.

Published apps use their approved datasets without a separate backend setting.
`DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT`
limits enrolled link principals per grant and defaults to `1000`. Set a positive
safe integer; `0` is invalid. This counts browser identities, not submitted rows.
Backend operations do not require the collection-create setting or public Edit.
See the [app backend guide](../../docs/how-to/app-backend.md) for publication,
runtime packaging, private uploads, and recovery.

Browser launch also requires `DOHC_SHARE_WEB_APP_DOMAIN` and
`DOHC_SHARE_WEB_PUBLIC_ORIGIN`. See [app domains](#app-domains) for the domain
and isolation requirements. App launch stays off when the app domain is unset.
Setting it without a public origin stops share-web at startup.

Launch issuance allows each authorized link browser profile or signed-in account
session a burst of 12, refilling 0.2 per second. People on the same network have
separate allowances. The relay must authorize the publication before this budget
is charged; a supplied profile or account cookie alone is not authority.
Account session rotation starts a new session allowance.
Before authorization, issuance admits 600 probes per address, refilling ten per
second, and 2,400 globally, refilling 40 per second. Each address may hold 16 of
the 64 issue slots. Bodies are limited to 1 KiB with a 15-second deadline.
These issuance limits return 429. Document builds, status checks, and app
operations retain separate admission lanes, so stalled issue bodies do not
occupy their slots.

Limits are shared with the desktop: 512 source files, 32 MiB per bundle,
20 MiB per blob, and 256 KiB for the complete publication request.
Withdrawal stops future authorized access. It cannot delete copies already received.

## Public origin and proxy

Give the viewer one public HTTPS base origin, such as
`https://share.example.com`. Set `DOHC_SHARE_WEB_PUBLIC_HOSTS` to the exact
`Host` value that the proxy forwards, such as `share.example.com`. The service
rejects every other Host. Terminate TLS at the reverse proxy and forward the
original Host unchanged. Do not put a caching proxy in front of `share-web`.

Set `DOHC_SHARE_WEB_TRUSTED_PROXIES` to the network peer addresses of proxies
that may supply `X-Forwarded-For`. Separate entries with commas and no spaces.
Each entry must be one IPv4 or IPv6 address. The service refuses to start on a
hostname, CIDR range, port, bracketed address, or IPv6 zone such as `%eth0`.
Leave the value empty when no trusted proxy connects to `share-web`.

The service compares addresses in one canonical form. IPv6 addresses match
regardless of letter case or zero compression, and an IPv4-mapped IPv6 address
such as `::ffff:10.0.0.2` matches `10.0.0.2`.

The service ignores `X-Forwarded-For` from an untrusted peer and uses the peer
address. For a trusted peer, it scans the list from right to left, skips empty
entries, and uses the first address that is not a trusted proxy. If it reaches
an entry that is not an IP address first, it uses the peer address. If the
header is missing or names only trusted proxies, it uses `unknown`. A peer
without an IP address also uses `unknown`, and all `unknown` requests share
one per-address allowance. The service sends the derived address to its
internal handler as `x-dohc-share-web-client-ip` for pre-authentication rate
limiting. The public proxy must not accept that internal header from clients.

Link exchange admits valid credentials per share grant, so people on one network
do not share the invalid-credential allowance. The relay allows a burst of 960
valid exchanges per grant and refills 16 per second. Both services bound all
exchange probes to a burst of 2,400, refilling 40 per second, with 64 requests
in flight. These budgets use the existing app and share-read admission sizes.
Before spending the global allowance, each address has a burst of 600 probes,
refilling ten per second, and at most 16 requests in flight. This preserves
room for other networks during a flood or stalled request bodies from one address.
Malformed viewer requests and invalid relay credentials use a separate per-IP
allowance of 12, refilling 0.2 per second. Exhausted budgets return 429.
The relay still performs a bounded credential lookup to distinguish a valid
secret after the per-IP allowance is exhausted; the global budget bounds this
work. Request bodies and relay responses have size limits and ten-second deadlines.

Link secrets reach the server only in a POST body or cookie; URL fragments stay
in the browser. Strip query strings from proxy access logs. Do not log request
bodies, `Cookie`, `Set-Cookie`, or the internal client-IP header. Disable body
capture in traces and error reports. `share-web` already sends
`private, no-store`; the proxy must not override or cache that response.

If the relay is unavailable or sends an invalid response to an authenticated
viewer request, `share-web` returns a generic 503 without relay details or
stale shared content. Restore the relay; the viewer can retry while its
in-memory session remains valid.

## Public Edit release

The self-host deployment sets `DOHC_SELF_HOST_LIVE=1` on both services.
Use the [self-host setup guide](../../docs/how-to/self-host.md) for deployment steps.
This selects shared limits for the native host, browser editor, sessions, and live transport.
It also supplies the Public Edit marker `{"version":1}`.
Operators still configure the public HTTPS origin, account service, secrets, and persistent native host storage.

For manually configured deployments, Public Edit stays disabled until both services receive `DOHC_PUBLIC_EDIT_RELEASE` as `{"version":1}`.
Unknown versions and extra fields are rejected. The marker carries no budgets; explicit profiles supply each limit.

Share-web requires `DOHC_SHARE_WEB_LINK_LIVE_LIMITS`, the exact public HTTPS origin,
and relay exchange configuration. The relay requires `DOHC_RELAY_LINK_LIVE=1`,
complete named live/session/ticket profiles, and its configured document host.
A service host must be configured and started. The self-host profile provisions that host and discovers shared live documents.
A device host also requires
configured device delivery and owner admission. An absent or incompatible marker
on either service prevents a successful public Edit exchange.

Edit links cover existing live Markdown documents on the main version, and a shared Collection's schema and automations.
Pinned versions cannot receive Edit links. The desktop obtains supported access
levels from authenticated relay inventory; the relay revalidates mutations.
Disabling release blocks Edit creation, widening, rotation, exchange, and renewal.
Owners can still narrow or revoke an existing Edit link.

## Named browser invitations

The owner can copy a browser invitation for direct named Edit access to live paths.
The relay builds `/s/edit/<encoded-grantId>` from `DOHC_RELAY_SHARE_WEB_ORIGIN` when named browser sessions are configured.
This URL identifies the invitation. The recipient must sign in with the invited account; knowing the URL grants no access.
Issuing the invitation does not check whether the editor or document host is available.

The self-host profile supplies the session, transport, and editor limits on both services.
The relay enrolls current Markdown documents covered by Edit shares and retains their native state across restarts.
The authenticated owner can inspect preparation or pause a document through `/sync/:workspaceId/live-host`.
Pausing retains its state and stops live authorization immediately.

The profile runs up to 64 documents across 16 workspaces, including paused documents.
Stopping live editing retires an enrollment and frees its slot. The server keeps acknowledged history and native state.
In desktop Settings, open **Sync and sharing**, then **Live documents**.
Choose **Stop live editing** for a document, or **Resume live editing** for a stopped document.
Retirement stops live editing for that document. It does not revoke its share grants or delete settled shared files.
An owner can resume the same document at the same path while capacity is available.
Active live documents must keep their original paths. Moving, deleting, or replacing one makes its live enrollment unavailable.
Other enrolled documents continue working. Returning the same document to its original path allows the host to resume.
Deleting enrollment storage or resetting its native state is not a recovery procedure.

For a manual deployment, configure both services:

- On the relay, set `DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS`, `DOHC_RELAY_SHARE_WEB_ORIGIN`, and `DOHC_RELAY_EXCHANGE_KEY`.
  Enable `DOHC_RELAY_NAMED_LIVE_CONFIG` and `DOHC_RELAY_NAMED_LIVE_HOSTS` with the existing link key and a configured native document host.
  Set `DOHC_RELAY_NAMED_EDITOR_LIMITS` to enable desktop live editing; its receive frame size must not exceed the named live frame size.
- On share-web, set `DOHC_SHARE_WEB_AUTH_URL` and `DOHC_SHARE_WEB_PUBLIC_ORIGIN` with the matching public Host and relay exchange key.
  Set `DOHC_SHARE_WEB_NAMED_BROWSER_SESSION_LIMITS`, `DOHC_SHARE_WEB_NAMED_LIVE_LIMITS`, and `DOHC_SHARE_WEB_NAMED_EDITOR_LIMITS`.

Serve the account service's `/account/*` and `/api/auth/*` paths on share-web's public origin so the sign-in form's "Forgot your password?" link works.

Without the self-host profile, the named session, live transport, and editor settings require explicit budgets.
Share-web refuses editor requests when its named editor is unconfigured.
Live browser editing covers shared Markdown files. Other files retain their existing sharing permissions and change-submission flow.
Desktop share codes remain available when browser invitations are unconfigured.

## Named recipient chat HTTP

These endpoints serve named recipients and agents holding their account session.
They require the named browser session limits, account authentication, and relay exchange configuration.
Chat does not require live tickets, a document host, or editor limits.

Named chat invitations use `/s/chat/<encoded-grantId>`.
The browser view signs in with the invited account, then reads, follows, and posts through these endpoints.
The URL identifies a share. It carries no credential.
The relay resolves the signed-in account and uses the same grants as the recipient desktop.
A recipient with several grants gets the highest permitted access on that share.

Send the account session cookie to share-web.
For POST requests, send `Origin: <public-origin>` and `Content-Type: application/json`.
GET requests can omit Origin. Browser requests must come from the configured public Host.
Share-web forwards only recognized account cookies and its trusted relay exchange key.

- `GET /api/named-chat/channels?grantId=<id>` resolves an invitation to its share.
  It returns `{shareId, userId, maxPostBytes, maxBodyBytes, channels: [{channelWireId, name, kind, access}]}`.
  A channel or Group share exposes one channel. `name` and `kind` can be null.
  Access is `read-only` or `read-write`, including the desktop's append restrictions.
  `maxPostBytes` bounds the complete UTF-8 POST JSON at both services. `maxBodyBytes` bounds the normalized message body.
- `GET /api/named-chat/messages?shareId=<id>&channelWireId=<wire-id>&limit=50` returns the newest page first.
  The response is `{shareId, channelWireId, messages, nextCursor, olderCursor}`.
  Messages appear in descending relay sequence order. The limit defaults to 100 and cannot exceed 100.
  Save the first page's `nextCursor` to follow new messages.
  Pass `before=<olderCursor>` to read older pages. Stop when `olderCursor` is null.
  Each page scans at most 2,000 workspace log rows and resolves earliest thread bindings once in SQL.
  The relay applies the share filter before returning messages.
  Empty pages can advance through other channels. Follow and older cursors include those scanned rows.
  Older-page watermarks must not replace the saved following cursor.
- `GET /api/named-chat/messages?shareId=<id>&channelWireId=<wire-id>&since=<nextCursor>&hold=30000&limit=50` follows new messages.
  The response is `{shareId, channelWireId, messages, nextCursor, hasMore}`.
  Messages appear in ascending relay sequence order. Save each returned cursor, including on empty pages.
  If `hasMore` is true, read the next page immediately.
  Hold defaults to zero and accepts integer milliseconds from zero through 30,000.
  A caught-up read waits for workspace log activity or the timeout.
  Cancellation releases the parked waiter. The relay hub bounds waiter counts.
  Follow reads use a separate pool at both services, leaving other requests available.
  The relay caps follow requests per account at the configured `maxPendingRequests`.
  Share-web applies the same cap per account cookie; each service also caps total follow requests at 4,096.
  Browser follows are capped at 128 per workspace, leaving wake-hub capacity for ordinary log readers.
- `POST /api/named-chat/messages` accepts this body:

  ```json
  {
    "shareId": "share-id",
    "channelWireId": "channel-wire-id",
    "id": "client-retry-id",
    "threadId": "existing-thread-id",
    "body": "Hello",
    "authorKind": "human"
  }
  ```

Omit `threadId` to create a chat thread and its first message atomically.
An existing thread must belong to the selected channel.
Post IDs are non-empty, trimmed strings of at most 256 UTF-16 code units, without control characters.
The relay assigns the message ID, timestamp, and authenticated `authorUserId`.
An optional `authorUserId` must equal that account; a different claim receives 403.
Author kind accepts `human` or `agent`. Browser sessions cannot post as automations.
For a human, omit `authorDisplayName`; the relay uses the authenticated account's name, or `Unnamed` when none is available.
For an agent, send `authorKind: "agent"` and `authorDisplayName: "Planner"` with the same message fields.
The agent name must be trimmed, non-empty, and at most 200 UTF-16 code units.
The relay stores the authenticated account's name as `authorOwnerDisplayName`.
Client-supplied owner names and human names are refused.
The body normalizes CRLF and CR to LF, trims its end, and must be non-empty.
The complete POST JSON must fit the returned `maxPostBytes`, 16 KiB in the self-hosted profile.
The normalized body must also fit `maxBodyBytes`.
The relay checks the response budget before appending the thread and message.
JSON escaping and metadata count toward that limit.

A successful post returns `{shareId, channelWireId, message}`.
Reuse the client ID and normalized request fields on retry.
The same account, share, ID, and fields return the original result.
Changed fields receive 409. Use a new ID for a new message.
The thread and message use the existing named log append, including its transaction authorization check.
The relay refuses reactions, decisions, attachments, channel creation, and extra body fields.
The ordinary recipient log route reserves `browser-chat` for these server-assigned sequences.

Every message contains `relaySeq`, `messageId`, `threadId`, `authorUserId`,
`authorDisplayName`, `authorKind`, `authorOwnerDisplayName`, `createdAtMs`, `body`, and `bodyTooLarge`.
The user ID and owner name are null when absent.
Author kind is `human`, `agent`, `automation`, or `link`. A `link` message came from a link holder through a share link.
Its user ID and owner name are always null. Its display name is the name the link holder chose, which nobody verified, or `Anonymous`.
If a body cannot fit the response budget, `body` is null and `bodyTooLarge` is true.
If metadata fills a page, the relay returns the prefix that fits and continues after its last message.
If one message's metadata cannot fit alone, the relay returns a minimal omission marker.
Its message ID is `omitted:<relaySeq>`; its thread ID and display names are empty, and its user ID is null.
The marker retains the sequence, author kind, and timestamp, with a null body and `bodyTooLarge: true`.
Other messages and later pages remain readable.
No engine is needed to read this JSON.

Oversized posts return 413 with `payload_too_large`. Full request pools return 429 with `share_access_rate_limited`.
Responses are private and never cached.
Read-only posts receive 403 at the relay, even when share-web is bypassed.
Missing or removed access receives 404. Invalid fields receive 400 or 403.
Waiter capacity receives 429. Response size overflow receives 413; request a smaller page.
The configured named session request and response byte limits also apply.
Share-web refuses malformed, oversized, redirected, or non-JSON relay responses.
Link holders cannot use these endpoints or create chat link grants.
A link on a Group share reads and posts in the Group's channel through the viewer and `/mcp` instead.

The corresponding trusted relay endpoints use `/sync/named-chat/channels` and `/sync/named-chat/messages`.
They require the recipient account cookie, configured public Origin, and relay exchange key.
The desktop transport also accepts `hold` on `GET /sync/shares/:shareId/log`.
It retains its existing envelope, channel filtering, and cursor contract.


## Storage and recovery

The supported Compose deployment runs one `share-web` instance.
Its viewer sessions live in memory. Restarting it signs viewers out.
A viewer can open the original share URL again unless the owner reset or ended the link.
Do not run multiple instances because they do not share viewer session state.

The relay stores its database in `dohc_self_host_sync_relay`.
The separate `dohc_self_host_relay_continuity` volume holds configuration, the writer lock and independent continuity.
Only one host uses these volumes at a time. Network filesystems and hosts that share the volumes are unsupported.
To move a deployment to a new host, keep these volumes on an attached disk and follow [Move to a new host](../../docs/how-to/self-host-recovery.md#move-to-a-new-host).
The deployment's initializer creates a fresh configuration only when its required storage is empty.
Ordinary relay startup never initializes missing continuity.
Preserve partial state if fresh initialization is interrupted; do not delete established volumes to retry setup.

Use the [self-host recovery procedure](../../docs/how-to/self-host-recovery.md) for snapshots, checks, repair and private archives.
Exact-stamp repair retains the original continuity, authentication and live-host data.
It preserves replaced relay files and refuses snapshots older than accepted work.
Offline salvage can export settled tracked files from older snapshots into a new directory.
It does not restore permissions, live-edit authority or a running deployment.

The relay can retire storage and return HTTP 503 from `/health`.
Restart once. If continuity still refuses, keep the service stopped and preserve all volumes.
Never replace current continuity with an older archived copy.
Losing continuity or rolling back after a migration requires further recovery work, not a marker reset.

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

A relay that hosts live documents on a device also needs `DOHC_RELAY_DEVICE_DELIVERY_CONFIG`: the absolute path of a JSON file that names the device host, its engine executable, and each workspace root it serves.
Private owner admission is optional: `DOHC_RELAY_OWNER_ADMISSION_CONFIG` names a second JSON file listing one share per delivered workspace with its validation budgets and drain limits.
The relay refuses to start when either file is missing a required field, names a workspace it does not deliver, or exceeds 1 MiB.
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

The delivery configuration accepts an optional `settlement` field:
`{maxApplicationsPerSettlement}`. Supply a positive integer for this limit.
When settlement is configured, `ingress.applicationWorkingReserveBytes` must be positive.

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
The file accepts these fields; all except `settlement` are required. Unknown fields are refused:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `engineExecutable` | Absolute canonical path to the configured-host engine executable |
| `hostId` | The provisioned service host ID |
| `instanceId` | A stable operator-assigned instance ID, reused after restart |
| `workspaces` | Nonempty array of `{root, workspaceId, maxRegistrations}` |
| `ingress` | `{aggregateBytes, applicationWorkingReserveBytes, maxUploads, uploadDeadlineMs}` for the daemon |
| `client` | `{aggregateBytes, maxUploads, connectTimeoutMs, requestDeadlineMs}` for the relay client |
| `settlement` | Optional `{maxApplicationsPerSettlement}` with a positive integer limit |

Each root must be an existing canonical directory with the intended workspace
identity and main version initialized through the engine. Use dedicated service
roots. Do not point this integration at an active desktop workspace.
Workspace IDs and roots must be unique. Supply positive safe integers for limits;
the application working reserve may be zero only when settlement is absent. Client budgets must also
meet the existing protocol's minimum upload allocation.

Startup verifies the daemon's namespace, host, and workspace handles before
opening admission. Shutdown closes the child before relay storage. A retired
connection cannot disconnect its replacement. Keep the instance ID across
restarts. This command cannot replace an instance at its current host epoch.

### Verify configured hosts

Use the configured-host executable and its repository verification build receipt.
Supply absolute paths to the executable and `.dohc-dev/verification/build.json` from that build:

```sh
pnpm verify:configured-hosts --binary ABSOLUTE_ENGINE_PATH --build-receipt ABSOLUTE_BUILD_JSON
```

The command checks the executable hash and native source against the receipt's engine hash and commit.
It builds the relay connector, then runs the service and outbound TLS device proofs sequentially.
Each proof covers settlement and restart recovery. The device proof also covers a lost acknowledgement and connection replacement.
Results and process logs remain in `.agent-artifacts/configured-hosts`.
The command does not build Rust or select a default executable.

## App domains

Use a registrable domain or a suffix in the private section of the Public Suffix
List for apps. For example, a viewer at `https://share.example.com` can use
`DOHC_SHARE_WEB_APP_DOMAIN=example.net` or a private suffix you control.
Use an app domain you control.
Set the domain without a scheme, port, or wildcard. The viewer must use HTTPS
without a port. It must not be the app domain or a host under it.
The app domain must not be the viewer's registrable domain or a host under it.
Launch hosts must not be public suffixes.
For example, `https://share.vercel.app` cannot be the viewer when the app domain
is `vercel.app`.
Accepted suffixes come from the Public Suffix List copy bundled with tldts; newly listed suffixes require a tldts update.

Point wildcard DNS for `*.example.net` at the share-web proxy and install a
matching wildcard TLS certificate. Forward those requests to the same share-web
instance as the viewer. Preserve the exact Host header and use HTTPS on port 443.
Keep `DOHC_SHARE_WEB_PUBLIC_HOSTS` limited to the viewer's exact hosts.
App routing separately accepts a 48-character lowercase hexadecimal label under
the configured app domain and checks its server-issued launch binding.
Unknown launches refuse access, even when the hostname has that shape.

Do not share cookies or cached responses across app hosts. The proxy must preserve
`Set-Cookie`, `Cache-Control`, `Content-Security-Policy`, and origin isolation headers.
Restarting share-web ends app sessions; recipients reopen the share link to launch again.

Phase 4 must define and test reverse-proxy WebSocket timeouts before browser
live editing ships.

## Development

### Check shared-link MCP against the native engine

Run `pnpm qa:prepare` from the repository root. Set these environment variables:

- `DOHC_SERVICE_HOST_PROOF_BINARY`: absolute path to the prepared `target/debug/dohc-workspace-engine` executable, with `.exe` on Windows.
- `DOHC_SERVICE_HOST_PROOF_SHA256`: SHA-256 digest of that executable.
- `DOHC_SERVICE_HOST_PROOF_OUTPUT`: absolute path to a disposable evidence directory.

Run `pnpm --filter @dohc/share-web exec vitest run --config vitest.mcp-native.config.ts`.
The test starts its own loopback HTTP listeners, relay store, workspace, and native service host.
It checks file reads, discussion, durable live edits, View restrictions, revoked access, and reads while the host is offline.
The owner identity is a test fixture. This does not verify account login, a desktop-host connection, ordinary file replication, TLS deployment, or production capacity.
The test stops its processes and retains its stores and result under the output directory for inspection.

### Run the viewer

Set `DOHC_SHARE_WEB_DEV=1` only with `NODE_ENV=development` or
`NODE_ENV=test`. Production startup fails when the viewer build is missing.
Run `pnpm --filter @dohc/share-web build` before production startup.

The session cookie always has the `Secure` attribute. Local development must
use `localhost`, where browsers accept Secure cookies without production TLS.
