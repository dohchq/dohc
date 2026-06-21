---
id: site-sdk
title: dohc Site SDK
---

# dohc Site SDK

Sites are ordinary website folders first. They only become dohc-aware when
they import `@dohc/sdk` and run inside a dohc preview host.

## Local Workspace Reads

The desktop preview host can expose a bounded `files.read` capability through
the SDK. When enabled, a site may call the SDK to read text from the local
workspace, not only files inside the site folder. This is intentional: a site
can be a dashboard over notes, CSV files, JSON, markdown, or shared-with-me
files that already exist in the user's local workspace.

The browser site does not provide identity, workspace authority, or raw file
access. SDK calls go through the dohc host bridge and the
`readWorkspaceText` IPC path. Authorization, workspace scope, locks, sharing
boundaries, and future review gates are enforced by dohc-owned code, not by
trusting the website's JavaScript.

If the host does not advertise `files.read`, SDK file reads fail with a
capability-disabled error. Plain websites remain previewable without the SDK.
