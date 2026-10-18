# Security boundaries

Use this reference when changing sharing, app execution, datasets, or automations.
The product invariants remain in [AGENTS.md](../../AGENTS.md).

## Grants authorize each action

The relay owns share selectors, grants, and link credentials. It derives authority
server-side and checks current access at reads and authoritative commits.
Browser identities provide provenance, not additional authority.
See the [grant transitions](share-grants.md) when changing generations or credentials.

Share-web exchanges a link secret for a scoped relay capability. It has no standing
workspace authority and does not read relay storage directly. Keep generic public
refusals, origin checks, and credential isolation.
The [operations reference](../../services/share-web/README.md) defines deployment controls.

## Live documents have one canonical host

The session host holds the canonical Y.Doc. It journals accepted updates durably
before acknowledgement and settles Markdown through the engine.
With no host online, shared files remain readable but live editing pauses.
Automatic device-to-service failover requires fences against competing writers.

Direct Edit requires commit-time grant checks, durable attribution, and stop and
restore. Restore creates a forward change and preserves legitimate unsynced work.
It cannot promise selective removal of one author's interleaved edits or recovery
of work already deleted before the restore point.

## App approval pins code and capabilities

A manifest requests capabilities. Only an immutable, owner-approved publication
grants them. Changed source, dependencies, or capabilities require a new review.
Apps receive only approved data and operations, subject to current grants and
server policy. Their browser origins remain isolated from viewer credentials.

Collection-create responses are ordinary shared files. Anyone with the share can
read every response field, including fields outside `readFields`.
Private responses require a dataset with explicitly authorized reads.

Frontends can contact external services and send received data elsewhere.
Approval does not certify app behavior. Withdrawal stops later authorized dohc
reads and writes; it cannot recall data or stop a loaded app's external traffic.
Keep these limits visible during approval and launch.

The fixed compiler reads declared inputs and bundles approved dependencies.
It does not run app-provided configuration, plugins, build hooks, or source.
Remote scripts stay blocked. On Windows, the compiler's process limits and
minimal environment do not provide OS network denial. On macOS, Seatbelt also
denies the network, reads of file contents other than the compiler's, the OS
libraries' and the build directory's, and writes outside the build directory.
It does not stop a compromised worker reading other processes' arguments and
environment. [App compiler containment](app-compiler.md) states what each
platform bounds. Arbitrary build scripts need a separate, credential-free sandbox before
they can run.

## Dataset hosts commit authority

A transactional dataset's checkpoint and committed journal are authoritative.
Isolated workers evaluate approved operations and materialize committed events.
The host rechecks access and commits changes, retry receipts, history, file
associations, quotas, and the revision together. Recovery applies committed events
without rerunning authored code.

Collections, apps, forms, imports, and agent tools use that authority.
Document Collections keep record properties in the live document's frontmatter
map and project them to Markdown on settlement, without a second field writer.
Shared datasets have one configured writer; unavailable hosts cannot accept
offline shared writes. Cross-dataset transactions are unsupported.
See the [runtime contract](../../packages/app-backend-runtime/README.md).

## Automation edits do not widen access

An automation can reach only what all its Collection's editors can reach.
The executor checks each target even when it runs on the owner's computer.
Personal steps use one person's access and remain limited to Collections only
that person can edit. Sharing can stop steps that exceed the editors' common access.

When unchanged steps become allowed after an editor is removed, a current editor
must confirm them. Removing an editor cannot silently activate their stopped code.

Record-triggered runs originate on the device that journals the triggering change.
Schedules, Group messages, and buttons pressed in a received share run on the
configured automation host. Shared presses require the presser's current named
Edit grant and expire after 30 days if unclaimed. Revoked presses cannot run.
Claims and idempotent workspace writes bound crash retries; they do not provide
exactly-once external effects.
The [reach tests](../../packages/automation-executor/src/automationReach.test.ts)
and [verdict tests](../../packages/automation-executor/src/reachVerdicts.test.ts)
cover the access rules.

## Direct Collection writes stay narrow

Edit on a Collection permits validated changes to its `collection.yaml` and
`automations.yaml`. Named recipients and Edit link holders can also create a
Collection with its first records inside a shared folder.
Named recipients must choose to propose other file changes.
Link holders cannot submit proposals, so unsupported changes are refused.
A dependent named grant needs promotion before it receives this direct lane.
Edit link holders can change the Collection's own files, with their grant and
server-minted link principal recorded as authors.

The relay checks current grant generation, expected file state, and content before
commit. The owner's engine admits only the allowed files and authors from the
relay's origin. Each author kind requires working stop and restore.
See the [Collection write tests](../../services/sync-relay/src/collectionWrites.test.ts).

## Link history follows continuous sharing

A link can read earlier revisions only while the same file remains continuously
inside its share and the revision remains above the workspace's epoch floor.
Deletion or movement outside the share withdraws that file's history immediately.
Moving it back does not restore earlier access. A content hash alone grants nothing.

An overwrite leaves previous content readable within retention. Removing sensitive
text from a link requires withdrawing the file or revoking the link.
Every read rechecks current authority and uses bounded history scans.
See [share reads](../../services/sync-relay/src/shareReadQueries.ts).

## Decision numbers in existing code

Existing comments cite the former ADR numbers. Their current boundaries are here:

| Former decisions | Current reference |
| --- | --- |
| ADR 0001, ADR 0005 | [Grant authority](#grants-authorize-each-action) and [grant transitions](share-grants.md) |
| ADR 0002, ADR 0003 | [Live documents](#live-documents-have-one-canonical-host) |
| ADR 0004, ADR 0006 | [App approval](#app-approval-pins-code-and-capabilities) |
| ADR 0007, ADR 0010, ADR 0011 | [Dataset and document authority](#dataset-hosts-commit-authority) |
| ADR 0008, ADR 0012 | [Automation access](#automation-edits-do-not-widen-access) |
| ADR 0009 | [Hosting requirements](../reference/desktop-capabilities.md) and [local ownership](../../AGENTS.md#product-commitments) |
| ADR 0013 | [Direct Collection writes](#direct-collection-writes-stay-narrow) |
| ADR 0014 | [Link history](#link-history-follows-continuous-sharing) |
