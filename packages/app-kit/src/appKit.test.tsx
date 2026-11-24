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
  type AppClient,
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
      "readOnly",
    ]);
    expect(fake.sent[0]!.op).toBe("backend.invoke");
    expect(fake.sent[0]!.readOnly).toBe(true);
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

    const poisonedInput = {
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytesBase64: "JVBERi0=",
      idempotencyKey: "spoofed-key",
      op: "backend.invoke",
      id: "spoofed-id",
    };
    const uploadPromise = client.upload(poisonedInput, "explicit-upload-key");
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const uploadMsg = fake.sent[2]!;
    expect(Object.keys(uploadMsg).sort()).toEqual([
      "bytesBase64",
      "contentType",
      "id",
      "idempotencyKey",
      "name",
      "op",
    ]);
    expect(uploadMsg.op).toBe("backend.upload");
    expect(uploadMsg.idempotencyKey).toBe("explicit-upload-key");
    expect(uploadMsg.id).not.toBe("spoofed-id");
    fake.reply({
      id: uploadMsg.id,
      ok: true,
      value: {
        file: {
          fileId: "f-1",
          name: "receipt.pdf",
          contentType: "application/pdf",
          byteLength: 5,
          sha256: "abc",
        },
        replayed: false,
      },
    });
    expect((await uploadPromise).file.fileId).toBe("f-1");
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

    const persistedHide = new Event("pagehide");
    Object.defineProperty(persistedHide, "persisted", { value: true });
    window.dispatchEvent(persistedHide);
    expect(fake.isClosed()).toBe(false);
    const countAfterBfcache = fake.sent.length;
    const reqC = createAppClient().read<{ c: number }>("opC");
    fake.reply({
      id: fake.sent[countAfterBfcache]!.id,
      ok: true,
      value: { result: { c: 3 }, revision: 4, replayed: false },
    });
    expect(await reqC).toEqual({ c: 3 });

    const finalHide = new Event("pagehide");
    Object.defineProperty(finalHide, "persisted", { value: false });
    window.dispatchEvent(finalHide);
    expect(fake.isClosed()).toBe(true);
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

    fake.reply({ id: fake.sent[2]!.id, ok: false, status: 404 });
    await waitFor(() => expect(screen.getByText("err:404")).toBeTruthy());
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();

    fake.reply({
      id: novId,
      ok: true,
      value: { result: { label: "StaleNov" }, revision: 8, replayed: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("err:404")).toBeTruthy();
    expect(screen.getByText("data:none")).toBeTruthy();
    expect(screen.getByText("rev:none")).toBeTruthy();
    client.close();
  });

  it("handles unserializable query inputs without throwing during render", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    function QueryProbe({ input, enabled }: { input: unknown; enabled: boolean }) {
      const query = useDatasetQuery("probe", input, { enabled });
      return (
        <div>
          <span>loading:{String(query.loading)}</span>
          <span>err:{query.error?.status ?? "none"}</span>
        </div>
      );
    }

    const { rerender } = render(
      <AppProvider client={client}>
        <QueryProbe input={circular} enabled={false} />
      </AppProvider>,
    );
    expect(screen.getByText("loading:false")).toBeTruthy();
    expect(screen.getByText("err:none")).toBeTruthy();
    expect(fake.sent).toHaveLength(0);

    rerender(
      <AppProvider client={client}>
        <QueryProbe input={circular} enabled />
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByText("err:400")).toBeTruthy());
    expect(screen.getByText("loading:false")).toBeTruthy();
    expect(fake.sent).toHaveLength(0);

    rerender(
      <AppProvider client={client}>
        <QueryProbe input={() => {}} enabled />
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByText("err:400")).toBeTruthy());
    expect(fake.sent).toHaveLength(0);
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
          <span>err:{save.error?.status ?? "none"}</span>
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
              <button
                type="button"
                onClick={() => {
                  const capturedRetry = save.retry;
                  void (async () => {
                    try {
                      await capturedRetry();
                    } catch {}
                    await capturedRetry();
                  })();
                }}
              >
                RetryTwiceSequentially
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
    expect(screen.getByText("err:none")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "SaveB" }));
    expect(fake.sent).toHaveLength(8);
    fake.reply({ id: fake.sent[7]!.id, ok: false, status: 503 });
    const retryTwice = await screen.findByRole("button", { name: "RetryTwiceSequentially" });
    fireEvent.click(retryTwice);
    expect(fake.sent).toHaveLength(9);
    fake.reply({
      id: fake.sent[8]!.id,
      ok: true,
      value: { result: { saved: true }, revision: 6, replayed: true },
    });
    await waitFor(() => expect(screen.getByText("uncertain:false")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent).toHaveLength(9);

    fireEvent.click(screen.getByRole("button", { name: "SaveB" }));
    expect(fake.sent).toHaveLength(10);
    fake.reply({ id: fake.sent[9]!.id, ok: false, status: 503 });
    const retryTwiceRefused = await screen.findByRole("button", {
      name: "RetryTwiceSequentially",
    });
    fireEvent.click(retryTwiceRefused);
    expect(fake.sent).toHaveLength(11);
    fake.reply({
      id: fake.sent[10]!.id,
      ok: false,
      status: 409,
      error: { code: "closed", message: "Closed" },
    });
    await waitFor(() => expect(screen.getByText("err:409")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent).toHaveLength(11);
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
    expect(formatCompact(1500)).toBe(
      new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(1500),
    );
    expect(formatDate("2026-11-23")).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(2026, 10, 23)),
    );
    expect(formatDate("2026-02-31")).toBe("2026-02-31");

    const progress = screen.getByRole("progressbar", { name: "Dining" });
    expect(progress.getAttribute("aria-valuenow")).toBe("1000");
    expect(progress.getAttribute("aria-valuetext")).toBe("$1,240 / $1,000");
    const targetMarker = progress.querySelector<HTMLElement>(".kit-progress-target");
    expect(targetMarker?.style.getPropertyValue("--kit-target-pct")).toBe("80%");

    const workoutsTab = screen.getByRole("tab", { name: "Workouts" });
    const workoutsPanelId = workoutsTab.getAttribute("aria-controls");
    expect(workoutsPanelId).toBeTruthy();
    const workoutsPanel = document.getElementById(workoutsPanelId!);
    expect(workoutsPanel?.getAttribute("role")).toBe("tabpanel");
    expect(workoutsPanel?.hidden).toBe(true);
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
          formatValue={(value) => String(value)}
          ariaLabel="Monthly breakdown"
        />
      </div>,
    );

    // Zero NaN attributes anywhere in generated SVG paths or rects.
    expect(container.innerHTML).not.toContain("NaN");

    // Interactive charts expose a single tab stop each and step with ArrowRight.
    const lineGroup = screen.getByRole("group", { name: "Daily spending" });
    expect(lineGroup.tabIndex).toBe(0);
    expect(lineGroup.querySelectorAll("[tabindex]")).toHaveLength(0);
    fireEvent.focus(lineGroup);
    expect(lineGroup.textContent).toContain("Mon: Spend 40");
    fireEvent.keyDown(lineGroup, { key: "ArrowRight" });
    expect(lineGroup.textContent).toContain("Tue: Spend no data");

    const barGroup = screen.getByRole("group", { name: "Signed totals" });
    expect(barGroup.tabIndex).toBe(0);
    expect(barGroup.querySelectorAll("[tabindex]")).toHaveLength(0);
    fireEvent.focus(barGroup);
    fireEvent.keyDown(barGroup, { key: "ArrowRight" });
    expect(barGroup.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Refund: Value -80",
    );
    // Hovering a focused bar chart clears live-region announcements.
    fireEvent.mouseEnter(barGroup.querySelector("svg g rect")!.parentElement!);
    expect(barGroup.querySelector('[aria-live="polite"]')?.textContent).toBe("");

    const donutGroup = screen.getByRole("group", { name: "Monthly breakdown" });
    expect(donutGroup.tabIndex).toBe(0);
    expect(donutGroup.querySelectorAll("[tabindex]")).toHaveLength(0);
    fireEvent.focus(donutGroup);
    expect(donutGroup.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Housing: 1800 (75%)",
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
      fireEvent.click(cellInput);
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  it("handles extreme scales, missing bar values, dense grouped bars, sparkline slot alignment, field descriptions, nested modals, and interactive table cells", () => {
    const denseLabels = Array.from({ length: 40 }, (_, i) => `D${i + 1}`);
    const denseSeries = [
      { name: "A", values: denseLabels.map(() => 10) },
      { name: "B", values: denseLabels.map(() => 20) },
      { name: "C", values: denseLabels.map(() => 15) },
    ];
    const rowClicks: string[] = [];

    function NestedModals() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <div>
          <Button onClick={() => setOuterOpen(true)}>LaunchOuter</Button>
          <Modal open={outerOpen} title="Outer" onClose={() => setOuterOpen(false)}>
            <Button onClick={() => setInnerOpen(true)}>OpenInner</Button>
            <Modal open={innerOpen} title="Inner" onClose={() => setInnerOpen(false)}>
              <Button>InnerAction</Button>
            </Modal>
          </Modal>
        </div>
      );
    }

    const { container } = render(
      <div>
        <LineChart
          labels={["Low", "High"]}
          series={[{ name: "Max", values: [-Number.MAX_VALUE, Number.MAX_VALUE] }]}
          formatValue={(v) => String(v)}
          ariaLabel="Extreme scale"
        />
        <BarChart
          labels={["Present", "Missing"]}
          series={[{ name: "Metric", values: [10, Number.NaN] }]}
          formatValue={(v) => String(v)}
          ariaLabel="Vertical missing"
        />
        <BarChart
          orientation="horizontal"
          labels={["Present", "Missing"]}
          series={[{ name: "Metric", values: [10, Number.NaN] }]}
          formatValue={(v) => String(v)}
          ariaLabel="Horizontal missing"
        />
        <BarChart labels={denseLabels} series={denseSeries} ariaLabel="Dense grouped" />
        <Sparkline
          values={[Number.NaN, Number.NaN, 42]}
          width={120}
          height={32}
          ariaLabel="Late lone spark"
        />
        <Field label="Budget" htmlFor="budget-in" hint="Monthly cap">
          <Input id="budget-in" aria-describedby="extra-desc" />
        </Field>
        <Field label="Plain" htmlFor="plain-in">
          <Input id="plain-in" />
        </Field>
        <DataTable
          rows={[{ id: "r1", name: "Coffee" }]}
          rowKey={(r) => r.id}
          onRowClick={(r) => rowClicks.push(r.id)}
          columns={[
            { key: "name", header: "Name" },
            {
              key: "actions",
              header: "Actions",
              render: () => <Button size="sm">DeleteRow</Button>,
            },
          ]}
        />
        <NestedModals />
      </div>,
    );

    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");

    const verticalMissing = screen.getByRole("group", { name: "Vertical missing" });
    expect(verticalMissing.querySelectorAll("svg rect")).toHaveLength(1);
    fireEvent.focus(verticalMissing);
    fireEvent.keyDown(verticalMissing, { key: "ArrowRight" });
    expect(verticalMissing.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Missing: Metric no data",
    );
    expect(verticalMissing.querySelector(".kit-chart-tooltip")?.textContent).toContain("—");

    const horizontalMissing = screen.getByRole("group", { name: "Horizontal missing" });
    expect(horizontalMissing.querySelectorAll("svg rect")).toHaveLength(1);
    expect(horizontalMissing.querySelector("svg")?.textContent).toContain("—");

    const denseGroup = screen.getByRole("group", { name: "Dense grouped" });
    const denseRects = [...denseGroup.querySelectorAll("svg rect")];
    expect(denseRects).toHaveLength(120);
    const padLeft = 54;
    const plotW = 560 - 54 - 16;
    const groupW = plotW / denseLabels.length;
    for (let groupIdx = 0; groupIdx < denseLabels.length; groupIdx += 1) {
      const groupLeft = padLeft + groupIdx * groupW;
      const groupRight = groupLeft + groupW;
      let prevRight = groupLeft;
      for (let seriesIdx = 0; seriesIdx < denseSeries.length; seriesIdx += 1) {
        const rect = denseRects[groupIdx * denseSeries.length + seriesIdx]!;
        const x = Number(rect.getAttribute("x"));
        const w = Number(rect.getAttribute("width"));
        expect(x).toBeGreaterThanOrEqual(prevRight - 1e-6);
        expect(x + w).toBeLessThanOrEqual(groupRight + 1e-6);
        prevRight = x + w;
      }
    }

    const lateSpark = screen.getByRole("img", { name: "Late lone spark" });
    expect(Number(lateSpark.querySelector("circle")?.getAttribute("cx"))).toBe(118);

    const budgetInput = screen.getByLabelText("Budget");
    const hintNode = screen.getByText("Monthly cap");
    expect(budgetInput.getAttribute("aria-describedby")).toBe(`extra-desc ${hintNode.id}`);
    expect(screen.getByLabelText("Plain").getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "DeleteRow" }));
    expect(rowClicks).toEqual([]);
    fireEvent.click(screen.getByText("Coffee"));
    expect(rowClicks).toEqual(["r1"]);

    const openInnerBtn = screen.getByRole("button", { name: "OpenInner" });
    openInnerBtn.focus();
    fireEvent.click(openInnerBtn);
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(2);
    const innerAction = screen.getByRole("button", { name: "InnerAction" });
    innerAction.focus();
    expect(document.activeElement).toBe(innerAction);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(openInnerBtn);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("serializes multi-Collection client.dataset(alias), useDatasetQuery, and useDatasetMutation messages", async () => {
    const channel = new MessageChannel();
    const seen: Array<Record<string, unknown>> = [];
    channel.port1.onmessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      seen.push(msg);
      if (msg.op === "backend.invoke") {
        channel.port1.postMessage({
          id: msg.id,
          ok: true,
          value: {
            result: { dataset: msg.dataset ?? null, op: msg.operation },
            revision: 3,
            replayed: false,
          },
        });
      } else if (msg.op === "backend.upload") {
        channel.port1.postMessage({
          id: msg.id,
          ok: true,
          value: {
            file: {
              fileId: "file_1",
              name: String(msg.name),
              contentType: String(msg.contentType),
              byteLength: 4,
              sha256: "a".repeat(64),
            },
            replayed: false,
          },
        });
      }
    };
    channel.port1.start();

    const client = createAppClient({ port: channel.port2 });
    try {
      const expensesA = client.dataset("expenses");
      const expensesB = client.dataset("expenses");
      expect(expensesA).toBe(expensesB);
      expect(() => client.dataset("BadAlias")).toThrow(/alias/i);
      expect(() => client.dataset("prototype")).toThrow(/alias/i);

      expensesA.close();
      expect(await expensesA.read("list")).toEqual({ dataset: "expenses", op: "list" });

      const sneakyUpload = {
        name: "receipt.txt",
        contentType: "text/plain",
        bytesBase64: "ZGF0YQ==",
        dataset: "workouts",
      };
      await expensesA.upload(sneakyUpload, "up-scoped");
      await client.upload(sneakyUpload, "up-root");
      const uploads = seen.filter((msg) => msg.op === "backend.upload");
      expect(uploads[0]?.dataset).toBe("expenses");
      expect(Object.hasOwn(uploads[1]!, "dataset")).toBe(false);

      function MultiHarness() {
        const q1 = useDatasetQuery<{ dataset: string | null; op: string }>(
          "list",
          {},
          { dataset: "expenses" },
        );
        const q2 = useDatasetQuery<{ dataset: string | null; op: string }>(
          "list",
          {},
          { dataset: "workouts" },
        );
        const addWorkout = useDatasetMutation<{ minutes: number }, { dataset: string | null }>(
          "create",
          { dataset: "workouts" },
        );
        const badQuery = useDatasetQuery("list", {}, { dataset: "Bad Alias" });
        const badMutate = useDatasetMutation("create", { dataset: "Bad Alias" });
        return (
          <div>
            <p data-testid="q1">{q1.data ? `${q1.data.dataset}:${q1.data.op}` : "loading"}</p>
            <p data-testid="q2">{q2.data ? `${q2.data.dataset}:${q2.data.op}` : "loading"}</p>
            <p data-testid="bad-q">{badQuery.error ? String(badQuery.error.status) : "ok"}</p>
            <p data-testid="bad-m">{badMutate.error ? String(badMutate.error.status) : "ok"}</p>
            <button type="button" onClick={() => void addWorkout.mutate({ minutes: 30 })}>
              Add workout
            </button>
            <button
              type="button"
              onClick={() => {
                void badMutate.mutate({}).catch(() => {});
              }}
            >
              Bad mutate
            </button>
          </div>
        );
      }

      render(
        <AppProvider client={client}>
          <MultiHarness />
        </AppProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("q1").textContent).toBe("expenses:list");
        expect(screen.getByTestId("q2").textContent).toBe("workouts:list");
        expect(screen.getByTestId("bad-q").textContent).toBe("400");
      });

      fireEvent.click(screen.getByRole("button", { name: "Add workout" }));
      fireEvent.click(screen.getByRole("button", { name: "Bad mutate" }));
      await waitFor(() => {
        expect(seen.some((msg) => msg.operation === "create" && msg.dataset === "workouts")).toBe(
          true,
        );
        expect(screen.getByTestId("bad-m").textContent).toBe("400");
      });
    } finally {
      client.close();
      channel.port1.close();
    }
  });

  it("memoizes custom AppClient.dataset(alias) targets in useDatasetQuery and isolates useDatasetMutation state across alias switches", async () => {
    let queryInvocations = 0;
    let rejectExpense!: (error: unknown) => void;
    const retryCalls: Array<{ alias: string; key?: string }> = [];
    let expenseAttempt = 0;

    const makeClient = (alias?: string): AppClient => ({
      async invoke<T>(operation: string, _input?: unknown, idempotencyKey?: string) {
        if (operation === "list") {
          queryInvocations += 1;
          return { result: { alias } as T, revision: 1, replayed: false };
        }
        if (alias === "expenses") {
          expenseAttempt += 1;
          retryCalls.push({ alias, key: idempotencyKey });
          if (expenseAttempt === 1) {
            return await new Promise<never>((_resolve, reject) => {
              rejectExpense = reject;
            });
          }
          return { result: { saved: "expenses" } as T, revision: 2, replayed: true };
        }
        retryCalls.push({ alias: alias ?? "", key: idempotencyKey });
        return { result: { saved: alias } as T, revision: 2, replayed: false };
      },
      async read<T>() {
        return {} as T;
      },
      async upload() {
        throw new Error("unused");
      },
      async file() {
        throw new Error("unused");
      },
      async attempt() {
        return { attempt: null };
      },
      dataset(nextAlias: string) {
        return makeClient(nextAlias);
      },
      close() {},
    });

    const customClient = makeClient();
    function SwitchHarness() {
      const [alias, setAlias] = useState("expenses");
      const query = useDatasetQuery<{ alias?: string }>("list", {}, { dataset: alias });
      const mutation = useDatasetMutation<{ v: number }, { saved: string }>("save", {
        dataset: alias,
      });
      return (
        <div>
          <p data-testid="alias">{alias}</p>
          <p data-testid="q-alias">{query.data?.alias ?? "loading"}</p>
          <p data-testid="m-err">{mutation.error ? String(mutation.error.status) : "none"}</p>
          <p data-testid="m-uncertain">{mutation.uncertain ? "yes" : "no"}</p>
          <p data-testid="m-pending">{mutation.pending ? "yes" : "no"}</p>
          <button
            type="button"
            onClick={() => {
              void mutation.mutate({ v: 1 }, "exp-key-1").catch(() => {});
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              void mutation.retry().catch(() => {});
            }}
          >
            Retry
          </button>
          <button type="button" onClick={() => setAlias("workouts")}>
            Switch workouts
          </button>
          <button type="button" onClick={() => setAlias("expenses")}>
            Switch expenses
          </button>
        </div>
      );
    }

    render(
      <AppProvider client={customClient}>
        <SwitchHarness />
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("q-alias").textContent).toBe("expenses"));
    expect(queryInvocations).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("m-pending").textContent).toBe("yes"));

    fireEvent.click(screen.getByRole("button", { name: "Switch workouts" }));
    await waitFor(() => expect(screen.getByTestId("q-alias").textContent).toBe("workouts"));
    expect(queryInvocations).toBe(2);

    rejectExpense(new AppBackendError(503));
    await waitFor(() => {
      expect(screen.getByTestId("m-err").textContent).toBe("none");
      expect(screen.getByTestId("m-uncertain").textContent).toBe("no");
      expect(screen.getByTestId("m-pending").textContent).toBe("no");
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch expenses" }));
    await waitFor(() => {
      expect(screen.getByTestId("m-err").textContent).toBe("503");
      expect(screen.getByTestId("m-uncertain").textContent).toBe("yes");
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByTestId("m-uncertain").textContent).toBe("no");
      expect(screen.getByTestId("m-err").textContent).toBe("none");
    });
    expect(retryCalls).toEqual([
      { alias: "expenses", key: "exp-key-1" },
      { alias: "expenses", key: "exp-key-1" },
    ]);
  });

  it("auto-refreshes live useDatasetQuery without flashing loading, skips stale revisions, coalesces bursts, and respects live: false", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });
    const loadingHistory: boolean[] = [];

    function Dashboard() {
      const expenses = useDatasetQuery<{ count: number }>(
        "listExpenses",
        {},
        { dataset: "expenses" },
      );
      const workouts = useDatasetQuery<{ count: number }>(
        "listWorkouts",
        {},
        { dataset: "workouts" },
      );
      const snapshot = useDatasetQuery<{ count: number }>(
        "listExpenses",
        { snap: true },
        { dataset: "expenses", live: false },
      );
      loadingHistory.push(expenses.loading);
      return (
        <div>
          <span data-testid="exp">
            {expenses.data ? `${expenses.data.count}@${expenses.revision}` : "none"}
          </span>
          <span data-testid="wrk">
            {workouts.data ? `${workouts.data.count}@${workouts.revision}` : "none"}
          </span>
          <span data-testid="snap">
            {snapshot.data ? `${snapshot.data.count}@${snapshot.revision}` : "none"}
          </span>
        </div>
      );
    }

    render(
      <AppProvider client={client}>
        <Dashboard />
      </AppProvider>,
    );

    expect(fake.sent).toHaveLength(3);
    expect(fake.sent.every((msg) => msg.readOnly === true)).toBe(true);
    for (const msg of fake.sent) {
      fake.reply({
        id: msg.id,
        ok: true,
        value: { result: { count: 1 }, revision: 2, replayed: false },
      });
    }
    await waitFor(() => {
      expect(screen.getByTestId("exp").textContent).toBe("1@2");
      expect(screen.getByTestId("wrk").textContent).toBe("1@2");
      expect(screen.getByTestId("snap").textContent).toBe("1@2");
    });

    loadingHistory.length = 0;

    // Stale revision <= 2 is skipped with zero fetches.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.sent).toHaveLength(3);

    // Rapid burst of revisions coalesces into a single background refresh for expenses only.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 3 });
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 4 });
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 5 });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    expect(fake.sent[3]!.dataset).toBe("expenses");
    expect(fake.sent[3]!.operation).toBe("listExpenses");
    expect(fake.sent[3]!.readOnly).toBe(true);
    expect(loadingHistory.every((value) => value === false)).toBe(true);

    // Another revision arriving while rev 5 refresh is in flight coalesces to one trailing refresh.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 6 });
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 7 });
    fake.reply({
      id: fake.sent[3]!.id,
      ok: true,
      value: { result: { count: 5 }, revision: 5, replayed: false },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(5));
    fake.reply({
      id: fake.sent[4]!.id,
      ok: true,
      value: { result: { count: 7 }, revision: 7, replayed: false },
    });
    await waitFor(() => expect(screen.getByTestId("exp").textContent).toBe("7@7"));

    // No spinner flash occurred on any background live refresh, workouts and live: false stayed untouched.
    expect(loadingHistory.every((value) => value === false)).toBe(true);
    expect(screen.getByTestId("wrk").textContent).toBe("1@2");
    expect(screen.getByTestId("snap").textContent).toBe("1@2");
    client.close();
  });

  it("handles an 8-widget live dashboard with 20 rapid edits cleanly without loading flashes", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port, maxInFlight: 8 });
    let backgroundLoadingFlashes = 0;
    let initialLoaded = false;

    function Widget({ index, dataset }: { index: number; dataset: string }) {
      const query = useDatasetQuery<{ rev: number }>(`widget${index}`, {}, { dataset });
      if (initialLoaded && query.loading) backgroundLoadingFlashes += 1;
      return <span data-testid={`w-${index}`}>{query.data?.rev ?? -1}</span>;
    }

    function EightWidgetDashboard() {
      return (
        <div>
          {Array.from({ length: 8 }, (_, index) => (
            <Widget key={index} index={index} dataset={index < 4 ? "expenses" : "workouts"} />
          ))}
        </div>
      );
    }

    render(
      <AppProvider client={client}>
        <EightWidgetDashboard />
      </AppProvider>,
    );

    // All 8 widgets dispatch concurrently when maxInFlight is 8.
    expect(fake.sent).toHaveLength(8);
    for (const msg of fake.sent) {
      fake.reply({
        id: msg.id,
        ok: true,
        value: { result: { rev: 1 }, revision: 1, replayed: false },
      });
    }
    await waitFor(() => expect(screen.getByTestId("w-7").textContent).toBe("1"));
    initialLoaded = true;

    let currentExpRev = 1;
    let currentWrkRev = 1;
    let nextReplyIndex = 8;
    const drain = () => {
      while (nextReplyIndex < fake.sent.length) {
        const msg = fake.sent[nextReplyIndex++]!;
        const rev = msg.dataset === "expenses" ? currentExpRev : currentWrkRev;
        fake.reply({
          id: msg.id,
          ok: true,
          value: { result: { rev }, revision: rev, replayed: false },
        });
      }
    };

    for (let edit = 2; edit <= 21; edit++) {
      if (edit % 2 === 0) {
        currentExpRev = edit;
        fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: edit });
      } else {
        currentWrkRev = edit;
        fake.reply({ kind: "dataset.changed", dataset: "workouts", revision: edit });
      }
      if (edit % 5 === 0) {
        await Promise.resolve();
        await Promise.resolve();
        drain();
      }
    }
    await waitFor(() => {
      drain();
      expect(screen.getByTestId("w-0").textContent).toBe(String(currentExpRev));
      expect(screen.getByTestId("w-7").textContent).toBe(String(currentWrkRev));
    });

    // Coalescing kept total refreshes well below uncoalesced 20 * 4 = 80, with zero loading flashes.
    expect(fake.sent.length).toBeLessThan(8 + 80);
    expect(backgroundLoadingFlashes).toBe(0);
    client.close();
  });

  it("catches up missed revisions when live mode resumes and retries rate-limited background refreshes", async () => {
    const fake = makeFakePort();
    const client = createAppClient({ port: fake.port });
    const loadingStates: boolean[] = [];

    function LiveToggle({ live }: { live: boolean }) {
      const query = useDatasetQuery<{ rev: number }>("list", {}, { dataset: "expenses", live });
      loadingStates.push(query.loading);
      return (
        <div>
          <span data-testid="val">
            {query.data ? `${query.data.rev}@${query.revision}` : "none"}
          </span>
          <span data-testid="err">{query.error?.status ?? "none"}</span>
        </div>
      );
    }

    const { rerender, unmount } = render(
      <AppProvider client={client}>
        <LiveToggle live={false} />
      </AppProvider>,
    );
    expect(fake.sent).toHaveLength(1);
    fake.reply({
      id: fake.sent[0]!.id,
      ok: true,
      value: { result: { rev: 1 }, revision: 1, replayed: false },
    });
    await waitFor(() => expect(screen.getByTestId("val").textContent).toBe("1@1"));
    loadingStates.length = 0;

    // Revision 2 arrives while live is false: no fetch while paused.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 2 });
    expect(fake.sent).toHaveLength(1);

    // Resuming live catches up in the background without flashing loading.
    rerender(
      <AppProvider client={client}>
        <LiveToggle live={true} />
      </AppProvider>,
    );
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(loadingStates.every((v) => v === false)).toBe(true);
    fake.reply({
      id: fake.sent[1]!.id,
      ok: true,
      value: { result: { rev: 2 }, revision: 2, replayed: false },
    });
    await waitFor(() => expect(screen.getByTestId("val").textContent).toBe("2@2"));

    // A 429 on background refresh retains the pending revision and retries cleanly.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 3 });
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    fake.reply({ id: fake.sent[2]!.id, ok: false, status: 429 });
    await waitFor(() => expect(screen.getByTestId("err").textContent).toBe("429"));
    expect(screen.getByTestId("val").textContent).toBe("2@2");

    // Newer revision 4 arrives during backoff and coalesces into the scheduled retry.
    fake.reply({ kind: "dataset.changed", dataset: "expenses", revision: 4 });
    expect(fake.sent).toHaveLength(3);
    await waitFor(() => expect(fake.sent).toHaveLength(4), { timeout: 2000 });
    fake.reply({
      id: fake.sent[3]!.id,
      ok: true,
      value: { result: { rev: 4 }, revision: 4, replayed: false },
    });
    await waitFor(() => {
      expect(screen.getByTestId("val").textContent).toBe("4@4");
      expect(screen.getByTestId("err").textContent).toBe("none");
    });
    expect(loadingStates.every((v) => v === false)).toBe(true);
    unmount();
    client.close();
  });
});
