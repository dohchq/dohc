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

    // Two port-less createAppClient() calls share the host channel without clobbering or closing it.
    const implicitA = createAppClient();
    const implicitB = createAppClient();
    expect(implicitA).toBe(implicitB);
    const countBeforeImplicit = fake.sent.length;
    const reqA = implicitA.read<{ a: number }>("opA");
    const reqB = implicitB.read<{ b: number }>("opB");
    implicitB.close();
    expect(fake.isClosed()).toBe(false);
    fake.reply({
      id: fake.sent[countBeforeImplicit]!.id,
      ok: true,
      value: { result: { a: 1 }, revision: 3, replayed: false },
    });
    fake.reply({
      id: fake.sent[countBeforeImplicit + 1]!.id,
      ok: true,
      value: { result: { b: 2 }, revision: 3, replayed: false },
    });
    expect(await reqA).toEqual({ a: 1 });
    expect(await reqB).toEqual({ b: 2 });
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

    rerender(
      <AppProvider client={client}>
        <View op="summary" month="Oct" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);

    rerender(
      <AppProvider client={client}>
        <View op="summary" month="Nov" />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(2);
    const novId = fake.sent[1]!.id;

    rerender(
      <AppProvider client={client}>
        <View op="missingOp" month="Oct" />
      </AppProvider>,
    );
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();
    expect(fake.sent).toHaveLength(3);

    // Late reply for the superseded November scope must be ignored.
    fake.reply({
      id: novId,
      ok: true,
      value: { result: { label: "StaleNov" }, revision: 8, replayed: false },
    });
    fake.reply({ id: fake.sent[2]!.id, ok: false, status: 404 });
    await waitFor(() => expect(screen.getByText("err:404")).toBeTruthy());
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();
    client.close();
  });

  it("snapshots original operation and preserves overlapping uncertain mutation retry keys", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });
    const mutablePayload = { amount: 10 };

    function Form({ operation }: { operation: string }) {
      const save = useDatasetMutation<unknown, { saved: boolean }>(operation);
      return (
        <div>
          <span>pending:{String(save.pending)}</span>
          <span>uncertain:{String(save.uncertain)}</span>
          <button
            type="button"
            onClick={() => {
              void save.mutate(mutablePayload).catch(() => {});
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              void save.mutate({ amount: 20 }).catch(() => {});
            }}
          >
            SaveB
          </button>
          <button
            type="button"
            onClick={() => {
              void save.mutate(null).catch(() => {});
            }}
          >
            SaveNull
          </button>
          <button
            type="button"
            onClick={() => {
              void save.mutate(() => {}).catch(() => {});
            }}
          >
            SaveBad
          </button>
          {save.uncertain ? (
            <>
              <button
                type="button"
                onClick={() => {
                  void save.retry().catch(() => {});
                }}
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => {
                  void save.retry().catch(() => {});
                  save.discardPending();
                  void save.retry().catch(() => {});
                }}
              >
                RetryDiscardRetry
              </button>
            </>
          ) : null}
        </div>
      );
    }

    const { rerender } = render(
      <AppProvider client={client}>
        <Form operation="opA" />
      </AppProvider>,
    );

    // Unserializable input rejects cleanly and never sticks pending.
    fireEvent.click(screen.getByRole("button", { name: "SaveBad" }));
    await waitFor(() => expect(screen.getByText("pending:false")).toBeTruthy());
    expect(fake.sent).toHaveLength(0);

    // Null input is preserved instead of coerced to {}.
    fireEvent.click(screen.getByRole("button", { name: "SaveNull" }));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.input).toBeNull();
    fake.reply({
      id: fake.sent[0]!.id,
      ok: true,
      value: { result: { saved: true }, revision: 1, replayed: false },
    });
    await waitFor(() => expect(screen.getByText("pending:false")).toBeTruthy());

    // Overlapping writes A and B both fail with 503 out of order (B then A).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "SaveB" }));
    expect(fake.sent).toHaveLength(3);
    const keyA = fake.sent[1]!.idempotencyKey;
    const keyB = fake.sent[2]!.idempotencyKey;
    fake.reply({ id: fake.sent[2]!.id, ok: false, status: 503 });
    fake.reply({ id: fake.sent[1]!.id, ok: false, status: 503 });

    const retryButton = await screen.findByRole("button", { name: "Retry" });

    // Mutate payload A and switch operation prop before retrying.
    mutablePayload.amount = 999;
    rerender(
      <AppProvider client={client}>
        <Form operation="opB" />
      </AppProvider>,
    );

    // Double-clicking Retry for the same retained write coalesces to a single RPC.
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(fake.sent).toHaveLength(4);
    expect(fake.sent[3]!.operation).toBe("opA");
    expect(fake.sent[3]!.input).toEqual({ amount: 20 });
    expect(fake.sent[3]!.idempotencyKey).toBe(keyB);
    fake.reply({
      id: fake.sent[3]!.id,
      ok: true,
      value: { result: { saved: true }, revision: 4, replayed: true },
    });
    await waitFor(() => expect(screen.getByText("pending:false")).toBeTruthy());
    expect(screen.getByText("uncertain:true")).toBeTruthy();

    // Second retry replays A with its snapshotted immutable payload and original key.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fake.sent).toHaveLength(5);
    expect(fake.sent[4]!.operation).toBe("opA");
    expect(fake.sent[4]!.input).toEqual({ amount: 10 });
    expect(fake.sent[4]!.idempotencyKey).toBe(keyA);
    fake.reply({
      id: fake.sent[4]!.id,
      ok: true,
      value: { result: { saved: true }, revision: 5, replayed: true },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByText("uncertain:false")).toBeTruthy();

    // Synchronous retry() -> discardPending() -> retry() sends only one RPC and never re-retains.
    fireEvent.click(screen.getByRole("button", { name: "SaveB" }));
    expect(fake.sent).toHaveLength(6);
    fake.reply({ id: fake.sent[5]!.id, ok: false, status: 503 });
    const rdr = await screen.findByRole("button", { name: "RetryDiscardRetry" });
    fireEvent.click(rdr);
    expect(fake.sent).toHaveLength(7);
    fake.reply({ id: fake.sent[6]!.id, ok: false, status: 503 });
    await waitFor(() => expect(screen.getByText("pending:false")).toBeTruthy());
    expect(screen.getByText("uncertain:false")).toBeTruthy();
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
            <input type="hidden" value="secret" />
            <Field label="Merchant" htmlFor="modal-merchant">
              <Input
                id="modal-merchant"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Button variant="primary">Save</Button>
            <fieldset disabled>
              <button type="button">DisabledFieldsetButton</button>
            </fieldset>
            <div style={{ display: "none" }}>
              <button type="button">HiddenAction</button>
            </div>
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

    // Tabbing from last visible modal focusable wraps to Close; Shift+Tab from Close skips hidden elements and lands on Save.
    const closeBtn = screen.getByRole("button", { name: "Close" });
    const saveBtn = screen.getByRole("button", { name: "Save" });
    saveBtn.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeBtn);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(saveBtn);

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
    expect(barGroup.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Refund: Value -80",
    );
    // Hovering a focused bar chart clears live-region announcements.
    fireEvent.mouseEnter(barGroup.querySelector("svg g rect")!.parentElement!);
    expect(barGroup.querySelector('[aria-live="polite"]')?.textContent).toBe("");

    const donutGroup = screen.getByRole("group", { name: "Monthly breakdown" });
    fireEvent.focus(donutGroup);
    expect(donutGroup.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Housing: 1,800 (75%)",
    );
    fireEvent.mouseEnter(donutGroup.querySelector(".kit-donut-row")!);
    expect(donutGroup.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  });

  it("survives shrinking chart data while focused, preserves sparkline gaps, and attaches ResizeObserver after empty mount", () => {
    const observed: Element[] = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;
    class FakeResizeObserver {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observed.push(el);
        this.cb(
          [{ contentRect: { width: 720 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    try {
      function DynamicCharts({ shrunk, loaded }: { shrunk: boolean; loaded: boolean }) {
        return (
          <div>
            <BarChart
              data={
                shrunk
                  ? [{ label: "A", value: 10 }]
                  : [
                      { label: "A", value: 10 },
                      { label: "B", value: 20 },
                      { label: "C", value: 30 },
                    ]
              }
              formatValue={(v) => v.toFixed(2)}
              ariaLabel="Dynamic bars"
            />
            <LineChart
              labels={loaded ? ["W1", "W2"] : []}
              series={loaded ? [{ name: "Trend", values: [1, 2] }] : []}
              ariaLabel="Late line"
            />
            <Sparkline values={[10, 20, Number.NaN, 30, 40]} ariaLabel="Gapped spark" />
          </div>
        );
      }

      const { rerender, container } = render(<DynamicCharts shrunk={false} loaded={false} />);
      const barGroup = screen.getByRole("group", { name: "Dynamic bars" });
      fireEvent.focus(barGroup);
      fireEvent.keyDown(barGroup, { key: "End" });
      expect(barGroup.textContent).toContain("C: Value 30.00");

      const observedBefore = observed.length;
      rerender(<DynamicCharts shrunk={true} loaded={true} />);
      expect(observed.length).toBeGreaterThan(observedBefore);
      expect(
        screen
          .getByRole("group", { name: "Late line" })
          .querySelector("svg")
          ?.getAttribute("width"),
      ).toBe("720");

      // Gapped sparkline renders two separate stroke paths (plus optional area fills) with zero NaN.
      const spark = screen.getByRole("img", { name: "Gapped spark" });
      expect(spark.querySelectorAll('path[fill="none"]')).toHaveLength(2);
      expect(container.innerHTML).not.toContain("NaN");

      // Sub-1e-6 data preserves distinct tick labels instead of collapsing to repeated zeros.
      const { container: tinyContainer } = render(
        <div>
          <LineChart
            labels={["A", "B"]}
            series={[{ name: "Tiny", values: [0, 4e-7] }]}
            formatValue={(v) => v.toExponential(1)}
            ariaLabel="Tiny scale"
          />
          <DataTable
            rows={[{ id: "1", name: "Item" }]}
            rowKey={(r) => r.id}
            onRowClick={() => {
              throw new Error("Descendant key event should not trigger onRowClick");
            }}
            columns={[
              {
                key: "name",
                header: "Item",
                render: () => <input aria-label="Cell input" defaultValue="" />,
              },
            ]}
          />
        </div>,
      );
      expect(tinyContainer.textContent).toContain("1.0e-7");
      expect(tinyContainer.textContent).toContain("4.0e-7");
      const cellInput = screen.getByLabelText("Cell input");
      fireEvent.keyDown(cellInput, { key: " " });
      fireEvent.keyDown(cellInput, { key: "Enter" });
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });
});
