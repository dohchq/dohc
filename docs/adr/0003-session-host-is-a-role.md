# The session host is a configured role, one holder per deployment

A live document session needs one host holding the canonical Y.Doc and settling it. The host is a role a deployment configures, not a fixed place: dohc Cloud runs a session service as the host; a self-hoster runs the same module or chooses device-only hosting, where the owner's device holds the role and browsers reach it through `share-web` acting as a pipe (NAT stops browsers connecting to a device directly). With no host online, shared work stays viewable from the relay replica and live editing pauses behind a plain banner.

Automatic movement of the role between device and service is deferred. Without durable leases, monotonic epochs, append-before-acknowledge journaling, and transactional stale-epoch refusal, a suspended device and a service can both accept and settle writes. Yjs merges concurrent updates, but settlement, lineage, and acknowledgement are not resolved by CRDT merge. Host movement becomes a protocol with those fences, proven by a partition prototype, before it becomes a feature.

## Considered options

- Service-hosted only: hollows out self-hosted live editing into a mandatory extra stateful service.
- Device-hosted only, everywhere: a closed laptop kills the flagship "group edits while the owner sleeps" scenario dohc Cloud exists to serve.
- Automatic device-first failover in v1: the dual-writer settlement problem above, hidden behind a routing feature.

## Consequences

- `share-web` is not a dumb pipe: it authenticates upgrades, validates origins, enforces limits, and closes invalid sessions. It does not interpret Yjs semantics.
- dohc Cloud's advantage is keeping sessions alive, not a capability self-hosters are denied.
