# Collections and datasets

## Document Collections (`collection.yaml`)

Put `collection.yaml` in a folder to make it a document Collection. `fields` is a YAML mapping keyed by field name, not a list. `select` and `multi-select` `options` are plain strings:

```yaml
version: 1
name: Kyoto Activities
fields:
  Day:
    type: number
  Status:
    type: select
    options:
      - Idea
      - Booked
      - Done
  Cost:
    type: number
```

Supported field types: `text`, `number`, `checkbox`, `date`, `select`, `multi-select`, `person`, `relation`, `url`, `button`.

Create records with `dohc_create_record` (pass `collectionPath`, `name`, optional `fields`). Update fields with `dohc_set_record_fields` (`recordPath`, `fields`). Query records with `dohc_query_collection`.

## Transactional Collections (`dataset.json`)

Every transactional Collection is defined by `dataset.json`, a SQLite schema (`schema.sql`), and operations source (`operations.js` or `backend.ts`).

### Choosing between `create`, `prepare` + `approve`, and `app stage`

- **Generated CRUD Collection**: Call `dohc_dataset` with `{ request: { action: "create", workspaceId, definition } }`, where `definition` is a `dataset.json` descriptor object (`formatVersion: 1` or `2`, `name`, `schemaPath`, `operationsPath`, `tables`, `operations`, plus `datasetId` for `formatVersion: 1`). dohc generates `dataset.json`, `schema.sql`, and `operations.js` and approves revision 1 in one step. Generated operations reject unknown keys with `invalid_input` and use these exact input shapes (keyed by field UUIDs from `describe`):
  - `read`: `{}` (all fields optional: `limit` 1–100 default 50, `after: { id, value } | null`, `search`, `filters: [{ fieldId, value }]` up to 20 AND-combined, `sort: { fieldId, direction: "asc" | "desc" }`, `range: { fieldId, start, end }`, `group: { fieldId, value }`, `groupBy: fieldId`, `groupAfter: { value }`).
  - `create`: `{ values: { "<fieldId>": value } }`.
  - `edit`: `{ id, expectedVersion, values: { "<fieldId>": value } }` (`expectedVersion` is `row.version` from `read`).
  - `delete`: `{ id, expectedVersion }` (no `values`).
- **Custom business rules (`backend.ts` or `operations.js`)**: Write `dataset.json`, `schema.sql`, and `backend.ts` with `dohc_write_file`, then call `prepare` followed by `approve`.
- **App + Collection created or changed together**: Use `dohc_publish_app` `stage` -> `approveStaged` to review and apply the Collection changes and activate the local app in one approval. Staging activates only the local app and does not update live share-link publications; share-link apps still require `prepare` + `approve`.

### Exact `dataset.json` rules

Every violation fails validation (for full slug-based `formatVersion: 2` details, see `docs/reference/app-kit.md`):

- `formatVersion` may be `1` (explicit UUIDs for `datasetId`, `tableId`, `fieldId`, and `operationId`) or `2` (`datasetId` is still required in authored `dataset.json` files, while `tableId`, `fieldId`, and `operationId` may be omitted and are derived deterministically via UUIDv5 from `datasetId`, `sqlName`, `sqlColumn`, and operation `name`; only `dohc_dataset` `create` generates a missing `datasetId`).
- In `formatVersion: 1`, `datasetId`, every `tableId`, every `fieldId`, and every `operationId` must be valid UUIDs and globally unique across the entire definition.
- `schemaPath` ends in `.sql` and `operationsPath` ends in `.js` or `.ts`. In `formatVersion: 1` and `dohc_dataset` `create`, both are workspace-relative; in authored `formatVersion: 2` descriptors they resolve relative to `dataset.json` (defaulting to `"schema.sql"` and `"operations.js"`).
- Each table has `name`, `sqlName`, `primaryKey`, and `fields` (plus `tableId` in v1). `primaryKey` must match a column field's `sqlColumn` whose `type` is `"text"` or `"number"`, with `required: true`, `unique: true`, and no `default`.
- Optional `"generated": "record-id"` is valid only on the primary key field when `type: "text"`, `required: true`, `unique: true`, and no `default`.
- Column field types: `text`, `number`, `checkbox`, `date`, `select`, `multi-select`, `url`, `attachment`, `relation` (plus `button` fields which have only `{ fieldId?, name, type: "button" }`).
- `select` and `multi-select` require non-empty unique `options: string[]`. Other field types must omit `options`.
- Each operation has `name`, `label`, `tableId` (or `table` in v2), `kind` (`"read" | "create" | "edit" | "delete" | "action"`), `access` (`"link" | "helper" | "owner"`), `readOnly`, and `fieldIds` (or `fields` in v2).
- `readOnly` must be `true` when `kind === "read"`, and `false` when `kind` is `"create"`, `"edit"`, or `"delete"`. `"action"` may be either.
- `kind === "delete"` must have `fieldIds: []`.
- `kind === "create"` must NOT list a `generated: "record-id"` field in `fieldIds`.
- `kind === "edit"` must NOT list the table's `primaryKey` field in `fieldIds`.
- Every field referenced by an operation must belong to a column field (not a button) on the operation's table.

### Custom operations (`backend.ts` / `operations.js`)

Operations run synchronously inside an isolated QuickJS sandbox with no `import`, `require`, network, or filesystem access. Assign functions to `globalThis.operations`:

```ts
globalThis.operations = {
  bookSeat(ctx, input) {
    const seats = Number(input?.seats ?? 1);
    if (!Number.isInteger(seats) || seats < 1) {
      ctx.refuse("invalid_seats", "Choose at least 1 seat.");
    }
    const taken = Number(ctx.db.query("SELECT COALESCE(SUM(seats), 0) AS n FROM bookings")[0]?.n ?? 0);
    if (taken + seats > 8) {
      ctx.refuse("workshop_full", "All 8 seats are taken.");
    }
    ctx.db.execute(
      "INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)",
      [ctx.requestId, String(input?.name ?? ""), seats],
    );
    return { id: ctx.requestId, seats };
  },
};
```

- `ctx.db.query(sql, params)` returns rows; `ctx.db.execute(sql, params)` returns `{ changes }`. Parameters are strings, finite numbers, or `null`.
- `ctx.refuse(code, message)` rolls back the transaction and returns a structured refusal (`code` matches `/^[a-z][a-z0-9_]{0,63}$/`).
- `ctx.caller.kind` is `"owner"`, `"named"`, `"link"`, or `"automation"`.

### `dohc_dataset` action cheat sheet

Pass `{ request: { action, ... } }` to `dohc_dataset`:

| Action | Required fields | Notes |
| --- | --- | --- |
| `list` | `workspaceId` | Returns approved Collections with `datasetPath`, `revision`, `revisionSha256`. |
| `describe` | `workspaceId`, `datasetPath` | Returns tables, fields, operations, `revision`, `revisionSha256`. |
| `permissions` | `workspaceId`, `datasetPath` | Returns collaborator grants, app bindings, `boundApps` with drift `status` (`"compatible"`, `"needs-refresh"`, `"incompatible"`) and `reasons`, and `boundAppsIncomplete: true` if discovery failed or results are paginated (do not treat omitted `boundApps` as a complete check when `boundAppsIncomplete` is set). |
| `create` | `workspaceId`, `definition` | Writes generated files and approves revision 1. |
| `prepare` | `workspaceId`, `descriptorPath` | Captures edited `dataset.json`, `schemaPath`, `operationsPath`. Returns `preparationId` and `revision.revisionSha256`. |
| `approve` | `workspaceId`, `preparationId`, `revisionSha256` | Approves a preparation. Do not pass `datasetPath` or `sourceDigest`. |
| `invoke` | `workspaceId`, `datasetPath`, `operationId`, `revision`, `revisionSha256`, `input`, `idempotencyKey` | Runs an approved operation. Use a fresh `idempotencyKey` per intended write; reuse the same key and input to retry an uncertain write. |
| `prepareSchemaChange` | `workspaceId`, `datasetPath`, `revision`, `revisionSha256`, `change` | `change.kind`: `addField`, `renameField`, `changeField`, `renameTable`, `renameCollection`, `addButton`. Required `addField` needs `default`. Returns `boundApps` and, if checks were incomplete or paginated, `boundAppsIncomplete: true`. |
| `prepareMigration` | `workspaceId`, `datasetPath`, `migrationPath` | Prepares edited source + SQL migration file for custom Collections. Pass `migrationPath: null` when only operations or metadata changed without schema SQL edits. Returns `boundApps` and, if checks were incomplete or paginated, `boundAppsIncomplete: true`. |
| `prepareRelationChoices` | `workspaceId`, `datasetPath`, `revision`, `revisionSha256`, `tableId`, `fieldId`, `labelFieldId` | Adds a public read operation returning only key + `labelFieldId` for a relation field. Returns `boundApps` and, if checks were incomplete or paginated, `boundAppsIncomplete: true`. |
| `approveMigration` | `workspaceId`, `preparationId`, `revisionSha256`, `approvalDigest` | Applies a prepared schema change, migration, or relation choices. Do not pass `datasetPath`. |
| `createForm` | `workspaceId`, `datasetPath`, `revision`, `revisionSha256`, `tableId`, `createOperationId`, `appRoot`, `fieldIds` | Optional `title`, `relationChoices: [{ fieldId, operationId, labelFieldId }]`. Generated `app.publish.json` omits `revision` and `revisionSha256` so re-preparing picks up later approved revisions automatically. |
