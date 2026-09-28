# App backend runtime

Reader: engineers connecting published app operations to authoritative storage, and engineers running automation formulas and code steps.

Transactional Collections use this package's host journal and [persistent materialization](#persistent-materialization).
The trusted host authorizes and commits changes; isolated workers evaluate approved JavaScript and apply committed events.
See [the operator guide](../../docs/how-to/app-backend.md) to create and manage an app.

The package also exposes a snapshot evaluator that returns candidate bytes, a changeset, JSON, and attached file identifiers.
That evaluator does not commit shared state or authorize callers. The snapshot-specific limits below do not describe persistent dataset capacity.

The [automation evaluator](#automation-formulas-and-code-steps) runs the formulas and code steps of Collection automations in the same kind of sealed QuickJS guest.

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

## Snapshot evaluator isolation and limits

Each evaluation runs in a new QuickJS Wasm instance with its own memory, inside a child process, so it cannot read memory another evaluation used.
The guest receives no process, filesystem, network, module loader, or host environment.
The child receives an empty environment and owns one temporary database.
The parent kills the owned child at the deadline or when its abort signal fires.
Temporary data is removed after the child closes.

Guest memory, stack, execution, SQL calls, query results, inputs, and outputs are bounded. Limits can be lowered, not raised.
`memoryBytes` is an operation's whole Wasm memory, 24 MiB by default. QuickJS uses about 5 MiB of it.
This QuickJS build has no `malloc_usable_size`, so QuickJS's own memory limit cannot count allocations. The memory's fixed size is the bound.
An operation that needs more fails with an error that names the limit. The limit is in whole MiB and at least 16 MiB, which QuickJS needs to start.
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
Its `runtime.ts` and `c/interface.c` implement explicit stack, interrupt, and module-loader controls.
Its `context.ts` implements host callbacks through QuickJS handles.
This package uses an explicit runtime and context for those controls, and instantiates the release build's Wasm with its own memory for each operation.

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
It refuses an existing destination. The host publishes the checkpoint and its manifest durably; accepted journal events remain retained.

On deadline, process death, or protocol failure, the client fails closed and does not restart itself.
Call `close`, then rebuild in a fresh directory from the authoritative checkpoint and journal.
The host owns directory cleanup after `close` completes. It must not reuse an orphan worker database.
The client bounds admitted work to 64 messages and gives queued work its own deadline.
Queued and active message payloads together cannot exceed 129 MiB.
The execution deadline starts on dispatch and kills blocked native SQL as well as guest code.
Initialization keeps its separate eight-second deadline when the host lowers the subsequent operation deadline.
`abort(reason)` immediately kills the worker and waits for process exit. Use it when authority is revoked or execution is cancelled.

Each operation receives a new QuickJS instance and memory, as a snapshot evaluation does. Reused SQLite connections additionally deny `changes()`, `total_changes()`, and `last_insert_rowid()`.
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

The owner first prepares a migration preview. Authored SQL runs once against a disposable copy, then schema and integrity checks run.
The preview lists every changed row's before and after values, with pages capped at 100 records and 256 KiB.
Primary keys identify records. Changed primary-key definitions appear as deletions and insertions rather than guessed matches.
Integer and blob values retain their SQLite types in the report. Conversion and constraint failures stop preparation before approval.

Approval verifies the current owner, lifecycle generation, source cursor, and candidate checksum before committing those exact checkpoint bytes.
It does not execute the migration SQL again. Other writes invalidate the preview. A changed owner or archived-and-restored dataset requires a new preview.
There are at most four previews per host and one per dataset. Previews expire after ten minutes and are discarded on host shutdown.
The owner can discard a preview earlier. A new preview replaces the dataset's previous preview after fresh authorization.

Preparation reserves twice the dataset's capacity for its private checkpoint and report before creating them.
Each file is bounded by the dataset capacity. Approval separately reserves the journal checkpoint while both copies exist.
Deletion of preview files releases the reservations. If closed storage refuses a refund, exclusive startup maintenance reclaims the durable reservation.
Preview files use supervised ownership directories, so startup removes files left by a crash before admitting work.

A source row larger than 128 KiB, a report record larger than 256 KiB, or a report larger than dataset capacity refuses preparation.
These limits never truncate reviewed values. Larger migrations need a future chunked-value report or a larger supported storage envelope.
The existing worker deadline also applies to migration and report generation. These are resource limits, not support for every possible migration.

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

## Retention and startup maintenance

Local and relay hosts keep one replaceable materialization checkpoint per dataset to reduce worker replay.
The supervisor attempts a snapshot after at least 128 uncached committed events.
Its 30-second idle eviction uses the same threshold; a smaller tail replays from retained history when the worker reopens.
The triggering operation returns before maintenance begins. The dataset's lane stays serialized while the snapshot is prepared.
Other datasets keep their own lanes; synchronous storage work still uses the host process.

The checkpoint contains an existing committed cursor. It does not advance the revision or replace the authoritative schema checkpoint.
Installation checks the active head, current authority, checksum, and staged bytes before replacing the cache and refunding its previous allocation.
Worker reopening validates the cache against retained journal state and the worker's scope marker.
An invalid cache falls back to the authoritative checkpoint and history. Authorization, deletion, and inactive-host errors still refuse access.

Maintenance reserves the temporary snapshot's dataset capacity before creating it, then accounts the staged checkpoint's actual bytes.
Peak storage includes the old cache, temporary snapshot reservation, and new staged checkpoint until replacement and cleanup finish.
File reads and chunk staging use 1 MiB buffers. Materialization checkpoint sealing hashes one chunk per transaction, then yields to host I/O.
Each chunk rechecks authority and the pending stage. The final transaction verifies the complete hash before sealing; installation still checks the current cursor.
Maintenance failures do not change an accepted operation's result. Insufficient quota can prevent caching, so replay length is not guaranteed under storage pressure.
Local and relay hosts log `dataset_materialization_deferred` with workspace and dataset IDs, without raw error text or record contents.
The supervisor reports one warning per dataset until a successful cache clears it. No operator action is required to resume authoritative replay.
Recovery exports retain the authoritative history and retry records; they do not include this replaceable cache.

The host retains committed events, schema checkpoints, and retry receipts within its storage quota. It does not delete committed history or expire accepted retry keys.
Receipts still refer to their original events, and recovery exports require the complete revision chain. Removing either would break recovery or repeat protection.
When quota is exhausted, further writes fail. An export preserves the data but does not release storage. Operators must provision capacity for retained history.

Before admitting work, the local host reclaims abandoned checkpoint stages under its exclusive worker-directory lease.
Configured relay deployments do the same under their deployment writer lock. Unlocked development relay storage skips this maintenance.
Maintenance reads at most 100 manifests per page and yields between pages. Each deletion refunds its reservation in the same transaction.
It preserves all active checkpoints and stages referenced by recovery imports, including installed imports awaiting a claim.
Transfer archives, receipts, and recovery-import state have separate lifecycles and are not swept by checkpoint maintenance.

## Automation formulas and code steps

`@dohc/app-backend-runtime/automation` evaluates the formulas and code steps of Collection automations.
It returns values and requested changes. It never writes; the executor applies each change with its own checks.

```ts
const evaluator = createAutomationEvaluator();
const [ready, note] = await evaluator.evaluate(scope, [
  { kind: "expression", source: 'record.Status == "Done"' },
  { kind: "text", parts: [{ kind: "text", text: "Finished " }, { kind: "expression", expression: "record.Name" }] },
]);
const step = await evaluator.runCode(scope, 'return { set: { "Finished on": ctx.today() } };');
```

### Isolation

Evaluation runs in a worker thread, so it never blocks the caller's thread. Requests run one at a time.
Each formula and each code step gets its own QuickJS runtime and context with the dataset guest's controls: no network, files, module loader, host objects, or asynchronous work.
A formula therefore cannot change what a later formula in the run sees. The evaluator also freezes the scope, the helpers, the global object, and the global built-ins with their prototypes.
It removes `SharedArrayBuffer` before authored code runs, because its `grow` returns heap memory without clearing it.

A worker thread is enough because evaluation runs only JavaScript and WebAssembly. The dataset guest uses a child process because it also runs SQLite.
The worker compiles QuickJS once and gives each request a fresh instance with its own WebAssembly memory, so no request reads memory that another request used.
That memory is capped at 24 MiB. QuickJS uses about 7 MiB of it, so one formula or code step can use about 17 MiB, less its scope.
QuickJS's own memory limit cannot measure allocations in this build, so the cap is the bound. The worker adds about 23 MB to its process when idle and about 38 MB at the cap.
The worker exits after 30 seconds without work, which returns that memory. The next request starts a new one.
Electron hosts stage `dist/automation-worker.mjs` beside its `quickjs-emscripten` dependency and pass that file as `entryPath`.

| Limit | Value | Dataset guest |
|---|---|---|
| Time to read the scope into one formula or code step's context | 1 s | none |
| Time for one formula | 100 ms | none |
| Time for one code step | 1 s | 1 s for one operation |
| Time one request's formulas and code steps run, not counting reading the scope | 8 s | 8 s for one operation |
| Time one request reads the scope, over all its formulas | 8 s | none |
| Memory for one formula or code step | about 17 MiB, from a 24 MiB cap | 16 MiB for one operation |
| Stack | 256 KiB | 256 KiB |
| Source of one formula or code step | 64 KiB | 256 KiB |
| Parts of one message text | 1,024 | none |
| Result of one formula or code step, as JSON | 64 KiB, nested at most 64 levels | 256 KiB |
| Scope, as JSON | 256 KiB, and each value in it nested at most 64 levels | 256 KiB of query results |
| Formulas in one request | 64 | none |
| Requests waiting or running | 16 | 8 operations running |

The time limits count wall time, as the dataset guest's limits do. A formula's time starts once its scope is ready, so a large scope does not use it up.
Windows counts a thread's processor time by clock ticks, and on a busy machine it counted 47 ms for 570 ms of work, so processor time cannot bound a formula.
The worker evaluates one formula as it starts, so a cold worker's first formula does not spend its time compiling QuickJS's code paths.
QuickJS checks the limits between bytecodes, so native work such as converting a huge BigInt to text can run past them.
A result or a read scope that arrives after its limit is a timeout. A watchdog replaces the worker when a formula runs 2 seconds past its limits.
That formula times out and a new worker evaluates the ones after it.
When an item breaks a worker's QuickJS instance, that item's own result asks for a new worker, which evaluates the items after it. A worker that fails before it finishes any item makes the items sent to it fail with `runtime` instead of starting another worker.
A request keeps two totals: the time its formulas run, and the time it spends reading the scope.
A run that sends several requests, as a run with code steps does, passes the same `spent` record to each, so the two totals cover the whole run.
Reading a 256 KiB scope takes 15 to 25 ms on a desktop, so 64 formulas can spend several seconds reading it. That time never cuts off a formula's run time.
Formulas that start after either total passes 8 seconds time out without running. Each total passes 8 seconds only by the item running when it did, so one request takes at most about 21 seconds.
When 16 requests are waiting or running, a new request returns `busy` for every item at once. The evaluator does this before it reads the scope or the formulas, so it returns `busy` even for input it would reject. The caller runs the automation again later.

The scope and formulas must be plain JSON data: no bigints, functions, symbols, or class instances such as dates, maps, and `Array` subclasses.
Before the caller's thread copies anything to the worker, the evaluator rejects a scope with such a value. It refuses an oversized source or message text, and an oversized or deeply nested scope, as `too_large`.
It counts the UTF-8 bytes `JSON.stringify` would write for the scope, including escapes, and stops at the limits, so a cycle is `too_large`.
Values in the scope, such as a field value or a bound step result, can nest 64 levels deep, as a result can. The scope and its `record` or `bindings` object add two levels.
The worker measures size and nesting again from the JSON, and it refuses a scope it cannot turn into JSON.

### Scope

| Name | Contents |
|---|---|
| `record` | The triggering record's field values, by field name. It is `null` when the trigger has no record, such as a schedule |
| `previous` | The field values before the change. It is empty when the trigger has no earlier values, such as a new record or a button |
| `trigger` | The trigger's `kind` and its facts |
| `person` | `{ id, name }` of the person who made the change, or `null` |
| `message` | The Group message that triggered the run, or `null` |
| `now` | The host passes the run's time as ISO 8601 with the running computer's UTC offset. Formulas read it through `now()` and `today()` |

The host also passes `bindings`: earlier step results, each under the name its step binds with `as`.
A formula reads each one as a name of its own, such as `tasks.length`. A binding cannot use a name in `AUTOMATION_SCOPE_NAMES` or a QuickJS global, such as `Math`.
Formulas use all these names directly. A code step reads them and the helpers from `ctx`, such as `ctx.record`, `ctx.tasks`, and `ctx.today()`.
Everything in the scope is frozen, so an assignment fails with a `TypeError`.

An `expression` formula is one JavaScript expression, such as `record.Status == "Done"`.
A `text` formula is message text that the file contract has split into text and expression parts.
Each expression's value is inserted: a list as its items joined with `, `, an object as JSON, and an empty value as nothing.
A formula without a value, such as a missing field, gives `null`.

### Helpers

Dates are ISO strings in and out. A calendar date such as `2026-09-24` has no time zone.
A date with a time keeps its UTC offset; one written without an offset uses the offset of `now`.
`now` is the time on the computer that runs the automation, so `today()` is that computer's calendar date.

| Helper | Returns |
|---|---|
| `today()` | The calendar date of `now`, such as `2026-09-24` |
| `now()` | The run's time with its offset, such as `2026-09-24T09:30:00.000+08:00`. Every call in a run returns the same time |
| `dateAdd(date, amount, unit)` | `date` moved by a whole `amount` of `years`, `quarters`, `months`, `weeks`, `days`, `hours`, or `minutes`. A month that lacks the day uses its last day, so January 31 plus 1 month is February 28. Hours and minutes added to a calendar date start at its midnight on the clock of `now` |
| `dateBetween(a, b, unit)` | The whole units from `b` to `a`, counted toward zero. It is negative when `a` is earlier. Both dates are read on the clock of `now` |
| `formatDate(date, format)` | `date` as text, `MMMM D, YYYY` (`September 24, 2026`) by default. Parts: `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `dddd` `ddd` `HH` `H` `hh` `h` `mm` `ss` `A`. Text in `[brackets]` stays as written. Names are English |
| `lower(text)`, `upper(text)`, `trim(text)` | The changed text. An empty value gives `""` |
| `contains(value, search)` | Whether text contains `search`, or a list has an item equal to it |
| `join(list, separator)` | The list's items as text, separated by `, ` by default. Empty items are skipped |
| `length(value)` | The characters in text or the items in a list. An empty value gives 0 |
| `sum(...values)`, `min(...values)`, `max(...values)` | The total, lowest, or highest of the numbers given, including numbers in lists. Empty values are skipped. `sum` of nothing is 0; `min` and `max` of nothing are `null` |
| `round(number, places)` | The number rounded to `places` decimal places, 0 by default. Halves round up |

Units can also be singular, such as `day`.

### Code steps

A code step is a function body that receives `ctx` and returns synchronously. Every key of its result is optional:

```js
return {
  set: { "Finished on": ctx.today() },
  records: [
    { action: "add", collection: "Trip/Tasks", fields: { Name: "Book hotel" } },
    { action: "change", collection: "Trip/Tasks", id: "record-7", fields: { Status: "Open" } },
  ],
  output: { total: 50 },
};
```

`set` names fields of the triggering record. `records` adds records to, or changes records in, the Collection at a workspace path.
`output` is any JSON value. A later step reads it by the name this step binds with `as`. Returning nothing asks for nothing.
The evaluator validates this shape. An unknown key or another shape gives `invalid_result`.

### Errors

Each formula and code step gives `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
The message is written for the person who reads the run.

| Code | Cause |
|---|---|
| `syntax` | The formula or code does not parse |
| `runtime` | It threw. A thrown string becomes the message. Also, the evaluator stopped before it could run the item |
| `timeout` | It, or reading its scope, ran past its time limit |
| `memory` | It used more memory or stack than the limits allow |
| `too_large` | Its source, the scope, or its result is over its size limit, or the scope nests too deeply |
| `invalid_result` | It gave a function, a promise, a value JSON cannot hold, a value nested too deeply, or a code step result of another shape |
| `busy` | The evaluator already had 16 requests waiting or running. Every item of the request gets it and nothing ran; run the automation again later |

The promise rejects for executor mistakes and a worker that cannot start, unless the queue is full.
Executor mistakes include more than 64 formulas, a malformed formula, a scope with a value JSON cannot hold, which the message names by type, a `now` without a valid UTC offset, a binding under a name the scope or QuickJS owns, and a call after `close`.
