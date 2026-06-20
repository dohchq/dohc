---
id: site-preview-security
title: Site Preview Security
---

# Site Preview Security

Desktop Sites render ordinary local websites through dohc-controlled preview
infrastructure. The security model has three layers.

## Loopback-Only URLs

Preview URLs must be unauthenticated HTTP URLs on exact loopback hosts. The
renderer validates URLs with the shared loopback helper before embedding them,
and the main process only grants preview origins that come from dohc-owned
static/dev/build preview handles.

## Exact Message Origins

SDK traffic uses `postMessage`, but the parent only accepts messages from the
mounted iframe window and the exact preview origin. A page on another origin,
another frame, or a stale preview cannot reuse the bridge.

## Sandboxed Iframe

The iframe uses `sandbox="allow-forms allow-same-origin allow-scripts"`.
`allow-same-origin` is required so localhost previews keep a real loopback
origin instead of becoming `"null"`, which lets the parent perform exact
origin checks. `allow-scripts` lets normal web apps run. `allow-forms` keeps
ordinary local forms usable inside previews.

The sandbox is not treated as the authorization boundary. Privileged dohc
operations still pass through dohc IPC and server-side policy. Loopback URL
restriction, exact origin matching, and dohc-owned preview processes work
together so a site can render like a normal website without gaining ambient
workspace or cloud authority.
