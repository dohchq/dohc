// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppBackendError,
  AppProvider,
  createAppClient,
  isAppBackendError,
  mutationKey,
  useDatasetMutation,
  useDatasetQuery,
} from "./app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  Field,
  Grid,
  Input,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  Stack,
  StatCard,
  Tabs,
  formatCompact,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
} from "./ui";
import { BarChart, DonutChart, LineChart, Sparkline } from "./charts";

afterEach(cleanup);

function makeFakePort() {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: ((event: MessageEvent) => void) | null = null;
  const port = {
    postMessage(message: Record<string, unknown>) {
      sent.push(message);
    },
    start() {},
    close() {},
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      onMessage = handler;
    },
    get onmessage() {
      return onMessage;
    },
  } as unknown as MessagePort;

  const reply = (payload: Record<string, unknown>) => {
    onMessage?.({ data: payload } as MessageEvent);
  };

  return { port, sent, reply };
}

describe("dohc/app", () => {
  it("routes single-dataset and aliased calls over MessagePort and preserves uncertain retry keys", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });

    const singlePromise = client.read<{ total: number }>("monthlyTotal", { month: "2026-11" });
    expect(fake.sent).toHaveLength(1);
    expect(Object.keys(fake.sent[0]!).sort()).toEqual([
      "id",
      "idempotencyKey",
      "input",
      "op",
      "operation",
    ]);
    expect(fake.sent[0]!.op).toBe("backend.invoke");
    expect(fake.sent[0]!.operation).toBe("monthlyTotal");
    fake.reply({
      id: fake.sent[0]!.id,
      ok: true,
      value: { result: { total: 420 }, revision: 3, replayed: false },
    });
    expect(await singlePromise).toEqual({ total: 420 });

    const aliasedPromise = client.dataset("spending").invoke("addExpense", { amount: 15 }, "k-1");
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.dataset).toBe("spending");
    expect(fake.sent[1]!.idempotencyKey).toBe("k-1");
    fake.reply({
      id: fake.sent[1]!.id,
      ok: false,
      status: 409,
      error: { code: "budget_locked", message: "Month is closed." },
    });
    await expect(aliasedPromise).rejects.toMatchObject({
      name: "AppBackendError",
      status: 409,
      message: "Month is closed.",
      refusal: { code: "budget_locked", message: "Month is closed." },
      uncertain: false,
    });

    expect(() => client.dataset("Bad Alias")).toThrow(/Invalid dataset alias/);
    expect(mutationKey("save")).toMatch(/^save:/);
    expect(isAppBackendError(new AppBackendError(503))).toBe(true);
    expect(new AppBackendError(503).uncertain).toBe(true);
    client.close();
  });

  it("guards stale useDatasetQuery responses and avoids refetch loops on inline object inputs", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });

    function View({ month }: { month: string }) {
      const query = useDatasetQuery<{ label: string }>("summary", { month });
      if (query.loading) return <span>Loading {month}</span>;
      if (query.error) return <span>Error {query.error.status}</span>;
      return <span>Loaded {query.data?.label}</span>;
    }

    const { rerender } = render(
      <AppProvider client={client}>
        <View month="Oct" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);
    const firstId = fake.sent[0]!.id as string;

    // Re-rendering with the same value must not resend even though `{ month }` is a fresh object.
    rerender(
      <AppProvider client={client}>
        <View month="Oct" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);

    rerender(
      <AppProvider client={client}>
        <View month="Nov" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(2);
    const secondId = fake.sent[1]!.id as string;

    // Resolve newer request first, then stale request; stale answer must not overwrite.
    fake.reply({
      id: secondId,
      ok: true,
      value: { result: { label: "November" }, revision: 2, replayed: false },
    });
    await waitFor(() => expect(screen.getByText("Loaded November")).toBeTruthy());

    fake.reply({
      id: firstId,
      ok: true,
      value: { result: { label: "October" }, revision: 1, replayed: false },
    });
    await Promise.resolve();
    expect(screen.getByText("Loaded November")).toBeTruthy();
    client.close();
  });

  it("retains the exact idempotencyKey when retrying an uncertain useDatasetMutation", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });

    function Form() {
      const save = useDatasetMutation<{ amount: number }, { saved: boolean }>("addExpense");
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              void save.mutate({ amount: 25 }).catch(() => {});
            }}
          >
            Save
          </button>
          {save.uncertain ? (
            <button
              type="button"
              onClick={() => {
                void save.retry().catch(() => {});
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      );
    }

    render(
      <AppProvider client={client}>
        <Form />
      </AppProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fake.sent).toHaveLength(1);
    const firstKey = fake.sent[0]!.idempotencyKey;
    fake.reply({ id: fake.sent[0]!.id, ok: false, status: 503 });

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.idempotencyKey).toBe(firstKey);
    fake.reply({
      id: fake.sent[1]!.id,
      ok: true,
      value: { result: { saved: true }, revision: 4, replayed: true },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    client.close();
  });
});

describe("dohc/ui and dohc/charts", () => {
  it("renders dashboard controls with sorting, search, tabs, modal escape, and formatters", () => {
    const onSelectRow = vi.fn();
    const onTab = vi.fn();
    const onCloseModal = vi.fn();

    render(
      <AppShell>
        <PageHeader
          eyebrow="Personal"
          title="Control Tower"
          subtitle="Spending and workouts"
          actions={<Button variant="primary">Add</Button>}
        />
        <Grid cols={3}>
          <StatCard
            label="Spent"
            value={formatCurrency(1240)}
            delta="-8%"
            tone="success"
            footer={<Sparkline values={[320, 410, 380, 290]} ariaLabel="Weekly spending" />}
          />
          <Card title="Budget">
            <ProgressBar
              value={1240}
              max={1000}
              target={800}
              label="Dining"
              valueLabel="$1,240 / $1,000"
            />
            <Badge tone="danger">Over target</Badge>
          </Card>
          <Card title="Quick form">
            <Stack gap={8}>
              <Field label="Merchant" htmlFor="merchant">
                <Input id="merchant" defaultValue="Blue Bottle" />
              </Field>
              <Select aria-label="Category" defaultValue="coffee">
                <option value="coffee">Coffee</option>
              </Select>
              <Checkbox label="Recurring" defaultChecked />
            </Stack>
          </Card>
        </Grid>
        <Callout tone="warning" title="Budget warning">
          Dining exceeded target.
        </Callout>
        <Tabs
          value="spending"
          onChange={onTab}
          items={[
            { id: "spending", label: "Spending", content: <p>Spending panel</p> },
            { id: "workouts", label: "Workouts", content: <p>Workouts panel</p> },
          ]}
        />
        <DataTable
          searchable
          rows={[
            { id: "1", name: "Espresso", amount: 6 },
            { id: "2", name: "Groceries", amount: 85 },
          ]}
          rowKey={(row) => row.id}
          onRowClick={onSelectRow}
          columns={[
            { key: "name", header: "Item", sortValue: (row) => row.name },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              sortValue: (row) => row.amount,
              render: (row) => formatCurrency(row.amount),
            },
          ]}
        />
        <Modal open title="Edit item" onClose={onCloseModal}>
          <p>Modal content</p>
        </Modal>
      </AppShell>,
    );

    expect(screen.getByRole("heading", { name: "Control Tower" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Dining" })).toBeTruthy();

    // Tab keyboard navigation
    const spendingTab = screen.getByRole("tab", { name: "Spending" });
    fireEvent.keyDown(spendingTab, { key: "ArrowRight" });
    expect(onTab).toHaveBeenCalledWith("workouts");

    // Table search + sort + click
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter rows" }), {
      target: { value: "groc" },
    });
    expect(screen.queryByText("Espresso")).toBeNull();
    fireEvent.click(screen.getByText("Groceries"));
    expect(onSelectRow).toHaveBeenCalledWith({ id: "2", name: "Groceries", amount: 85 });

    // Modal Escape
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseModal).toHaveBeenCalledTimes(1);

    expect(formatNumber(1234)).toContain("1");
    expect(formatPercent(0.25)).toContain("25");
    expect(formatCompact(1500)).toMatch(/1\.5/);
    expect(formatDate("2026-11-23")).toContain("2026");
  });

  it("renders interactive LineChart, BarChart, and DonutChart SVGs", () => {
    render(
      <div>
        <LineChart
          variant="area"
          labels={["Mon", "Tue", "Wed"]}
          series={[{ name: "Spend", values: [40, 65, 30] }]}
          goal={{ value: 50, label: "Daily cap" }}
          ariaLabel="Daily spending"
        />
        <BarChart
          data={[
            { label: "Food", value: 320 },
            { label: "Transit", value: 110 },
          ]}
          ariaLabel="Category totals"
        />
        <BarChart
          orientation="horizontal"
          stacked
          labels={["Week 1", "Week 2"]}
          series={[
            { name: "Run", values: [20, 25] },
            { name: "Lift", values: [15, 20] },
          ]}
          ariaLabel="Workout mix"
        />
        <DonutChart
          data={[
            { label: "Housing", value: 1800 },
            { label: "Food", value: 600 },
          ]}
          centerLabel="Monthly"
          ariaLabel="Monthly breakdown"
        />
      </div>,
    );

    expect(screen.getByRole("img", { name: "Daily spending" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Category totals" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Workout mix" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Monthly breakdown" })).toBeTruthy();
    expect(screen.getByText("Daily cap")).toBeTruthy();
    expect(screen.getByText(/75%/)).toBeTruthy();
  });
});
