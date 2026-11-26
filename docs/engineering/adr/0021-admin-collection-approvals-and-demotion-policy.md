---
status: accepted
---

# Admins approve Collection rules as themselves, and a demotion never stops a live Collection

A team workspace needs more than one person who can create a transactional Collection or change its rules. [ADR 0020](0020-collection-workspace-defaults-live-on-the-server.md) let Admins manage grants and defaults on Collections the Owner approved, but only the Owner could approve `schema.sql`, `operations.ts`, and migrations. This ADR lets an active Admin approve them too, on Collections the relay hosts.

An Admin approves as themselves. The dataset host takes a governance authority, separate from the data authority that operations run under. An Owner's governance authority is their owner authority. An Admin's names their member entry, member grant, and that grant's generation. The host records this authority when an approval starts and checks it again inside the commit's transaction. An Admin who is demoted, removed, or fenced between preparing a migration and approving it fails at commit. Governance authority never reaches data, invoke, or app paths, so an Admin who approves rules gains no new data access.

Admins can create and activate a Collection, read its approved artifacts, and prepare, preview, approve, and discard a migration. Deletion, raw SQL, recovery import and export, bulk changes, archive and restore, and approvals for secrets and outside calls stay with the Owner.

Each approved revision records who approved it: their user id and their role at the time (`dohc_dataset_approvers`). A recovery file carries the record, so restoring a Collection keeps it. Deleting the approver's account clears the user id and keeps the role.

When an Admin who approved the live revision stops being one, the Collection keeps running. Removing someone must never take down the apps and forms that depend on what they built. The relay derives `needsOwnerConfirmation` from current membership on each read: the approver was an Admin, and is no longer an Admin or the Owner. The Owner sees "Approved by <name>, former Admin" and can confirm the live revision in one step. Confirming records the Owner as its approver. It doesn't run a migration or write history, and it refuses if the rules changed since the Owner looked.

## Considered options

- **Let an Admin act as the Owner, as Collection grant management does.** Rejected. It would record the Owner as approver of rules they never saw, and an Admin's demotion would not stop an approval already in flight.
- **Pause a Collection whose approver loses the Admin role.** Rejected. Removing a person would break signup forms and shared apps that other people depend on, with no warning to them.
- **Keep approvals Owner-only.** Rejected. One person would gate every schema change in a team workspace.
- **Let Admins approve on Collections hosted on the Owner's computer.** Rejected for now. That host can't check a member's current role at commit, so the desktop refuses and says to move the Collection to the server.

## Consequences

- An approval always names a real person and role. A deleted account shows as "a former Admin".
- Demoting an Admin takes effect at the next commit check, including approvals already running.
- Confirming an approval changes no rules and invalidates no app bindings.
