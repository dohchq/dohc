import { describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { createPressWindows, registerAutomationButtonsIpc } from "./automationButtonsIpc";
import { CHANNELS } from "./channels";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRESS_ID = "4f2d3c1a-9b8e-4c7d-a6f5-0e1d2c3b4a59";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class FakeWindow {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  destroyed = false;
  workspaceId: string | null = WORKSPACE_ID;
  isDestroyed() { return this.destroyed; }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
}

const dataset = JSON.stringify({
  formatVersion: 1, datasetId: id(1), name: "Billing", schemaPath: "Billing/schema.sql", operationsPath: "Billing/operations.js",
  tables: [{ tableId: id(2), name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
  ] }],
  operations: [
    { operationId: id(4), name: "list", label: "List", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3)] },
    { operationId: id(5), name: "add", label: "Add", tableId: id(2), kind: "create", access: "helper", readOnly: false, fieldIds: [] },
  ],
});

function fixture(options: {
  shareView?: unknown;
  files?: Record<string, string>;
  pressed?: Awaited<ReturnType<CollectionAutomations["press"]>>;
  /** Why the run the press joins waits. */
  waiting?: "roster" | "held" | "busy";
  described?: string[];
  /** Each described table's Button fields, by table name. */
  buttons?: Record<string, string[]>;
} = {}) {
  const handlers = new Map<string, (event: { sender: FakeWindow }, payload: unknown) => unknown>();
  const window = new FakeWindow();
  const pressWindows = createPressWindows<FakeWindow>((sender) => sender.workspaceId);
  const executor = {
    buttons: vi.fn(async (_path: string, fields: readonly string[]) => fields.map((field) => ({ field, state: { kind: "ready", automationId: `collection:Invoices#${field}` } }))),
    press: vi.fn(async (_input: unknown, watch: (claimId: string, waiting: "roster" | "held" | "busy" | null) => void, checkNew: () => Promise<void>) => {
      await checkNew();
      const pressed = options.pressed ?? { busy: false as const, claimId: "atc_press", settled: null };
      if (!pressed.busy && pressed.settled === null) watch(pressed.claimId, options.waiting ?? null);
      return pressed;
    }),
    datasetButtons: vi.fn(async (_datasetId: string, buttons: ReadonlyArray<{ field: string }>, _description: DatasetDescription) =>
      buttons.map(({ field }) => ({ kind: "ready", automationId: `collection:Billing#${field}` }))),
    pressDataset: vi.fn(async (_input: unknown, _description: DatasetDescription, watch: (claimId: string, waiting: "roster" | "held" | "busy" | null) => void) => {
      const pressed = options.pressed ?? { busy: false as const, claimId: "a".repeat(64), settled: null };
      if (!pressed.busy && pressed.settled === null) watch(pressed.claimId, options.waiting ?? null);
      return pressed;
    }),
  };
  const buttonFields = vi.fn(async () => ["Mark paid"]);
  const relayPress = vi.fn(async (_operation: unknown, _input: { pressId: string; automationId: string; recordId: string }) => undefined);
  const invoice: CollectionRecord = { id: "rec_invoice12", path: "Invoices/12.md", conflicted: false, values: [] };
  const recordAt = vi.fn(async (_operation: unknown, path: string) => (path === "Invoices/12.md" ? { collectionPath: "Invoices", record: invoice } : null));
  const describeDataset = vi.fn(async (): Promise<DatasetDescription> => {
    const definition = JSON.parse(dataset) as { operations: DatasetDescription["operations"] };
    return {
      datasetId: id(1), name: "Billing", revision: 1, revisionSha256: "a".repeat(64),
      tables: Object.entries(options.buttons ?? { Invoices: [] }).map(([name, buttons], table) => ({ tableId: table === 0 ? id(2) : id(20 + table), name, fields: [
        { fieldId: id(3 + table * 100), name: "ID", type: "text", required: true, unique: true },
        ...buttons.map((button, index) => ({ fieldId: id(9 + table * 100 + index), name: button, type: "button" as const })),
      ] })),
      operations: definition.operations.filter((operation) => (options.described ?? []).includes(operation.name)),
    };
  });
  registerAutomationButtonsIpc<FakeWindow, { sender: FakeWindow }, {
    workspace: { workspaceId: string; rootPath: string; shareView?: unknown };
    state: { collectionAutomations: CollectionAutomations };
  }>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender, _workspaceId, _message, work) => await work({
      workspace: { workspaceId: WORKSPACE_ID, rootPath: "/workspace", ...(options.shareView === undefined ? {} : { shareView: options.shareView }) },
      state: { collectionAutomations: executor as unknown as CollectionAutomations },
    }),
    readText: async (_root, path) => {
      const text = options.files?.[path];
      return text === undefined ? null : { text, truncated: false, contentHash: "hash" };
    },
    buttonFields,
    relayPress,
    recordAt,
    describeDataset,
    pressedBy: async () => "user-main",
    pressWindows,
  });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: window }, { workspaceId: WORKSPACE_ID, collectionPath: "Invoices", ...payload });
  const press = (payload: Record<string, unknown> = {}) =>
    call(CHANNELS.pressAutomationButton, { field: "Mark paid", recordId: "Invoices/12.md", pressId: PRESS_ID, ...payload });
  // A dataset Collection goes by its id, and a press names its table.
  const callDataset = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: window }, { workspaceId: WORKSPACE_ID, datasetId: id(1), ...payload });
  const pressDataset = (payload: Record<string, unknown> = {}) =>
    callDataset(CHANNELS.pressAutomationButton, { table: "Invoices", field: "Mark paid", recordId: "12", pressId: PRESS_ID, ...payload });
  return { call, press, callDataset, pressDataset, executor, buttonFields, relayPress, describeDataset, window, pressWindows, invoice };
}

const PAID_FILE = "version: 1\nautomations:\n  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n";
const editShare = (paths: string[], access = "edit") => ({
  shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantedSelector: { paths, versionId: null, access },
});

describe("listing a Collection's buttons", () => {
  it("asks the executor about each Button field the engine's schema names", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "ready", automationId: "collection:Invoices#Mark paid" } }],
    });
    expect(f.executor.buttons).toHaveBeenCalledWith("Invoices", ["Mark paid"]);
  });

  it("reads a shared view's buttons from its automations file, or shows them as needing Edit, without asking the executor", async () => {
    const owner = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    await expect(owner.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "ready", automationId: "collection:Invoices#paid" } }],
    });
    const none = fixture({ shareView: editShare(["Invoices"]) });
    await expect(none.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "no-automation", reason: "No automation uses this button." } }],
    });
    const viewer = fixture({ shareView: editShare(["Invoices"], "view") });
    await expect(viewer.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "disabled", reason: "Only people who can edit Invoices can use this button." } }],
    });
    expect(owner.executor.buttons).not.toHaveBeenCalled();
    expect(viewer.executor.buttons).not.toHaveBeenCalled();
  });
});

describe("listing an open record's buttons", () => {
  it("names the record the file is, with its Collection's buttons", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listRecordButtons, { path: "Invoices/12.md" })).resolves.toEqual({
      record: f.invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#Mark paid" } }],
    });
    expect(f.executor.buttons).toHaveBeenCalledWith("Invoices", ["Mark paid"]);
  });

  it("answers no record for a file mounted under shared-with-me, without asking anything", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listRecordButtons, { path: "shared-with-me/Ana/Invoices/12.md" })).resolves.toEqual({ record: null });
    expect(f.buttonFields).not.toHaveBeenCalled();
  });

  it("answers no record for a file outside any Collection", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listRecordButtons, { path: "Notes/todo.md" })).resolves.toEqual({ record: null });
    expect(f.buttonFields).not.toHaveBeenCalled();
  });

  it("shows a shared view's record buttons from its automations file", async () => {
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    await expect(f.call(CHANNELS.listRecordButtons, { path: "Invoices/12.md" })).resolves.toMatchObject({
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid" } }],
    });
    expect(f.executor.buttons).not.toHaveBeenCalled();
  });
});

describe("pressing a button", () => {
  it("presses for main's own person, refuses a press that names one, and watches the run for the window", async () => {
    const f = fixture();
    await expect(f.press({ pressedBy: "user-someone-else" })).rejects.toThrow();
    await expect(f.press()).resolves.toEqual({ busy: false, claimId: "atc_press", settled: null });
    expect(f.executor.press).toHaveBeenCalledWith(
      { collectionPath: "Invoices", field: "Mark paid", recordId: "Invoices/12.md", pressId: PRESS_ID, pressedBy: "user-main" },
      expect.any(Function),
      expect.any(Function),
    );
    f.pressWindows.waiting(WORKSPACE_ID, { claimId: "atc_press", reason: "roster" });
    f.pressWindows.settled(WORKSPACE_ID, { claimId: "atc_press", outcome: "done", error: null });
    f.pressWindows.settled(WORKSPACE_ID, { claimId: "atc_press", outcome: "done", error: null });
    expect(f.window.sent).toEqual([
      { channel: CHANNELS.automationRunWaiting, payload: { workspaceId: WORKSPACE_ID, claimId: "atc_press", reason: "roster" } },
      { channel: CHANNELS.automationRunSettled, payload: { workspaceId: WORKSPACE_ID, claimId: "atc_press", outcome: "done", error: null } },
    ]);
  });

  it("answers busy while the button runs on the record for someone else", async () => {
    const f = fixture({ pressed: { busy: true } });
    await expect(f.press()).resolves.toEqual({ busy: true, reason: "Running for this record." });
  });

  it("answers a press sent again after its run ended with how it ended", async () => {
    const f = fixture({ pressed: { busy: false, claimId: "atc_press", settled: { outcome: "failed", error: "Paid is not a field." } } });
    await expect(f.press()).resolves.toEqual({ busy: false, claimId: "atc_press", settled: { outcome: "failed", error: "Paid is not a field." } });
    expect(f.window.sent).toEqual([]);
  });

  it("tells a window that joins a waiting run why it waits", async () => {
    const f = fixture({ waiting: "held" });
    await f.press();
    expect(f.window.sent).toEqual([
      { channel: CHANNELS.automationRunWaiting, payload: { workspaceId: WORKSPACE_ID, claimId: "atc_press", reason: "held" } },
    ]);
  });

  it("refuses a field that is not a button, and a press id that is not a UUID", async () => {
    const f = fixture();
    await expect(f.press({ field: "Status" })).rejects.toThrow("Status is not a button in Invoices.");
    await expect(f.press({ pressId: "press-1" })).rejects.toThrow();
    expect(f.executor.press).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an Edit grant on the Collection", editShare(["Invoices"])],
    ["an Edit grant on a folder above it", editShare(["Billing"])],
  ])("sends a press in a shared view with %s to the relay, never to this computer's executor", async (_name, shareView) => {
    const collectionPath = shareView.grantedSelector.paths[0] === "Billing" ? "Billing/Invoices" : "Invoices";
    const f = fixture({ shareView, files: { [`${collectionPath}/automations.yaml`]: PAID_FILE } });
    await expect(f.press({ collectionPath })).resolves.toEqual({ busy: false, relayed: true });
    expect(f.relayPress).toHaveBeenCalledWith(expect.anything(), { pressId: PRESS_ID, automationId: `collection:${collectionPath}#paid`, definitionHash: expect.stringMatching(/^[0-9a-f]{16}$/), recordId: "Invoices/12.md" });
    expect(f.executor.press).not.toHaveBeenCalled();
  });

  it("does not send a shared view's press for a button no automation can run", async () => {
    const f = fixture({ shareView: editShare(["Invoices"]) });
    await expect(f.press()).rejects.toThrow("No automation uses this button.");
    await expect(f.press({ field: "Status" })).rejects.toThrow("Status is not a button in Invoices.");
    expect(f.relayPress).not.toHaveBeenCalled();
  });

  it.each([
    ["Edit on one record", editShare(["Invoices/12.md"]), "Only people who can edit Invoices can use this button."],
    ["a View grant", editShare(["Invoices"], "view"), "Only people who can edit Invoices can use this button."],
  ])("refuses a press in a shared view with %s, before reading anything else", async (_name, shareView, reason) => {
    const f = fixture({ shareView });
    await expect(f.press({ collectionPath: shareView.grantedSelector.paths[0] === "Billing" ? "Billing/Invoices" : "Invoices" })).rejects.toThrow(reason);
    expect(f.buttonFields).not.toHaveBeenCalled();
    expect(f.executor.press).not.toHaveBeenCalled();
    expect(f.relayPress).not.toHaveBeenCalled();
  });

  it("presses a dataset button through this computer's executor, for main's person, with the host's description of them", async () => {
    const f = fixture({ described: ["list", "add"], buttons: { Invoices: ["Mark paid"] } });
    const claimId = "a".repeat(64);
    await expect(f.pressDataset({ recordId: "12" })).resolves.toEqual({ busy: false, claimId, settled: null });
    expect(f.describeDataset).toHaveBeenCalledWith(f.window, WORKSPACE_ID, id(1));
    expect(f.executor.pressDataset).toHaveBeenCalledWith(
      { datasetId: id(1), table: "Invoices", field: "Mark paid", recordId: "12", pressId: PRESS_ID, pressedBy: "user-main", confirmed: [] },
      expect.objectContaining({ operations: [expect.objectContaining({ name: "list" }), expect.objectContaining({ name: "add" })] }),
      expect.any(Function),
    );
    // The pressing window hears how the run settles.
    f.pressWindows.settled(WORKSPACE_ID, { claimId, outcome: "done", error: null });
    expect(f.window.sent).toEqual([{ channel: CHANNELS.automationRunSettled, payload: { workspaceId: WORKSPACE_ID, claimId, outcome: "done", error: null } }]);
    expect(f.executor.press).not.toHaveBeenCalled();
    const busy = fixture({ described: ["list", "add"], pressed: { busy: true } });
    await expect(busy.pressDataset()).resolves.toEqual({ busy: true, reason: "Running for this record." });
  });

  it("refuses a press that names both a folder and a dataset, a dataset press with no table, and one that names a person", async () => {
    const f = fixture({ described: ["list", "add"] });
    await expect(f.pressDataset({ collectionPath: "Invoices" })).rejects.toThrow();
    await expect(f.pressDataset({ table: undefined })).rejects.toThrow();
    await expect(f.pressDataset({ pressedBy: "user-someone-else" })).rejects.toThrow();
    expect(f.executor.pressDataset).not.toHaveBeenCalled();
  });

  it("lists every table's buttons from the executor, each with its table, describing the dataset once", async () => {
    const f = fixture({ described: ["list"], buttons: { Invoices: ["Mark paid", "Refund"], Customers: ["Mark paid"] } });
    await expect(f.callDataset(CHANNELS.listAutomationButtons, {})).resolves.toEqual({ buttons: [
      { field: "Mark paid", table: "Invoices", state: { kind: "ready", automationId: "collection:Billing#Mark paid" } },
      { field: "Refund", table: "Invoices", state: { kind: "ready", automationId: "collection:Billing#Refund" } },
      { field: "Mark paid", table: "Customers", state: { kind: "ready", automationId: "collection:Billing#Mark paid" } },
    ] });
    expect(f.describeDataset).toHaveBeenCalledTimes(1);
    expect(f.executor.datasetButtons).toHaveBeenCalledWith(id(1),
      [{ field: "Mark paid", table: "Invoices" }, { field: "Refund", table: "Invoices" }, { field: "Mark paid", table: "Customers" }],
      expect.objectContaining({ datasetId: id(1) }));
    // The document rule is not what answers a dataset.
    expect(f.buttonFields).not.toHaveBeenCalled();
  });

  it("refuses a shared view's dataset buttons, past access, without asking this computer's executor", async () => {
    const shareView = editShare(["Invoices"]);
    const reader = fixture({ described: ["list"], shareView, buttons: { Invoices: ["Mark paid"] } });
    await expect(reader.pressDataset()).rejects.toThrow("Only people who can edit Invoices can use this button.");
    await expect(reader.callDataset(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: "Invoices", state: { kind: "disabled", reason: "Only people who can edit Invoices can use this button." } }],
    });
    const editor = fixture({ described: ["list", "add"], shareView, buttons: { Invoices: ["Mark paid"] } });
    await expect(editor.pressDataset()).rejects.toThrow("dohc can't run buttons on shared dataset Collections yet.");
    await expect(editor.callDataset(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: "Invoices", state: { kind: "disabled", reason: "dohc can't run buttons on shared dataset Collections yet." } }],
    });
    for (const f of [reader, editor]) {
      expect(f.executor.pressDataset).not.toHaveBeenCalled();
      expect(f.executor.datasetButtons).not.toHaveBeenCalled();
      expect(f.buttonFields).not.toHaveBeenCalled();
    }
  });
});

describe("press windows", () => {
  it("tells only live windows that still show the workspace", () => {
    const current = new FakeWindow(), moved = new FakeWindow(), closed = new FakeWindow();
    const windows = createPressWindows<FakeWindow>((sender) => sender.workspaceId);
    for (const window of [current, moved, closed]) windows.watch(WORKSPACE_ID, "atc_press", window, null);
    moved.workspaceId = "22222222-2222-4222-8222-222222222222";
    closed.destroyed = true;
    windows.settled(WORKSPACE_ID, { claimId: "atc_press", outcome: "skipped", error: null });
    windows.settled("22222222-2222-4222-8222-222222222222", { claimId: "atc_press", outcome: "done", error: null });
    expect(current.sent).toHaveLength(1);
    expect(moved.sent).toEqual([]);
    expect(closed.sent).toEqual([]);
  });

  it("drops closed windows when another run registers, and a closed workspace's runs", () => {
    const closed = new FakeWindow(), open = new FakeWindow();
    const windows = createPressWindows<FakeWindow>((sender) => sender.workspaceId);
    windows.watch(WORKSPACE_ID, "atc_one", closed, null);
    closed.destroyed = true;
    windows.watch(WORKSPACE_ID, "atc_two", open, null);
    expect(windows.size()).toBe(1);
    windows.watch("22222222-2222-4222-8222-222222222222", "atc_three", open, null);
    windows.forget(WORKSPACE_ID);
    expect(windows.size()).toBe(1);
    windows.settled(WORKSPACE_ID, { claimId: "atc_two", outcome: "done", error: null });
    expect(open.sent).toEqual([]);
  });
});
