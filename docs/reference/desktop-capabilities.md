# Desktop capabilities

Use this reference to check which platform and services a feature needs.

| Capability | Requirements |
| --- | --- |
| Local workspaces and editing | Desktop app. No account or server. |
| Sync between devices | Reachable self-hosted services, an account, and workspace authorization. |
| Sharing with named recipients | Reachable sharing services, recipient identity, and a share grant. |
| Browser access through a share link | Reachable share-web and relay services, with the owner's selected access. |
| Shared live document editing | A configured session host and the relay's required admission settings. |
| Publish an app from the packaged desktop | Windows x64, an Apple silicon Mac with macOS 13.5 or later, or Linux x64 with Linux 5.13 or later and Landlock enabled, and a server configured to accept app publishing. |
| Create a Collection and its actions | Desktop app on Windows x64, an Apple silicon Mac, or Linux. No account or server. |
| Create and run a local Collection-backed app | Windows x64, an Apple silicon Mac with macOS 13.5 or later, or Linux x64 with Linux 5.13 or later and Landlock enabled, with the bundled app compiler and dataset runtime. No account or server; the approved app opens in a local browser session. |
| Share an app with private data | App publishing plus backend-enabled relay services. The shared host must be reachable to confirm operations. |
| Manage app data through tables or an agent | An approved transactional Collection; table edits and app operations use the same dataset rules. |
| Run the bundled MCP launcher | The installed desktop app on Windows x64 or Apple silicon Macs. dohc supplies Node.js. Linux needs Node.js 22.13+, 23.4+, or 24+ on `PATH`. |
| Agent replies through MCP or `dohc chat reply` | An installed agent and the desktop app. dohc supplies the reply runtime on Windows x64 and Apple silicon Macs. Linux needs Node.js on `PATH`. |
| dohc Drive | Coming soon. The managed service is not available for launch. |

The supported self-host bundle supplies the session host and live-editing limits.
Live editing covers existing Markdown documents on the main version.
Moving, deleting, or replacing an enrolled document pauses its live editing.
The server preserves its accepted state; it does not silently bind that state to a different file.

Releases ship for Windows x64, macOS arm64 (Apple silicon), and Linux x64.
There is no build for Intel Macs.
On macOS, move dohc to Applications before saving an MCP configuration.
On Linux, dohc keeps the AppImage's MCP launcher at a stable path.
If you move or rename an installed app, create its MCP configuration again.

Every release target compiles Collection actions. App publishing and local app
launch need the installed app compiler. It ships for Windows x64, Apple silicon
Macs with macOS 13.5 or later, and Linux x64 with Linux 5.13 or later and Landlock
enabled. Linux arm64 does not include the app compiler's Node.js runtime.
Reading a shared app in a browser does not require that compiler.

The [app backend guide](../how-to/app-backend.md) covers local launch, sharing,
owner management, and recovery. Shared app data has one authoritative host;
the desktop does not independently accept its writes while that host is offline.

A private server requires recipients to have network access. Public HTTPS
hosting can support browser links without a private network. Hosting does not
grant workspace access; the server still enforces each share's permissions.

Self-hosting and dohc Drive use the same collaboration model. Their distinction
is who operates the services.

Check your server's configuration before using sync, browser sharing, live
editing, or app publishing.
