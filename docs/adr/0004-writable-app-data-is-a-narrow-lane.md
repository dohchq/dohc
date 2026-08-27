# Writable app data is a narrow, owner-approved lane

Published apps must let link holders act: a trip poll that waits for owner approval per vote is dead. But a general writable-data interface for anonymous strangers is unshippable. The lane is narrow: owner-approved app data is the only non-document application state a link holder may change without a proposal, and v1 ships at most one typed create-only collection with a fixed schema, idempotency keys, server-set principal fields, per-grant quotas, append-only history, and one owner-visible bulk undo. Update-own-row arrives only when a real app requires it. Files are never part of this lane.

Before this lane ships, the design must name the authoritative store for app data and its sync, export, backup, restore, and deletion path, for dohc Cloud and self-hosters alike. A "writable" boolean is not an authorization model; capabilities name the app publication, dataset, operation, and row policy.

## Consequences

- Apps execute only in the visitor's browser on an isolated per-publication origin, against a data API scoped to the owner's approval; `share-web` never runs owner-authored code.
- The approval is the security boundary. Widening it silently, through defaults, wildcards, or inherited workspace authority, is the failure mode to refuse in review.
