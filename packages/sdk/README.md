# @dohc/sdk

The default `dohc` export assumes a browser preview context with a dohc host
window. In SSR or Node.js, import `createDohcClient` and provide an explicit
transport instead.

For `file://` dohc hosts, browser `postMessage` requires request `targetOrigin`
`"*"` because there is no stable origin to target. Response source and origin
checks still guard replies, but they cannot protect request payloads already
sent to the page. Do not put user identities, workspace IDs, file paths,
internal state, tokens, or other sensitive data in `file://` request messages.
Authorization and user identity validation must always happen in the dohc
host/server layer; browser callers are untrusted. Prefer normal dohc preview
origins, or another restricted same-origin transport, when the app needs
isolation.
