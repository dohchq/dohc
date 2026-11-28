# Built-in app kit

dohc's closed app compiler provides a pinned set of browser modules so apps can use React, backend calls, themed controls, and SVG charts without vendoring `node_modules` or adding `packageMap` entries.

## Available imports

| Specifier | Purpose |
| --- | --- |
| `react`, `react/jsx-runtime` | React 19 hooks and JSX runtime |
| `react-dom`, `react-dom/client` | ReactDOM (`createRoot`, `createPortal`) |
| `dohc/app` | MessageChannel backend client, hooks, and host helpers (`AppProvider`, `useApp`, `useDatasetQuery`, `useDatasetPages`, `useDatasetMutation`, `createAppClient`, `mutationKey`, `appBudget`, `copyText`, `print`, `notice`, `AppBackendError`) |
| `dohc/ui` | Light and dark themed layout, data, and form components (`AppShell`, `PageHeader`, `Grid`, `Stack`, `Card`, `StatCard`, `Tabs`, `DataTable`, `Badge`, `ProgressBar`, `Callout`, `EmptyState`, `Skeleton`, `Button`, `Field`, `Input`, `Select`, `Textarea`, `DateField`, `Checkbox`, `Modal`, plus currency/number/percent/date formatters). `Button`, `Checkbox`, `Input`, `Select`, and `Textarea` accept `ref`. `Tone` supports `"neutral"`, `"info"`, `"success"`, `"warning"`, and `"danger"`. `Badge` supports `dot`, `Button` supports `loading` and `iconOnly`, `Field` supports `required` and wires `aria-invalid` on errors, `Checkbox` supports `description`, and `Modal` supports `description` and `size` (`"sm" \| "md" \| "lg"`). `DateField` takes and returns `YYYY-MM-DD`, with optional `min` and `max`: ArrowUp and ArrowDown step one day, and `onChange` gets `""` while the text is not a real date inside the bounds |
| `dohc/charts` | Responsive SVG charts with light and dark tokens: interactive `LineChart`, `BarChart`, and `DonutChart` (single-tab-stop arrow-key navigation), plus non-interactive `Sparkline`. `LineChart` supports `curve="smooth"` (default `"linear"`) and `markerIndex`, which draws a rule at one label, such as a replay's current step |
| `dohc/icons` | A curated set of [Lucide](https://lucide.dev) icons as React components (for example `Plus`, `Trash2`, `X`, `ZoomIn`, `PanelRight`, `Play`, `Receipt`, `CalendarDays`). Only the icons an app imports end up in its bundle |
| `dohc/money` | Exact money in whole minor units (cents): `formatCents(123400, { currency: "EUR", locale: "de-DE" })` gives `1.234,00 €` without floating-point rounding, and `parseCents("$1,234.50")` gives `123450`, or `null` for text that isn't an exact amount |
| `dohc/csv` | RFC 4180 `parseCsv(text)` for quoted fields, embedded line breaks, and a leading byte order mark, and `toCsv(rows)`, which prefixes text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return with `'` so spreadsheets don't run them as formulas. Pass amounts as numbers so negative values stay numeric |

The prefixes `react`, `react-dom`, `scheduler`, and `dohc` are reserved. Do not map them in `app.publish.json`'s `packageMap`.

## Styles and theming

- Importing `dohc/ui` automatically bundles the kit's light and dark styles into `bundle.css`.
- Importing only `dohc/charts` bundles only the color tokens and chart rules without resetting page styles.
- Importing only `dohc/app` or `react` adds no CSS.
- Every app page starts with the kit's sans-serif font and `border-box` sizing, in a cascade layer that any app style overrides.

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
        value={data ? formatCurrency(data.total) : loading ? "…" : "—"}
      />
      {data ? (
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

When a reload fails, `data` and `revision` keep the last good answer and `error` says why, so a page that calls `reload()` on a timer keeps showing data through one failed request. `data` clears when the operation, input, or Collection changes.

## Paged reads

`useDatasetPages` reads every page of an operation that pages with `nextCursor`, such as a generated row-list read (`ExpensePage` is defined in [Typed rows and operations](#typed-rows-and-operations)). It sends `input` for the first page, then `{ ...input, after: nextCursor }` until `nextCursor` is `null`, and returns the pages in order. It has the same options, live updates, and `reload` as `useDatasetQuery`.

```tsx
const { data } = useDatasetPages<ExpensePage>("listExpenses");
const rows = useMemo(() => data?.flatMap((page) => page.rows) ?? [], [data]);
```

- `data` is set once the last page arrives. `revision` is the first page's revision.
- If the Collection changes while pages load, the read starts again from the first page, at most twice. After the second restart it keeps the pages it gets, even if they come from different revisions.
- When a page hits a rate limit, the read waits `retryAfterMs`, or 2 s when the host gives none, and asks for that page again.
- A page without a `nextCursor` field, or a `nextCursor` the read already followed, fails with `error.status === 400`. `groupBy` reads, which return `nextGroupCursor`, and offset-paged reads need `useDatasetQuery`.

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
- `Operations`: each operation's `kind`, `table`, `access`, `readOnly`, and `fields`, the row columns it declares. An `action` also has `input` and `output`, from its contract or `unknown`.
- `OperationName`: the operation names.
- `Input<"name">` and `Output<"name">`: an action's declared input and result. Other operations give `never`.

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

Types describe the approved revision, not a draft. Run the command again after you approve a change.

### Typed actions

An `action` can declare a `contract` in `dataset.json`: the input it takes and the result it returns.

```json
{
  "name": "setStatus",
  "table": "tasks",
  "kind": "action",
  "readOnly": false,
  "contract": {
    "input": { "object": { "id": "string", "status": { "enum": ["open", "done"] }, "note": { "nullable": "string" } }, "optional": ["note"] },
    "output": { "object": { "status": { "enum": ["open", "done"] } } }
  }
}
```

A type is `"string"`, `"number"`, `"boolean"`, `"unknown"`, `{ "enum": [...] }` with up to 64 strings, numbers, or booleans, `{ "array": type }`, `{ "nullable": type }`, or `{ "object": { "key": type }, "optional": ["key"] }` with 1 to 64 keys. A contract nests at most 8 levels and holds at most 256 types. `Output` types the action's `result`, inside the reply's `{ result, revision, replayed }`:

```tsx
import type { Input, Output } from "../.dohc/types/tasks-11111111-1111-4111-8111-111111111101";

const setStatus = useDatasetMutation<Input<"setStatus">, Output<"setStatus">>("setStatus");
```

dohc does not check values against a contract. Check input in `operations.js` and refuse what it can't take. When an owner reviews a change, an app built on an action is marked **Needs update** if the action stops accepting input it took before or can return output the app doesn't expect. A change to a contract alone keeps the app's approval. Type the results of actions without a contract with `Row`, `fields`, or your own types.

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

## Calling outside services with a workspace secret (`external`)

An app can call an outside API with a secret from **Settings > Secrets** without the secret reaching the app. Declare each request in `app.publish.json`:

```json
{
  "entryPath": "main.tsx",
  "external": {
    "recentEvents": {
      "method": "POST",
      "url": "https://us.posthog.com/api/projects/{{project}}/query/",
      "body": { "query": { "kind": "HogQLQuery", "query": "select event, count() from events group by event" } },
      "params": { "project": { "type": "integer", "min": 1, "max": 99999999 } },
      "secret": { "name": "POSTHOG_KEY", "header": "Authorization", "prefix": "Bearer " }
    }
  }
}
```

Then call it by name:

```tsx
const { status, data } = await useApp().external<{ results: unknown[] }>("recentEvents", { project: 42 });
```

- `method` is `GET` or `POST`. Only `POST` sends a `body`.
- `url` is `https://host/path`. Put query fields in `query`, not in the URL.
- `{{name}}` fills a whole path segment, query value, or body value with a declared input. Inputs are `integer` (`min`, `max`), `enum` (`values`), `boolean`, or `string` (`maxLength`). Every input is required.
- `headers` are fixed text. `secret.header` names the header that carries the secret, after an optional `prefix`. The secret must be a header secret whose allowed websites include the URL's host.
- `maxResponseBytes` defaults to 192 KiB, which is also the most it can be. The answer must be uncompressed JSON in UTF-8, nested at most 64 levels deep. Each call times out after 10 seconds.
- `access` is `"owner"`, the default, or `"viewers"`. An `"owner"` call runs only for the owner. A `"viewers"` call runs for anyone who can open the app, including visitors on a share link, and spends the owner's secret.
- `status` is the service's HTTP status, so check it. A refused call throws an `AppBackendError` whose `refusal.code` is one such as `external_input`, `external_secret`, or `secret_echoed`.

The owner approves these calls in the dohc window, when approving the app or sharing it. The CLI, MCP, and `dohc app stage` refuse them. Any change to `external` needs a new approval.

Where the calls run:

- An app approved on this computer, in a workspace that isn't synced, runs them on this computer with the secret in Settings > Secrets.
- A shared app runs them on your dohc server, with the server's copy of the secret. This covers share links, the people the app is shared with, and the phone, which opens shared apps only. Sharing is refused until the secret is on the server as a header secret for the call's host. Sharing binds the secret as it is then: you can replace its value, but if you delete the secret and add it again, or change its usage or websites, stop sharing the app and share it again.
- In a synced workspace, an app approved on this computer runs them on your dohc server, for you alone, with the server's copy of the secret. They stop while sync is paused. An app that creates Collection files can't call outside services there.
- A shared app that creates Collection files can't declare `external`.

The server allows each workspace 120 calls in a row, then 1 each second, and each share link 30 in a row, then 1 every 2 seconds. A workspace runs at most 8 calls at once, and 2 of those are kept for the owner. A busy or rate-limit refusal names the limit, for visitors too. For any other refusal, visitors see only that the service isn't available, and the owner sees what to fix.

## Sandbox limits, clipboard, printing, and fullscreen

Published and local apps run inside an opaque-origin `srcdoc` iframe (`window.origin === "null"`) without `allow-same-origin` or `allow-modals`. That isolation keeps app code separate from session credentials and stops modal spam, and it affects app code in these ways:

- **Storage APIs.** `sessionStorage`, `localStorage`, `indexedDB`, and `document.cookie` throw `SecurityError` in an opaque origin. Keep transient UI state in React state or memory, and save durable data in an approved Collection.
- **Clipboard.** Calling `navigator.clipboard.writeText` inside the app frame fails and logs a Chromium Permissions Policy console error, which fails `verifyFrontend`. Use `copyText(text)` from `dohc/app` inside a click or key handler instead. The trusted host bootstrap writes up to 65,536 UTF-8 bytes after a recent user click or key press, at most once per 1 s.
- **Printing.** Calling `window.print()` inside the app frame is blocked because the sandbox omits `allow-modals`. Use `print()` from `dohc/app` inside a click or key handler so the trusted host bootstrap prints the app frame with its `@media print` styles, at most once per 5.5 s. When a report scrolls inside a fixed-height container (`height: 100vh; overflow: auto`), expand that container in `@media print` (`height: auto; overflow: visible`) and pass the expanded height with `print({ height })` (for example `document.documentElement.scrollHeight + (container.scrollHeight - container.clientHeight)`, up to 50,000 CSS px) so rows below the viewport are not clipped. On mobile WebViews where the OS print sheet is unavailable, or when people need a standalone file, export HTML through `allow-downloads`.
- **Fullscreen.** On a share link, the frame allows full screen after a click or key press. In dohc's own tab and in `verifyFrontend`, it doesn't: `document.fullscreenEnabled` is `false`, and `requestFullscreen()` rejects and logs a Permissions Policy console error, which fails `verifyFrontend`. Fill the frame with CSS (`height: 100vh`), and offer full screen only when `document.fullscreenEnabled` is `true`, from a click or key handler.
- **IntersectionObserver.** Without a `root`, an observer ignores `rootMargin`, because the frame's origin differs from the page around it. To load content before it scrolls into view, pass `root: document` or the scrolling element.
- **Failures in Notices.** After your own error toast, call `notice({ message, detail })` from `dohc/app` so the failure stays in dohc's Notices after the toast is gone. In dohc's own app tab, it adds one row for the app, which names the app and shows your text as plain text, and its Try again opens the app. A newer notice replaces the app's row. `message` is one line of up to 200 characters and `detail` one line of up to 500. It resolves `true` when dohc recorded the row, and `false` on a share link, in a browser, while another notice is on its way, or within 5 s of the last recorded notice.
- **Stale queries and rate limits.** `useDatasetQuery` and `useDatasetPages` cancel queued superseded requests when their operation, dataset, or input changes. When a request hits a rate limit (`error.status === 429`), `error.message` names the limit, unit, usage window, and retry timing, and `error.retryAfterMs` gives the retry delay in milliseconds when known. `await appBudget()` returns the host's budget: how many requests can be in flight, and the burst and refill of operation calls and of file reads, which have their own budget. The client sends waiting calls before waiting file reads and keeps one slot free for calls, so a save never waits behind a wall of photos.
