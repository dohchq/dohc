// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetCollectionAutomationRunResult,
  ListCollectionAutomationRunsResult,
  ListServerAutomationRunsResult,
  ListCollectionAutomationsResult,
  ListAutomationGroupsResult,
  ListAutomationPeopleResult,
  ListAutomationTargetsResult,
  RetryCollectionAutomationResult,
  ScheduleHostResult,
  UndoCollectionAutomationRunResult,
  WriteCollectionAutomationsPayload,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import type { DatasetDescription, DatasetOperation } from "@dohc/security-contract/dataset";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { parseAutomationsFile, writeAutomationsFile } from "@dohc/workspace-contracts/automations";
import { formulaProblems } from "@dohc/automation-executor/automation-plan";
import {
  AutomationsPanel,
  resetKeptAutomationDraftsForTests,
  useCollectionAutomations,
  type AutomationFocus,
} from "./AutomationsPanel";
import { AutomationRuns } from "./AutomationRuns";
import type { Automation, ValidAutomationSummary } from "./automationSentence";
import type { AutomationDatasetTable, AutomationTable } from "./automationDraft";
import { START_OVER_SENTENCE } from "./useAutomationRetry";

const HASH = "a".repeat(64);
const FIELDS: FieldDefinition[] = [
  { name: "Title", type: "text" },
  { name: "Status", type: "select", options: ["Doing", "Done"] },
  { name: "Finished on", type: "date" },
  { name: "Points", type: "number" },
  { name: "Tags", type: "multi-select", options: ["urgent", "later", "home"] },
];
/** A dataset table as the builder reads it: its fields, and its approved operations as "name:kind". */
const datasetTable = (fields: FieldDefinition[], ...operations: string[]): AutomationDatasetTable => ({
  fields,
  operations: operations.map((operation) => {
    const [name, kind] = operation.split(":") as [string, AutomationDatasetTable["operations"][number]["kind"]];
    return { name, kind };
  }),
});
// The builder checks formulas a moment after typing stops; a loaded machine
// can take longer than the default wait.
const SLOW = { timeout: 10_000 };
const stamp: Automation = {
  id: "stamp",
  name: "Stamp the finish date",
  enabled: true,
  when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: null },
  if: null,
  do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null, operation: null }],
};
const nudge: Automation = { ...stamp, id: "nudge", name: "Nudge the owner", when: { kind: "record-added", table: null } };

function summary(automation: Automation, overrides: Partial<ValidAutomationSummary> = {}): ValidAutomationSummary {
  return {
    valid: true,
    automationId: `collection:Tasks#${automation.id}`,
    automation,
    definitionHash: "0123456789abcdef",
    cannotRun: null,
    reach: { kind: "checked", steps: automation.do.map(() => ({ verdict: "allowed" as const })) },
    lastRun: null,
    ...overrides,
  };
}

const NOTHING_UNDONE = { status: "undone" as const, reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };

function read(automations: ValidAutomationSummary[], onServer?: { runs: boolean | null }): ListCollectionAutomationsResult {
  return { status: "read", contentHash: HASH, automations, addsStay: [], ...(onServer ? { onServer } : {}) };
}

type Run = Extract<ListCollectionAutomationRunsResult, { status: "listed" }>["runs"][number];
const run = (overrides: Partial<Run>): Run => ({
  claimId: "atc_1", state: "done", error: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
  trigger: { kind: "changed", recordId: "rec_1", by: "human", sharedAuthor: null, depth: 0 }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undone: false, undoUnfinished: false, ...overrides,
});

function makeBridge(file: ListCollectionAutomationsResult, runs: Run[] = [], options: {
  holdsUnreadable?: boolean;
  roundTripWrites?: boolean;
  /** The server's runs; null when it has no copy of the workspace. */
  serverRuns?: Run[] | null;
} = {}) {
  let current = file;
  let holdsUnreadable = options.holdsUnreadable ?? false;
  const failureListeners: Array<(event: { workspaceId: string }) => void> = [];
  const changeListeners = new Set<(event: { workspaceId: string }) => void>();
  const hostListeners = new Set<(workspaceId: string) => void>();
  const written: WriteCollectionAutomationsPayload[] = [];
  const writeResults: WriteCollectionAutomationsResult[] = [];
  const bridge = {
    listCollectionAutomations: vi.fn(async () => current),
    writeCollectionAutomations: vi.fn(async (payload: WriteCollectionAutomationsPayload) => {
      written.push(payload);
      const result = writeResults.shift() ?? { status: "written" as const, contentHash: "b".repeat(64) };
      if (result.status === "written") {
        let automations = payload.automations;
        if (options.roundTripWrites) {
          const written = writeAutomationsFile(automations.map((automation) => ({ status: "valid", automation })));
          if (written.status !== "ok") throw new Error("Fixture automation could not be written");
          const parsed = parseAutomationsFile(written.text);
          if (parsed.status !== "read") throw new Error("Fixture automation could not be read");
          automations = parsed.entries.map((entry) => {
            if (entry.status !== "valid") throw new Error("Fixture automation is invalid after writing");
            return entry.automation;
          });
        }
        current = read(automations.map((automation) => summary(automation)));
      }
      return result;
    }),
    listCollectionAutomationRuns: vi.fn(async (_payload?: { before?: string }): Promise<ListCollectionAutomationRunsResult> => ({ status: "listed", runs, next: null })),
    getCollectionAutomationRun: vi.fn(async (): Promise<GetCollectionAutomationRunResult> => ({ status: "missing" })),
    listServerAutomationRuns: vi.fn(async (_payload?: { before?: string }): Promise<ListServerAutomationRunsResult> => ({ runs: options.serverRuns ?? null, next: null })),
    listAutomationHolds: vi.fn(async () => ({ holds: [], unreadable: holdsUnreadable })),
    resetAutomationHolds: vi.fn(async () => {
      holdsUnreadable = false;
      return { status: "reset" as const };
    }),
    revealAutomationHolds: vi.fn(async () => undefined),
    retryCollectionAutomation: vi.fn(async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued", press: false })),
    undoCollectionAutomationRun: vi.fn(async (): Promise<UndoCollectionAutomationRunResult> =>
      ({ ...NOTHING_UNDONE, reverted: 1, changedSince: 1 })),
    confirmCollectionAutomationStep: vi.fn(async () => ({ status: "confirmed" as const })),
    listAutomationTargets: vi.fn(async (): Promise<ListAutomationTargetsResult> => ({ collections: [
      { kind: "document", path: "Tasks", name: "Tasks", stopped: null, findStopped: null },
      { kind: "document", path: "Log", name: "Log", stopped: null, findStopped: null },
      { kind: "document", path: "Budget", name: "Budget", stopped: "ana@dohc.test cannot edit Budget.", findStopped: null },
    ] })),
    getCollection: vi.fn(async ({ collectionPath }: { collectionPath: string }) => ({
      path: collectionPath, status: "valid", reasons: [], recordCount: 0,
      schema: { name: null, description: null, views: [], fields: collectionPath === "Log" ? [{ name: "Entry", type: "text" }] : [] },
    })),
    // Main's check, for real: the file contract's writer and the formula parser.
    checkCollectionAutomation: vi.fn(async ({ automation }: { automation: Automation }) => {
      const written = writeAutomationsFile([{ status: "valid", automation }]);
      return {
        diagnostics: written.status === "refused" ? written.diagnostics : [],
        formulaProblems: formulaProblems(automation),
        findProblems: [] as Array<{ path: string; problem: string }>,
        cannotRun: null as string | null,
        missingFiles: [] as string[],
      };
    }),
    onWorkspaceActivity: vi.fn((_listener: (event: { workspaceId?: string }) => void) => () => undefined),
    onAutomationRunsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      failureListeners.push(listener);
      return () => undefined;
    }),
    onAutomationHoldsChanged: vi.fn((_listener: (event: { workspaceId: string }) => void) => () => undefined),
    onCollectionAutomationsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    }),
    readScheduleHost: vi.fn(async (_payload: { workspaceId: string }): Promise<ScheduleHostResult> => ({ kind: "this-computer" })),
    onScheduleHostChanged: vi.fn((listener: (workspaceId: string) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    }),
    onCloudSessionChanged: vi.fn(() => () => undefined),
    createWorkspaceFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({ relativePath })),
    listAutomationGroups: vi.fn(async (): Promise<ListAutomationGroupsResult> => ({ groups: [] })),
    listAutomationPeople: vi.fn(async (): Promise<ListAutomationPeopleResult> => ({ status: "listed", people: [] })),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  // Another writer changes the file; the panel reads it again, as it does
  // when a run settles.
  const replaceFile = (next: ListCollectionAutomationsResult) => {
    current = next;
    for (const listener of failureListeners) listener({ workspaceId: "ws-1" });
  };
  // Main says this workspace's automations changed, as after a hand edit.
  const automationsChanged = (workspaceId: string) => {
    for (const listener of changeListeners) listener({ workspaceId });
  };
  // Main says which computer runs schedules changed, as after a handover.
  const hostChanged = (workspaceId: string) => {
    for (const listener of hostListeners) listener(workspaceId);
  };
  return { bridge, written, writeResults, replaceFile, hostChanged, automationsChanged };
}

const ignoreError = () => undefined;

function Panel(props: {
  workspaceId?: string;
  table?: AutomationTable;
  onRunUndone?: () => void;
  fields?: FieldDefinition[];
  focus?: AutomationFocus | null;
  onNotice?: (message: string, undo?: () => void) => void;
  onError?: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onOpenFile?: (path: string) => void;
  onOpenScheduleSettings?: () => void;
  onOpenFields?: () => void;
  closeAsk?: number;
  onClose?: () => void;
  start?: { automation: Automation; seq: number } | null;
  onStarted?: () => void;
}) {
  // The shell passes one handler for the page's life; a new one each render would read the file again each render.
  const onError = props.onError ?? ignoreError;
  const workspaceId = props.workspaceId ?? "ws-1";
  const automations = useCollectionAutomations(workspaceId, "Tasks", onError);
  return (
    <AutomationsPanel
      workspaceId={workspaceId}
      collectionPath="Tasks"
      table={props.table}
      onRunUndone={props.onRunUndone}
      automations={automations}
      fields={props.fields ?? FIELDS}
      focus={props.focus ?? null}
      start={props.start ?? null}
      onStarted={props.onStarted}
      closeAsk={props.closeAsk ?? 0}
      onClose={props.onClose ?? (() => undefined)}
      onOpenFile={props.onOpenFile ?? (() => undefined)}
      onOpenScheduleSettings={props.onOpenScheduleSettings ?? (() => undefined)}
      onOpenFields={props.onOpenFields}
      onError={onError}
      onNotice={props.onNotice ?? (() => undefined)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A test that ends with a changed draft leaves it kept, as a panel does.
  resetKeptAutomationDraftsForTests();
});

describe("the ⚡ panel", () => {
  it("duplicates switched off beside the original, and deletes with an Undo that puts it back", async () => {
    const { written } = makeBridge(read([summary(stamp), summary(nudge)]));
    const onNotice = vi.fn();
    render(<Panel onNotice={onNotice} />);
    const row = await screen.findByTestId("automation-stamp");

    // The row menu works from the keyboard.
    within(row).getByRole("button", { name: "Stamp the finish date actions" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement?.textContent).toBe("Edit");
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("Delete");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Edit");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    expect(document.activeElement?.textContent).toBe("Duplicate");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations.map((automation) => [automation.id, automation.name, automation.enabled])).toEqual([
      ["stamp", "Stamp the finish date", true],
      ["stamp-copy", "Stamp the finish date copy", false],
      ["nudge", "Nudge the owner", true],
    ]);
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: "Stamp the finish date actions" }));

    await userEvent.click(within(await screen.findByTestId("automation-stamp-copy")).getByRole("button", { name: /actions/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Deleted "Stamp the finish date copy"', expect.any(Function)));
    expect(written[1]!.automations.map((automation) => automation.id)).toEqual(["stamp", "nudge"]);
    // The deleted row held focus; the next automation's switch has it now.
    expect(document.activeElement).toBe(within(screen.getByTestId("automation-nudge")).getByRole("switch"));

    // The notice's Undo reads the file again itself: it outlives the panel.
    (onNotice.mock.calls[0]![1] as () => void)();
    await waitFor(() => expect(written).toHaveLength(3));
    expect(written[2]!.automations.map((automation) => automation.id)).toEqual(["stamp", "stamp-copy", "nudge"]);
  });

  it("changes nothing when a save or an Undo answers after the workspace changed", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "done", atMs: Date.now() } })]), [
      run({ writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Note", before: "a", after: "b" }] }),
    ]);
    let answerWrite: (result: WriteCollectionAutomationsResult) => void = () => undefined;
    bridge.writeCollectionAutomations.mockImplementationOnce(() => new Promise((resolve) => { answerWrite = resolve; }));
    let answerUndo: (result: UndoCollectionAutomationRunResult) => void = () => undefined;
    bridge.undoCollectionAutomationRun.mockImplementationOnce(() => new Promise((resolve) => { answerUndo = resolve; }));
    const onError = vi.fn();
    const onNotice = vi.fn();
    const { rerender } = render(<Panel onError={onError} onNotice={onNotice} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    await userEvent.click(screen.getByRole("button", { name: /^Runs\. The last run finished/ }));
    await userEvent.click(within(await screen.findByTestId("automation-run-atc_1")).getByRole("button", { name: "Undo" }));

    rerender(<Panel workspaceId="ws-2" onError={onError} onNotice={onNotice} />);
    answerWrite({ status: "reformats" });
    answerUndo({ ...NOTHING_UNDONE, reverted: 1 });
    await waitFor(() => expect(bridge.listCollectionAutomations).toHaveBeenCalledWith({ workspaceId: "ws-2", collectionPath: "Tasks" }));
    expect(screen.queryByTestId("automations-reformat")).toBeNull();
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("says an automation waits to check who can edit, and lets a person allow a held step", async () => {
    const held = summary(nudge, {
      automationId: "collection:Tasks#nudge",
      reach: { kind: "checked", steps: [{ verdict: "held", step: "operation:invoices.edit", stoppedFor: "bob@dohc.test", fileUnread: false, seq: 7, target: "Budget", action: "change" }] },
    });
    const { bridge } = makeBridge(read([
      summary(stamp, { reach: { kind: "waiting", reason: "dohc could not check who can edit Tasks. Try again later." } }),
      held,
    ]));
    render(<Panel />);
    expect(await screen.findByText("Waiting to check who can edit Tasks.")).toBeTruthy();
    const row = screen.getByTestId("automation-nudge");
    expect(row.textContent).toContain("A step can now change Budget. It stopped before because bob@dohc.test could not.");
    await userEvent.click(within(row).getByRole("button", { name: "Allow" }));
    expect(bridge.confirmCollectionAutomationStep).toHaveBeenCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#nudge", definitionHash: "0123456789abcdef", step: "operation:invoices.edit", seq: 7, onServer: false,
    });
  });
});

describe("the builder's triggers", () => {
  const options = (name: string) =>
    within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);
  it("watches another table of the dataset with that table's fields and buttons, and keeps a draft a button started", async () => {
    const REFUND_FIELDS: FieldDefinition[] = [{ name: "Amount", type: "number" }, { name: "Refund", type: "button" }];
    const table: AutomationTable = {
      name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS)], ["Refunds", datasetTable(REFUND_FIELDS)]]),
      actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: true }],
    };
    const { written } = makeBridge(read([]));
    const user = userEvent.setup();
    const draft: Automation = { id: "", name: "Settle", enabled: true, when: { kind: "button", field: "Settle", table: "Invoices" }, if: null,
      do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [{ key: "id", value: { kind: "formula", expression: "record.id" } }] }] };
    render(<Panel table={table} fields={[...FIELDS, { name: "Settle", type: "button" }]} start={{ automation: draft, seq: 1 }} />);
    expect((await screen.findByRole("combobox", { name: "Trigger" }) as HTMLSelectElement).value).toBe("button");
    expect((screen.getByRole("combobox", { name: "Table" }) as HTMLSelectElement).value).toBe("Invoices");
    expect((screen.getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value).toBe("invoices.settle");

    await user.selectOptions(screen.getByRole("combobox", { name: "Table" }), "Refunds");
    expect(screen.getByText("Settle is not a field in Refunds.")).toBeTruthy();
    expect(options("Button")).toEqual(["Settle", "Refund"]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const button = screen.getByRole("combobox", { name: "Button" });
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Settle is not a button in Refunds. Choose a button.");
    expect(screen.queryByText("Settle is not a field in Refunds.")).toBeNull();
    expect(written).toEqual([]);
    await user.selectOptions(button, "Refund");
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "field-changed");
    expect(options("Field that changes")).toEqual(["Amount"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition" }), "rows");
    expect(options("Condition 1, field")).toEqual(["Amount"]);
    await user.type(screen.getByRole("textbox", { name: "Condition 1, value" }), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]).toMatchObject({
      when: { kind: "field-changed", field: "Amount", to: null, table: "Refunds" },
      if: "record.Amount == 5",
      do: draft.do,
    });
  }, 30_000);
});

describe("the builder's steps in other Collections", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const options = (name: string) =>
    [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options].map((option) => [option.textContent, option.disabled]);
  const LEDGER_ID = "00000000-0000-4000-8000-000000000301";
  const PAYEES_STOPPED = "ana@dohc.test cannot use payees.create in Ledger.";
  const VOID_STOPPED = "ana@dohc.test cannot use entries.void in Ledger.";
  type Target = Extract<ListAutomationTargetsResult, { collections: unknown }>["collections"][number];
  const LEDGER: Target = {
    kind: "dataset", path: "Ledger", name: "Ledger", datasetId: LEDGER_ID, stopped: null, findStopped: null, editStopped: null, actionsStopped: null,
    operations: [
      { name: "entries.list", kind: "read", stopped: null },
      { name: "entries.create", kind: "create", stopped: null },
      { name: "entries.edit", kind: "edit", stopped: null },
      { name: "payees.create", kind: "create", stopped: PAYEES_STOPPED },
      { name: "entries.post", kind: "action", stopped: null },
      { name: "entries.void", kind: "action", stopped: VOID_STOPPED },
    ],
  };
  const operation = (operationId: string, name: string, tableId: string, kind: DatasetOperation["kind"], fieldIds: string[], extra: Partial<DatasetOperation> = {}): DatasetOperation =>
    ({ operationId, name, label: name, tableId, kind, access: "helper", readOnly: kind === "read", fieldIds, ...extra });
  const LEDGER_DATASET: DatasetDescription = {
    datasetId: LEDGER_ID, name: "Ledger", revision: 1, revisionSha256: "c".repeat(64),
    tables: [
      { tableId: "entries", name: "Entries", fields: [
        { fieldId: "memo", name: "Memo", type: "text", required: false, unique: false },
        { fieldId: "amount", name: "Amount", type: "number", required: false, unique: false },
      ] },
      { tableId: "payees", name: "Payees", fields: [{ fieldId: "payee", name: "Payee", type: "text", required: true, unique: true }] },
    ],
    operations: [
      operation("o1", "entries.list", "entries", "read", ["memo", "amount"]),
      operation("o2", "entries.create", "entries", "create", ["memo", "amount"]),
      operation("o3", "entries.edit", "entries", "edit", ["memo", "amount"]),
      operation("o4", "payees.create", "payees", "create", ["payee"]),
      operation("o5", "entries.post", "entries", "action", ["amount"], { label: "Post", reversedBy: "entries.void" }),
      operation("o6", "entries.void", "entries", "action", ["amount"], { label: "Void" }),
    ],
  };
  const DOCUMENTS: Target[] = [
    { kind: "document", path: "Tasks", name: "Tasks", stopped: null, findStopped: null },
    { kind: "document", path: "Log", name: "Log", stopped: null, findStopped: null },
  ];
  /** A bridge whose main lists Ledger, a dataset dohc describes as LEDGER_DATASET. */
  function ledgerBridge(file: ListCollectionAutomationsResult, targets: Target[] = [...DOCUMENTS, LEDGER]) {
    const made = makeBridge(file);
    made.bridge.listAutomationTargets.mockResolvedValue({ collections: targets });
    const dataset = vi.fn(async (_payload: { workspaceId: string; datasetPath: string; expectedDatasetId: string; action: "describe" }) =>
      ({ kind: "description" as const, dataset: LEDGER_DATASET }));
    return { ...made, bridge: Object.assign(made.bridge, { dataset }) };
  }

  it("adds a record to a table of another dataset, offering a table the step cannot reach disabled, with why", async () => {
    const { bridge, written } = ledgerBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    await waitFor(() => expect(options("Step 2, Collection")).toEqual([["Tasks", false], ["Log", false], ["Ledger", false]]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, Collection" }), "Ledger");
    // Ledger has two tables, so the step names one. Payees' only way to add records is out of reach.
    const table = await screen.findByRole("combobox", { name: "Step 2, table" });
    expect(options("Step 2, table")).toEqual([["Choose a table", true], ["Entries", false], [`Payees (${PAYEES_STOPPED})`, true]]);
    expect(bridge.dataset).toHaveBeenCalledWith({ workspaceId: "ws-1", datasetPath: "Ledger/dataset.json", expectedDatasetId: LEDGER_ID, action: "describe" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(table), SLOW);
    expect(screen.getByText("Choose a table.")).toBeTruthy();
    await user.selectOptions(table, "Entries");
    expect(options("Step 2, field 1").map(([name]) => name)).toEqual(["Choose a field", "Memo", "Amount"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Amount");
    await user.type(screen.getByRole("textbox", { name: "Step 2, Amount" }), "12");
    // Entries has no delete, so Undo keeps what the step adds.
    expect(within(screen.getByTestId("builder-step-1")).getByText(/Undo keeps the records this step adds\. Entries has no delete action/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    // Choosing the table names its operation; main pins the one that fits the step's fields when it saves.
    expect(written[0]!.automations[0]!.do[1]).toEqual({
      kind: "add-record", values: [{ field: "Amount", value: { kind: "literal", value: 12 } }], collection: "Ledger", as: null, operation: "entries.create",
    });
    expect(bridge.dataset).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("drops another workspace's answers about Collections and their tables", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "add-record", values: [{ field: "Amount", value: { kind: "literal", value: 1 } }], collection: "Ledger", as: null, operation: "entries.create" },
    ] };
    const { bridge } = ledgerBridge(read([summary(saved)]));
    let describeFirst: (result: { kind: "description"; dataset: DatasetDescription }) => void = () => undefined;
    bridge.dataset.mockImplementationOnce(() => new Promise((resolve) => { describeFirst = resolve; }));
    let listSecond: (result: ListAutomationTargetsResult) => void = () => undefined;
    const onError = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledTimes(1));
    bridge.listAutomationTargets.mockImplementationOnce(() => new Promise((resolve) => { listSecond = resolve; }));
    rerender(<Panel workspaceId="ws-2" onError={onError} />);
    await waitFor(() => expect(bridge.listAutomationTargets).toHaveBeenCalledWith({ workspaceId: "ws-2", collectionPath: "Tasks" }));
    // ws-1's description arrives after the switch: ws-2 has not said what Ledger is, so the step stays its sentence.
    await act(async () => describeFirst({ kind: "description", dataset: LEDGER_DATASET }));
    const step = screen.getByTestId("builder-step-0");
    expect(within(step).queryByRole("combobox")).toBeNull();
    // ws-2's own answer describes Ledger again, for ws-2.
    await act(async () => listSecond({ collections: [...DOCUMENTS, LEDGER] }));
    expect(await within(step).findByRole("combobox", { name: "Step 1, Collection" })).toBeTruthy();
    expect(bridge.dataset).toHaveBeenLastCalledWith({ workspaceId: "ws-2", datasetPath: "Ledger/dataset.json", expectedDatasetId: LEDGER_ID, action: "describe" });
    expect(onError).not.toHaveBeenCalled();
  }, 30_000);
});

describe("the builder's people", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const TO_YOU = "A direct message goes to another person. To reach yourself, use Notify.";
  const NO_DM_BOB = "There is no direct message with bob@dohc.test yet. Start one first: automations never start one.";
  const PEOPLE = [
    { userId: "user-owner", name: "you", you: true, dmStopped: TO_YOU, noticeStopped: null },
    { userId: "user-ana", name: "ana@dohc.test", you: false, dmStopped: null, noticeStopped: "ana@dohc.test cannot view Tasks." },
    { userId: "user-bob", name: "bob@dohc.test", you: false, dmStopped: NO_DM_BOB, noticeStopped: null },
  ];
  it("keeps another person's agent step as theirs with its verdict, and edits your own", async () => {
    const actsAsAna = "This step acts as ana@dohc.test, and you can also edit Tasks.";
    const wakes: Automation = { ...stamp, do: [
      { kind: "wake-agent", text: "Plan the trip", person: "user-ana" },
      { kind: "wake-agent", text: "Plan mine", person: "user-owner" },
      // Someone main does not list, who could be you by an account this computer does not know.
      { kind: "wake-agent", text: "Plan theirs", person: "user-unknown" },
    ] };
    const { bridge, written } = makeBridge(read([summary(wakes, { reach: { kind: "checked", steps: [
      { verdict: "stopped", reason: actsAsAna }, { verdict: "allowed" }, { verdict: "allowed" },
    ] } })]));
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: PEOPLE });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const theirs = screen.getByTestId("builder-step-0");
    const whose = "This step wakes ana@dohc.test's agent and acts as them, so you cannot change its message here.";
    expect(await within(theirs).findByText(whose)).toBeTruthy();
    expect(theirs.textContent).toContain("Wake an agent");
    expect(theirs.textContent).toContain("Plan the trip");
    expect(within(theirs).getByText(actsAsAna)).toBeTruthy();
    expect(within(theirs).getByLabelText("Someone else's step")).toBeTruthy();
    expect(within(theirs).queryByRole("textbox")).toBeNull();
    // Your own, named by your account, edits as in a workspace never shared.
    expect(screen.getByTestId("builder-step-1").textContent).toContain("Wake your agent");
    // A new one is offered only where steps can name you without an account.
    expect(screen.queryByRole("button", { name: "Wake your agent" })).toBeNull();
    const unknown = screen.getByTestId("builder-step-2");
    expect(within(unknown).getByText("dohc cannot tell whose agent this step wakes, so you cannot change its message here.")).toBeTruthy();
    // The icon says so too, for a screen reader.
    expect(within(unknown).getByLabelText("dohc cannot tell whose step this is")).toBeTruthy();
    expect(within(unknown).queryByLabelText("Someone else's step")).toBeNull();
    expect(within(unknown).queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Move step 1 down" }));
    // Moved, it keeps its verdict and stays theirs.
    const moved = screen.getByTestId("builder-step-1");
    expect(within(moved).getByText(actsAsAna)).toBeTruthy();
    expect(within(moved).getByText(whose)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Step 1, message" }), " today");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ ...wakes.do[1], text: "Plan mine today" }, wakes.do[0], wakes.do[2]]);
  }, 30_000);
});

describe("an automation's runs", () => {
  const failed = run({
    claimId: "atc_failed", state: "failed", error: "ana@dohc.test cannot edit Budget",
    writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Finished on", before: null, after: "2026-09-25" }],
  });
  const stopped = run({ claimId: "atc_stopped", state: "failed", error: "chain-stopped", neverStarted: true, chainStopped: true });
  const TOO_LARGE = "This change was too large for dohc to start automations for every record. Change fewer records at a time.";
  const unclaimed = run({ claimId: "atc_unclaimed", state: "failed", error: TOO_LARGE, neverStarted: true });

  it("opens from a notice, offers Try again except for a run that never started, and confirms a changed automation first", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "failed", atMs: Date.now() } })]), [failed, stopped, unclaimed]);
    bridge.retryCollectionAutomation.mockResolvedValueOnce({ status: "definition-changed", repeatsMessages: false });
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);

    const failedRow = await screen.findByTestId("automation-run-atc_failed");
    expect(failedRow.textContent).toContain("ana@dohc.test cannot edit Budget.");
    expect(within(screen.getByTestId("automation-run-atc_stopped")).queryByRole("button", { name: "Try again" })).toBeNull();
    // A change too large to claim keeps its own reason, and none can start it.
    const unclaimedRow = screen.getByTestId("automation-run-atc_unclaimed");
    expect(unclaimedRow.textContent).toContain(TOO_LARGE);
    expect(within(unclaimedRow).queryByRole("button", { name: "Try again" })).toBeNull();

    await userEvent.click(within(failedRow).getByRole("button", { name: "Try again" }));
    expect(bridge.retryCollectionAutomation).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_failed", startOver: false, onServer: false,
    });
    expect((await screen.findByTestId("automation-start-over")).textContent).toContain(START_OVER_SENTENCE);
    await userEvent.click(screen.getByTestId("automation-start-over-confirm"));
    await waitFor(() => expect(bridge.retryCollectionAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({ claimId: "atc_failed", startOver: true }),
    ));
  });

  it("reports a pending reversal and keeps Undo available after host refusal", async () => {
    const pending = run({undoSettlementPending: true, undone: true,
      reversals: [{recordId: "rec_1", path: "Tasks/Plan.md", field: "Note", state: "pending"}],
      writes: [{kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Note", before: "a", after: "b", sharedFileUpdateState: "settled"}]});
    const {bridge} = makeBridge(read([summary(stamp)]), [pending]);
    const draft = {outboxId: "outbox", appendKey: "reverse/Note", nativeHeadSequence: 2,
      binding: {workspaceId: "ws-1", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
        currentPath: "Tasks/Plan.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0}};
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({...NOTHING_UNDONE, sharedReversals: [{recordId: "rec_1", field: "Note", draft, state: "pending"}]});
    const onNotice = vi.fn();
    const onError = vi.fn();
    render(<AutomationRuns workspaceId="ws-1" automationId="collection:Tasks#stamp" refreshKey={0} onRetry={vi.fn()} onError={onError} onNotice={onNotice} />);
    const row = await screen.findByTestId("automation-run-atc_1");
    expect(within(row).getByRole("status").textContent).toContain("Reversal saved on this computer.");
    expect(within(row).queryByLabelText("Undone")).toBeNull();
    await userEvent.click(within(row).getByRole("button", {name: "Show 1 change"}));
    expect(row.textContent).toContain("Note: a → b · Accepted by the shared host");
    expect(row.textContent).toContain("Undo · Plan · Note · Awaiting the shared host");
    expect(within(row).queryByRole("button", {name: "Undo"})).toBeNull();
    expect(row.textContent).not.toContain("Reopen History");
    bridge.listCollectionAutomationRuns.mockResolvedValue({status: "listed", runs: [{...pending, undone: false, undoSettlementPending: false, undoSettlementNotAccepted: true}], next: null});
    act(() => bridge.onWorkspaceActivity.mock.calls[0]![0]({workspaceId: "ws-1"}));
    await waitFor(() => expect(within(row).getByRole("status").textContent).toContain("Try Undo again."));
    expect(within(row).getByLabelText("Not accepted")).toBeTruthy();
    expect(within(row).queryByLabelText("Undone")).toBeNull();
    expect(within(row).getByRole("button", {name: "Undo"})).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])("confirms dataset deletes and sends the choice to the run's host (server: %s)", async (onServer) => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    const added = (recordId: string) => ({ kind: "dataset-created" as const, rules, operationId: "create", tableId: "table-1", recordId, version: 1, deletes: ["delete", "archive"] });
    const rows = [run({ writes: [added("invoice-2"), added("invoice-3")] })];
    const { bridge } = makeBridge(read([summary(stamp)]), onServer ? [] : rows, { serverRuns: onServer ? rows : null });
    bridge.undoCollectionAutomationRun
      .mockResolvedValueOnce({ status: "confirm", preview: {
        deletes: 2, unchecked: 1, kept: 1, keptChanged: 1, gone: 1, reverts: 0, irreversible: 0, reverses: 1, actions: 0, token: "preview-1",
        choices: [{ key: "invoices-deletes", table: "Invoices", records: 2, operations: [{ operationId: "delete", label: "Delete" }, { operationId: "archive", label: "Archive" }] }],
      } })
      .mockResolvedValueOnce({ ...NOTHING_UNDONE, deleted: 1, keptChanged: 1, gone: 1 });
    const onNotice = vi.fn();
    const user = userEvent.setup();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} onNotice={onNotice} />);
    await user.click(within(await screen.findByTestId(`automation-run-${onServer ? "server-" : ""}atc_1`)).getByRole("button", { name: "Undo" }));
    const dialog = await screen.findByRole("dialog", { name: "Undo this run?" });
    expect([...dialog.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "Undo will reverse 1 action.",
      "Undo will delete 2 added records.",
      "Undo will try to delete 1 added record that dohc could not check. Any that someone changed will stay.",
      "A record or field someone else changed stays as they left it.",
      "1 added record will stay. This Collection has no delete action available to the automation.",
      "1 added record will stay because someone changed it.",
      "1 added record is already gone.",
      "You cannot undo these deletions in dohc.",
    ]);
    const confirm = within(dialog).getByRole("button", { name: "Undo and delete 3 records" });
    expect(confirm.matches(":disabled")).toBe(true);
    await user.click(within(dialog).getByRole("radio", { name: "Archive" }));
    await user.click(confirm);
    expect(bridge.undoCollectionAutomationRun).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_1", onServer, deletes: { token: "preview-1", chosen: [{ key: "invoices-deletes", operationId: "archive" }] },
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      "Deleted 1 added record. 1 added record stays because someone changed it. 1 added record was already gone.",
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never shows one automation's server runs under another", async () => {
    const onServer = run({ ...failed, claimId: "atc_server" });
    const { bridge } = makeBridge(read([summary(stamp), summary(nudge, { automationId: "collection:Tasks#nudge" })]), [], { serverRuns: [onServer] });
    const { rerender } = render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    expect(await screen.findByTestId("automation-run-server-atc_server")).toBeTruthy();
    bridge.listServerAutomationRuns.mockRejectedValue(new Error("Your server answered with 500."));
    rerender(<Panel focus={{ automationId: "collection:Tasks#nudge", run: null, seq: 2 }} />);
    expect(await screen.findByText("This automation has not run on this computer yet.")).toBeTruthy();
    expect(screen.queryByTestId("automation-run-server-atc_server")).toBeNull();
  });
});

describe("the builder", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));

  it("does not save over a change someone else made while editing, and replaces it on the next Save", async () => {
    const { written, replaceFile } = makeBridge(read([summary(stamp), summary(nudge)]));
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");

    replaceFile(read([summary({ ...stamp, enabled: false }), summary(nudge)]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      '"Stamp the finish date!" changed in automations.yaml while you were editing, so dohc did not save. Save again to replace it with yours.',
      null,
    ));
    expect(written).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations.map((automation) => automation.name)).toEqual(["Stamp the finish date!", "Nudge the owner"]);
  });

  it("asks before Back, Cancel, or a notice drops changes, and saves or discards as the person chooses", async () => {
    const { written } = makeBridge(read([summary(stamp)]), [run({})]);
    const user = userEvent.setup();
    const { rerender } = render(<Panel />);
    await openBuilder(user);
    // Nothing changed, so Back needs no question.
    await user.click(screen.getByRole("button", { name: "Back to automations" }));
    await openBuilder(user);

    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Back to automations" }));
    await user.click(within(screen.getByTestId("automation-unsaved")).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Stamp the finish date!");

    // A notice asks to open runs: the builder asks too, and stays open.
    rerender(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    expect(await screen.findByTestId("automation-unsaved")).toBeTruthy();
    await user.click(within(screen.getByTestId("automation-unsaved")).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(screen.getByTestId("automation-unsaved")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.name).toBe("Stamp the finish date!");
    expect(await screen.findByTestId("automation-stamp")).toBeTruthy();

    await openBuilder(user, "Stamp the finish date!");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "?");
    await user.click(screen.getByRole("button", { name: "Back to automations" }));
    await user.click(within(screen.getByTestId("automation-unsaved")).getByRole("button", { name: "Discard" }));
    expect(await screen.findByTestId("automation-stamp")).toBeTruthy();
    expect(written).toHaveLength(1);
  });

  // Steps 1 to 15 in reading order: an If whose Do holds steps 2 to 4 and
  // whose Otherwise holds 5 and 6, then every other kind of step.
  const title = (value: string) => [{ field: "Title", value: { kind: "literal" as const, value } }];
  const everyKind: Automation = { ...stamp, id: "every", name: "Every kind", do: [
    { kind: "if", if: "record.Points > 1", do: [
      { kind: "set", values: title("A"), records: null, operation: null },
      { kind: "find", condition: 'record.Status == "Doing"', collection: null, as: "open", operation: null },
      { kind: "set", values: title("B"), records: "open", operation: null },
    ], otherwise: [
      { kind: "set", values: title("C"), records: null, operation: null },
      { kind: "invoke", collection: null, operation: "tasks.close", input: [{ key: "id", value: { kind: "formula", expression: "record.id" } }] },
    ] },
    { kind: "notify", text: "Done: {record.Title}", to: [{ kind: "literal", value: "ana" }] },
    { kind: "post", text: "Done", group: "Trip" },
    { kind: "direct-message", text: "Done", to: [{ kind: "literal", value: "ana" }] },
    { kind: "wake-agent", text: "Look", person: "owner" },
    { kind: "run", code: "return 1;", as: "one" },
    { kind: "run-file", file: "scripts/two.js", as: null },
    { kind: "add-record", values: [{ field: "Entry", value: { kind: "literal", value: "x" } }], collection: "Log", as: "added", operation: null },
    { kind: "find", condition: "true", collection: null, as: "all", operation: null },
    // A number field's text the file wrote stays text until someone edits it.
    { kind: "set", values: [{ field: "Points", value: { kind: "literal", value: "001" } }], records: null, operation: null },
  ] };

  it("saves every kind of step as the file wrote it, and shows each nested step's own reach", async () => {
    // Reach places run depth first: 2, 3, 4, and 5 inside the If, then notify to ana, post, message to ana, wake, add, find.
    const places = ["allowed", "allowed", "allowed", "stopped", "allowed", "allowed", "allowed", "allowed", "allowed", "allowed"] as const;
    const { written } = makeBridge(read([summary(everyKind, { reach: { kind: "checked", steps: places.map((verdict) =>
      verdict === "stopped" ? { verdict, reason: "ana@dohc.test cannot edit Tasks." } : { verdict }) } })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Every kind");
    expect(screen.getByTestId("builder-step-4").textContent).toContain("ana@dohc.test cannot edit Tasks.");
    expect(screen.getByTestId("builder-step-1").textContent).not.toContain("cannot edit");
    expect(screen.getByRole("group", { name: "Step 1, Otherwise" })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(everyKind.do);
  }, 30_000);

  it.each(["new"])("keeps a newer %s draft after retrying an older save, then saves it against the acknowledged version", async (kind) => {
    const { bridge, written } = makeBridge(
      kind === "new" ? { status: "missing" } : read([summary(stamp)]), [], { roundTripWrites: true },
    );
    bridge.writeCollectionAutomations.mockRejectedValueOnce(new Error("Write unavailable"));
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    if (kind === "new") await user.click(await screen.findByRole("button", { name: "New automation" }));
    else await openBuilder(user);
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Draft A");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "dohc could not save automations.yaml.", expect.any(Error), expect.any(Function),
    ));
    const tryAgain = onError.mock.calls[0]![2] as () => void;
    await waitFor(() => expect(name.matches(":disabled")).toBe(false));
    await user.clear(name);
    await user.type(name, "Draft B");
    await user.selectOptions(screen.getByRole("combobox", { name: "Changes to" }), "Doing");

    await act(async () => tryAgain());
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.name).toBe("Draft A");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" }).matches(":disabled")).toBe(false));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Draft B");
    expect(within(screen.getByTestId("collection-automations-panel")).getByText("Draft A")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2));
    expect(written[1]!.automations[0]!.name).toBe("Draft B");
    expect(written[1]!.automations[0]!.when).toMatchObject({ to: { kind: "literal", value: "Doing" } });
    expect(written[1]!.automations).toHaveLength(1);
    expect(written[1]!.automations[0]!.id).toBe(written[0]!.automations[0]!.id);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
