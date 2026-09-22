# Build an app connected to a Collection

App authors and self-host operators use this guide to create, share, and manage a Collection-backed app.
An already connected agent can use the same commands. Run the CLI from the owning workspace while dohc is open.
Replace uppercase values with IDs returned by dohc. JSON examples work in PowerShell 7 and POSIX shells.

## Create the Collection first

Create a transactional Collection in the Data section, then choose **Create form**.
Choose which approved create operation and public fields the form can use.
Submissions appear in the same Collection. Private fields remain outside the form's grant.

Forms support multiple file fields and the full 128-field table envelope, without a separate form-field ceiling.
Each file can contain up to 5 MiB. The form uploads files sequentially with separate retry identities.
One response can attach up to 32 files, matching the operation's file-metadata admission bound.
Forms can have more optional file controls, but cannot require more files than an operation accepts.
The form checks the selected file count before uploading anything.
The combined response, including file references, must fit the 64 KiB operation input limit.
The form checks this bound before uploading. It stores the completed response before invoking its create action.
After an uncertain submission or reload, retrying uses that same stored response and request identity.

The 128-field limit bounds table metadata, validation, generated controls, and operation field grants.
It is the current tested product envelope, not a SQLite column limit or an unlimited-capacity claim.
Dataset descriptors also remain bounded to 256 KiB, and generated operation source must fit its existing compilation limit.
Larger answers can exhaust the input bound before all fields reach their individual text limits.

For a related-record field, choose an approved public read action and its label under **Public choices**.
The action must belong to the relation's target table and declare only its key and label fields.
This grants the complete action, including its actual returned output. Declared fields do not enforce output filtering on authored code.
Choose **Review action source** before sharing; never expose a private read action as a shortcut.
The picker reads choices when opened, searches the selected action, and pages without a total count.
Relations currently connect tables within one dataset. Separate datasets do not receive implicit access to each other.

If no suitable action exists, expand **Create public choices**, select a public label, and choose **Review public choices**.
This prepares a read action that returns every target record's key and selected label, with no other fields.
Search matches only the selected label. An empty label displays the key.
Review and approve the change, then reopen **Create form** and select the new action.
The new action preserves existing custom source and records. Existing apps require review for the changed executable revision.
Creating the action does not publish an app or add the action to existing app grants.

Creating and compiling Collection actions currently requires the Windows x64 desktop build.
The relay's Node runtime portability does not establish desktop creation support on other platforms.

For custom rules, copy [the fundraiser example](../../examples/fundraiser/README.md) into the workspace.
Review its synthetic event details and payment instructions before using it.
The dataset descriptor names stable tables, fields, operations, schema source, and operation source.
Prepare and approve that source:

```sh
dohc dataset prepare '{"workspaceId":"WORKSPACE_ID","descriptorPath":"fundraiser/dataset.json"}'
dohc dataset approve '{"workspaceId":"WORKSPACE_ID","preparationId":"PREPARATION_ID","revisionSha256":"REVISION_SHA256"}'
dohc dataset describe '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID"}'
```

Review the captured source before approving its exact revision hash.
Keep app code and Collection views on the same dataset. They do not need separate response stores.

## Connect the app

Put `app.publish.json` in the app folder. Declare the frontend entry, source inputs, and a `dataset` binding.
The binding names `datasetId`, the approved `revision` and `revisionSha256`, and permitted `operationIds`.
Use the [fundraiser declaration](../../examples/fundraiser/app.publish.json) as an example.
No private app database path or backend capability is declared.

The dataset's operation source assigns synchronous functions to `globalThis.operations`:

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

Declare those tables and operations in the dataset descriptor and schema.
`ctx.db.query` returns rows; `ctx.db.execute` returns `{ changes }`.
Parameters are strings, finite numbers, or null. The host verifies `ctx.caller`.
The request identity and operation context stay stable during host retries.
`ctx.files.attach(fileId)` associates an admitted upload with the transaction.
`ctx.refuse(code, message)` rolls back a business-rule failure.
Returning `{ ok: false }` is an ordinary successful result and keeps preceding writes.

Backend operations have no network, filesystem, process, arbitrary dependency, or secret-store access.
They cannot send emails or payments. See [runtime limits and isolation](../../packages/app-backend-runtime/README.md).

## Approve and open the local app

```sh
dohc app prepareLocal '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser"}'
dohc app approve '{"workspaceId":"WORKSPACE_ID","approvalId":"APPROVAL_ID","candidateDigest":"CANDIDATE_DIGEST"}'
dohc app launchLocal '{"workspaceId":"WORKSPACE_ID","publicationId":"PUBLICATION_ID"}'
```

Review the source and requested dataset operations before approving.
App approval grants access to the approved dataset; it does not create a second database.
The local URL starts a browser session on this computer. Keep dohc open while using it.
It is not a public share link.

## Share the app

Configure a [self-hosted server](self-host.md) with the [app-origin and publication settings](../../services/share-web/README.md).
Enable `DOHC_RELAY_APP_PUBLICATIONS=1`.
Use the release tooling so the server includes its compiled runtime and QuickJS dependencies.

Share the app source folder, then prepare and approve the publication:

```sh
dohc app prepare '{"workspaceId":"WORKSPACE_ID","appRoot":"fundraiser","shareId":"SHARE_ID","grantId":"LINK_GRANT_ID"}'
dohc app approve '{"workspaceId":"WORKSPACE_ID","approvalId":"APPROVAL_ID","candidateDigest":"CANDIDATE_DIGEST"}'
```

The dataset transfers to one shared authority before shared writes begin. Local writes remain fenced after transfer.
Keep the shared host online while friends submit. A failed transfer must resume through dohc, not create another writer.
Dataset records and uploaded files do not require ordinary file-share selectors.

Friends open the share link and launch the app. The browser broker supplies only granted operations and files.
It does not supply owner credentials. The frontend can use ordinary networking, so review where it sends data.

## Manage the same records

Use the Collection table for permitted reads and edits, or invoke an approved operation:

```sh
dohc dataset invoke '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","revision":1,"revisionSha256":"REVISION_SHA256","operationId":"OPERATION_ID","idempotencyKey":"REQUEST_ID","input":{}}'
dohc dataset history '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","limit":50}'
dohc dataset permissions '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID"}'
```

Generate a fresh retry key for each intended change. Keep the same key and exact input after a lost response.
Changed input under the same key refuses. Revoked access cannot be recovered through a saved result.
History shows saved-operation metadata to the owner.
For eligible reversible edits under the current approved rules, it also shows previous values for the operation's declared fields.
Other input and result fields remain excluded. Choose **Undo edit** to restore the shown values if the record has not changed.

Manage explicit data grants through **Access** or `dataset setGrant` and `dataset removeGrant`.
Source-folder access alone does not grant Collection access. An app binding and a data grant are separate permissions.
Run `dohc dataset --help` for the supported command fields.

## Change fields and rules

Use **Fields and names** to add fields or rename fields, tables, and the Collection.
For custom schema or rule changes, prepare the new dataset descriptor and a migration SQL file:

```sh
dohc dataset prepareMigration '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","descriptorPath":"fundraiser/dataset.json","migrationPath":"fundraiser/migration.sql"}'
```

Preparation runs the migration against a saved copy and validates its schema and constraints.
Review the captured source, migration SQL, and each changed record's before and after values.
The returned `candidate.preview.firstPage` contains the first page. Use its `nextCursor` to read subsequent pages:

```sh
dohc dataset migrationPreviewPage '{"workspaceId":"WORKSPACE_ID","preparationId":"PREPARATION_ID","after":"NEXT_CURSOR","limit":100}'
```

Approve the reviewed result using the returned hashes, or discard it:

```sh
dohc dataset approveMigration '{"workspaceId":"WORKSPACE_ID","preparationId":"PREPARATION_ID","revisionSha256":"REVISION_SHA256","approvalDigest":"APPROVAL_DIGEST"}'
dohc dataset discardMigration '{"workspaceId":"WORKSPACE_ID","preparationId":"PREPARATION_ID"}'
```

Approval applies the exact reviewed checkpoint; it does not rerun the SQL.
Prepare a new review if the data changes, access changes, or the review expires.
Reviews expire after ten minutes. Each dataset can retain one review, with at most four reviews per host.
Rows above 128 KiB or encoded changes above 256 KiB refuse preparation without truncation.
Checkpoint and report storage must each fit the dataset capacity. See the [migration limits](../../packages/app-backend-runtime/README.md#approved-schema-transitions).

App bindings and data grants remain tied to their approved revision.
Review and approve access to the new revision before using those apps or grants again.

## Archive or delete a Collection

Archive a Collection to stop its operations while retaining its records. Restore it to resume under its existing rules.
Withdrawing an app leaves its dataset intact.

Before permanent deletion, export a private recovery archive and review every affected app in the deletion preview.
Permanent deletion removes the dataset's private data and cannot be undone on that host.
The host retains a deletion record that prevents restoring the same dataset identity there.
An archive can preserve a separate copy for recovery on clean host storage, subject to the recovery requirements below.

## Export and recover

Use **Import or export CSV** for tabular interchange. CSV import invokes the approved create operation for each row.
The saved retry report preserves row identities across interruptions. Each row commits separately.
Spreadsheet-safe CSV export escapes formula-like text and includes only the read operation's declared fields.

Use a private recovery archive to retain data, files, source, history, and retry credentials:

```sh
dohc dataset export '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","savePath":"C:/Backups/fundraiser.dohc-recovery"}'
```

The destination directory must exist. Existing files require explicit `overwrite:true`.
Protect the archive as private data. Its integrity checks detect corruption; they do not encrypt it.
The host keeps a replaceable checkpoint to reduce replay when reopening a Collection.
Checkpoint maintenance preserves committed history, schema checkpoints, and accepted retry keys. It does not delete old history.
If checkpoint maintenance cannot finish, the host rebuilds from the original checkpoint and retained history; reopening can take longer.
Quota exhaustion refuses further writes. Exporting an archive does not release storage.
Do not replace an authority that has accepted newer writes with an older archive.
Restore to clean local host storage with the same workspace identity and no existing copy of that Collection.
Do not create an empty Collection first. Recovery refuses every existing dataset, including an inactive or transferred copy.
The target must also have no permanent-deletion record for this dataset. Removing those records is not a supported recovery procedure.

Choose **Restore a Collection**, or prepare a private archive through the CLI:

```sh
dohc dataset prepareRecovery '{"workspaceId":"WORKSPACE_ID","sourcePath":"C:/Backups/fundraiser.dohc-recovery"}'
```

Preparation validates the archive, rules, history, files, and workspace identity. It does not create an active Collection.
Review the returned `recovery`, then stop the old host for this dataset.
Do not restart that old host after recovery.

Submit the returned identity fields without changing them:

```sh
dohc dataset claimRecovery '{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","transferId":"TRANSFER_ID","manifestSha256":"MANIFEST_SHA256","sourceCursor":{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","hostEpoch":"SOURCE_EPOCH","approvedRevisionHash":"REVISION_SHA256","revision":42,"digest":"SOURCE_DIGEST"},"oldHostStopped":true}'
```

The restored Collection retains records, attachments, approved rules, history, and retry receipts.
It receives a new host epoch. Saved sharing grants remain inactive; review and approve access again.
A failed claim can retry with the same identity fields, including after restarting dohc.
Before claiming, cancel with `dataset discardRecovery` and the returned `transferId`.

To recover onto a clean shared host, first restore locally, then publish the app through the normal sharing flow.
That transfer stops local writes before the server accepts the dataset. It preserves attachments and retry receipts.
The shared target must have neither an existing copy nor a permanent-deletion record for this dataset.
Recovery never promotes a downloaded replica or replaces a running shared authority.

See [server recovery](self-host-recovery.md) for whole-service restoration.
