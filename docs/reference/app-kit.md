# Built-in app kit

dohc's closed app compiler provides a pinned set of browser modules so apps can use React, backend calls, themed controls, and SVG charts without vendoring `node_modules` or adding `packageMap` entries.

## Available imports

| Specifier | Purpose |
| --- | --- |
| `react`, `react/jsx-runtime` | React 19 hooks and JSX runtime |
| `react-dom`, `react-dom/client` | ReactDOM (`createRoot`, `createPortal`) |
| `dohc/app` | MessageChannel backend client and hooks (`AppProvider`, `useApp`, `useDatasetQuery`, `useDatasetMutation`, `createAppClient`, `mutationKey`, `AppBackendError`) |
| `dohc/ui` | Light and dark themed layout, data, and form components (`AppShell`, `PageHeader`, `Grid`, `Stack`, `Card`, `StatCard`, `Tabs`, `DataTable`, `Badge`, `ProgressBar`, `Callout`, `EmptyState`, `Skeleton`, `Button`, `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Modal`, plus currency/number/percent/date formatters) |
| `dohc/charts` | Responsive SVG charts with light and dark tokens: interactive `LineChart`, `BarChart`, and `DonutChart` (single-tab-stop arrow-key navigation), plus non-interactive `Sparkline` |
| `dohc/icons` | A curated set of [Lucide](https://lucide.dev) icons as React components (for example `Plus`, `Trash2`, `Receipt`, `Wallet`, `Plane`, `CalendarDays`). Only the icons an app imports end up in its bundle |
| `dohc/money` | Exact money in whole minor units (cents): `formatCents(123400, { currency: "EUR", locale: "de-DE" })` gives `1.234,00 €` without floating-point rounding, and `parseCents("$1,234.50")` gives `123450`, or `null` for text that isn't an exact amount |
| `dohc/csv` | RFC 4180 `parseCsv(text)` for quoted fields, embedded line breaks, and a leading byte order mark, and `toCsv(rows)`, which prefixes text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return with `'` so spreadsheets don't run them as formulas. Pass amounts as numbers so negative values stay numeric |

The prefixes `react`, `react-dom`, `scheduler`, and `dohc` are reserved. Do not map them in `app.publish.json`'s `packageMap`.

## Styles and theming

- Importing `dohc/ui` automatically bundles the kit's light and dark styles into `bundle.css`.
- Importing only `dohc/charts` bundles only the color tokens and chart rules without resetting page styles.
- Importing only `dohc/app` or `react` adds no CSS.

## Minimal example

This example assumes the app's dataset binding includes an approved `monthlySummary` operation that returns `{ total: number, weekly: { label: string, value: number }[] }`. See the [app backend guide](../how-to/app-backend.md) to configure operations and bindings.

```tsx
import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetQuery } from "dohc/app";
import { AppShell, Button, Callout, Card, PageHeader, StatCard, formatCurrency } from "dohc/ui";
import { LineChart } from "dohc/charts";

function Dashboard() {
  const { data, loading, error, reload } = useDatasetQuery<{
    total: number;
    weekly: { label: string; value: number }[];
  }>("monthlySummary");
  return (
    <AppShell>
      <PageHeader title="Spending" />
      {error ? (
        <Callout
          tone="danger"
          title="Could not load spending"
          action={
            <Button size="sm" onClick={reload}>
              Try again
            </Button>
          }
        >
          {error.message}
        </Callout>
      ) : null}
      <StatCard
        label="This month"
        value={loading ? "…" : data ? formatCurrency(data.total) : "—"}
      />
      {!error && data ? (
        <Card title="Weekly trend">
          <LineChart variant="area" data={data.weekly} formatValue={(v) => formatCurrency(v)} />
        </Card>
      ) : null}
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <Dashboard />
  </AppProvider>,
);
```

## Minimal `app.publish.json`

`inputs` and `packageMap` are optional. When `inputs` is omitted, dohc includes the supported source files in the app folder and leaves out `app.publish.json`, `dataset.json`, co-located Collection schemas and operations, strict Collection subfolders, top-level `changes/` and `revisions/`, `collection.yaml`, `automations.yaml`, `package.json`, `dohc.json`, `tsconfig*.json`, `*.test.*`, `*.spec.*`, dotfiles, and `node_modules`. Relative script imports without extensions (for example `./Summary` or `./date.utils`) resolve unambiguously across `.tsx`, `.ts`, `.jsx`, `.js`, and `index.*`.

A Collection binding can name operations directly and omit `revision` and `revisionSha256`; dohc pins them to the Collection's currently approved revision when preparing the app:

```json
{
  "version": 1,
  "entryPath": "main.tsx",
  "dataset": {
    "kind": "dataset",
    "datasetPath": "expenses/dataset.json",
    "operations": ["listExpenses", "addExpense"]
  }
}
```

## Multi-Collection owner apps (`datasets`)

An owner desktop app can bind between 1 and 16 Collections on the same host by replacing `dataset` with a `datasets` map keyed by lowercase alias (`^[a-z][a-z0-9_-]{0,63}$`, excluding the reserved names `constructor` and `prototype`). Each alias maps to one Collection reference and cannot share a `datasetId` with another alias. Shared links, named shares, and phone apps stay at one Collection.

```json
{
  "version": 1,
  "entryPath": "main.tsx",
  "datasets": {
    "expenses": {
      "kind": "dataset",
      "datasetPath": "expenses/dataset.json",
      "operations": ["listExpenses", "addExpense"]
    },
    "workouts": {
      "kind": "dataset",
      "datasetPath": "workouts/dataset.json",
      "operations": ["listWorkouts", "logWorkout"]
    }
  }
}
```

Pass the alias to `useDatasetQuery`, `useDatasetMutation`, or `client.dataset(alias)`:

```tsx
const expenses = useDatasetQuery("listExpenses", {}, { dataset: "expenses" });
const logWorkout = useDatasetMutation("logWorkout", { dataset: "workouts" });
const workoutsClient = useApp().dataset("workouts");
```

Each Collection keeps its own permissions, idempotency keys, file storage, and per-Collection rate limit. Owner requests to all bound Collections also share one budget. When that budget is empty, calls to any bound Collection are refused. Archiving or deleting any bound Collection stops the app until you restore or re-approve it.

## Slug-based `dataset.json` (`formatVersion: 2`)

Collection definitions can use `formatVersion: 2` to declare tables, fields, and operations by SQL name instead of hand-writing UUIDs. `schemaPath` and `operationsPath` resolve relative to the `dataset.json` folder (defaulting to `schema.sql` and `operations.js`), and `schemaPath` must stay in that folder or a generated `revisions/` subfolder. Operation `access` defaults to `"owner"`. dohc derives stable RFC 4122 UUIDv5 identifiers from `datasetId` and the SQL names (or button display names) and validates the normalized definition under the same rules and 256 KB limit as `formatVersion: 1`. Before renaming a table, column, button, or operation on an existing Collection, pin its explicit `tableId`, `fieldId`, or `operationId` (renaming a table's `sqlName` also changes derived `fieldId`s for every column and button in that table, so pin those `fieldId`s too), and update any name-based `app.publish.json` bindings that reference renamed operations or fields. When passing a `formatVersion: 2` definition to `dohc dataset create`, include explicit workspace-relative `schemaPath` and `operationsPath`.

```json
{
  "formatVersion": 2,
  "datasetId": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Expenses",
  "tables": [
    {
      "sqlName": "expenses",
      "primaryKey": "id",
      "fields": [
        { "sqlColumn": "id", "type": "text" },
        { "sqlColumn": "merchant", "name": "Merchant", "type": "text", "required": true },
        { "sqlColumn": "amount", "name": "Amount", "type": "number", "required": true }
      ]
    }
  ],
  "operations": [
    { "name": "listExpenses", "table": "expenses", "kind": "read", "fields": ["id", "merchant", "amount"] },
    { "name": "addExpense", "table": "expenses", "kind": "create", "fields": ["id", "merchant", "amount"] }
  ]
}
```

## Typed rows and operations

`dohc dataset types` writes TypeScript declarations for a Collection's approved revision to `.dohc/types/<name>-<datasetId>.d.ts` at the workspace root and returns the exact `path`. `<name>` comes from the Collection's folder, for example `.dohc/types/expenses-11111111-1111-4111-8111-111111111101.d.ts` for `expenses/dataset.json`.

```bash
dohc dataset types '{"workspaceId":"<workspaceId>","datasetPath":"expenses/dataset.json"}'
```

The file exports:

- `Tables`: each table's row, keyed by SQL column, with values as dohc's generated operations read and write them. A checkbox is `boolean`, a select is a union of its options, a multi-select or a many relation is an array, and a field that isn't required can be `null`.
- `Row<"table">`: one table's row.
- `FieldIds`: each column's `fieldId`, the key generated operations use in `values`.
- `Operations`: each operation's `kind`, `table`, `access`, `readOnly`, and `fields`, the row columns it declares.
- `OperationName`: the operation names.

Import them with `import type`, so the app bundle and its approval never include the file. Generated row-list reads (without `groupBy`) return `{ rows, nextCursor }` with each row's `values` keyed by `FieldIds`:

```tsx
import type {
  FieldIds,
  Operations,
  Row,
} from "../.dohc/types/expenses-11111111-1111-4111-8111-111111111101";

type ExpenseFields = Operations["listExpenses"]["fields"];
type ExpenseValues = {
  [Column in keyof ExpenseFields as FieldIds["expenses"][Column]]: ExpenseFields[Column];
};
type ExpensePage = {
  rows: Array<{ id: Row<"expenses">["id"]; version: number; values: ExpenseValues }>;
  nextCursor: { id: Row<"expenses">["id"]; value: unknown } | null;
};

const { data } = useDatasetQuery<ExpensePage>("listExpenses");
```

Types describe the approved revision, not a draft. Run the command again after you approve a change. Operations you write yourself return whatever their code returns, so type their results with `Row`, `fields`, or your own types.

## Staging an app and its Collections together

To create or update bound Collections and approve an app in one owner review, run `dohc app stage`:

```bash
dohc app stage '{"workspaceId":"<workspaceId>","appRoot":"personal-control-tower"}'
```

- Staging is read-only on workspace files and stores the staged review locally under `.dohc/local/staged-apps/`.
- Every new or updated Collection is preflighted and the app is compiled before anything is saved.
- Operations-only updates to an existing Collection need no migration file (`migrationPath` defaults to `null`, running an in-memory `SELECT 1;` no-op migration). Pass `"migrations": { "<alias-or-datasetPath>": "<migration.sql>" }` when a Collection's schema changed.
- Open the app in dohc and click **Review app** to inspect every new/updated Collection and app capability in one card, then click **Approve and open** (or **Discard**). Interrupted approvals resume cleanly from per-step receipts without repeating already-applied Collections.
- See `examples/personal-control-tower` for a complete two-Collection example (`expenses` and `workouts`).
