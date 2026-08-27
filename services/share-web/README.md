# share-web

This service is the public browser boundary for share links. It exchanges a
fragment secret with the sync relay, stores the returned relay capability in a
bounded in-memory session, and sends only an HttpOnly session cookie to the
browser.

Operators must set `DOHC_SHARE_WEB_RELAY_URL` and
`DOHC_SHARE_WEB_PUBLIC_HOSTS`. The host list contains exact comma-separated
HTTP `Host` values, including ports where required. `DOHC_SHARE_WEB_PORT`
defaults to `1790`.

Set `DOHC_SHARE_WEB_DEV=1` only with `NODE_ENV=development` or
`NODE_ENV=test`. Production startup fails when the viewer build is missing.
Run `pnpm --filter @dohc/share-web build` before production startup.

The session cookie always has the `Secure` attribute. Local development must
use `localhost`, where browsers accept Secure cookies without production TLS.
