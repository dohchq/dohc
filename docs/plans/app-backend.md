# A general-purpose backend for workspace apps

Reader: Ice and the engineers implementing app data, execution, sharing, and owner management.

Status: proposed design, September 21, 2026. The product target is agreed; the architecture below is a recommendation. No implementation or runtime verification is complete. Terms used for proposed mechanisms are descriptive, not additions to the canonical glossary.

The [fundraiser case](fundraiser-app.md) records the agreed requirements and inspected example. The goal is a backend that owners use through their agents and dohc's interfaces. An owner should not need a separate database, storage, or hosting account for each app. App authors retain control over their schema, logic, interface, and external integrations.

## The owner builds an app, not infrastructure

An owner asks their agent to build an app. The agent creates its source, data definitions, backend operations, and tests in the workspace. The owner can inspect and change that work through dohc or ordinary development tools.

The app runs locally without an account. Sharing uses a configured self-hosted server first and, later, dohc Drive. Publishing presents the app's requested data and operations for owner approval. Friends open the resulting link in their browsers. Organizers authenticate for the additional operations they have been granted.

The owner manages the same data through a table interface, an admin app, or their agent. Editing through one interface must not bypass a rule enforced by another. General data management should work without a custom dashboard; authors can build one when it helps.

## What exists and what must change

| Existing implementation | Reuse | Missing behavior |
| --- | --- | --- |
| Immutable app publications and isolated browser launch | Source capture, approved revisions, launch identity, withdrawal | Backend revision and data-schema compatibility |
| Published collection list and create | Scoped requests, submission receipts, quotas, provenance | General queries, updates, relationships, trusted custom operations |
| Collections backed by document frontmatter | Human table controls, familiar field editing, agent access patterns | Enforcement of cross-record rules; current validation flags invalid data and preserves it |
| Local SQLite files and database editing | Portable storage and existing database management entry points | Shared transaction authority, backend policy enforcement, durable transaction replication |
| Workspace files and sharing | Ownership, existing storage mechanisms, history patterns | Public uploads that do not expose private workspace files |

Relevant source:

- [Publication contract](../../packages/security-contract/src/appPublication.ts): permits at most one collection capability.
- [Published collection transport](../../services/share-web/src/appCollectionBroker.ts): dispatches list and create.
- [Relay collection storage](../../services/sync-relay/src/storage/appCollections.ts): commits a submission, receipt, and workspace log entry in a relay transaction.
- [Collection schema](../../packages/workspace-contracts/src/collection.ts) and [collection plan](collections.md): typed document records with permissive validation.
- [Local database edit](../../apps/desktop/src/workspaces/workspaceDatabaseCore.ts): uses a local SQLite transaction and a separate operation log. This is not evidence of a distributed transaction protocol.
- [SDK](../../packages/sdk/src/index.ts): exposes local database reads and edits; those methods are not the published browser contract.

## Recommend transactional storage for data with strict rules

Use a workspace-owned transactional database for app data that needs relationships, uniqueness, and atomic changes across records. Evaluate extending the existing SQLite feature before introducing another database product. The implementation must prove durable commits and replication; using SQLite alone does not provide those guarantees.

Keep ordinary collections' current document behavior. They remain useful for notes, planning, and freely editable records. Do not silently give document merging a new promise about cross-record consistency.

Reuse suitable collection controls for viewing database-backed data. This is a view of the authoritative data, not a second set of editable Markdown records. The glossary currently defines a Collection as a folder of Markdown records. Calling a database table a Collection would require an explicit vocabulary and contract decision.

Authors declare database constraints and checks that every supported write must satisfy. They can also define named operations for changes that need several steps. Direct field editing remains available where those constraints permit it; a state transition can require a named operation. For example, changing a registration to rejected releases its slots in the same transaction.

All supported write paths must enter the same enforcement module: browser requests, desktop edits, agent tools, imports, and replicated changes. No general SQL or file-edit route may bypass the rules on a database governed this way. Owners still control their local files. External modifications must be detected and reconciled or treated as an explicit import; they cannot silently become trusted shared commits. The exact detection and recovery path must be designed before implementation.

### One host confirms shared transactions

For an unshared app, the local device executes transactions without a network connection. Once the owner shares a database, one configured host orders and confirms its transactions. The host may be the owner's online computer or a self-hosted server. Drive later operates the same capability.

A disconnected device retains its downloaded data, source, and ability to prepare changes. An operation requiring shared consistency cannot report success until the configured host commits it. A draft is visibly distinct from an accepted change. Independent local work remains usable.

Do not automatically promote an offline replica into a competing writer. Moving authority requires fencing the previous writer, transferring committed state and retry receipts, and verifying recovery. Multiple devices independently accepting the final available slot cannot preserve a single capacity limit through last-writer-wins merging.

This proposal trades offline confirmation of shared transactions for consistent outcomes. It does not require an account for local apps. Confirm this product behavior before implementing shared transaction authority.

## Keep custom backend code separate from the sharing service

Let agents author ordinary backend logic against a small workspace-scoped interface. A proposed interface has query, invoke-operation, and file-transfer functions. Concrete names and types should follow a prototype. Avoid requiring a fundraiser-specific API or a new workflow language.

An operation receives a verified caller, validated input, and access only to approved data. It can read and change related records within one bounded transaction. It returns a result or a structured refusal. The trusted host enforces declared constraints and commits data, history, and the retry receipt together.

Execute authored logic in an isolated runtime outside Electron main, the relay process, and `share-web`. It must not inherit host credentials, arbitrary workspace paths, database-admin credentials, or unrestricted process access. A worker thread or language VM alone does not establish this isolation. Runtime selection needs a concrete Windows and Linux security and performance evaluation.

Keep network calls and other external effects outside retriable database transactions. A failed transaction may run again; sending a payment or message twice is unacceptable. External integrations need an explicit effect interface with secrets scoped to the operation, durable status, and stated retry behavior. Do not claim exactly-once external delivery. The fundraiser's external transfers do not require a payment processor integration.

Pin backend code and its dependencies alongside the approved frontend revision. Keep secrets outside published source and bundles. Schema changes need a compatible activation sequence, backup, and recovery path. Restoring older code must not silently restore an incompatible schema or erase transactions accepted after publication.

## Separate participation from access to private data

A link can authorize a person to invoke an operation without authorizing them to browse the underlying database or upload folder. The owner approves the operation's data reach. The caller's grant controls which operation may run and what results the caller may receive.

The host derives identity from authenticated sessions or link credentials. Client-supplied roles and user IDs grant no authority. An organizer's account does not automatically grant access to every app or the surrounding workspace. Apply the same authorization to human and agent calls.

This requires changing the current coupling between app data and the link's shared-file selector. Today, [publication preparation](../../apps/desktop/src/workspaces/ownerAppPublication.ts) requires the collection inside that selector. [Ordinary link reads](../../services/sync-relay/src/linkReadRoutes.ts) separately expose selected files. An app's filtered fields are therefore not sufficient evidence that its underlying responses are private.

Reproduce that concern with synthetic data before claiming a vulnerability. Then prove that an upload or submission grant cannot list or fetch other participants' records, including through file, blob, log, history, and alternate app routes. Broader file access must require a separate explicit grant.

## Uploads are workspace files with scoped access

Support images, PDFs, and other allowed files through one upload mechanism. A receipt is a file referenced by a registration. S3-compatible storage is a possible storage implementation, not a requirement that each owner configures.

An upload authorization names the workspace, app operation, limits, and permitted association. The host chooses storage identity and verifies actual bytes and size. Client paths and claimed content types do not establish authority. Uploaded content remains untrusted when previewed or downloaded.

Stage the upload first. The registration transaction attaches a completed file to its record. Incomplete or abandoned uploads have bounded lifetime and storage usage. A committed registration must not reference an unfinished upload; cleanup must not delete an attached file. Define recovery for a crash between blob persistence and the database commit.

Reading a file requires current permission, including when its identifier is known. Prefer authenticated reads where immediate revocation is required; any signed URL must have an explicit expiry and revocation limitation. Source publication and workspace export must not accidentally include private uploads in a public bundle.

## Make durability and performance part of the interface

A successful operation means its data, provenance, and replay result are durable. A repeated request with the same identity and payload returns the original result; reusing the identity with different input refuses. Retain enough state through backup, restore, deletion, and compaction to preserve that promise.

Replicas apply committed transactions without rerunning authored logic or external effects. Do not independently synchronize the same governed state as both mutable files and database operations. Define transaction ordering, replica freshness, restart recovery, and authority transfer before adding write clients.

Owners can export and recover their schema, data, files, and source. A working local copy must remain more useful than an opaque remote cache. A consistent backup also includes policies, operation receipts, and references needed to recover file associations. A fresh self-hosted deployment must restore and continue the app without depending on the old service.

Bound query work, transaction duration, upload storage, and operation execution. Keep database and authored-code work off the desktop UI thread. Use indexed, paginated queries for owner views. Measure local startup, operation latency, concurrent requests, and replica catch-up before setting performance claims.

## Build in this order

1. Test the current submission privacy concern with a real relay and synthetic records. Preserve the result as a regression test.
2. Resolve the transaction host, offline behavior, and relationship between database data and collection views. Compare the existing SQLite implementation with the required durability contract. Select an isolated runtime through a focused prototype.
3. Implement one generic operation path that spans multiple records, validates the caller, enforces constraints, and survives retries and crashes. Prove it through browser, owner, and agent entry points.
4. Add scoped file uploads and reads, authenticated organizer operations, and owner table management through the same data interface.
5. Port the fundraiser as app source on a prepared self-hosted server. Do not put its prices, statuses, or capacity rules in dohc core.
6. Test a second small app with different rules, such as order entry with stock limits. Confirm that it needs app source and schema changes only.
7. Verify export, restore, withdrawal, offline behavior, and the full owner experience. Fix the friction before presenting the example as supported.

Each step should produce usable code or a decision that the next step needs. This sequence does not require Drive or mobile to launch first.

## What the fundraiser must prove

| Scenario | Required result |
| --- | --- |
| Two groups request the last slot | Only a transaction with sufficient remaining capacity succeeds |
| One registration requests both sessions | Both reservations commit together or neither does |
| The response is lost after commit | Retry returns the original registration without another charge to capacity |
| An organizer rejects or restores a registration | Status and capacity change together, subject to current constraints |
| An agent or owner edits through the data interface | The same rules apply as in the admin app |
| A participant uploads a receipt | Authorized organizers can read it; unrelated participants cannot |
| A participant guesses a file or record identifier | Alternate routes do not bypass authorization |
| Organizer access is revoked | Subsequent protected operations refuse |
| The transaction host is unavailable | Existing downloaded work remains readable; unconfirmed operations do not appear accepted |
| The host restarts or is restored | Confirmed data, attachments, and retry behavior remain consistent |
| The agent builds the app | No per-app database account, storage bucket setup, or manually patched dohc core is required |

## Decisions to record before production implementation

The following decisions are not settled by agreement on the product goal:

- One transaction host for shared app data, including offline behavior and safe authority transfer.
- The authoritative storage model and how owner table views relate to the existing Collection definition.
- The isolated execution runtime, its supported environments, and capabilities for external effects.
- Publication and grant authority for operations over private data outside the caller's file selector.

Record ADRs when those trade-offs are chosen. This proposal would supersede the scope limit in [ADR 0004](../adr/0004-writable-app-data-is-a-narrow-lane.md) and revise the browser-only execution and selector restrictions in [ADR 0006](../adr/0006-apps-publish-as-approved-bundles.md). It preserves their requirements for explicit authority, immutable approved code, and isolation from `share-web`. Ordinary collections retain [ADR 0007](../adr/0007-record-properties-ride-the-frontmatter-map.md) unless a later decision explicitly replaces it.
