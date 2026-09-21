# A backend for workspace apps

Reader: engineers maintaining app execution, data, publication, and owner management.

Status: implemented, September 21, 2026. The fundraiser passed browser and local Electron acceptance with synthetic data. Runtime, storage, HTTP, publication, and interface tests cover the remaining boundaries. See the [fundraiser evidence and limits](fundraiser-app.md) and [author and operator guide](../how-to/app-backend.md).

An owner and their agent can define an app's schema and operations in workspace source. dohc supplies execution, private storage, publication, caller authority, and recovery. The fundraiser and stock-order examples use the same backend contract; their prices, capacity, payment states, and stock rules live in app source.

## Data and authority

Each app backend owns a SQLite database identified by its workspace and `dataPath`. The path names the database; it does not expose a mutable SQLite file through ordinary workspace sharing. Private database snapshots, operation receipts, history, and uploaded files live in the backend store. Sharing the app's source does not grant access to those bytes.

An unshared backend runs on the owner's device without a server account. A shared backend has one host that confirms transactions under the relay's fenced write authority. Publishing existing local data fences writes to that local store and transfers its recovery bundle to the selected host. An independently initialized local store on another device requires collision resolution before transfer; offline devices are not globally fenced. An unavailable shared host cannot confirm an operation; there is no offline shared-write queue or automatic promotion of another device.

The current implementation transfers authority from local to shared hosting. It does not provide continuous desktop replicas of shared app data or an automatic shared-to-local handback. Export provides a recoverable copy; it is not sync. Drive and mobile remain future deployment and client work.

An app backend is separate from a Collection. Collections remain folders of typed Markdown records with permissive validation. App tables use their declared read and write operations. The desktop App data panel and agent CLI call those operations, so a table edit cannot bypass a rule enforced in the app's admin interface.

## Execution and commit

Publication captures frontend inputs, backend source, schema, and requested operations. The owner approves that immutable revision. A fixed compiler bundles the source without running app build hooks. The browser receives browser artifacts; the backend runs separately.

The runtime evaluates synchronous JavaScript in a fresh QuickJS Wasm instance inside a bounded child process. Its context supplies verified caller identity, stable request values, SQL over declared tables, and file attachment. It supplies no network, filesystem, imports, process access, environment secrets, or external effects. There is no OS filesystem sandbox around the child: guest confinement depends on Wasm and the explicit callbacks. See the [runtime contract](../../packages/app-backend-runtime/README.md).

An operation evaluates against a captured database snapshot. Its result is a candidate until the host atomically commits the new database, changeset, provenance, retry receipt, and file associations. The host compares revisions and can reevaluate on a conflict, keeping the request identity, time, and secret stable. Read-only operations cannot change the database or attach files.

The host rechecks publication and caller authority before returning protected results and at commit. A retry with the same principal, idempotency key, and payload returns the saved result. Changing the payload under that key refuses. Replaying a receipt does not bypass revocation. App-defined recovery credentials can extend recovery across browser profiles, as the fundraiser does; core retry identity alone cannot identify a person who has lost their browser profile.

Schema activation currently requires an unchanged schema digest and version for an existing database. Source updates can preserve data, but changing the schema requires explicit migration work that is not implemented. No fallback silently resets data.

## Permissions and files

Operations declare `link`, `helper`, or `owner` access. The host derives the caller from credentials. A helper needs both a current named Edit grant and the owner's explicit helper designation. An owner alone manages helpers and recovery. Neither client role fields nor possession of a file ID grants authority.

Uploads stage bytes before an operation attaches them. The host verifies JPEG, PNG, or PDF signatures and limits each file to 5 MiB. Unattached files expire after 24 hours; each caller can have at most 32 pending files. An operation attaches only an admitted file. Database rollback also rolls back that association. Attached files are retained with the app data and are excluded from pending-upload cleanup.

Owners and current helpers can read private files through the authenticated backend route. An app can authorize a narrower read through a read-only operation returning exactly `{ fileId }`. The host checks authority again before returning bytes. Ordinary file, blob, log, and history routes do not turn a form link into access to private backend storage.

Ordinary collection responses remain shared files. Collection publication therefore requires read access to every submitted field. Field projection is a display feature, not a private-response boundary. Use an app backend for private responses.

## Recovery and bounds

Export includes the database snapshot, approved backend source and capability, history changesets, retry receipts, and attached file bytes. It omits helper designations and unattached uploads. Restore validates the bundle and SQLite schema in the isolated runtime and requires an empty target with matching workspace, app, data path, schema, and source. Restore preserves logical revision and retry identities. It does not overwrite a populated app or import arbitrary SQL around app rules.

The runtime defaults to a 16 MiB database, 64 KiB input, 256 KiB source and result, 128 SQL statements, 1,000 rows per query, a one-second guest budget, and an eight-second child deadline. The shared store admits roughly 64 MiB of aggregate app data to keep its encoded recovery bundle within 128 MiB. Recovery bounds each history, receipt, and file inventory to 100,000 rows. These limits make the snapshot implementation bounded; they are not a claim of large-database performance.

The current store retains committed history and retry receipts. It has no compaction or user-facing app-data deletion workflow. Storage exhaustion refuses further admitted writes rather than discarding recovery state. Higher capacity, retention policy, migrations, continuous replication, and backend external effects require further design and implementation.

## Code ownership and evidence

| Boundary | Implementation and focused evidence |
| --- | --- |
| Declared capability and caller contract | [security contract](../../packages/security-contract/src/appBackend.ts) |
| Isolated candidate evaluation | [runtime](../../packages/app-backend-runtime/src/index.ts), [tests](../../packages/app-backend-runtime/src/runtime.test.ts) |
| Shared authorization and commit | [host](../../services/sync-relay/src/appBackendHost.ts), [authority](../../services/sync-relay/src/appBackendAuthority.ts), [HTTP fundraiser tests](../../services/sync-relay/src/appBackendFundraiser.test.ts) |
| Durable data and recovery | [storage](../../services/sync-relay/src/storage/appBackendData.ts), [tests](../../services/sync-relay/src/storage/appBackendData.test.ts) |
| Local ownership and transfer | [local host](../../apps/desktop/src/workspaces/localAppBackend.ts), [publication transfer](../../apps/desktop/src/workspaces/publishAppBackend.ts) |
| Owner table management | [App data panel](../../apps/desktop/src/renderer/OwnerAppBackend.tsx), [tests](../../apps/desktop/src/renderer/OwnerAppBackend.test.tsx) |
| Agent management | [CLI publication](../../packages/cli/src/appPublication.ts), [CLI operations](../../packages/cli/src/appBackend.ts) |
| App-defined rules | [fundraiser](../../examples/fundraiser/backend.ts), [stock orders](../../examples/stock-orders/backend.ts), [runtime examples tests](../../packages/app-backend-runtime/src/examples.test.ts) |

[ADR 0010](../adr/0010-app-backends-own-private-transactional-data.md) records the trade-offs. Browser acceptance, packaging checks, and final gate evidence belong with the delivered change, not in a claim inferred from these source files.
