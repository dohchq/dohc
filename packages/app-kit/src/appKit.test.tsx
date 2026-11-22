// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
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
  let closed = false;
  const port = {
    postMessage(message: Record<string, unknown>) {
      if (closed) throw new Error("Port closed");
      sent.push(message);
    },
    start() {},
    close() {
      closed = true;
    },
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

  return { port, sent, reply, isClosed: () => closed };
}

describe("dohc/app", () => {
  it("sends exact broker wire keys and surfaces structured refusals", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });

    const readPromise = client.read<{ total: number }>("monthlyTotal", { month: "2026-11" });
    expect(fake.sent).toHaveLength(1);
    expect(Object.keys(fake.sent[0]!).sort()).toEqual([
      "id",
      "idempotencyKey",
      "input",
      "op",
      "operation",
    ]);
    expect(fake.sent[0]!.op).toBe("backend.invoke");
    fake.reply({
      id: fake.sent[0]!.id,
      ok: true,
      value: { result: { total: 420 }, revision: 3, replayed: false },
    });
    expect(await readPromise).toEqual({ total: 420 });

    const refused = client.invoke("addExpense", { amount: 15 }, "k-1");
    fake.reply({
      id: fake.sent[1]!.id,
      ok: false,
      status: 409,
      error: { code: "budget_locked", message: "Month is closed." },
    });
    await expect(refused).rejects.toMatchObject({
      name: "AppBackendError",
      status: 409,
      message: "Month is closed.",
      refusal: { code: "budget_locked", message: "Month is closed." },
      uncertain: false,
    });

    expect(mutationKey("save")).toMatch(/^save:/);
    expect(isAppBackendError(new AppBackendError(503))).toBe(true);
    expect(new AppBackendError(503).uncertain).toBe(true);
    client.close();
  });

  it("captures the host port before AppProvider mounts and survives StrictMode remounts", async () => {
    const fake = makeFakePort();
    const fakeParent = {} as Window;
    const originalParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: fakeParent });
    const event = new MessageEvent("message", {
      data: { kind: "dohc-app-channel", version: 1 },
      ports: [fake.port],
    });
    Object.defineProperty(event, "source", { value: fakeParent });
    window.dispatchEvent(event);
    if (originalParent) Object.defineProperty(window, "parent", originalParent);

    function Probe() {
      const q = useDatasetQuery<{ ok: boolean }>("ping");
      return <span>{q.loading ? "loading" : q.data?.ok ? "connected" : "failed"}</span>;
    }

    const first = render(
      <StrictMode>
        <AppProvider>
          <Probe />
        </AppProvider>
      </StrictMode>,
    );
    expect(fake.isClosed()).toBe(false);
    expect(fake.sent.length).toBeGreaterThanOrEqual(1);
    for (const msg of fake.sent) {
      fake.reply({
        id: msg.id,
        ok: true,
        value: { result: { ok: true }, revision: 1, replayed: false },
      });
    }
    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());

    first.unmount();
    expect(fake.isClosed()).toBe(false);

    const beforeCount = fake.sent.length;
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    expect(fake.sent.length).toBe(beforeCount + 1);
    fake.reply({
      id: fake.sent[beforeCount]!.id,
      ok: true,
      value: { result: { ok: true }, revision: 2, replayed: false },
    });
    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());
  });

  it("clears query data on scope change and guards late replies without refetch loops", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });

    function View({ op, month }: { op: string; month: string }) {
      const query = useDatasetQuery<{ label: string }>(op, { month });
      return (
        <div>
          <span>{query.loading ? "loading" : "idle"}</span>
          <span>data:{query.data?.label ?? "none"}</span>
          <span>rev:{query.revision ?? "none"}</span>
          <span>err:{query.error?.status ?? "none"}</span>
        </div>
      );
    }

    const { rerender } = render(
      <AppProvider client={client}>
        <View op="summary" month="Oct" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);
    fake.reply({
      id: fake.sent[0]!.id,
      ok: true,
      value: { result: { label: "October" }, revision: 7, replayed: false },
    });
    await waitFor(() => expect(screen.getByText("data:October")).toBeTruthy());

    // Same value inline object must not refetch.
    rerender(
      <AppProvider client={client}>
        <View op="summary" month="Oct" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);

    // Changing operation immediately clears old data/revision even when the new query fails with 404.
    rerender(
      <AppProvider client={client}>
        <View op="missingOp" month="Oct" />
      </AppProvider>,
    );
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();
    expect(fake.sent).toHaveLength(2);

    fake.reply({ id: fake.sent[1]!.id, ok: false, status: 404 });
    await waitFor(() => expect(screen.getByText("err:404")).toBeTruthy());
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();
    client.close();
  });

  it("snapshots original operation and immutable payload across uncertain mutation retries", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });
    const mutablePayload = { amount: 10 };

    function Form({ operation }: { operation: string }) {
      const save = useDatasetMutation<{ amount: number }, { saved: boolean }>(operation);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              void save.mutate(mutablePayload).catch(() => {});
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

    const { rerender } = render(
      <AppProvider client={client}>
        <Form operation="opA" />
      </AppProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fake.sent).toHaveLength(1);
    const firstKey = fake.sent[0]!.idempotencyKey;
    fake.reply({ id: fake.sent[0]!.id, ok: false, status: 503 });

    const retryButton = await screen.findByRole("button", { name: "Retry" });

    // Mutate the original object and switch component operation prop before retrying.
    mutablePayload.amount = 999;
    rerender(
      <AppProvider client={client}>
        <Form operation="opB" />
      </AppProvider>,
    );

    fireEvent.click(retryButton);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.operation).toBe("opA");
    expect(fake.sent[1]!.input).toEqual({ amount: 10 });
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
  it("renders dashboard controls, keeps modal focus while typing, and traps Tab inside modal", () => {
    const onSelectRow = vi.fn();
    const onTab = vi.fn();

    function ModalHarness() {
      const [open, setOpen] = useState(true);
      const [text, setText] = useState("");
      return (
        <div>
          <Button onClick={() => setOpen(true)}>Outside</Button>
          <Modal open={open} title="Edit item" onClose={() => setOpen(false)}>
            <Field label="Merchant" htmlFor="modal-merchant">
              <Input
                id="modal-merchant"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Button variant="primary">Save</Button>
          </Modal>
        </div>
      );
    }

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
            footer={<Sparkline values={[42]} ariaLabel="Single point" />}
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
        <ModalHarness />
      </AppShell>,
    );

    expect(screen.getByRole("img", { name: "Single point" })).toBeTruthy();

    // Typing in modal input with inline onClose must NOT steal focus.
    const modalInput = screen.getByLabelText("Merchant");
    modalInput.focus();
    fireEvent.change(modalInput, { target: { value: "Blue" } });
    expect(document.activeElement).toBe(modalInput);

    // Tabbing from last modal focusable wraps to first modal focusable (Close button), not Outside.
    const saveBtn = screen.getByRole("button", { name: "Save" });
    saveBtn.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Tab keyboard navigation
    fireEvent.keyDown(screen.getByRole("tab", { name: "Spending" }), { key: "ArrowRight" });
    expect(onTab).toHaveBeenCalledWith("workouts");

    // Table search shows filtered empty state when nothing matches.
    const search = screen.getByRole("searchbox", { name: "Filter rows" });
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText("No matching rows")).toBeTruthy();
    fireEvent.change(search, { target: { value: "groc" } });
    fireEvent.click(screen.getByText("Groceries"));
    expect(onSelectRow).toHaveBeenCalledWith({ id: "2", name: "Groceries", amount: 85 });

    expect(formatNumber(1234)).toContain("1");
    expect(formatPercent(0.25)).toContain("25");
    expect(formatCompact(1500)).toMatch(/1\.5/);
    expect(formatDate("2026-11-23")).toContain("2026");
  });

  it("handles NaN gaps, signed bars, grouped horizontal bars, and single-tab-stop chart navigation", () => {
    const { container } = render(
      <div>
        <LineChart
          variant="area"
          labels={["Mon", "Tue", "Wed", "Thu"]}
          series={[{ name: "Spend", values: [40, Number.NaN, 30, 50] }]}
          goal={{ value: 45, label: "Daily cap" }}
          ariaLabel="Daily spending"
        />
        <BarChart
          data={[
            { label: "Income", value: 320 },
            { label: "Refund", value: -80 },
          ]}
          ariaLabel="Signed totals"
        />
        <BarChart
          orientation="horizontal"
          labels={["Week 1", "Week 2"]}
          series={[
            { name: "Run", values: [20, 25] },
            { name: "Lift", values: [15, -5] },
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

    // Zero NaN attributes anywhere in generated SVG paths or rects.
    expect(container.innerHTML).not.toContain("NaN");

    // Interactive charts expose a single tab stop each and step with ArrowRight.
    const lineGroup = screen.getByRole("group", { name: "Daily spending" });
    expect(lineGroup.querySelectorAll("[tabindex]")).toHaveLength(0);
    fireEvent.focus(lineGroup);
    expect(lineGroup.textContent).toContain("Mon: Spend 40");
    fireEvent.keyDown(lineGroup, { key: "ArrowRight" });
    expect(lineGroup.textContent).toContain("Tue: Spend no data");

    const barGroup = screen.getByRole("group", { name: "Signed totals" });
    fireEvent.focus(barGroup);
    fireEvent.keyDown(barGroup, { key: "ArrowRight" });
    expect(barGroup.textContent).toContain("Refund: Value -80");

    const donutGroup = screen.getByRole("group", { name: "Monthly breakdown" });
    fireEvent.focus(donutGroup);
    expect(donutGroup.textContent).toContain("Housing: 1,800 (75%)");
  });
});
