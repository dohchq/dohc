# @dohc/sdk

The default `dohc` export assumes a browser preview context with a dohc host
window. In SSR or Node.js, import `createDohcClient` and provide an explicit
transport instead.

For `file://` dohc hosts, browser `postMessage` requires sending requests with
target origin `"*"`. Response source and origin checks still guard replies, but
request messages are visible to iframes on the page, so prefer normal dohc
preview origins when isolation matters.
