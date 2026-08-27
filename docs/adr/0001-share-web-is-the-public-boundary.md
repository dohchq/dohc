# share-web is the public web boundary, not the relay

Share links give dohc its first unauthenticated surface. That surface lives in a new service, `services/share-web`. It serves the viewer, the link endpoints, live-session websockets, and published apps. The relay stays a bearer-only JSON service with its fail-closed refusal discipline intact, and `share-web` applies the same discipline (generic 404s, no existence or level oracles) on its public routes.

The relay owns link grants and link-secret verification. `share-web` exchanges a presented secret at one narrow internal seam, authenticated by workload identity, for a short-lived capability bound to one grant and generation. `share-web` never holds standing workspace authority, never reads the relay's storage directly, and never re-implements selector authorization.

## Considered options

- Grow the relay: fewer services, but bolts anonymous HTML and websocket serving onto the one component whose whole security posture is "every route authenticates."
- Static viewer on a CDN hitting the relay via CORS: still needs public relay endpoints, plus a cross-origin auth dance.
- A broad service credential for `share-web`: one route bug would make the public service a deputy for every workspace.
