# @dohc/sdk

The default `dohc` export assumes a browser preview context with a dohc host
window. In SSR or Node.js, import `createDohcClient` and provide an explicit
transport instead.

## Security Note: file:// Previews

For `file://` dohc hosts, browser `postMessage` requires request `targetOrigin`
`"*"` because there is no stable origin to target. Response source and origin
checks still guard replies, but they cannot protect request payloads already
sent to the page: every script on that `file://` page can observe request
parameters. Workspace-relative paths passed to APIs such as `files.read(path)`
are acceptable because authorization is enforced by the dohc host, but do not
send absolute file paths, user identities, workspace IDs, internal state,
tokens, or other sensitive data in `file://` request messages. Authorization
and user identity validation must always happen in the dohc host/server layer;
browser callers are untrusted. `file://` sandboxing is inherently weaker than
an HTTP(S) origin, even though response validation still checks `event.source`
and response data remains origin-checked. Production sites should be previewed
over HTTP(S) for full origin isolation. Prefer normal dohc preview origins, or
another restricted same-origin transport, when the app needs isolation.
