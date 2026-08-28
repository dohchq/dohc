# share-web

This service is the public browser boundary for share links. It exchanges a
fragment secret with the sync relay, stores the returned relay capability in a
bounded in-memory session, and sends only an HttpOnly session cookie to the
browser.

Operators must set `DOHC_SHARE_WEB_RELAY_URL` and
`DOHC_SHARE_WEB_PUBLIC_HOSTS`. The host list contains exact comma-separated
HTTP `Host` values, including ports where required. `DOHC_SHARE_WEB_PORT`
defaults to `1790`.

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

The relay does not persist viewer IP addresses. It keeps share, grant, link
credential, usage, and audit records until the owner deletes their containing
share or grant. Backups retain those rows until the operator expires the
backup. The relay reads shared content in plaintext. A link secret hides the
work from other people, not from the relay operator.

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
