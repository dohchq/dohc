---
status: accepted
---

# Member apps cap every viewer to both the author's and viewer's reach

This records a design from [the team apps and Collections plan](../plans/team-apps-and-collections.md).

A Member or Admin can share a Member app inside a workspace without waiting for the workspace Owner to approve it. Every call a Member app makes to a Collection runs under the intersection of four caps: the operations the app declares, the author's current Collection grants, the viewer's current Collection grants, and the exact operation set the viewer approved on first open. When the lower of the author's and viewer's folder levels on that Collection is below Edit, only read-only operations run.

This cap applies even when the workspace Owner or an Admin opens a Member app. The Owner never runs a Member app with `owner` authority, and a Member app can never run an `owner`-only operation. Without the author cap, a Member could publish an app whose frontend calls delete or write operations the Member cannot run, and those calls would run with the Owner's or an Admin's access as soon as that person opened the app.

The server evaluates both the author's and the viewer's membership, folder access rules, and Collection grants on every call and again inside the commit transaction, folding all of them and the consented scope digest into the checked authority token. Removing the author, lowering either person's folder rule, revoking either person's grant, or withdrawing the Member app ends access and aborts in-flight commits.

## Considered options

- **Cap only by the viewer's reach (`declared ∩ viewer`).** Rejected. This creates a Member-to-Owner and Member-to-Admin confused-deputy escalation whenever a higher-privilege user opens a Member's app.
- **Require Owner approval for every team app.** Rejected. That keeps the Owner as a bottleneck for routine internal tools and slows down teams building on shared Collections.
- **Trust a Member app's initial consent forever on its `publicationId`.** Rejected. If a viewer approves a read-only Member app and later receives a write grant on the same Collection, an already-declared write operation would start working without a second review. Pinning consent to the reviewed effective-operation digest prevents silent widening.

## Consequences

- A Member app stops working immediately when its author leaves or is removed from the workspace. To keep a critical tool running, the Owner reviews its source and publishes it as an official Workspace Publication.
- Changing any source file, dependency, or declared capability produces a new immutable revision and requires every viewer to review it again before opening the new version.
- Consent comes only from a browser sign-in through the viewer, so an agent using the desktop's sign-in cannot approve a Member app on its person's behalf. The author's own app opens for them without review, because their reach already bounds it.
- Official Owner-approved Publications remain distinct in `CONTEXT.md` and open for workspace members without a first-open Member app review.
