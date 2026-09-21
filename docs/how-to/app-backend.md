# Build and operate an app backend

This guide is for app authors and self-host operators. An owner can delegate these steps to an already connected agent. Commands use the dohc CLI connected to the running desktop app. Replace uppercase values with IDs returned by dohc. JSON examples work in PowerShell 7 and POSIX shells.

For a complete source example, copy [examples/fundraiser](../../examples/fundraiser/README.md) into a workspace as `fundraiser`. Its event details are synthetic. Set the event and payment instructions before accepting real registrations.

## Define the app

Put `app.publish.json` in the app folder. Paths in the declaration are relative to the workspace, including entries in `inputs`. The fundraiser's [declaration](../../examples/fundraiser/app.publish.json) includes its browser source, backend source, schema, operations, and tables.

The backend declaration names:

- `entryPath`: authored backend JavaScript or TypeScript, compiled without app build hooks.
- `schemaPath`: SQL that creates the declared tables, indexes, constraints, and triggers. Every table needs an explicit non-null primary key; an `INTEGER PRIMARY KEY` is also supported.
- `dataPath`: the stable identity of this app's database within the workspace. This does not create a directly editable shared SQLite file at that path.
- `schemaVersion`: the approved schema version. Changing it or the schema digest currently refuses activation over existing data; there is no migration runner yet.
- `operations`: names with `access` set to `link`, `helper`, or `owner`, and an explicit `readOnly` value.
- `tables`: table names, primary keys, and their declared read and optional write operations.

Publish at most one backend capability per app. Do not put credentials in source or import backend source into the frontend.

Backend source assigns synchronous functions to `globalThis.operations`:

```js
globalThis.operations = {
  reserve(ctx, input) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      ctx.refuse("invalid_quantity", "Enter a positive quantity.");
    }
    const updated = ctx.db.execute(
      "UPDATE stock SET remaining=remaining-? WHERE id=? AND remaining>=?",
      [input.quantity, input.itemId, input.quantity],
    );
    if (updated.changes !== 1) ctx.refuse("stock_full", "There is not enough stock.");
    ctx.db.execute("INSERT INTO orders(id,item_id,quantity) VALUES(?,?,?)",
      [ctx.requestId, input.itemId, input.quantity]);
    return { id: ctx.requestId };
  },
};
```

`ctx.db.query` returns rows; `ctx.db.execute` returns `{ changes }`. Parameters are strings, finite numbers, or null. `ctx.caller` is verified by the host. `ctx.nowMs`, `ctx.requestId`, and `ctx.secret` stay stable during host retries. `ctx.files.attach(fileId)` associates an admitted upload and returns its metadata. Use `ctx.refuse(code, message)` to roll back a business-rule failure. Returning `{ ok: false }` is an ordinary successful result and keeps preceding writes.

There is no backend network, filesystem, process, import, or secret-store API. Transactions may rerun; they cannot send emails or payments. See [runtime limits and isolation](../../packages/app-backend-runtime/README.md).

## Approve local data

Create and manage an unshared backend without a server account:

```sh
dohc app prepareLocal '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser"}'
dohc app approve '{"workspaceId":"WORKSPACE_ID","approvalId":"APPROVAL_ID","candidateDigest":"CANDIDATE_DIGEST"}'
dohc app listLocal '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser"}'
```

Review the source and requested capability returned by preparation. Use its exact `approvalId` and `candidateDigest` for approval. Approval initializes the database and returns a `publicationId`. Local management uses the same operation commands as shared management. This local backend does not by itself create a URL that friends can visit.

Open the approved app from dohc's local app controls, or request its local launch URL:

```sh
dohc app launchLocal '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID"}'
```

Open the returned `url` in a browser on this computer within 30 seconds. It starts a single-use local session with owner authority and requires dohc to stay open. It is not a share link. Launch again when the session ends.

```sh
dohc app describe '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID"}'
dohc app invoke '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID","operation":"listPublicSessions","idempotencyKey":"sessions-1","input":{}}'
```

For mutations, generate a fresh idempotency key for each intended change. Keep that key and the exact payload when retrying a lost response. Changed input under the same key refuses. A revoked caller cannot use a saved result to regain access.

## Share the app

Set up a [self-hosted server](self-host.md), including the [app-origin and publication configuration](../../services/share-web/README.md). Enable `DOHC_RELAY_APP_PUBLICATIONS=1` and `DOHC_RELAY_APP_BACKENDS=1`. The server image must contain the compiled runtime child and QuickJS Wasm dependencies. Use the release tooling rather than copying a service bundle alone.

Share the app source folder in dohc. Select the share and link grant that cover its declared source inputs, then prepare and approve:

```sh
dohc app prepare '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser","shareId":"SHARE_ID","grantId":"LINK_GRANT_ID"}'
dohc app approve '{"workspaceId":"WORKSPACE_ID","approvalId":"APPROVAL_ID","candidateDigest":"CANDIDATE_DIGEST"}'
dohc app list '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser"}'
```

The private database and uploaded files need no file-share selector. The publication authorizes operations over that data. An app with ordinary Collection responses has different privacy: those responses remain readable shared files.

If this app already has local data, approval fences local writes and transfers that data to the shared host. Its local backend source and schema must match the prepared shared version. Once transferred, the shared host confirms all operations. Keep it online while friends submit. A failed transfer remains fenced; retry the publication flow rather than deleting its local store or starting a second writer. A changed schema cannot transfer over an existing database.

Friends open the share link and launch the app. The app communicates through dohc's browser broker; it never receives owner credentials. Use the fundraiser client as the example for invocation, upload, and file reads. The browser can use ordinary networking, so the owner must trust the approved source with data it receives.

## Manage data and organizers

The desktop publication view includes App data. Each declared table read receives `{ offset, limit, search }` and must return `{ rows, total? }`. A table write receives `{ rowId, field, value, expectedVersion? }`. Return a numeric `version` in a row to have the table send that version with an edit. The operation decides which fields and transitions are valid; setting `writeOperation` to null makes the table read-only.

The same operations work through `dohc app invoke` and the custom admin app. They do not expose raw SQL writes to the browser or table editor.

Invite an organizer to the source share with named Edit access, then explicitly designate that grant as a helper:

```sh
dohc app helper '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID","grantId":"NAMED_GRANT_ID","enabled":true}'
```

The organizer signs in through the shared app. Named Edit access alone is insufficient; so is a helper designation after the grant is revoked or narrowed. Use `enabled:false` to remove helper access. Only the owner can manage helpers, export, or restore. Helper designations are not included in app recovery exports.

Uploads support JPEG, PNG, and PDF up to 5 MiB, verified from the bytes. Stage a file, then attach its ID in the operation that creates its record. Pending uploads expire after 24 hours and are limited to 32 per caller. A read-only operation can authorize a file read by returning exactly `{ fileId }`. Never treat a supplied file ID as permission.

## Export and recover

Export from App data or supply an absolute `.json` path through the CLI:

```sh
dohc app export '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID","savePath":"C:/Backups/fundraiser.json"}'
```

The destination directory must exist. Existing files require explicit `overwrite:true`. Protect the export as private data: it includes the database, backend source, history, retry receipts, and attached file bytes. It omits unattached files and helper designations. The bundle's integrity checksum detects corruption; it is not encryption.

Restore requires an empty target with the same workspace identity, app root, data path, schema, and backend source. Prepare that source and approve with `initialize:false` so approval does not create a new empty database first:

```sh
dohc app approve '{"workspaceId":"WORKSPACE_ID","approvalId":"APPROVAL_ID","candidateDigest":"CANDIDATE_DIGEST","initialize":false}'
dohc app restore '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID","sourcePath":"C:/Backups/fundraiser.json"}'
```

Use `prepareLocal` for a local target or `prepare` for a shared target before that approval. Restore validates the approved schema, history, file associations, and retry receipts. It does not overwrite a populated store or migrate to another workspace identity. App recovery is separate from [whole-server recovery](self-host-recovery.md), including the relay's continuity requirements. Do not use an old app bundle to replace a host that has accepted newer work.

The runtime database limit is 16 MiB. The shared host bounds aggregate app storage to roughly 64 MiB and serialized recovery to 128 MiB. Committed history and retry receipts consume that budget and currently have no compaction workflow. There is no continuous shared-data replica on the desktop, automatic return to local authority, schema migration runner, or backend external-effect service in this version.
