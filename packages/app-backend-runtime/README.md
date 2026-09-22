# App backend runtime

Reader: engineers connecting published app operations to authoritative storage.

This package evaluates approved JavaScript against a temporary SQLite snapshot.
It returns a candidate snapshot, SQLite changeset, JSON result, and attached file identifiers.
It does not commit shared state or authorize callers.

The host must validate the publication, operation, caller, and files before evaluation.
The host must recheck authority when it atomically commits the candidate and retry receipt.
Keep `requestId`, `nowMs`, and `secret` stable across retries against newer snapshots.
Discard every output if that commit fails.

## Authoring an operation

```js
globalThis.operations = {
  reserve(ctx, input) {
    const changed = ctx.db.execute(
      'UPDATE stock SET remaining=remaining-? WHERE id=? AND remaining>=?',
      [input.quantity, input.itemId, input.quantity],
    ).changes;
    if (changed !== 1) ctx.refuse('capacity_full', 'There are not enough places left.');
    ctx.db.execute('INSERT INTO reservations(id,quantity) VALUES(?,?)', [ctx.requestId, input.quantity]);
    return { id: ctx.requestId };
  },
};
```

Operations are synchronous. They receive frozen input and a frozen context:

- `caller`: the host's verified caller data.
- `nowMs`, `requestId`, and `secret`: trusted request values. The secret is a 256-bit base64url string.
- `db.query(sql, params)`: returns rows containing JSON scalar values.
- `db.execute(sql, params)`: returns `{ changes }`.
- `refuse(code, message)`: refuses the candidate with a bounded public message. Catching the guest exception cannot cancel the refusal.
- `files.attach(fileId)`: returns admitted file metadata and records its attachment. It does not expose bytes or commit the attachment.

SQL parameters are strings, finite numbers, or null. Convert booleans to integers.
Use `ctx.refuse` when a business rule fails. Returning `{ ok: false }` is an ordinary successful result and retains preceding writes.
The caller receives `AppBackendRuntimeError` with `code: 'operation_refused'` and a `refusal` containing the supplied code and message.
Other guest exceptions return a generic error without invoking guest error getters.

## Isolation and limits

Each evaluation uses a fresh QuickJS Wasm runtime inside a child process.
The guest receives no process, filesystem, network, module loader, or host environment.
The child receives an empty environment and owns one temporary database.
The parent kills the owned child at the deadline or when its abort signal fires.
Temporary data is removed after the child closes.

Guest memory, stack, execution, SQL calls, query results, inputs, and outputs are bounded.
The default snapshot limit is 16 MiB. Limits can be lowered, not raised.
SQLite has a 64 MiB native heap cap and a database page cap.
The parent deadline also covers native SQL, initialization, serialization, and child startup.
There is no operating-system filesystem sandbox around the child. Guest confinement depends on Wasm and the explicit callbacks.

The SQL authorizer permits declared tables and denies transaction control, schema edits, attached databases, and unsafe file or extension functions.
During admitted writes, SQLite's session extension can inspect declared table metadata.
Guest statements cannot invoke that privileged metadata inspection directly.
Read-only operations also refuse file attachments.

Schema initialization is separate. It admits declared tables, indexes, constraints, and triggers.
Every table needs a non-null primary key or a single INTEGER primary key that aliases rowid.
SQLite sessions capture changes for host history and replication. Replicas must apply changesets without rerunning authored logic.
Recovery uses `validateAppDatabase` before committing an imported snapshot.
The isolated child compares its schema to a fresh database from the approved schema source, then checks integrity and foreign keys.

## Dependency evidence

The runtime pins `quickjs-emscripten` to `0.32.0`.
The inspected upstream source is [commit df4efb9ef2cb25c417ecb57986da462d11b244ed](https://github.com/justjake/quickjs-emscripten/tree/df4efb9ef2cb25c417ecb57986da462d11b244ed), the published package's `gitHead`.
Its `runtime.ts` and `c/interface.c` implement explicit memory, stack, interrupt, and module-loader controls.
Its `context.ts` implements host callbacks through QuickJS handles.
The convenience module `evalCode` removes its memory limit before dumping results, so this package uses an explicit runtime and context.

Focused tests cover candidate isolation, changesets, SQL access, read-only calls, loops, allocation pressure, serialization getters, native SQL timeouts, refusal, attachment scope, and cancellation.
The initial implementation passed on Windows Node 24.16.0.
A Linux Node 24.20.0 container also initialized a database, executed an operation, and returned the expected changeset.
These checks do not establish shared commit, publication, or packaged desktop behavior.

## Packaging

Run the package's `build` script before consuming it. Tests build it automatically.
Both the client and child exports resolve to compiled `.mjs` files under `dist`.
Keep this package and its QuickJS dependencies external when bundling a Node host.
Deployment must include `dist` and the QuickJS Wasm dependency files.
The child export resolves through the package name, so bundling the host does not change its location.
Desktop hosts must supply a compatible child launcher instead of treating Electron's executable as Node.
Use `createAppBackendRuntime({ launch })` to inject that launcher.

## Persistent materialization

`@dohc/app-backend-runtime/persistent` exports `openPersistentAppBackend` for trusted hosts.
This worker materializes a host-owned checkpoint and journal. It does not authorize callers or store authoritative retry receipts.
The existing snapshot interface and its 16 MiB limit remain unchanged.

The host supplies a fresh directory, approved schema, tables, scope, and checkpoint cursor.
Scope includes workspace, dataset, host epoch, and approved revision hash.
Paths must be absolute and cannot contain symbolic links. The worker creates `app.sqlite` exclusively.
An initial revision-zero dataset can initialize from schema. Later revisions require a checkpoint.
The host validates the checkpoint manifest before opening it. A checkpoint containing the internal cursor must match the supplied scope and cursor exactly.
A clean checkpoint without the internal cursor must still match the approved schema and pass integrity checks.

The host serializes operations using these steps:

1. Call `prepare` with verified caller data and the expected cursor.
2. Recheck authority and durably append the operation's result, changeset, attachments, and receipt to the host journal.
3. Call `finalize` with the proposal ID, changeset hash, previous digest, and committed cursor.
4. Return the result after host commit succeeds. Recover from the journal if finalization is uncertain.

`prepare` keeps writes in an open transaction. `discard` rolls them back.
Another prepare, replay, or snapshot refuses while a proposal is pending.
Read-only prepares roll back immediately and need no finalization. The host must still recheck read authority before returning data.
Finalization stores the internal cursor and dataset changes in the same transaction.
The worker checks consecutive revisions and matching previous digests. The host verifies the journal's canonical event hashes.

`apply` replays committed changesets without evaluating authored JavaScript.
It aborts the entire transaction for conflicts or undeclared tables, including internal metadata.
Replay temporarily removes triggers and disables foreign-key actions because the changeset already contains their effects.
It restores triggers and checks foreign keys before committing, then enables foreign-key enforcement for subsequent operations.
If intermediate unique constraints reject an otherwise valid net changeset, recovery applies it to a disposable shadow without secondary constraints.
It then copies the final rows into the unchanged approved schema in one transaction, checking structural constraints and recomputing generated columns.
This fallback runs only during replay and leaves ordinary writes unchanged. It uses additional temporary disk space up to the dataset reservation.
Replay and checkpoint integrity checks restore accepted state without reevaluating `CHECK` predicates, which can depend on time or randomness.
The trusted host verifies journal and checkpoint identity before supplying them. Replay still checks keys and foreign keys; subsequent guest writes enforce `CHECK` again.
`snapshot(path)` creates an exclusive SQLite checkpoint containing the current scope and cursor, then keeps the worker open.
It refuses an existing destination. The host publishes the checkpoint and its manifest durably before retiring journal events.

On deadline, process death, or protocol failure, the client fails closed and does not restart itself.
Call `close`, then rebuild in a fresh directory from the authoritative checkpoint and journal.
The host owns directory cleanup after `close` completes. It must not reuse an orphan worker database.
The client bounds admitted work to 64 messages and gives queued work its own deadline.
Queued and active message payloads together cannot exceed 129 MiB.
The execution deadline starts on dispatch and kills blocked native SQL as well as guest code.
Initialization keeps its separate eight-second deadline when the host lowers the subsequent operation deadline.
`abort(reason)` immediately kills the worker and waits for process exit. Use it when authority is revoked or execution is cancelled.

Each operation receives a fresh QuickJS runtime. Reused SQLite connections additionally deny `changes()`, `total_changes()`, and `last_insert_rowid()`.
Use `ctx.db.execute(...).changes` for the current statement's affected row count.
Journaled datasets reject `AUTOINCREMENT` because SQLite changesets omit its retained sequence state. Use an `INTEGER PRIMARY KEY` or an explicit ID.
Implicit `rowid`, `oid`, and `_rowid_` reads are unavailable unless backed by a declared `INTEGER PRIMARY KEY`.
Those alias names are reserved for an `INTEGER PRIMARY KEY`; use other names for ordinary fields.
Prepare refuses deferred foreign-key violations and transactions ended by conflict handling before the host can commit a journal event.
The persistent storage reservation defaults to 128 MiB and can be lowered. It includes internal cursor pages; other guest limits retain snapshot defaults.
This reservation is a bound, not a measured performance or scale guarantee.
Electron hosts must inject their utility-process launcher and package the `persistent-child` export.

Changeset filtering was checked against Node 24.16.0's [SQLite binding at c7d10158bc31036de6783d66beaaaf551e3167aa](https://github.com/nodejs/node/blob/c7d10158bc31036de6783d66beaaaf551e3167aa/src/node_sqlite.cc).
Its filter includes tables when the callback returns true. Tests cover admitted replay and rollback of mixed admitted/internal changesets.

## Approved schema transitions

`migrateCheckpoint({path,schemaSql,tables,migrationSql})` applies an owner-approved migration to a disposable copy of the idle materialization.
The host must obtain approval for the new rules and warn before destructive changes. The worker does not grant that approval.
Migration SQL has the source byte limit and the worker execution deadline. It cannot attach databases, access files, change transaction control, or create temporary objects.
It can change declared tables, indexes, and triggers. Table identifiers can start with an underscore; internal `dohc_` and `sqlite_` names remain reserved.
The resulting schema must exactly match the new approved schema, and integrity and foreign-key checks must pass.

The output checkpoint omits the internal scope and cursor marker. The returned cursor identifies the unchanged live dataset it came from.
The host hashes the checkpoint, commits the schema transition against that cursor, and opens a new worker under the committed identity.
An empty migration normalizes a checkpoint without changing its schema or records.
Failures leave the live dataset unchanged. Cancellation kills the worker; the host removes its disposable directory after process exit.
The host retains the prior approved artifacts and checkpoint before activation so the owner can reverse the transition.
The launcher starts the compiled `entryPath` with an empty environment and maps utility-process messages, errors, exits, and kill.
The child accepts one request on `process.parentPort` and sends one reply.
The utility-process adapter should send `{ kind: "close" }` after it receives the reply.
The child exits after that close message.
