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

`inputs` and `packageMap` are optional. When `inputs` is omitted, dohc includes the supported source files in the app folder and leaves out `app.publish.json`, `dataset.json`, co-located Collection schemas and operations, strict Collection subfolders, top-level `changes/` and `revisions/`, `collection.yaml`, `automations.yaml`, `package.json`, `dohc.json`, `tsconfig*.json`, dotfiles, and `node_modules`. Relative script imports without extensions (for example `./Summary` or `./date.utils`) resolve unambiguously across `.tsx`, `.ts`, `.jsx`, `.js`, and `index.*`.

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
