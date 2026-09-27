# Build an app connected to a Collection

App authors and self-host operators use this guide to create, share, and manage a Collection-backed app.
An already connected agent can use the same commands. Run the CLI from the owning workspace while dohc is open.
Replace uppercase values with IDs returned by dohc. JSON examples work in PowerShell 7 and POSIX shells.

## Create the Collection first

Use **New collection** to create a transactional Collection, then choose **Create form** from its **Manage** menu.
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
dohc dataset describe '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json"}'
```

Review the captured source before approving its exact revision hash.
Keep app code and Collection views on the same dataset. They do not need separate response stores.

## Connect the app

Put `app.publish.json` in the app folder. Declare the frontend entry, source inputs, and a `dataset` binding.
Write entryPath, inputs, and packageMap paths relative to the app folder. Start a path with `../` to include a file beside it.
After moving or renaming a dataset folder, update its path in commands and app manifests.
An old path reports a broken reference. dohc does not rewrite app source when files move.
Already approved apps keep their ID-based grants until you withdraw or replace their publication.
The engine resolves the path to the internal dataset ID; the path grants no access.
For direct Collection access in a shared workspace, the owner must include dataset.json in the share.
Published apps keep their approved grants and do not need their audience to read dataset.json.

The binding names the workspace-relative `datasetPath` ending in `dataset.json`, the approved `revision` and `revisionSha256`, and permitted `operationIds`.
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
`ctx.caller.kind` says who asked: `owner`, `named` for a person the owner granted access, `link` for someone with a share link, or `automation` for an automation on the Collection.
An automation caller has `automationId`, such as `collection:Invoices#mark-paid`.
It is not the owner: an operation that allows only the owner refuses it.
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

Choose **Table**, **Board**, or **Calendar** in the Collection's layout control.
For a board, choose **Group board by**. For a calendar, choose **Calendar date**.
Use **Create view** to save a layout with filters and sorting.
Boards page through groups and their records. Calendars request the visible date range.
Moving a card or date invokes the permitted edit operation with the record's current version.
Read-only access cannot move records. A refused move leaves the saved record unchanged.

Generated read actions support these layouts. Custom actions must support the requested grouping or date range.
If a custom action refuses a view, update its source and review the change before reopening that view.

Use the Collection controls for permitted reads and edits, or invoke an approved operation:

```sh
dohc dataset invoke '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","revision":1,"revisionSha256":"REVISION_SHA256","operationId":"OPERATION_ID","idempotencyKey":"REQUEST_ID","input":{}}'
dohc dataset history '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","limit":50}'
dohc dataset permissions '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json"}'
```

Generate a fresh retry key for each intended change. Keep the same key and exact input after a lost response.
Changed input under the same key refuses. Revoked access cannot be recovered through a saved result.
History shows saved record operations and field or rule revisions to the owner.
For eligible reversible edits under the current approved rules, it also shows previous values for the operation's declared fields.
Other input and result fields remain excluded. Choose **Undo edit** to restore the shown values if the record has not changed.

Manage explicit data grants through **Access** or `dataset setGrant` and `dataset removeGrant`.
Source-folder access alone does not grant Collection access. An app binding and a data grant are separate permissions.
Run `dohc dataset --help` to list the verbs. Run `dohc dataset <verb> --help` for that verb's fields.
The [CLI, MCP, and SDK reference](../reference/cli-mcp-sdk.md) also lists each verb's result, and shows how an app page calls an approved operation.

## Change fields and rules

Use **Fields and names** to add fields or rename fields, tables, and the Collection.
Renaming keeps authored operation source intact. Adding a field does not expand public or collaborator access.
For custom operations, update their source explicitly before using a new field.

Choose **Change field type or requirement** to review supported conversions on generated Collections.
Text-to-number conversions must preserve the original value. Conflicting values stop preparation instead of losing information.
Fix those records and prepare again. Required fields must have values; newly added required fields need a default.
For fields governed by custom rules, the error names the affected actions and source file.
Choose **Review source change** to review the corresponding rule and schema edits.

For custom schema or rule changes, prepare the new dataset descriptor and a migration SQL file:

```sh
dohc dataset prepareMigration '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","migrationPath":"fundraiser/migration.sql"}'
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

Changes limited to display names or source locations keep existing shared apps and collaborator access working.
Changes to executable rules, field structure, or permissions need renewed app and collaborator approval.
Review the affected access before using those apps or grants again.

## Reverse a saved change

Open **History**, expand a **Fields and rules** entry, then choose **Compare change**.
Compare the saved fields, actions, schema, and operation source before and after that change.
The source paths and SHA-256 hashes identify the approved bytes, even if workspace files have since changed.
Choose **Open current rules file** or **Open current schema file** to open its workspace source.
Use that file's History to inspect its file changes. Restoring a file does not activate Collection rules or permissions.

Choose **Review reversal** to prepare a new revision against the current records.
The reversal targets the selected change and preserves unrelated later names, rules, records, and current access.
If the same rules or names changed again, resolve the conflict before approving.
Structural changes need **Fields and names** or **Review source migration**; dohc does not infer an inverse for arbitrary SQL.
Review the resulting change, then choose **Approve change**.
If records changed after preparation, prepare a new review. Accepted registrations are never replaced with an older database copy.

Agents use the same immutable source and review path:

```sh
dohc dataset historyRevision '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","revisionSha256":"SAVED_REVISION_SHA256"}'
dohc dataset prepareHistoryRestore '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","revision":3,"revisionSha256":"CURRENT_REVISION_SHA256","targetRevisionSha256":"BEFORE_REVISION_SHA256","changedRevisionSha256":"AFTER_REVISION_SHA256"}'
```

Take the before and after hashes from the selected history entry. Approve through `dataset approveMigration` as above.

## Read shared records offline

A named collaborator can reopen saved read pages on the same device without reaching the sharing server.
While connected, open the Collection and each required view or page first.
The device saves only successful results from permitted read actions, scoped to that account, workspace, and share.
Saving happens in the background. Online responses do not confirm an offline save; a failed save leaves that page unavailable offline.
This is a saved-page cache, not a complete dataset snapshot. Older pages can leave the cache as space fills.

Offline reads require the same action, revision, filters, and page request that the device saved.
A different search, page, or date range may require reconnecting. Offline views identify saved pages and their save time.
Connect to change records, upload files, or open attachments. Attachment bytes are not saved for collaborators.

Known revocation, changed permissions, account changes, or a narrower local share remove the affected saved pages.
A disconnected device cannot learn about remote revocation until it reconnects.
Revoking access cannot erase information that someone already downloaded outside dohc.

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
dohc dataset export '{"workspaceId":"WORKSPACE_ID","datasetPath":"fundraiser/dataset.json","savePath":"C:/Backups/fundraiser.dohc-recovery"}'
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
dohc dataset claimRecovery '{"workspaceId":"WORKSPACE_ID","transferId":"TRANSFER_ID","manifestSha256":"MANIFEST_SHA256","sourceCursor":{"workspaceId":"WORKSPACE_ID","datasetId":"DATASET_ID","hostEpoch":"SOURCE_EPOCH","approvedRevisionHash":"REVISION_SHA256","revision":42,"digest":"SOURCE_DIGEST"},"oldHostStopped":true}'
```

The restored Collection retains records, attachments, approved rules, history, and retry receipts.
Recovery restores missing source files without replacing existing files. The result includes its datasetPath.
If source restoration fails, the data stays restored. The result reports sourceError and a null datasetPath.
It receives a new host epoch. Saved sharing grants remain inactive; review and approve access again.
A failed claim can retry with the same identity fields, including after restarting dohc.
Before claiming, cancel with `dataset discardRecovery` and the returned `transferId`.

To recover onto a clean shared host, first restore locally, then publish the app through the normal sharing flow.
That transfer stops local writes before the server accepts the dataset. It preserves attachments and retry receipts.
The shared target must have neither an existing copy nor a permanent-deletion record for this dataset.
Recovery never promotes a downloaded replica or replaces a running shared authority.

See [server recovery](self-host-recovery.md) for whole-service restoration.
