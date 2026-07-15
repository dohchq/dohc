---
id: site-sdk
title: dohc Site SDK
---

# dohc Site SDK

Sites are ordinary web projects. They can be plain HTML, CSS, and JavaScript,
or use any normal web framework. A site becomes dohc-aware when it imports
`@dohc/sdk` and runs in a dohc preview.

`dohc_add_sdk` installs the version-matched SDK from the desktop app into the
site at `vendor/dohc-sdk` and adds a local package dependency. This works
offline and does not depend on an npm publication.

Package/bundled projects import `@dohc/sdk`. Plain static HTML sites import
`./vendor/dohc-sdk/dist/index.js` (adjusted relative to the importing module),
because browsers do not resolve bare package specifiers without a bundler or
import map. The tool reports the applicable `importMode` and example usage.

## Authority model

The SDK is an app bridge, not a second permissions system. A locally owned site
acts with the current user's authority in the current workspace. Capability
discovery reports which host APIs exist in the current context; it does not ask
the user to approve each call.

The dohc host still owns collaboration boundaries:

- Browser code never supplies its own user identity or workspace identity.
- An owned site can read, list, write, and search workspace files, inspect and
  edit databases, and open workspace items through the APIs the host exposes.
- A shared site inherits only its `shared-with-me/<label>` mount. Paths are
  projected relative to that mount and writes are unavailable.
- A whole shared view is read-only.
- The host re-derives site and share authority for every request.

Plain websites remain previewable without the SDK. New host capabilities can
be used immediately through `dohc.request()` or `dohc.subscribe()` while a
typed convenience API is being added.

## Sharing sites

Owned sites use the normal dohc share flow. Recipients mount them under
`shared-with-me`, see them in Sites, and open them in a normal editor tab. A
recipient runs the shared browser artifact in static mode; dohc does not run
foreign package scripts. Copying a shared site into owned files gives it the
recipient's normal local authority.
