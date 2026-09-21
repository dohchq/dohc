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
