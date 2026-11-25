---
status: accepted
---

# Collection workspace defaults live on the server beside folder access rules

This records a design from [the team apps and Collections plan](../plans/team-apps-and-collections.md).

Transactional Collections require explicit operation grants so no app or folder share can widen access by accident. Granting operations one person at a time does not scale when a team of 30 to 100 people joins a workspace. To reconcile explicit Collection capabilities with workspace roles, each Collection can opt in to workspace defaults keyed by folder access level (`View`, `Comment`, `Edit`), capped by folder access rules ([ADR 0017](0017-folder-access-rules-live-on-the-server.md)).

Those defaults live on `sync-relay`, not inside `dataset.json`. Existing Collections default to no operations until the Owner or an Admin configures defaults for that Collection. Operations marked `owner` can never appear in workspace defaults. When a person's effective folder level on a Collection is `View` or `Comment`, only `readOnly` operations can run through workspace apps. Because Admins hold `Edit` reach on every folder, Admins inherit a Collection's `Edit` workspace defaults plus any explicit per-person grants. Explicit per-person grants remain available for narrow exceptions.

The defaults carry a revision token folded into each caller's checked authority token, so narrowing defaults takes effect immediately and aborts in-flight commits.

## Considered options

- **Store workspace defaults inside `dataset.json` as part of the approved Collection revision.** Rejected. Changing which team level can call an operation is an access-control decision, not a schema or code change. Putting it in `dataset.json` would force a new Collection revision whenever permissions change, and copying or exporting a Collection into another workspace could carry unintended open defaults.
- **Keep per-person `dohc_dataset_data_grants` only.** Rejected. Every new hire joining a team workspace would see zero operations on every transactional Collection until someone granted each Collection by hand.
- **Unlock `link`-access operations automatically from folder visibility alone.** Rejected. A Member with `View` access on a folder could trigger `link`-access write operations without anyone explicitly opting that Collection into team access.

## Consequences

- Adjusting a Collection's workspace defaults never changes its schema revision and never invalidates bound apps.
- Admins can manage workspace defaults and per-person grants for existing Owner-approved Collections in Phase 1 without gaining authority to approve new Collection SQL or operation code.
- Exporting a workspace does not export server-side Collection defaults, matching [ADR 0017](0017-folder-access-rules-live-on-the-server.md) for folder access rules.
