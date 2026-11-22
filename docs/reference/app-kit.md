# Built-in app kit

dohc's closed app compiler provides a pinned set of browser modules so apps can use React, backend calls, themed controls, and SVG charts without vendoring `node_modules` or adding `packageMap` entries.

## Available imports

| Specifier | Purpose |
| --- | --- |
| `react`, `react/jsx-runtime` | React 19 hooks and JSX runtime |
| `react-dom`, `react-dom/client` | ReactDOM (`createRoot`, `createPortal`) |
| `dohc/app` | MessageChannel backend client and hooks (`AppProvider`, `useApp`, `useDatasetQuery`, `useDatasetMutation`, `createAppClient`, `mutationKey`, `AppBackendError`) |
| `dohc/ui` | Light and dark themed layout, data, and form components (`AppShell`, `PageHeader`, `Grid`, `Stack`, `Card`, `StatCard`, `Tabs`, `DataTable`, `Badge`, `ProgressBar`, `Callout`, `EmptyState`, `Skeleton`, `Button`, `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Modal`, plus currency/number/percent/date formatters) |
| `dohc/charts` | Responsive SVG charts (`LineChart`, `BarChart`, `DonutChart`, `Sparkline`) with light and dark tokens and single-tab-stop arrow-key navigation |

The prefixes `react`, `react-dom`, `scheduler`, and `dohc` are reserved. Do not map them in `app.publish.json`'s `packageMap`.

## Styles and theming

- Importing `dohc/ui` automatically bundles the kit's light and dark styles into `bundle.css`.
- Importing only `dohc/charts` bundles only the color tokens and chart rules without resetting page styles.
- Importing only `dohc/app` or `react` adds no CSS.

## Minimal example

```tsx
import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetQuery } from "dohc/app";
import { AppShell, Card, PageHeader, StatCard, formatCurrency } from "dohc/ui";
import { LineChart } from "dohc/charts";

function Dashboard() {
  const { data, loading, error } = useDatasetQuery<{ total: number; weekly: { label: string; value: number }[] }>(
    "monthlySummary",
  );
  return (
    <AppShell>
      <PageHeader title="Spending" />
      <StatCard label="This month" value={loading ? "…" : formatCurrency(data?.total ?? 0)} />
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
