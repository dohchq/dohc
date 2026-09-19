# Hosting does not change workspace capabilities

dohc works locally without an account or server. Sync and sharing use services that users can self-host or, when available, obtain through dohc Drive.
Drive takes responsibility for operating those services. Its convenience includes setup, availability, and sharing with people outside the owner's network.
Self-hosting must provide the same collaboration capabilities through a supported configuration. We do not restrict self-hosting to make Drive more attractive.

Clients name the capability "Sync and sharing" and identify the connected server. "dohc Drive" names only the managed offering.
Drive remains coming soon until the managed service launches. Endpoint configuration alone must not advertise its availability.

Private-network access and workspace permissions are separate requirements. A Tailscale route makes a server reachable by authorized network participants; it grants no workspace access.
A public self-hosted server can support browser share links without requiring recipients to join a private network.
Anonymous participation remains scoped to the owner's share grant, regardless of hosting.

Server connection setup discovers service addresses. It does not grant workspace access, change a workspace's server, or send an existing session to a different server.
Local work remains usable when the server is unreachable. The interface distinguishes signing in, connecting, and completing synchronization.
