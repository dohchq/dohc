---
id: guest-preview-security
title: Guest Preview Security
---

# Guest Preview Security

dohc shows plugin panels and plugin web apps as ordinary local web pages on
loopback origins dohc controls. The security model has three layers.

## Loopback-Only URLs

Preview URLs must be unauthenticated HTTP URLs on exact loopback hosts. The
renderer validates URLs with the shared loopback helper before embedding them,
and the main process only grants origins that come from preview handles dohc
owns.

## Exact Message Origins

SDK traffic uses `postMessage`, but the parent only accepts messages from the
mounted iframe window and the exact guest origin. A page on another origin,
another frame, or a stale guest cannot reuse the bridge.

## Sandboxed Iframe

The iframe uses `sandbox="allow-forms allow-same-origin allow-scripts"`.
`allow-same-origin` is required so a loopback page keeps a real origin instead
of becoming `"null"`, which lets the parent perform exact origin checks.
`allow-scripts` lets normal web apps run. `allow-forms` keeps ordinary local
forms usable inside a guest.

This combination is intentionally treated as minimal UI containment, not a
security boundary. A same-origin scripted page can effectively escape many
iframe sandbox restrictions, so dohc must never rely on this attribute for
authorization, workspace isolation, or cloud access control.

Privileged dohc operations still pass through dohc IPC and server-side policy.
Loopback URL restriction, exact origin matching, preview processes dohc owns,
path containment, and SDK capability checks are the real controls. A future
host that needs stronger containment should add a dedicated unguessable origin
or stricter Content Security Policy rather than assuming the iframe sandbox is
enough.
