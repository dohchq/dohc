import { describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { SHARED_BUTTON_DENIED, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import { BUTTON_CHECKING } from "@dohc/automation-executor/automation-buttons";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { RelayButtonInspection, RelayButtonTarget } from "@dohc/workspace-contracts/relay";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { createPressWindows, refreshSharedButtonInspections, registerAutomationButtonsIpc, type NamedPress, type PressCaller } from "./automationButtonsIpc";
import { CHANNELS } from "./channels";
import { createServerCollectionsData } from "../workspaces/remoteDataset";
import { CollectionsRefusalError } from "../workspaces/collectionsHolder";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRESS_ID = "4f2d3c1a-9b8e-4c7d-a6f5-0e1d2c3b4a59";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SERVER_SESSION = { serverUrl: "https://account.example", relayUrl: "https://relay.example", userId: "user-main", token: "test-only", email: "main@example.test" };
const KEPT_ELSEWHERE = new CollectionsRefusalError({ kind: "elsewhere", computer: { installId: "install-studio", label: "Studio Mac" }, sameName: false });
const ownerButtonId = (target: RelayButtonTarget) => `collection:${target.collectionPath.replaceAll("/", "-")}#${target.automationId}`;

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
  /** The dataset a Collection folder holds, when it is one. */
  datasetIn?: string;
  /** The actions a dataset button runs that dohc cannot undo. */
  irreversible?: Array<{ name: string; label: string }>;
  /** A dataset button's state other than ready. */
  datasetState?: { kind: "disabled"; reason: string };
  /** The dataset ledger remembers the press. */
  remembered?: boolean;
  inspection?: RelayButtonInspection;
  inspect?: (targets: readonly RelayButtonTarget[]) => Promise<RelayButtonInspection[]>;
  fields?: string[];
  /** The dataset is on the workspace's server: this fake relay answers its presses. */
  server?: (path: string, body: unknown) => unknown;
} = {}) {
  const handlers = new Map<string, (event: { sender: FakeWindow }, payload: unknown) => unknown>();
  const window = new FakeWindow();
  const pressWindows = createPressWindows<FakeWindow>((sender) => sender.workspaceId);
  const executor = {
    buttons: vi.fn(async (_path: string, fields: readonly string[], _describe: Parameters<CollectionAutomations["buttons"]>[2]) => fields.map((field) => ({ field, state: { kind: "ready", automationId: `collection:Invoices#${field}`, ...(options.irreversible ? { irreversible: options.irreversible } : {}) } }))),
    documentPressed: vi.fn(async () => options.remembered ?? false),
    press: vi.fn(async (_input: unknown, watch: (claimId: string, waiting: "roster" | "held" | "busy" | null) => void, checkNew: () => Promise<void>, _describe: Parameters<CollectionAutomations["press"]>[3]) => {
      await checkNew();
      const pressed = options.pressed ?? { busy: false as const, claimId: "atc_press", settled: null };
      if (!pressed.busy && pressed.settled === null) watch(pressed.claimId, options.waiting ?? null);
      return pressed;
    }),
    datasetButtons: vi.fn(async (_datasetId: string, buttons: ReadonlyArray<{ field: string }>, _describe: Parameters<CollectionAutomations["datasetButtons"]>[2]) =>
      buttons.map(({ field }) => options.datasetState ??
        ({ kind: "ready", automationId: `collection:Billing#${field}`, ...(options.irreversible ? { irreversible: options.irreversible } : {}) }))),
    datasetPressed: vi.fn(async (_pressId: string) => options.remembered ?? false),
    datasetIn: vi.fn(async (_collectionPath: string) => options.datasetIn ?? null),
    pressDataset: vi.fn(async (_input: unknown, _describe: Parameters<CollectionAutomations["pressDataset"]>[1], watch: (claimId: string, waiting: "roster" | "held" | "busy" | null) => void) => {
      const pressed = options.pressed ?? { busy: false as const, claimId: "a".repeat(64), settled: null };
      if (!pressed.busy && pressed.settled === null) watch(pressed.claimId, options.waiting ?? null);
      return pressed;
    }),
  };
  const serverRelay = options.server === undefined ? null : vi.fn(async (_credentials: unknown, path: string, init: RequestInit) =>
    ({ kind: "success" as const, body: options.server!(path, JSON.parse(String(init.body))) }));
  const buttonFields = vi.fn(async () => options.fields ?? ["Mark paid"]);
  const relayPress = vi.fn(async (_operation: unknown, _input: { pressId: string; automationId: string; recordId: string }) => undefined);
  const relayInspect = vi.fn(async (_operation: unknown, targets: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]> =>
    options.inspect ? options.inspect(targets) : targets.map(target => options.inspection ?? { kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] }));
  const invoice: CollectionRecord = { id: "rec_invoice12", path: "Invoices/12.md", conflicted: false, values: [] };
  const recordAt = vi.fn(async (_operation: unknown, path: string) => (path === "Invoices/12.md" ? { collectionPath: "Invoices", record: invoice } : null));
  const describeDataset = vi.fn(async (_sender: FakeWindow, _workspaceId: string, datasetId: string): Promise<DatasetDescription> => {
    const definition = JSON.parse(dataset) as { operations: DatasetDescription["operations"] };
    return {
      datasetId, name: "Billing", revision: 1, revisionSha256: "a".repeat(64),
      tables: Object.entries(options.buttons ?? { Invoices: [] }).map(([name, buttons], table) => ({ tableId: table === 0 ? id(2) : id(20 + table), name, fields: [
        { fieldId: id(3 + table * 100), name: "ID", type: "text", required: true, unique: true },
        ...buttons.map((button, index) => ({ fieldId: id(9 + table * 100 + index), name: button, type: "button" as const })),
      ] })),
      operations: definition.operations.filter((operation) => (options.described ?? []).includes(operation.name)),
    };
  });
  type Operation = {
    workspace: { workspaceId: string; rootPath: string; shareView?: unknown; attachmentId: symbol };
    state: { collectionAutomations: CollectionAutomations };
  };
  const attachmentId = Symbol("workspace");
  let account: string | null = "user-main";
  const operation = (): Operation => ({
    workspace: { workspaceId: WORKSPACE_ID, rootPath: "/workspace", attachmentId, ...(options.shareView === undefined ? {} : { shareView: options.shareView }) },
    state: { collectionAutomations: executor as unknown as CollectionAutomations },
  });
  const readText = vi.fn(async (_root: string, path: string) => {
    const text = options.files?.[path] ?? (["Invoices/collection.yaml", "Billing/Invoices/collection.yaml"].includes(path) ? "fields:\n  Mark paid:\n    type: button\n" : undefined);
    return text === undefined ? null : { text, truncated: false, contentHash: "hash" };
  });
  const presses = registerAutomationButtonsIpc<FakeWindow, { sender: FakeWindow }, Operation>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender, _workspaceId, _message, work) => {
      const held = operation();
      let released = false;
      const scoped = { state: held.state, get workspace() {
        if (released) throw new Error("This workspace authority lease was released.");
        return held.workspace;
      } };
      try { return await work(scoped); }
      finally { released = true; }
    },
    readText,
    buttonFields,
    relayPress,
    relayInspect,
    inspectionAccount: async () => account,
    inspectionChanged: () => window.send(CHANNELS.collectionAutomationsChanged, { workspaceId: WORKSPACE_ID }),
    // The server's data as main makes it on a computer that doesn't keep the Collections.
    serverCollection: async () => serverRelay === null ? null : { data: createServerCollectionsData({
      workspaceId: WORKSPACE_ID, credentials: SERVER_SESSION, credentialGeneration: 1, signal: new AbortController().signal,
      currentCredentialGeneration: () => 1, assertCurrent() {}, relayJson: serverRelay, elsewhere: KEPT_ELSEWHERE }) },
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
  // A press by Collection folder, as the CLI sends it, with no window to tell.
  const waits: Array<string | null> = [];
  const named = (input: Partial<NamedPress> = {}, by: PressCaller<Operation>["by"] = { kind: "human" }) => presses.pressNamed(
    { workspaceId: WORKSPACE_ID, collectionPath: "Invoices", field: "Mark paid", recordId: "12", confirm: [], pressKey: "key-1", ...input },
    {
      by,
      withOperation: async (work) => await work(operation()),
      describeDataset: async (datasetId) => await describeDataset(window, WORKSPACE_ID, datasetId),
      watch: (_claimId, waiting) => { waits.push(waiting); },
    },
  );
  const changeAccount = (next: string | null, clear = true) => {
    account = next;
    if (clear) presses.clearInspections();
  };
  const credentialsChanged = (next: string | null) => {
    account = next;
    refreshSharedButtonInspections(presses.clearInspections, [WORKSPACE_ID], workspaceId => window.send(CHANNELS.collectionAutomationsChanged, { workspaceId }));
  };
  return { call, press, callDataset, pressDataset, named, waits, executor, buttonFields, readText, relayPress, relayInspect, describeDataset, window, pressWindows, invoice, changeAccount, credentialsChanged, serverRelay };
}

async function expectCallerDescriptions(
  f: ReturnType<typeof fixture>, describe: Parameters<CollectionAutomations["pressDataset"]>[1],
) {
  const calls = f.describeDataset.mock.calls.length;
  const sourceCall = f.describeDataset.mock.calls.findLastIndex(([, , datasetId]) => datasetId === id(1));
  const source = await f.describeDataset.mock.results[sourceCall]!.value;
  await expect(describe(id(1))).resolves.toBe(source);
  expect(f.describeDataset).toHaveBeenCalledTimes(calls);
  const destination = { ...source, datasetId: id(50), operations: [] };
  f.describeDataset.mockResolvedValueOnce(destination);
  await expect(describe(id(50))).resolves.toBe(destination);
  expect(f.describeDataset).toHaveBeenLastCalledWith(f.window, WORKSPACE_ID, id(50));
}

const PAID_FILE = "version: 1\nautomations:\n  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n";
const editShare = (paths: string[], access = "edit") => ({
  shareId: "share-1", recipientUserId: "recipient-1", granterEmail: "owner@example.com", genericChatWritable: false,
  grantedSelector: { paths, versionId: null, access },
});

describe("dataset operations from shared document buttons", () => {
  it("rechecks a signed-out Button after the credential notification without a manual list", async () => {
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    f.changeAccount(null);
    let shown = await f.call(CHANNELS.listAutomationButtons, {});
    expect(shown).toMatchObject({ buttons: [{ state: { kind: "disabled", reason: "Sign in with Edit access to use this button." } }] });
    // The open table re-lists only on this event, as CollectionPage does.
    vi.spyOn(f.window, "send").mockImplementation((channel, payload) => {
      f.window.sent.push({ channel, payload });
      if (channel === CHANNELS.collectionAutomationsChanged) void Promise.resolve(f.call(CHANNELS.listAutomationButtons, {})).then(result => { shown = result; });
    });
    f.credentialsChanged("user-main");
    await vi.waitFor(() => expect(shown).toMatchObject({ buttons: [{ state: { kind: "ready" } }] }));
    expect(f.relayInspect).toHaveBeenCalledOnce();
    expect(f.window.sent[0]).toEqual({ channel: CHANNELS.collectionAutomationsChanged, payload: { workspaceId: WORKSPACE_ID } });
  });
  it("expires the last answer while its refresh is still pending", async () => {
    const answers: Array<(value: RelayButtonInspection[]) => void> = [];
    const inspect = vi.fn((_targets: readonly RelayButtonTarget[]) =>
      new Promise<RelayButtonInspection[]>(resolve => { answers.push(resolve); }));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    answers[0]!(inspect.mock.calls[0]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    const checkedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(checkedAt + 6_000);
    try {
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
      now.mockReturnValue(checkedAt + 120_000);
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
      expect(inspect).toHaveBeenCalledTimes(2);
      answers[1]!(inspect.mock.calls[1]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
      await vi.waitFor(() => expect(f.window.sent).toHaveLength(2));
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
    } finally { now.mockRestore(); }
  });
  it("shows checking when an expired answer starts a refresh", async () => {
    const inspect = vi.fn(async (targets: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]> =>
      targets.map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    inspect.mockImplementationOnce(() => new Promise(() => undefined));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  it.each([false, true])("isolates answers by account with explicit clearing %s", async clear => {
    const inspect = vi.fn(async (targets: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]> =>
      targets.map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    inspect.mockImplementation(() => new Promise(() => undefined));
    f.changeAccount("user-other", clear);
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
    expect(inspect).toHaveBeenCalledTimes(2);
    if (clear) {
      f.changeAccount(null);
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "disabled", reason: "Sign in with Edit access to use this button." } }] });
      f.changeAccount("user-main");
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
      expect(inspect).toHaveBeenCalledTimes(3);
    } else {
      f.changeAccount("user-main", false);
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
      expect(inspect).toHaveBeenCalledTimes(2);
    }
  });
  it("discards an old account's pending answer after sign-out and sign-in", async () => {
    const answers: Array<(value: RelayButtonInspection[]) => void> = [];
    const inspect = vi.fn((_targets: readonly RelayButtonTarget[]) =>
      new Promise<RelayButtonInspection[]>(resolve => { answers.push(resolve); }));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    f.changeAccount(null);
    f.changeAccount("user-main");
    await f.call(CHANNELS.listAutomationButtons, {});
    answers[0]!(inspect.mock.calls[0]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
    expect(f.window.sent).toHaveLength(0);
    answers[1]!(inspect.mock.calls[1]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
  });
  it("lists checking at once, inspects one Collection batch, and notifies when its answer arrives", async () => {
    let answer!: (value: RelayButtonInspection[]) => void;
    const inspect = vi.fn((targets: readonly RelayButtonTarget[]) => new Promise<RelayButtonInspection[]>(resolve => { answer = resolve; }));
    const file = PAID_FILE.replace("do: [{set: {Paid: true}}]", "do: [{set: {Paid: true}}]\n  - id: archive\n    name: Archive\n    when: {button: Archive}\n    do: [{set: {Paid: true}}]");
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": file }, fields: ["Mark paid", "Archive"], inspect });
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }, { state: { kind: "checking" } }] });
    expect(inspect).toHaveBeenCalledTimes(1);
    const targets = inspect.mock.calls[0]![0];
    expect(targets).toHaveLength(2);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    try {
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }, { state: { kind: "checking" } }] });
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
    answer(targets.map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await vi.waitFor(() => expect(f.window.sent).toEqual([{ channel: CHANNELS.collectionAutomationsChanged, payload: { workspaceId: WORKSPACE_ID } }]));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }, { state: { kind: "ready" } }] });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("keeps the last answer during refresh and notifies when a later check fails", async () => {
    const answers: Array<(value: RelayButtonInspection[]) => void> = [];
    const inspect = vi.fn((_targets: readonly RelayButtonTarget[]) =>
      new Promise<RelayButtonInspection[]>(resolve => { answers.push(resolve); }));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    answers[0]!(inspect.mock.calls[0]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    try {
      for (let index = 0; index < 2; index++) {
        await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
      }
      expect(inspect).toHaveBeenCalledTimes(2);
      answers[1]!(inspect.mock.calls[1]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
      await vi.waitFor(async () => {
        now.mockReturnValue(Date.now() + 6_000);
        await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
        expect(inspect).toHaveBeenCalledTimes(3);
      });
      expect(f.window.sent).toHaveLength(1);
      answers[2]!([{ kind: "unchecked", reason: "Host unavailable" }]);
      await vi.waitFor(() => expect(f.window.sent).toHaveLength(2));
      await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "unchecked", reason: "Host unavailable" } }] });
    } finally { now.mockRestore(); }
  });
  it("asks the host again for Check again, past its last answer, and lists checking until the host answers", async () => {
    const answers: Array<(value: RelayButtonInspection[]) => void> = [];
    const inspect = vi.fn((_targets: readonly RelayButtonTarget[]) => new Promise<RelayButtonInspection[]>(resolve => { answers.push(resolve); }));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await f.call(CHANNELS.listAutomationButtons, {});
    answers[0]!([{ kind: "unchecked", reason: "Host unavailable" }]);
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "unchecked", reason: "Host unavailable" } }] });
    expect(inspect).toHaveBeenCalledTimes(1);
    // That answer is recent, so a listing keeps it. Check again asks the host anyway.
    await expect(f.call(CHANNELS.listAutomationButtons, { check: true })).resolves.toMatchObject({ buttons: [{ state: { kind: "checking", reason: BUTTON_CHECKING } }] });
    expect(inspect).toHaveBeenCalledTimes(2);
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
    expect(inspect).toHaveBeenCalledTimes(2);
    answers[1]!(inspect.mock.calls[1]![0].map(target => ({ kind: "ready", ...target, automationId: ownerButtonId(target), irreversible: [] })));
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(2));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] });
  });
  it("lists unchecked, not checking, when the host check fails", async () => {
    const inspect = vi.fn(async (_targets: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]> => { throw new Error("relay unreachable"); });
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "checking" } }] });
    await vi.waitFor(() => expect(f.window.sent).toHaveLength(1));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED } }] });
  });
  it("presses with the owner's Button identity returned by inspection", async () => {
    const inspect = vi.fn(async (targets: readonly RelayButtonTarget[]) => targets.map(target => ({ kind: "ready" as const, ...target, automationId: `collection:owner-invoices#${target.automationId}`, irreversible: [] })));
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspect });
    await expect(f.named({}, { kind: "agent", originId: "mcp", depth: 0 })).resolves.toEqual({ busy: false, relayed: true });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith([expect.objectContaining({ automationId: "paid", collectionPath: "Invoices" })]);
    expect(f.relayPress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ automationId: "collection:owner-invoices#paid" }));
    expect(f.relayPress).toHaveBeenCalledTimes(1);
  });
  it("uses authorized host inspection for named pressers and the same confirmation path for CLI agents", async () => {
    const inspection: RelayButtonInspection = { kind: "ready", automationId: "collection:Invoices#paid", definitionHash: "0000000000000000", irreversible: [{ name: `${id(1)}/sendInvoice`, label: "Send" }] };
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspection });
    // A reply for another definition is unknown, even if that host said ready.
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "unchecked" } }] }); });
    const parsed = parseAutomationsFile(PAID_FILE); const entry = parsed.status === "read" ? parsed.entries[0] : null;
    if (entry?.status !== "valid") throw Error("Invalid fixture");
    inspection.definitionHash = definitionHash(entry.automation);
    await expect(f.named({}, { kind: "agent", originId: "agent", depth: 0 })).resolves.toEqual({ confirm: inspection.irreversible });
    expect(f.relayPress).not.toHaveBeenCalled();
    await expect(f.press()).rejects.toThrow("changed after it was pressed");
    await expect(f.named({ confirm: [inspection.irreversible[0]!.name] }, { kind: "agent", originId: "agent", depth: 0 })).resolves.toEqual({ busy: false, relayed: true });
    expect(f.relayPress).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ confirmed: [inspection.irreversible[0]!.name] }));
    expect(f.describeDataset).not.toHaveBeenCalled();
  });
  it.each(["denied", "unchecked"] as const)("preserves the host's %s access state", async kind => {
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE }, inspection: { kind, reason: "Host access result" } });
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: kind === "denied" ? "disabled" : "unchecked" } }] }); });
    await expect(f.named()).rejects.toThrow("Host access result");
    expect(f.relayPress).not.toHaveBeenCalled();
  });
  it.each([
    ["Find", "      - find: 'true'\n        collection: Billing\n        operation: list\n        as: matches", { "Billing/dataset.json": dataset }],
    ["Find without a pinned operation", "      - find: 'true'\n        collection: Billing\n        as: matches", { "Billing/dataset.json": dataset }],
    ["invoke", "      - invoke: sendInvoice\n        collection: Billing\n        input: {id: 12}", { "Billing/dataset.json": dataset }],
    ["nested step", "      - if: 'false'\n        do: [{set: {Paid: true}}]\n        otherwise:\n          - find: 'true'\n            collection: Billing\n            operation: list\n            as: matches", { "Billing/dataset.json": dataset }],
    ["implicit read", "      - add-record: {Paid: false}\n        collection: Billing\n        operation: add\n        as: added\n      - set: {Paid: true}\n        records: added\n        operation: edit", { "Billing/dataset.json": dataset }],
    ["missing destination", "      - find: 'true'\n        collection: Missing\n        as: matches", {}],
    ["invalid destination", "      - find: 'true'\n        collection: Broken\n        as: matches", { "Broken/collection.yaml": "[" }],
  ])("disables the listing and refuses window and named presses for %s", async (_name, steps, files) => {
    const automations = `version: 1\nautomations:\n  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do:\n${steps}\n`;
    const f = fixture({ shareView: editShare(["Invoices"]), files: { ...files, "Invoices/automations.yaml": automations }, inspection: { kind: "denied", reason: SHARED_BUTTON_DENIED } });
    const state = { kind: "disabled", reason: SHARED_BUTTON_DENIED };
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state }] }); });
    await expect(f.press()).rejects.toThrow(SHARED_BUTTON_DENIED);
    await expect(f.named()).rejects.toThrow(SHARED_BUTTON_DENIED);
    await expect(f.press({ confirmed: ["sendInvoice"] })).rejects.toThrow(SHARED_BUTTON_DENIED);
    expect(f.relayPress).not.toHaveBeenCalled();
    expect(f.executor.press).not.toHaveBeenCalled();
    expect(f.describeDataset).not.toHaveBeenCalled();
  });

  it("keeps buttons ready and relays presses when all destinations are document Collections", async () => {
    const automations = PAID_FILE.replace("do: [{set: {Paid: true}}]", "do: [{find: 'true', collection: Notes, as: matches}, {set: {Paid: true}, records: matches}]");
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": automations, "Notes/collection.yaml": "fields: {Paid: {type: checkbox}}" } });
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ state: { kind: "ready" } }] }); });
    await expect(f.press()).resolves.toEqual({ busy: false, relayed: true });
    expect(f.describeDataset).not.toHaveBeenCalled();
  });
});

describe("listing a Collection's buttons", () => {
  it("shows no buttons before an existing Collection is indexed, then lists them", async () => {
    const f = fixture();
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({ buttons: [] });
    expect(f.executor.buttons).not.toHaveBeenCalled();
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({
      buttons: [{ field: "Mark paid", state: { kind: "ready" } }],
    });
  });

  it("keeps the missing Collection error", async () => {
    const f = fixture();
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    await expect(f.call(CHANNELS.listAutomationButtons, { collectionPath: "Missing" })).rejects.toThrow("collection-not-found");
  });

  it("keeps the missing Collection error after its schema is deleted", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toMatchObject({ buttons: [{ field: "Mark paid" }] });
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    f.readText.mockResolvedValueOnce(null);
    await expect(f.call(CHANNELS.listAutomationButtons, {})).rejects.toThrow("collection-not-found");
  });

  it("keeps real engine failures for an existing Collection", async () => {
    const f = fixture();
    f.buttonFields.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).rejects.toThrow("The workspace engine is not running.");
  });

  it.each(["[", "version: 999\nfields: {}\n"])("shows no buttons before a degraded Collection is indexed: %s", async (schema) => {
    const f = fixture({ files: { "Invoices/collection.yaml": schema } });
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({ buttons: [] });
  });

  it("shows no buttons before a Collection with a truncated schema is indexed", async () => {
    const f = fixture();
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    f.readText.mockResolvedValueOnce({ text: "fields:", truncated: true, contentHash: "hash" });
    await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({ buttons: [] });
  });

  it("keeps a real file-read failure when checking an unindexed Collection", async () => {
    const f = fixture();
    f.buttonFields.mockRejectedValueOnce(new Error("collection-not-found"));
    f.readText.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(f.call(CHANNELS.listAutomationButtons, {})).rejects.toThrow("Permission denied");
  });

  it("asks the executor about each Button field the engine's schema names", async () => {
    const f = fixture();
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "ready", automationId: "collection:Invoices#Mark paid" } }],
    }); });
    expect(f.executor.buttons).toHaveBeenCalledWith("Invoices", ["Mark paid"], expect.any(Function));
  });

  it("reads a shared view's buttons from its automations file, or shows them as needing Edit, without asking the executor", async () => {
    const owner = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    await vi.waitFor(async () => { await expect(owner.call(CHANNELS.listAutomationButtons, {})).resolves.toEqual({
      buttons: [{ field: "Mark paid", table: null, state: { kind: "ready", automationId: "collection:Invoices#paid" } }],
    }); });
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
  it("names the record the file is and its Collection's Button fields, without asking what they do", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listRecordButtons, { path: "Invoices/12.md" })).resolves.toEqual({
      record: f.invoice, collectionPath: "Invoices", fields: ["Mark paid"],
    });
    expect(f.executor.buttons).not.toHaveBeenCalled();
  });

  it("answers no record for a file mounted under shared-with-me, without asking anything", async () => {
    const f = fixture();
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listRecordButtons, { path: "shared-with-me/Ana/Invoices/12.md" })).resolves.toEqual({ record: null }); });
    expect(f.buttonFields).not.toHaveBeenCalled();
  });

  it("answers no record for a file outside any Collection", async () => {
    const f = fixture();
    await vi.waitFor(async () => { await expect(f.call(CHANNELS.listRecordButtons, { path: "Notes/todo.md" })).resolves.toEqual({ record: null }); });
    expect(f.buttonFields).not.toHaveBeenCalled();
  });

  it("names a shared view's record without waiting on the host that checks its buttons", async () => {
    const f = fixture({ shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    await expect(f.call(CHANNELS.listRecordButtons, { path: "Invoices/12.md" })).resolves.toEqual({
      record: f.invoice, collectionPath: "Invoices", fields: ["Mark paid"],
    });
    expect(f.relayInspect).not.toHaveBeenCalled();
    expect(f.executor.buttons).not.toHaveBeenCalled();
  });
});

describe("pressing a button", () => {
  it("presses for main's own person, refuses a press that names one, and watches the run for the window", async () => {
    const f = fixture();
    await expect(f.press({ pressedBy: "user-someone-else" })).rejects.toThrow();
    await expect(f.press()).resolves.toEqual({ busy: false, claimId: "atc_press", settled: null });
    expect(f.executor.press).toHaveBeenCalledWith(
      { collectionPath: "Invoices", field: "Mark paid", recordId: "Invoices/12.md", pressId: PRESS_ID, pressedBy: "user-main", by: { kind: "human" }, confirmed: [] },
      expect.any(Function),
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
    expect(f.relayPress).toHaveBeenCalledWith(expect.anything(), { pressId: PRESS_ID, automationId: `collection:${collectionPath.replaceAll("/", "-")}#paid`, collectionPath, definitionHash: expect.stringMatching(/^[0-9a-f]{16}$/), recordId: "Invoices/12.md", confirmed: [] });
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
      { datasetId: id(1), table: "Invoices", field: "Mark paid", recordId: "12", pressId: PRESS_ID, pressedBy: "user-main", by: { kind: "human" }, confirmed: [] },
      expect.any(Function),
      expect.any(Function),
    );
    const describe = f.executor.pressDataset.mock.calls[0]![1];
    await expect(describe(id(1))).resolves.toMatchObject({
      operations: [expect.objectContaining({ name: "list" }), expect.objectContaining({ name: "add" })],
    });
    await expectCallerDescriptions(f, describe);
    // The pressing window hears how the run settles.
    f.pressWindows.settled(WORKSPACE_ID, { claimId, outcome: "done", error: null });
    expect(f.window.sent).toEqual([{ channel: CHANNELS.automationRunSettled, payload: { workspaceId: WORKSPACE_ID, claimId, outcome: "done", error: null } }]);
    expect(f.executor.press).not.toHaveBeenCalled();
    const busy = fixture({ described: ["list", "add"], pressed: { busy: true } });
    await expect(busy.pressDataset()).resolves.toEqual({ busy: true, reason: "Running for this record." });
  });

  it("sends a press on a Collection on the server to the server, for the person or their agent, and runs nothing here", async () => {
    const claimId = "b".repeat(64);
    const bodies: unknown[] = [];
    const f = fixture({ datasetIn: id(1), described: ["list", "add"], buttons: { Invoices: ["Mark paid"] },
      server: (_path, body) => { bodies.push(body); return { busy: false, claimId, settled: null }; } });
    // The window's button is free again at once: the server runs it, and a failure arrives as the server's notice.
    await expect(f.pressDataset({ recordId: "12", confirmed: ["sendInvoice"] })).resolves.toEqual({ busy: false, relayed: true });
    // An agent's press names the agent and its depth, and the server answers with its run.
    await expect(f.named({}, { kind: "agent", originId: "agent-run-7", depth: 2 })).resolves.toEqual({ busy: false, claimId, settled: null });
    expect(f.serverRelay!.mock.calls.map(([, path, init]) => [path, init.method, init.redirect])).toEqual([
      [`/sync/${WORKSPACE_ID}/datasets/${id(1)}/press`, "POST", "error"],
      [`/sync/${WORKSPACE_ID}/datasets/${id(1)}/press`, "POST", "error"],
    ]);
    // Who pressed is the server's to know from the session; the body never names a person.
    expect(bodies).toEqual([
      { table: "Invoices", field: "Mark paid", recordId: "12", pressId: PRESS_ID, confirmed: ["sendInvoice"] },
      { table: "Invoices", field: "Mark paid", recordId: "12", pressId: expect.stringMatching(/^[0-9a-f-]{36}$/u), confirmed: [],
        agent: { originId: "agent-run-7", depth: 2 } },
    ]);
    // The server checks a new press itself; this computer's ledger and checks are not asked.
    expect(f.executor.datasetPressed).not.toHaveBeenCalled();
    expect(f.executor.datasetButtons).not.toHaveBeenCalled();
    expect(f.executor.pressDataset).not.toHaveBeenCalled();
    expect(f.window.sent).toEqual([]);
    // A run the server already ended says how; one busy for someone else says so.
    const ended = fixture({ server: () => ({ busy: false, claimId, settled: { outcome: "done", error: null } }) });
    await expect(ended.pressDataset()).resolves.toEqual({ busy: false, claimId, settled: { outcome: "done", error: null } });
    const busy = fixture({ server: () => ({ busy: true }) });
    await expect(busy.pressDataset()).resolves.toEqual({ busy: true, reason: "Running for this record." });
    // An answer that is not a press is refused.
    const odd = fixture({ server: () => ({ busy: false, claimId, settled: null, pressedBy: "someone" }) });
    await expect(odd.pressDataset()).rejects.toThrow();
  });

  it("lets the server answer a CLI press it remembers, and checks the button here only to say why the server refused one", async () => {
    const claimId = "c".repeat(64);
    // Sent again after a lost answer: the automation is off now, but the server remembers the press.
    const remembered = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] },
      datasetState: { kind: "disabled", reason: "Mark paid is off. Turn it on in Automations." },
      server: () => ({ busy: false, claimId, settled: { outcome: "done", error: null } }) });
    await expect(remembered.named({}, { kind: "agent", originId: "agent-run-7", depth: 1 })).resolves.toEqual({ busy: false, claimId, settled: { outcome: "done", error: null } });
    expect(remembered.executor.datasetButtons).not.toHaveBeenCalled();
    // A new press the server refuses says why as this computer reads the button.
    const off = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] },
      datasetState: { kind: "disabled", reason: "Mark paid is off. Turn it on in Automations." },
      server: () => { throw new Error("Mark paid is off. Turn it on in Automations."); } });
    await expect(off.named()).rejects.toThrow("Mark paid is off. Turn it on in Automations.");
    // One that runs an action dohc cannot undo asks for it by name, as a press kept here does.
    const irreversible = [{ name: "sendInvoice", label: "Send invoice" }];
    const unconfirmed = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] }, irreversible,
      server: () => { throw new Error("Mark paid changed after it was pressed. Press it again."); } });
    await expect(unconfirmed.named()).resolves.toEqual({ confirm: irreversible });
    // The server's own refusal stands when this computer sees nothing wrong.
    const refused = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] },
      server: () => { throw new Error("This record is no longer in Invoices."); } });
    await expect(refused.named()).rejects.toThrow("This record is no longer in Invoices.");
    for (const f of [remembered, off, unconfirmed, refused]) expect(f.executor.pressDataset).not.toHaveBeenCalled();
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
      expect.any(Function));
    await expectCallerDescriptions(f, f.executor.datasetButtons.mock.calls[0]![2]);
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

describe("pressing a button by its Collection's folder, as the CLI does", () => {
  it("carries destination confirmations and caller descriptions through document app presses", async () => {
    const confirmed = [`${id(50)}/sendInvoice`];
    const f = fixture();
    await f.press({ confirmed });
    expect(f.executor.press.mock.calls[0]![0]).toMatchObject({ confirmed });
    await f.executor.press.mock.calls[0]![3]!(id(50));
    expect(f.describeDataset).toHaveBeenLastCalledWith(f.window, WORKSPACE_ID, id(50));
    await f.call(CHANNELS.listAutomationButtons, {});
    await f.executor.buttons.mock.calls[0]![2]!(id(51));
    expect(f.describeDataset).toHaveBeenLastCalledWith(f.window, WORKSPACE_ID, id(51));
  });

  it.each([{ kind: "human" as const }, { kind: "agent" as const, originId: "dohc-mcp", depth: 2 }])("confirms destination actions from a document button for %s", async (by) => {
    const name = `${id(50)}/sendInvoice`;
    const irreversible = [{ name, label: "Billing: Send invoice" }];
    const f = fixture({ irreversible });
    expect(await f.named({ confirm: ["sendInvoice"] }, by)).toEqual({ confirm: irreversible });
    expect(f.executor.press).not.toHaveBeenCalled();
    expect(await f.named({ confirm: [name] }, by)).toMatchObject({ busy: false });
    expect(f.executor.press.mock.calls[0]![0]).toMatchObject({ confirmed: [name], by });
    await f.executor.press.mock.calls[0]![3]!(id(50));
    expect(f.describeDataset).toHaveBeenLastCalledWith(f.window, WORKSPACE_ID, id(50));
  });

  it("does not reconfirm a remembered document press", async () => {
    const f = fixture({ remembered: true, irreversible: [{ name: `${id(50)}/sendInvoice`, label: "Send invoice" }] });
    expect(await f.named()).toMatchObject({ busy: false });
    expect(f.executor.buttons).not.toHaveBeenCalled();
  });

  it("presses a document Collection's button through the same press, and tells the caller why the run waits", async () => {
    const f = fixture({ waiting: "roster" });
    await expect(f.named({ recordId: "rec_invoice12" })).resolves.toEqual({ busy: false, claimId: "atc_press", settled: null });
    expect(f.executor.press).toHaveBeenCalledWith(
      { collectionPath: "Invoices", field: "Mark paid", recordId: "rec_invoice12", pressId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u), pressedBy: "user-main", by: { kind: "human" }, confirmed: [] },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(f.waits).toEqual(["roster"]);
    // No window pressed, so none hears the run.
    expect(f.window.sent).toEqual([]);
    await expect(f.named({ collectionPath: "shared-with-me/Invoices" })).rejects.toThrow("is not a Collection in this workspace");
  });

  it("asks before a dataset press runs an action dohc cannot undo, and runs only the actions confirmed by name", async () => {
    const irreversible = [{ name: "sendInvoice", label: "Send invoice" }, { name: "charge", label: "Charge card" }];
    const f = fixture({ datasetIn: id(1), described: ["list", "add"], buttons: { Invoices: ["Mark paid"] }, irreversible });
    await expect(f.named()).resolves.toEqual({ confirm: irreversible });
    await expect(f.named({ confirm: ["sendInvoice"] })).resolves.toEqual({ confirm: [irreversible[1]] });
    expect(f.executor.pressDataset).not.toHaveBeenCalled();
    await expect(f.named({ confirm: ["sendInvoice", "charge"] })).resolves.toEqual({ busy: false, claimId: "a".repeat(64), settled: null });
    // The executor checks the names again against the automation it runs.
    expect(f.executor.pressDataset).toHaveBeenCalledWith(
      { datasetId: id(1), table: "Invoices", field: "Mark paid", recordId: "12", pressId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u), pressedBy: "user-main", by: { kind: "human" }, confirmed: ["sendInvoice", "charge"] },
      expect.any(Function),
      expect.any(Function),
    );
    await expectCallerDescriptions(f, f.executor.datasetButtons.mock.calls.at(-1)![2]);
    await expectCallerDescriptions(f, f.executor.pressDataset.mock.calls[0]![1]);
    expect(f.executor.press).not.toHaveBeenCalled();
  });

  it("finds a dataset button's table, and asks for it only when two tables have the button", async () => {
    const one = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"], Payments: [] } });
    await expect(one.named()).resolves.toMatchObject({ busy: false });
    expect(one.executor.datasetButtons).toHaveBeenCalledWith(id(1), [{ field: "Mark paid", table: "Invoices" }], expect.anything());
    const two = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"], Payments: ["Mark paid"] } });
    await expect(two.named()).rejects.toThrow("Mark paid is a button in more than one table of Invoices. Name the table.");
    await expect(two.named({ table: "Payments" })).resolves.toMatchObject({ busy: false });
    await expect(two.named({ field: "Refund" })).rejects.toThrow("Refund is not a button in Invoices.");
  });

  it("answers a press sent again with its first run, whatever changed in the button since", async () => {
    const irreversible = [{ name: "sendInvoice", label: "Send invoice" }];
    const changed = [
      { datasetState: { kind: "disabled" as const, reason: "Mark paid is switched off." } },
      { irreversible },
      // Renamed since: the resend names the table it pressed in.
      { buttons: { Invoices: ["Mark as paid"] } },
    ];
    for (const since of changed) {
      const f = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] }, remembered: true, ...since });
      await expect(f.named({ table: "Invoices" })).resolves.toEqual({ busy: false, claimId: "a".repeat(64), settled: null });
      expect(f.executor.datasetButtons).not.toHaveBeenCalled();
      expect(f.executor.pressDataset).toHaveBeenCalledWith(expect.objectContaining({ table: "Invoices", field: "Mark paid", pressId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u) }), expect.anything(), expect.any(Function));
    }
    // A new press of a switched-off button is refused with its reason.
    const off = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] }, datasetState: changed[0]!.datasetState });
    await expect(off.named()).rejects.toThrow("Mark paid is switched off.");
    expect(off.executor.pressDataset).not.toHaveBeenCalled();
  });

  it("names a press by its key, its Collection, and the Collection's kind, so the key never spans two ledgers", async () => {
    const idOf = (call: unknown[] | undefined) => (call?.[0] as { pressId: string }).pressId;
    const document = fixture();
    await document.named();
    await document.named();
    await document.named({ pressKey: "key-2" });
    const [first, again, other] = document.executor.press.mock.calls.map(idOf);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    // The same key on the same folder, once it holds a dataset, is a new press in the dataset's ledger.
    const dataset = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] } });
    await dataset.named();
    expect(idOf(dataset.executor.pressDataset.mock.calls[0])).not.toBe(first);
    expect(dataset.executor.datasetPressed).toHaveBeenCalledWith(idOf(dataset.executor.pressDataset.mock.calls[0]));
  });

  it("presses as the agent the caller names, at its run's depth, for main's person, on both kinds of Collection", async () => {
    const agent = { kind: "agent" as const, originId: "dohc-mcp", depth: 2 };
    const document = fixture();
    await document.named({ recordId: "rec_invoice12" }, agent);
    expect(document.executor.press).toHaveBeenCalledWith(
      expect.objectContaining({ pressedBy: "user-main", by: agent }), expect.any(Function), expect.any(Function), expect.any(Function));
    const dataset = fixture({ datasetIn: id(1), described: ["list"], buttons: { Invoices: ["Mark paid"] } });
    await dataset.named({}, agent);
    expect(dataset.executor.pressDataset).toHaveBeenCalledWith(
      expect.objectContaining({ pressedBy: "user-main", by: agent }), expect.anything(), expect.any(Function));
  });

  it("relays a shared view's press of a document button as the app does, without this computer's executor", async () => {
    const f = fixture({ datasetIn: id(1), shareView: editShare(["Invoices"]), files: { "Invoices/automations.yaml": PAID_FILE } });
    await expect(f.named({ recordId: "rec_invoice12" })).resolves.toEqual({ busy: false, relayed: true });
    expect(f.relayPress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pressId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u), recordId: "rec_invoice12" }));
    expect(f.executor.datasetIn).not.toHaveBeenCalled();
    expect(f.executor.press).not.toHaveBeenCalled();
    // Less than Edit on the Collection refuses, as the app's button does.
    const view = fixture({ shareView: editShare(["Invoices"], "view"), files: { "Invoices/automations.yaml": PAID_FILE } });
    await expect(view.named()).rejects.toThrow("Only people who can edit Invoices can use this button.");
    expect(view.relayPress).not.toHaveBeenCalled();
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
