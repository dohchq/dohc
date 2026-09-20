# Desktop capabilities

Release owners use this reference to decide which capabilities they can claim
for a tested build. A configured release target is not evidence that its
installer has passed the [release rehearsal](../how-to/desktop-release.md).

| Capability | Requirements |
| --- | --- |
| Local workspaces and editing | Desktop app. No account or server. |
| Sync between devices | Reachable self-hosted services, an account, and workspace authorization. |
| Sharing with named recipients | Reachable sharing services, recipient identity, and a share grant. |
| Browser access through a share link | Reachable share-web and relay services, with the owner's selected access. |
| Shared live document editing | A configured session host and the relay's required admission settings. |
| Publish an app from the packaged desktop | Windows x64 and a server configured to accept app publishing. |
| Run the bundled MCP launcher | Node.js 22.13+, 23.4+, or 24+ on `PATH`. The desktop runtime does not supply Node to MCP. |
| dohc Drive | Coming soon. The managed service is not available for launch. |

The release workflow builds Windows x64, macOS x64, macOS arm64, and Linux x64.
App publishing has a narrower platform boundary because its installed compiler
currently ships a Windows x64 runtime. Reading a shared app in a browser does
not require that compiler.

A private server requires recipients to have network access. Public HTTPS
hosting can support browser links without a private network. Hosting does not
grant workspace access; the server still enforces each share's permissions.

Self-hosting and dohc Drive use the same collaboration model. Their distinction
is who operates the services. Drive's planned free tier and managed setup do not
justify restricting self-hosted capabilities.

These requirements describe the code's boundaries. Verify the installed server
configuration before claiming that sync, browser sharing, live editing, or app
publishing is available.
