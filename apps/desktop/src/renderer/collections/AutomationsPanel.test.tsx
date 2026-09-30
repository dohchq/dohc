// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  GetCollectionAutomationRunResult,
  ListCollectionAutomationRunsResult,
  ListServerAutomationRunsResult,
  ListCollectionAutomationsResult,
  ListAutomationGroupsResult,
  ListAutomationPeopleResult,
  ListAutomationTargetsResult,
  RetryCollectionAutomationResult,
  ScheduleHostComputer,
  ScheduleHostResult,
  UndoCollectionAutomationRunResult,
  WriteCollectionAutomationsPayload,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import type { DatasetDescription, DatasetOperation } from "@dohc/security-contract/dataset";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { parseAutomationsFile, writeAutomationsFile } from "@dohc/workspace-contracts/automations";
import { formulaProblems } from "@dohc/automation-executor/automation-plan";
import { automationCount, AutomationsPanel, resetKeptAutomationDraftsForTests, useCollectionAutomations } from "./AutomationsPanel";
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

function read(automations: ValidAutomationSummary[]): ListCollectionAutomationsResult {
  return { status: "read", contentHash: HASH, automations, addsStay: [] };
}

type Run = Extract<ListCollectionAutomationRunsResult, { status: "listed" }>["runs"][number];
const run = (overrides: Partial<Run>): Run => ({
  claimId: "atc_1", state: "done", error: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
  trigger: { kind: "changed", recordId: "rec_1", by: "human", sharedAuthor: null, depth: 0 }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undone: false, ...overrides,
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
        cannotRun: null as string | null,
        missingFiles: [] as string[],
      };
    }),
    onAutomationRunsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      failureListeners.push(listener);
      return () => undefined;
    }),
    onAutomationHoldsChanged: vi.fn((_listener: (event: { workspaceId: string }) => void) => () => undefined),
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
  // Main says which computer runs schedules changed, as after a handover.
  const hostChanged = (workspaceId: string) => {
    for (const listener of hostListeners) listener(workspaceId);
  };
  return { bridge, written, writeResults, replaceFile, hostChanged };
}

const ignoreError = () => undefined;

function Panel(props: {
  workspaceId?: string;
  table?: AutomationTable;
  onRunUndone?: () => void;
  fields?: FieldDefinition[];
  focus?: { automationId: string; run: string | null; seq: number } | null;
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
  it("lists each automation in plain words and saves its switch over the file it read", async () => {
    const { written } = makeBridge(read([summary(stamp), summary(nudge)]));
    render(<Panel />);
    const row = await screen.findByTestId("automation-stamp");
    expect(row.textContent).toContain("When Status becomes Done, set Finished on to today");

    await userEvent.click(within(row).getByRole("switch", { name: "Stamp the finish date" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({
      workspaceId: "ws-1", collectionPath: "Tasks", expectedContentHash: HASH, reformat: false,
      automations: [{ ...stamp, enabled: false }, nudge],
    });
    await waitFor(() => expect(within(screen.getByTestId("automation-stamp")).getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  });

  it("asks once before it lays out a file with comments, then saves with the person's agreement", async () => {
    const { written, writeResults } = makeBridge(read([summary(stamp)]));
    writeResults.push({ status: "reformats" });
    render(<Panel />);
    await userEvent.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    const dialog = await screen.findByTestId("automations-reformat");
    expect(dialog.textContent).toContain("so you lose its comments and hand formatting.");
    await userEvent.click(screen.getByTestId("automations-reformat-confirm"));
    await waitFor(() => expect(written).toHaveLength(2));
    expect(written[1]).toMatchObject({ reformat: true, automations: [{ ...stamp, enabled: false }] });
  });

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

  it("moves focus to Back when Runs opens, and back to the row's actions when it closes", async () => {
    makeBridge(read([summary(stamp), summary(nudge)]), [run({})]);
    const user = userEvent.setup();
    render(<Panel />);
    const row = await screen.findByTestId("automation-nudge");
    const actions = within(row).getByRole("button", { name: "Nudge the owner actions" });
    await user.click(actions);
    await user.click(screen.getByRole("menuitem", { name: "Runs" }));
    await screen.findByTestId("automation-runs");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to automations" }));
    await user.keyboard("{Enter}");
    await screen.findByTestId("automation-nudge");
    expect(document.activeElement).toBe(within(screen.getByTestId("automation-nudge")).getByRole("button", { name: "Nudge the owner actions" }));
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

  it("turns editing off and offers the file when an automation cannot be read", async () => {
    const { bridge } = makeBridge({
      status: "read", contentHash: HASH, addsStay: [],
      automations: [summary(stamp), { valid: false, id: "Broken", name: "Broken", diagnostics: [{ code: "invalid-id", path: "/automations/1/id" }] }],
    });
    const onOpenFile = vi.fn();
    render(<Panel onOpenFile={onOpenFile} />);
    expect((await screen.findByRole("switch", { name: "Stamp the finish date" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("dohc cannot read this automation, so it does not run.")).toBeTruthy();
    expect(screen.getByText("invalid-id at /automations/1/id")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("Tasks/automations.yaml");
    expect(bridge.writeCollectionAutomations).not.toHaveBeenCalled();
  });

  it("drops an Open folder failure that answers after the workspace changed", async () => {
    const { bridge } = makeBridge(read([summary(stamp)]), [], { holdsUnreadable: true });
    let fail: (error: unknown) => void = () => undefined;
    bridge.revealAutomationHolds.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject; }));
    const onError = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Panel onError={onError} />);
    await user.click(within(await screen.findByTestId("automation-holds-unreadable")).getByRole("button", { name: "Open folder" }));
    rerender(<Panel workspaceId="ws-2" onError={onError} />);
    await waitFor(() => expect(bridge.listCollectionAutomations).toHaveBeenCalledWith({ workspaceId: "ws-2", collectionPath: "Tasks" }));
    await act(async () => {
      fail(new Error("The folder is gone."));
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers Reset holds and Open folder when dohc cannot read which steps were allowed", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { reach: { kind: "waiting", reason: "" } })]), [], { holdsUnreadable: true });
    const user = userEvent.setup();
    render(<Panel />);
    const line = await screen.findByTestId("automation-holds-unreadable");
    expect(line.textContent).toContain("dohc cannot read .dohc/automations/reach.json");
    await user.click(within(line).getByRole("button", { name: "Open folder" }));
    expect(bridge.revealAutomationHolds).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    await user.click(within(line).getByRole("button", { name: "Reset holds" }));
    expect(bridge.resetAutomationHolds).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    await waitFor(() => expect(screen.queryByTestId("automation-holds-unreadable")).toBeNull());
  });

  it("says plainly when an automation names a field its Collection lacks", async () => {
    makeBridge(read([summary(stamp, { cannotRun: "Finished on is not a field in Tasks." })]));
    render(<Panel />);
    const row = await screen.findByTestId("automation-stamp");
    expect(row.textContent).toContain("Finished on is not a field in Tasks.");
    expect(within(row).getByLabelText("Does not run")).toBeTruthy();
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

  it("says a step waits because the automations file does not read in one version", async () => {
    makeBridge(read([summary(nudge, {
      automationId: "collection:Tasks#nudge",
      reach: { kind: "checked", steps: [{ verdict: "held", step: "0", stoppedFor: null, fileUnread: true, seq: 3, target: "Budget", action: "change" }] },
    })]));
    render(<Panel />);
    const row = await screen.findByTestId("automation-nudge");
    expect(row.textContent).toContain(
      "A step can change Budget. dohc cannot read the automations file in one version of the workspace. New steps here wait for you.",
    );
    expect(within(row).getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});

describe("a dataset table's ⚡ panel", () => {
  const onInvoices: Automation = { ...stamp, when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: "Invoices" } };
  const onRefunds: Automation = { ...nudge, id: "refund", name: "Log refunds", when: { kind: "record-added", table: "Refunds" } };
  const anyTable: Automation = { ...nudge, id: "any", name: "Any table" };
  const file = read([summary(onInvoices), summary(onRefunds), summary(anyTable)]);
  const INVOICES: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS, "invoices.create:create", "invoices.edit:edit")], ["Refunds", datasetTable([], "refunds.create:create")]]), actions: [] };
  const REFUNDS: AutomationTable = { ...INVOICES, name: "Refunds" };

  it("lists and counts the automations that watch this table or name none, and saves the whole file", async () => {
    const { written } = makeBridge(file);
    render(<Panel table={INVOICES} />);
    await screen.findByTestId("automation-stamp");
    expect(screen.getByTestId("automation-any")).toBeTruthy();
    expect(screen.queryByTestId("automation-refund")).toBeNull();
    expect(automationCount(file, INVOICES)).toBe(2);
    expect(automationCount(file, REFUNDS)).toBe(2);
    expect(automationCount(file)).toBe(3);

    await userEvent.click(within(screen.getByTestId("automation-stamp")).getByRole("switch"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations).toEqual([{ ...onInvoices, enabled: false }, onRefunds, anyTable]);
  });

  it("shows an automation whose table the dataset no longer has in every table, with why it does not run", async () => {
    const renamed: Automation = { ...nudge, id: "old", name: "Old table", when: { kind: "record-added", table: "Bills" } };
    const orphan = read([summary(renamed, { cannotRun: "Budget has no table named Bills." })]);
    makeBridge(orphan);
    render(<Panel table={REFUNDS} />);
    expect((await screen.findByTestId("automation-old")).textContent).toContain("Budget has no table named Bills.");
    expect(automationCount(orphan, INVOICES)).toBe(1);
    expect(automationCount(orphan, REFUNDS)).toBe(1);
  });

  it("starts a new automation on this table, adds records to the trigger's table, and lists the other Collections a step can use", async () => {
    const { bridge, written } = makeBridge(read([summary(onRefunds)]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "record-added");
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    const picker = screen.getByRole("combobox", { name: "Step 2, table" }) as HTMLSelectElement;
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Invoices", "Refunds"]);
    expect(picker.value).toBe("Invoices");
    // Another Collection is a choice too, and one no step can change is disabled, with why.
    const collection = screen.getByRole("combobox", { name: "Step 2, Collection" }) as HTMLSelectElement;
    await waitFor(() => expect([...collection.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["Tasks", false], ["Log", false], ["Budget (ana@dohc.test cannot edit Budget.)", true],
    ]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Title");
    await user.type(screen.getByRole("textbox", { name: "Step 2, Title" }), "Log");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations).toEqual([onRefunds, expect.objectContaining({ when: { kind: "record-added", table: "Invoices" } })]);
    expect(bridge.listAutomationTargets).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Tasks" });
  });

  it("runs an action on the record, with its id as input, says it can't be undone, and saves the step", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: false }, { name: "invoices.remind", label: "Remind", table: "Invoices", reversible: false }] };
    const { written } = makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.click(screen.getByRole("button", { name: "Run an action" }));
    const picker = screen.getByRole("combobox", { name: "Step 2, action" });
    expect(document.activeElement).toBe(picker);
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Settle", "Remind"]);
    expect(screen.getByText("Settle can't be undone.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Step 2, input 1 name" }) as HTMLInputElement).value).toBe("id");
    await user.selectOptions(picker, "invoices.remind");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    // A name the step already has, and an empty one, are problems to fix before Save.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name this input.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Step 2, input 2 name" }), "id");
    expect(await screen.findByText("id is in this step twice.")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Step 2, input 2 name" }));
    await user.type(screen.getByRole("textbox", { name: "Step 2, input 2 name" }), "note");
    await user.type(screen.getByRole("textbox", { name: "Step 2, note" }), "Due soon");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[1]).toEqual({ kind: "invoke", collection: null, operation: "invoices.remind", input: [
      { key: "id", value: { kind: "formula", expression: "record.id" } },
      { key: "note", value: { kind: "literal", value: "Due soon" } },
    ] });
  }, 30_000);

  it("keeps a saved action input's number as the file wrote it, shows it as a number, and keeps a typed today() in view", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: false }] };
    const saved: Automation = { ...onInvoices, id: "settle", name: "Settle it", do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [
      { key: "amount", value: { kind: "literal", value: 12 } },
      { key: "due", value: { kind: "formula", expression: "today()" } },
    ] }] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "Settle it" }));
    expect((screen.getByRole("combobox", { name: "Step 1, amount, kind" }) as HTMLSelectElement).value).toBe("number");
    expect((screen.getByRole("textbox", { name: "Step 1, amount" }) as HTMLInputElement).value).toBe("12");
    expect((screen.getByRole("textbox", { name: "Step 1, due, formula" }) as HTMLInputElement).value).toBe("today()");
    await user.type(screen.getByRole("textbox", { name: "Name" }), " now");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(saved.do);
  }, 30_000);

  it("shows the label and the can't be undone line for another table's action a step runs, and offers every table's, the trigger's first", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [
      { name: "invoices.settle", label: "Settle", table: "Invoices", reversible: false },
      { name: "refunds.issue", label: "Issue refund", table: "Refunds", reversible: false },
    ] };
    const saved: Automation = { ...onInvoices, id: "refund", name: "Refund it", do: [{ kind: "invoke", collection: null, operation: "refunds.issue", input: [] }] };
    makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "Refund it" }));
    const picker = screen.getByRole("combobox", { name: "Step 1, action" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Settle", "Issue refund (Refunds)"]);
    expect(screen.getByText("Issue refund can't be undone.")).toBeTruthy();
  }, 30_000);

  it("opens the builder on a draft the page asks for, says it took it, and gives Name focus", async () => {
    makeBridge(read([]));
    const onStarted = vi.fn();
    const draft: Automation = { id: "", name: "Settle", enabled: true, when: { kind: "button", field: "Settle", table: "Invoices" }, if: null,
      do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [{ key: "id", value: { kind: "formula", expression: "record.id" } }] }] };
    render(<Panel table={{ ...INVOICES, actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: false }] }}
      start={{ automation: draft, seq: 1 }} onStarted={onStarted} />);
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    const name = await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Settle");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect((screen.getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value).toBe("invoices.settle");
  });

  it("asks before Back drops the steps a page filled in, and a new panel does not take a request it already took", async () => {
    makeBridge(read([]));
    const user = userEvent.setup();
    const draft: Automation = { id: "", name: "Settle", enabled: true, when: { kind: "button", field: "Settle", table: "Invoices" }, if: null,
      do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [{ key: "id", value: { kind: "formula", expression: "record.id" } }] }] };
    const table = { ...INVOICES, actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: false }] };
    let start: { automation: Automation; seq: number } | null = { automation: draft, seq: 1 };
    const { rerender, unmount } = render(<Panel table={table} start={start} onStarted={() => { start = null; }} />);
    await screen.findByRole("combobox", { name: "Step 1, action" });
    await user.click(screen.getByRole("button", { name: "Back to automations" }));
    expect(await screen.findByTestId("automation-unsaved")).toBeTruthy();
    await user.click(within(screen.getByTestId("automation-unsaved")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull());
    // The page forgot the request it saw taken, so a panel that mounts again shows the list.
    rerender(<Panel table={table} start={start} onStarted={() => { start = null; }} />);
    unmount();
    render(<Panel table={table} start={start} />);
    expect(await screen.findByRole("button", { name: "New automation" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("keeps each action input's kind, asks for a number where one is typed, and saves it as a number", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [{ name: "invoices.settle", label: "Settle", table: "Invoices", reversible: true }] };
    const saved: Automation = { ...onInvoices, id: "settle", name: "Settle it", do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [
      { key: "amount", value: { kind: "literal", value: 3 } },
      { key: "paid", value: { kind: "literal", value: false } },
      { key: "note", value: { kind: "literal", value: null } },
      { key: "tags", value: { kind: "literal", value: [1, "a, b", ""] } },
      { key: "memo", value: { kind: "literal", value: "Thanks" } },
    ] }] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "Settle it" }));
    const kinds = ["amount", "paid", "note", "tags", "memo"].map((key) => (screen.getByRole("combobox", { name: `Step 1, ${key}, kind` }) as HTMLSelectElement).value);
    expect(kinds).toEqual(["number", "boolean", "empty", "list", "text"]);
    expect((screen.getByRole("combobox", { name: "Step 1, paid" }) as HTMLSelectElement).value).toBe("false");
    // Each item is its own field, so an item with a comma, or an empty one, stays one item.
    const tags = screen.getByRole("group", { name: "Step 1, tags, list" });
    expect(within(tags).getAllByRole("textbox").map((item) => (item as HTMLInputElement).value)).toEqual(["1", "a, b", ""]);
    await user.click(within(tags).getByRole("button", { name: "Add item" }));
    await user.type(within(tags).getByRole("textbox", { name: "Step 1, tags, item 4" }), "c");

    const amount = screen.getByRole("textbox", { name: "Step 1, amount" });
    await user.clear(amount);
    await user.type(amount, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a number.")).toBeTruthy();
    expect(written).toEqual([]);
    await user.clear(amount);
    await user.type(amount, "4.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    const [step] = written[0]!.automations[0]!.do;
    const input = (saved.do[0] as Extract<Automation["do"][number], { kind: "invoke" }>).input;
    expect(step).toEqual({ ...saved.do[0], input: [
      { key: "amount", value: { kind: "literal", value: 4.5 } },
      input[1], input[2],
      { key: "tags", value: { kind: "literal", value: [1, "a, b", "", "c"] } },
      input[4],
    ] });
  }, 30_000);

  it("edits another table's action inside an If, and keeps an action the dataset lacks with why", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [
      { name: "invoices.settle", label: "Settle", table: "Invoices", reversible: true },
      { name: "refunds.issue", label: "Issue refund", table: "Refunds", reversible: false },
    ] };
    const saved: Automation = { ...onInvoices, id: "branch", name: "Branch", do: [{ kind: "if", if: "record.Points > 1", do: [
      { kind: "invoke", collection: null, operation: "gone.op", input: [] },
    ], otherwise: [
      { kind: "invoke", collection: null, operation: "invoices.settle", input: [] },
    ] }] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "Branch" }));
    // The action the file names is gone: it stays, says so, and the step can still be saved or changed.
    expect(screen.getByText("Invoices has no action named gone.op. Choose another.")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Step 2, action" }) as HTMLSelectElement).value).toBe("gone.op");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, action" }), "refunds.issue");
    expect(within(screen.getByTestId("builder-step-2")).getByText("Issue refund can't be undone.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    const [branch] = written[0]!.automations[0]!.do;
    expect(branch).toEqual({ ...saved.do[0], otherwise: [{ kind: "invoke", collection: null, operation: "refunds.issue", input: [] }] });
  }, 30_000);

  it("keeps the list's reason on an unchanged automation when main's check gives none", async () => {
    const reason = "This Collection's rules are not approved yet, so its automations cannot run.";
    const { bridge } = makeBridge(read([summary(onInvoices, { cannotRun: reason })]));
    // Main's check of the unchanged automation gives no reason, as for rules it cannot see. The syntax
    // problem it also names shows when its answer has landed.
    bridge.checkCollectionAutomation.mockResolvedValue({
      diagnostics: [], formulaProblems: [{ path: "/do/0/set/Finished on", problem: "Marker." }], cannotRun: null, missingFiles: [],
    });
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(await screen.findByText("This formula has a syntax error. Marker.", undefined, SLOW)).toBeTruthy();
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  }, 30_000);

  it("shows what main says about whether the draft would run, and lets it be saved", async () => {
    const withActions: AutomationTable = { ...INVOICES, actions: [{ name: "invoices.remind", label: "Remind", table: "Invoices", reversible: true }] };
    const { bridge, written } = makeBridge(read([]));
    const reason = "A schedule starts this automation, so an action's input cannot use trigger.record. Use a value instead.";
    bridge.checkCollectionAutomation.mockImplementation(async ({ automation }: { automation: Automation }) => ({
      diagnostics: [], formulaProblems: [], cannotRun: automation.do.some((step) => step.kind === "invoke" && step.input.length > 0) ? reason : null, missingFiles: [],
    }));
    const user = userEvent.setup();
    render(<Panel table={withActions} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "schedule");
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Run an action" }));
    // A schedule has no record, so a new action starts with no input.
    expect(screen.queryByRole("textbox", { name: "Step 1, input 1 name" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(screen.getByRole("textbox", { name: "Step 1, input 1 name" }), "id");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, id, kind" }), "formula");
    await user.type(screen.getByRole("textbox", { name: "Step 1, id, formula" }), "trigger.record.id");
    expect(await screen.findByText(reason, undefined, SLOW)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove id from step 1" }));
    await waitFor(() => expect(screen.queryByText(reason)).toBeNull(), SLOW);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ kind: "invoke", collection: null, operation: "invoices.remind", input: [] }]);
  }, 30_000);

  it("gives an action on another table than the trigger's no record input", async () => {
    makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel table={{ ...INVOICES, actions: [{ name: "refunds.issue", label: "Issue refund", table: "Refunds", reversible: true }] }} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.click(screen.getByRole("button", { name: "Run an action" }));
    expect((screen.getByRole("combobox", { name: "Step 2, action" }) as HTMLSelectElement).value).toBe("refunds.issue");
    expect(screen.queryByRole("textbox", { name: "Step 2, input 1 name" })).toBeNull();
  });

  it("says nothing about undo for an action whose rules name its reverse", async () => {
    makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel table={{ ...INVOICES, actions: [{ name: "invoices.hold", label: "Hold", table: "Invoices", reversible: true }] }} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.click(screen.getByRole("button", { name: "Run an action" }));
    expect(screen.getByRole("combobox", { name: "Step 2, action" })).toBeTruthy();
    expect(screen.queryByText(/can't be undone/)).toBeNull();
  });

  it("says beside a step that wakes an agent that other people's changes can start it", async () => {
    const wakes: Automation = { ...onInvoices, do: [{ kind: "wake-agent", text: "Look at {record.Status}", person: "owner" }] };
    const line = "Changes other people make can start this step, and their text reaches your agent as data.";
    makeBridge(read([summary(wakes)]));
    const user = userEvent.setup();
    const { unmount } = render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(within(screen.getByTestId("builder-step-0")).getByText(line)).toBeTruthy();
    unmount();

    // Only a dataset Collection shows it.
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(screen.queryByText(line)).toBeNull();
  });

  it("offers no action step on a table without actions", async () => {
    makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    expect(screen.queryByRole("button", { name: "Run an action" })).toBeNull();
  });

  it("says beside an Add record step when Undo would keep the records it adds", async () => {
    const addsLog: Automation = { ...onInvoices, do: [{ kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "Log" } }], collection: null, as: null, operation: "invoices.create" }] };
    const hint = "Undo keeps the records this step adds. This Collection has no delete action available to the automation.";
    makeBridge({ status: "read", contentHash: HASH, automations: [summary(addsLog)], addsStay: ["Invoices"] });
    const user = userEvent.setup();
    const { unmount } = render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(screen.getByTestId("builder-step-0").textContent).toContain(hint);
    unmount();
    makeBridge(read([summary(addsLog)]));
    const second = render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(screen.getByTestId("builder-step-0").textContent).not.toContain(hint);
    second.unmount();

    // Each step says so for the table it adds to.
    const both: Automation = { ...addsLog, do: [...addsLog.do, { kind: "add-record", values: [], collection: null, as: null, operation: "refunds.create" }] };
    makeBridge({ status: "read", contentHash: HASH, automations: [summary(both)], addsStay: ["Refunds"] });
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect(screen.getByTestId("builder-step-0").textContent).not.toContain("Undo keeps");
    expect(screen.getByTestId("builder-step-1").textContent)
      .toContain("Undo keeps the records this step adds. Refunds has no delete action available to the automation.");
  });

  it("edits an Add record that adds to another table in that table, and leaves one whose operation is gone as the file wrote it", async () => {
    const addsRefund: Automation = { ...onInvoices, do: [
      { kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "Refund" } }], collection: null, as: null, operation: "refunds.create" },
      { kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "Old" } }], collection: null, as: null, operation: "old.create" },
    ] };
    makeBridge(read([summary(addsRefund)]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    expect((screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement).value).toBe("Refunds");
    const gone = screen.getByTestId("builder-step-1");
    expect(within(gone).queryByRole("combobox")).toBeNull();
    expect(gone.textContent).toContain("Step 2");
  });

  it("moves focus after a delete to the next row on screen, not one another table hides", async () => {
    const later: Automation = { ...onInvoices, id: "later", name: "Later" };
    makeBridge(read([summary(onInvoices), summary(onRefunds), summary(later)]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(within(await screen.findByTestId("automation-stamp")).getByRole("button", { name: "Stamp the finish date actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByTestId("automation-later")).getByRole("switch")));
  });

  it("tells the page after an Undo, so it reads the records the run changed again", async () => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    makeBridge(read([summary(onInvoices)]), [run({ writes: [{ kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", expectedVersion: 1, version: 2,
      fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] }] })]);
    const onRunUndone = vi.fn();
    render(<Panel table={INVOICES} onRunUndone={onRunUndone} focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    await userEvent.click(within(await screen.findByTestId("automation-run-atc_1")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onRunUndone).toHaveBeenCalledOnce());
  });
});

describe("the builder's triggers", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const APPROVE: FieldDefinition = { name: "Approve", type: "button" };
  const options = (name: string) =>
    within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);
  const checked = () => within(screen.getByRole("group", { name: "Fields that change" })).getAllByRole("checkbox")
    .flatMap((box) => ((box as HTMLInputElement).checked ? [box.parentElement!.textContent] : []));
  const toggle = async (user: ReturnType<typeof userEvent.setup>, ...names: string[]) => {
    for (const name of names) await user.click(within(screen.getByRole("group", { name: "Fields that change" })).getByRole("checkbox", { name }));
  };

  it("watches any field or chosen ones, keeps a chosen field the Collection lost until it is cleared, and asks for one", async () => {
    const chosen: Automation = { ...stamp, when: { kind: "record-changed", fields: ["Gone", "Status"], table: null } };
    const { written } = makeBridge(read([summary(chosen)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Which fields" }) as HTMLSelectElement).value).toBe("chosen");
    expect(checked()).toEqual(["Gone", "Status"]);
    expect(screen.getByText("Gone is not a field in Tasks.")).toBeTruthy();

    await toggle(user, "Gone", "Status");
    expect(screen.queryByText("Gone is not a field in Tasks.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose at least one field.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Title" }));
    await toggle(user, "Points", "Title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.when).toEqual({ kind: "record-changed", fields: ["Title", "Points"], table: null });

    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Which fields" }), "any");
    expect(screen.queryByRole("group", { name: "Fields that change" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2), SLOW);
    expect(written[1]!.automations[0]!.when).toEqual({ kind: "record-changed", fields: null, table: null });
  }, 30_000);

  it("builds what a record starts to match from rows, and keeps a formula that rows cannot show", async () => {
    const { written } = makeBridge(read([summary({ ...stamp, when: { kind: "starts-matching", condition: "record.Points > 3", table: null } })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Match" }) as HTMLSelectElement).value).toBe("formula");
    expect((screen.getByRole("textbox", { name: "Condition to match" }) as HTMLInputElement).value).toBe("record.Points > 3");
    await user.click(screen.getByRole("button", { name: "Back to automations" }));

    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "starts-matching");
    expect((screen.getByRole("combobox", { name: "Match" }) as HTMLSelectElement).value).toBe("rows");
    await user.selectOptions(screen.getByRole("combobox", { name: "Match condition 1, field" }), "Status");
    await user.selectOptions(screen.getByRole("combobox", { name: "Match condition 1, value" }), "Done");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Match condition 2, field" }), "Points");
    await user.type(screen.getByRole("textbox", { name: "Match condition 2, value" }), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a number.")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Match condition 2, value" }));
    await user.type(screen.getByRole("textbox", { name: "Match condition 2, value" }), "2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations.at(-1)!.when).toEqual({ kind: "starts-matching", condition: 'record.Status == "Done" && record.Points == 2', table: null });
  }, 30_000);

  it("does not save the old table's fields after the trigger moves to another table, and focuses the first", async () => {
    const REFUND_FIELDS: FieldDefinition[] = [{ name: "Amount", type: "number" }];
    const table: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS)], ["Refunds", datasetTable(REFUND_FIELDS)]]), actions: [] };
    const onInvoices: Automation = { ...stamp, when: { kind: "field-changed", field: "Status", to: null, table: "Invoices" }, if: 'record.Title == "x"' };
    const { written } = makeBridge(read([summary(onInvoices)]));
    const user = userEvent.setup();
    render(<Panel table={table} />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Table" }), "Refunds");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const trigger = screen.getByRole("combobox", { name: "Field that changes" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("Status is not a field in Refunds. Choose a field.");
    expect(screen.getByText("Title is not a field in Refunds. Choose a field.")).toBeTruthy();
    expect(screen.getByText("Finished on is not a field in Refunds. Choose a field.")).toBeTruthy();
    expect(screen.getByText("3 problems. The first is focused.")).toBeTruthy();
    expect(written).toEqual([]);

    // Back on the table it was saved on, a missing field only warns.
    await user.selectOptions(screen.getByRole("combobox", { name: "Table" }), "Invoices");
    expect(screen.queryByText(/Choose a field\./u)).toBeNull();
  }, 30_000);

  it("still asks after a draft on another table is kept and opened again, and points an empty choice's problem at Which fields", async () => {
    const table: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS)], ["Refunds", datasetTable([{ name: "Refund", type: "button" }])]]), actions: [] };
    const watching: Automation = { ...stamp, when: { kind: "record-changed", fields: ["Status"], table: "Invoices" } };
    const { written } = makeBridge(read([summary(watching)]));
    const user = userEvent.setup();
    const first = render(<Panel table={table} />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Table" }), "Refunds");
    first.unmount();

    render(<Panel table={table} />);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    const status = screen.getByRole("checkbox", { name: "Status" });
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(screen.getByText("Status is not a field in Refunds. Clear it.")).toBeTruthy();
    await user.click(status);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose at least one field.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Which fields" })));
    expect(written).toEqual([]);
  }, 30_000);

  it("writes back conditions nobody changed as the file wrote them, and compares a checkbox with unchecked", async () => {
    const saved: Automation = { ...stamp, when: { kind: "starts-matching", condition: 'record.Points == "2"', table: null }, if: "record.Points == null" };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel fields={[...FIELDS, { name: "Done", type: "checkbox" }]} />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Match" }) as HTMLSelectElement).value).toBe("rows");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]).toMatchObject({ when: saved.when, if: saved.if });

    await openBuilder(user, "Stamp the finish date!");
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1, field" }), "Done");
    expect((screen.getByRole("combobox", { name: "Condition 1, value" }) as HTMLSelectElement).value).toBe("false");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2), SLOW);
    expect(written[1]!.automations[0]!.if).toBe("record.Done == false");
  }, 30_000);

  it("offers a Button field only as a button, never as a value to set or compare", async () => {
    makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel fields={[...FIELDS, APPROVE]} />);
    await openBuilder(user);
    expect(options("Step 1, field 1")).not.toContain("Approve");
    expect(options("Field that changes")).not.toContain("Approve");
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition" }), "rows");
    expect(options("Condition 1, field")).not.toContain("Approve");
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "button");
    expect(options("Button")).toEqual(["Approve"]);
  });

  it("repairs a button trigger whose field is gone, and says how to add a button where there is none", async () => {
    const gone: Automation = { ...stamp, when: { kind: "button", field: "Gone", table: null } };
    const { written } = makeBridge(read([summary(gone)]));
    const onOpenFields = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Panel fields={[...FIELDS, APPROVE]} onOpenFields={onOpenFields} />);
    await openBuilder(user);
    expect(screen.getByText("Gone is not a field in Tasks.")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Button" }), "Approve");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.when).toEqual({ kind: "button", field: "Approve", table: null });

    rerender(<Panel fields={FIELDS} onOpenFields={onOpenFields} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "button");
    expect(screen.getByText("Tasks has no Button field. Add one, then choose it here.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose a button.")).toBeTruthy();
    expect(written).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Edit fields" }));
    expect(onOpenFields).toHaveBeenCalledOnce();
  }, 30_000);

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

describe("a schedule's next run", () => {
  const NOW = Date.UTC(2026, 8, 25, 10);
  const daily: Automation = {
    ...stamp,
    id: "report",
    name: "Morning report",
    when: { kind: "schedule", every: "day", at: "09:00", timezone: "UTC" },
    do: [{ kind: "add-record", values: [], collection: null, as: null, operation: null }],
  };
  const localTime = (ms: number) => new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(ms);
  const tomorrow = `Next run ${localTime(Date.UTC(2026, 8, 26, 9))}`;
  const computers = [
    { installId: "me", kind: "computer", label: "DESKTOP-1", lastSeenMs: NOW, thisComputer: true },
    { installId: "laptop", kind: "computer", label: "Ice's laptop", lastSeenMs: NOW - 86_400_000, thisComputer: false },
  ] satisfies ScheduleHostComputer[];
  const relay = (hostInstallId: string | null, handoverFrom: string | null = null, listed: ScheduleHostComputer[] = computers): ScheduleHostResult =>
    ({ kind: "relay", generation: 3, hostInstallId, handoverFrom, computers: listed });

  // Only Date is fake: the panel's timer and the test's waits run on real time.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows when a switched-on schedule runs next, in local time, and nothing for others", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge } = makeBridge(read([
      summary(daily),
      summary({ ...daily, id: "off", name: "Off", enabled: false }),
      summary({ ...daily, id: "stuck", name: "Stuck" }, { cannotRun: "Turn on sync to run this workspace's schedules." }),
      summary(stamp),
    ]));
    render(<Panel />);
    const row = await screen.findByTestId("automation-report");
    await waitFor(() => expect(bridge.readScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    expect(within(row).getByText(tomorrow)).toBeTruthy();
    for (const id of ["off", "stuck", "stamp"]) {
      expect(screen.getByTestId(`automation-${id}`).textContent).not.toContain("Next run");
    }
  });

  it("does not ask which computer runs schedules when nothing here is scheduled", async () => {
    const { bridge } = makeBridge(read([summary(stamp), summary({ ...daily, enabled: false })]));
    render(<Panel />);
    await screen.findByTestId("automation-report");
    expect(bridge.readScheduleHost).not.toHaveBeenCalled();
    expect(bridge.onScheduleHostChanged).not.toHaveBeenCalled();
  });

  it("moves on to the following run once the shown one comes due, and when the schedule changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 8, 26, 9) - 20 });
    const { replaceFile } = makeBridge(read([summary(daily)]));
    render(<Panel />);
    expect(await screen.findByText(tomorrow)).toBeTruthy();
    vi.setSystemTime(Date.UTC(2026, 8, 26, 9));
    expect(await screen.findByText(`Next run ${localTime(Date.UTC(2026, 8, 27, 9))}`)).toBeTruthy();

    replaceFile(read([summary({ ...daily, when: { kind: "schedule", every: "day", at: "18:30", timezone: "UTC" } })]));
    expect(await screen.findByText(`Next run ${localTime(Date.UTC(2026, 8, 26, 18, 30))}`)).toBeTruthy();
    replaceFile(read([summary({ ...daily, enabled: false })]));
    await waitFor(() => expect(screen.getByTestId("automation-report").textContent).not.toContain("Next run"));
  });

  it("names the computer that runs schedules when it is not this one, and follows a handover", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge, hostChanged } = makeBridge(read([summary(daily)]));
    bridge.readScheduleHost.mockResolvedValueOnce(relay("laptop"));
    const onOpenScheduleSettings = vi.fn();
    render(<Panel onOpenScheduleSettings={onOpenScheduleSettings} />);
    expect(await screen.findByText(`${tomorrow} on Ice's laptop`)).toBeTruthy();

    bridge.readScheduleHost.mockResolvedValueOnce(relay("me", "laptop"));
    act(() => hostChanged("ws-2"));
    act(() => hostChanged("ws-1"));
    const handover = await screen.findByTestId("schedule-host-handover");
    expect(within(handover).getByText("Schedules wait for Ice's laptop to hand over.")).toBeTruthy();
    expect(screen.getByText(tomorrow)).toBeTruthy();
    expect(bridge.readScheduleHost).toHaveBeenCalledTimes(2);
    // Settings can take over from a computer that stays away.
    await userEvent.click(within(handover).getByRole("button", { name: "Choose a computer" }));
    expect(onOpenScheduleSettings).toHaveBeenCalledTimes(1);

    bridge.readScheduleHost.mockResolvedValueOnce(relay("me"));
    act(() => hostChanged("ws-1"));
    await waitFor(() => expect(screen.queryByTestId("schedule-host-handover")).toBeNull());
    expect(screen.getByText(tomorrow)).toBeTruthy();
  });

  it("says plainly when no computer runs schedules, and opens the setting that chooses one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge, hostChanged } = makeBridge(read([summary(daily), summary({ ...daily, id: "second", name: "Second" })]));
    bridge.readScheduleHost.mockResolvedValueOnce(relay(null));
    const onOpenScheduleSettings = vi.fn();
    render(<Panel onOpenScheduleSettings={onOpenScheduleSettings} />);
    const note = await screen.findByTestId("schedule-host-missing");
    expect(screen.getAllByText("No computer runs this workspace's schedules.")).toHaveLength(1);
    expect(screen.queryByText(/Next run/)).toBeNull();
    await userEvent.click(within(note).getByRole("button", { name: "Choose a computer" }));
    expect(onOpenScheduleSettings).toHaveBeenCalledTimes(1);

    // The owner chose this computer in settings.
    bridge.readScheduleHost.mockResolvedValueOnce(relay("me"));
    act(() => hostChanged("ws-1"));
    await waitFor(() => expect(screen.getAllByText(tomorrow)).toHaveLength(2));
    expect(screen.queryByTestId("schedule-host-missing")).toBeNull();
  });

  it("names this server as where schedules run, and follows its handover to a computer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const server = { installId: "server", kind: "server", label: "My dohc server", lastSeenMs: NOW, thisComputer: false } as const;
    const { bridge, hostChanged } = makeBridge(read([summary(daily)]));
    bridge.readScheduleHost.mockResolvedValueOnce(relay("server", null, [server, ...computers]));
    render(<Panel />);
    expect(await screen.findByText(`${tomorrow} on this server`)).toBeTruthy();

    bridge.readScheduleHost.mockResolvedValueOnce(relay("me", "server", [server, ...computers]));
    act(() => hostChanged("ws-1"));
    const handover = await screen.findByTestId("schedule-host-handover");
    expect(within(handover).getByText("Schedules wait for this server to hand over.")).toBeTruthy();
  });

  it("says when the server named to run schedules does not run automations, and opens the setting that chooses a computer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge } = makeBridge(read([summary(daily)]));
    bridge.readScheduleHost.mockResolvedValueOnce(relay("server"));
    const onOpenScheduleSettings = vi.fn();
    render(<Panel onOpenScheduleSettings={onOpenScheduleSettings} />);
    const note = await screen.findByTestId("schedule-host-missing");
    expect(within(note).getByText("This server does not run automations.")).toBeTruthy();
    expect(screen.queryByText(/Next run/)).toBeNull();
    await userEvent.click(within(note).getByRole("button", { name: "Choose a computer" }));
    expect(onOpenScheduleSettings).toHaveBeenCalledTimes(1);
  });

  it("shows no next run while a server that runs no automations still hands over to a computer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge } = makeBridge(read([summary(daily)]));
    bridge.readScheduleHost.mockResolvedValueOnce(relay("laptop", "server"));
    render(<Panel />);
    const note = await screen.findByTestId("schedule-host-missing");
    expect(within(note).getByText("This server does not run automations.")).toBeTruthy();
    expect(screen.queryByTestId("schedule-host-handover")).toBeNull();
    expect(screen.queryByText(/Next run/)).toBeNull();
  });

  it("says offline that dohc could not check, keeps the computer it last named, and checks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const offline: ScheduleHostResult = { kind: "note", message: "dohc could not reach your server to check which computer runs schedules." };
    const { bridge, hostChanged } = makeBridge(read([summary(daily)]));
    const onError = vi.fn();
    bridge.readScheduleHost.mockResolvedValueOnce(offline);
    const { unmount } = render(<Panel onError={onError} />);
    const note = await screen.findByTestId("schedule-host-unchecked");
    expect(note.textContent).toContain(offline.message);
    expect(screen.getByText(tomorrow)).toBeTruthy();

    bridge.readScheduleHost.mockResolvedValueOnce(relay("laptop"));
    await userEvent.click(within(note).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(`${tomorrow} on Ice's laptop`)).toBeTruthy();
    expect(screen.queryByTestId("schedule-host-unchecked")).toBeNull();

    // The connection drops: the laptop stays named, with the note beside it.
    bridge.readScheduleHost.mockResolvedValueOnce(offline);
    act(() => hostChanged("ws-1"));
    expect(await screen.findByTestId("schedule-host-unchecked")).toBeTruthy();
    expect(screen.getByText(`${tomorrow} on Ice's laptop`)).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    unmount();
  });

  it("shows next runs in the time zone the computer is in now", async () => {
    // A formatter made without a zone takes the computer's zone when it is
    // made, as in Electron. Stubbing that keeps the process's own zone intact.
    let zone = "UTC";
    const RealDateTimeFormat = Intl.DateTimeFormat;
    // A function, not an arrow: the panel calls it with new.
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        return new RealDateTimeFormat(locales, { timeZone: zone, ...options });
      },
    );
    onTestFinished(() => spy.mockRestore());
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    makeBridge(read([summary(daily)]));
    render(<Panel />);
    const row = await screen.findByTestId("automation-report");
    await waitFor(() => expect(row.textContent).toMatch(/9:00/));
    // The person flies to India, and the window gets focus there.
    zone = "Asia/Kolkata";
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(row.textContent).toMatch(/2:30/));
  });

  it("reports a failed read with Try again, and drops an answer for a workspace it left", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { bridge } = makeBridge(read([summary(daily)]));
    const onError = vi.fn();
    bridge.readScheduleHost.mockRejectedValueOnce(new Error("dohc could not reach the relay."));
    const { rerender } = render(<Panel onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "dohc could not read which computer runs schedules.", expect.any(Error), expect.any(Function),
    ));
    expect(screen.getByText(tomorrow)).toBeTruthy();
    const tryAgain = onError.mock.calls[0]?.[2] as () => void;
    bridge.readScheduleHost.mockResolvedValueOnce(relay("laptop"));
    act(() => tryAgain());
    expect(await screen.findByText(`${tomorrow} on Ice's laptop`)).toBeTruthy();

    // ws-1's answer comes after the panel moved to ws-2: it never shows there.
    let answer: (result: ScheduleHostResult) => void = () => undefined;
    bridge.readScheduleHost.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    act(() => tryAgain());
    rerender(<Panel workspaceId="ws-2" onError={onError} />);
    await waitFor(() => expect(bridge.readScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws-2" }));
    await act(async () => answer(relay(null)));
    expect(await screen.findByText(tomorrow)).toBeTruthy();
    expect(screen.queryByText("No computer runs this workspace's schedules.")).toBeNull();
    expect(screen.queryByText(/on Ice's laptop/)).toBeNull();
  });
});

describe("the builder's If", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const title = (value: string) => [{ field: "Title", value: { kind: "literal" as const, value } }];
  const setTitle = (value: string) => ({ kind: "set" as const, values: title(value), records: null, operation: null });
  const group = (name: string) => screen.getByRole("group", { name });

  it("adds an If with a condition and a step in Do, and saves an empty Otherwise as none", async () => {
    const { written } = makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "If" }));
    const mode = screen.getByRole("combobox", { name: "Step 2, if" }) as HTMLSelectElement;
    expect(document.activeElement).toBe(mode);
    expect(mode.value).toBe("rows");
    // An If always has a condition, so it offers no Always.
    expect(within(mode).getAllByRole("option").map((option) => option.textContent)).toEqual(["Fields match", "Formula"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, condition 1, field" }), "Status");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, condition 1, value" }), "Done");

    // An empty Do is a problem; an empty Otherwise is not.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(group("Step 2, Do")).findByText("Add a step.")).toBeTruthy();
    expect(within(group("Step 2, Otherwise")).queryByText("Add a step.")).toBeNull();
    expect(written).toEqual([]);

    await user.click(within(group("Step 2, Do")).getByRole("button", { name: "Set fields" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, field 1" }), "Title");
    await user.type(screen.getByRole("textbox", { name: "Step 3, Title" }), "Closed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[1]).toEqual({ kind: "if", if: 'record.Status == "Done"', do: [setTitle("Closed")], otherwise: [] });
  }, 30_000);

  it("offers every step in either branch, and no fourth If inside three, saying why", async () => {
    const nested: Automation = { ...stamp, do: [
      { kind: "if", if: "record.Points > 1", otherwise: [], do: [
        { kind: "if", if: "record.Points > 2", otherwise: [], do: [
          { kind: "if", if: "record.Points > 3", otherwise: [], do: [setTitle("Deep")] },
        ] },
      ] },
    ] };
    makeBridge(read([summary(nested)]));
    const user = userEvent.setup();
    render(<Panel table={{ name: "Tasks", tables: new Map([["Tasks", datasetTable(FIELDS)]]),
      actions: [{ name: "tasks.close", label: "Close", table: "Tasks", reversible: true }] }} />);
    await openBuilder(user);
    const outer = group("Step 1, Otherwise");
    for (const kind of ["Set fields", "Add a record", "Find records", "Run an action", "If"]) {
      expect((within(outer).getByRole("button", { name: kind }) as HTMLButtonElement).disabled).toBe(false);
    }
    const innermost = group("Step 3, Do");
    const add = within(innermost).getByRole("button", { name: "If" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(document.getElementById(add.getAttribute("aria-describedby")!)?.textContent)
      .toBe("An If here would sit inside three others, and an automation allows three.");
    expect((within(innermost).getByRole("button", { name: "Set fields" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(group("Step 3, Otherwise")).getByRole("button", { name: "If" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(group("Step 2, Otherwise")).getByRole("button", { name: "If" }) as HTMLButtonElement).disabled).toBe(false);
  }, 30_000);

  it("keeps an If's formula as written, shows its syntax error beside it, and keeps a result named in a branch inside it", async () => {
    const branched: Automation = { ...stamp, do: [
      { kind: "if", if: "record.Points >", otherwise: [], do: [
        { kind: "find", condition: "true", collection: null, as: "inner", operation: null },
        { kind: "set", values: title("Seen"), records: "inner", operation: null },
      ] },
      setTitle("After"),
    ] };
    const { written } = makeBridge(read([summary(branched)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const formula = screen.getByRole("textbox", { name: "Step 1, condition formula" }) as HTMLInputElement;
    expect(formula.value).toBe("record.Points >");
    await waitFor(() => expect(formula.getAttribute("aria-invalid")).toBe("true"), SLOW);
    expect(document.getElementById(formula.getAttribute("aria-describedby")!)?.textContent).toMatch(/^This formula has a syntax error\./u);
    // The Set inside Do can change what the Find found; the step after the If cannot.
    expect((screen.getByRole("combobox", { name: "Step 3, record" }) as HTMLSelectElement).value).toBe("inner");
    expect(screen.queryByRole("combobox", { name: "Step 4, record" })).toBeNull();
    await user.type(formula, " 3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ ...branched.do[0], if: "record.Points > 3" }, branched.do[1]]);
  }, 30_000);

  it("saves an If whose unchanged rows compare a number field with text, as the file wrote them", async () => {
    const compared: Automation = { ...stamp, do: [{ kind: "if", if: 'record.Points == ""', do: [setTitle("Blank")], otherwise: [] }] };
    const { written } = makeBridge(read([summary(compared)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Step 1, if" }) as HTMLSelectElement).value).toBe("rows");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(compared.do);
  }, 30_000);

  it("starts an If on a schedule as a formula, and says a schedule has no record before what rows lack", async () => {
    makeBridge(read([summary({ ...stamp, when: { kind: "schedule", every: "day", at: "09:00", timezone: "UTC" }, if: "record.Points == 3", do: [
      { kind: "add-record", values: title("Daily"), collection: null, as: null, operation: null },
    ] })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "If" }));
    expect((screen.getByRole("combobox", { name: "Step 2, if" }) as HTMLSelectElement).value).toBe("formula");
    // Field rows, emptied, still say first that a schedule has no record.
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, if" }), "rows");
    await user.click(screen.getByRole("button", { name: "Remove step 2, condition 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This trigger has no record to compare. Write a formula.")).toBeTruthy();
    expect(screen.queryByText("Add a condition.")).toBeNull();
  }, 30_000);

  it("moves through an If's condition into its Do with Tab, and asks for a formula on a schedule", async () => {
    makeBridge(read([summary({ ...stamp, when: { kind: "schedule", every: "day", at: "09:00", timezone: "UTC" }, do: [
      { kind: "add-record", values: title("Daily"), collection: null, as: null, operation: null },
    ] })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "If" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, if" }), "rows");
    await user.click(within(screen.getByTestId("builder-step-1")).getByRole("button", { name: "Add condition" }));
    await user.click(within(screen.getByTestId("builder-step-1")).getByRole("button", { name: "Remove step 2, condition 2" }));
    // Focus goes back to the first condition's remove button; Tab reaches Add condition, then Do's first choice.
    await user.tab();
    expect(document.activeElement).toBe(within(screen.getByTestId("builder-step-1")).getByRole("button", { name: "Add condition" }));
    await user.tab();
    expect(document.activeElement).toBe(within(group("Step 2, Do")).getByRole("button", { name: "Set fields" }));

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This trigger has no record to compare. Write a formula.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 2, if" })));
  }, 30_000);
});

describe("the builder's Find and results", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const options = (name: string) =>
    within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);

  it("finds records by a field, names them, and sets fields on them in a later step", async () => {
    const { written } = makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "Find records" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 2, Collection" }));
    expect((screen.getByRole("combobox", { name: "Step 2, records to find" }) as HTMLSelectElement).value).toBe("always");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, records to find" }), "rows");
    // A document's Find checks one field, with is or contains.
    expect(options("Step 2, condition 1, comparison")).toEqual(["is", "contains"]);
    expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, condition 1, field" }), "Status");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, condition 1, value" }), "Doing");

    // A Find needs a name before a later step can use what it found.
    await user.click(screen.getByRole("button", { name: "Save" }));
    const resultName = screen.getByRole("textbox", { name: "Step 2, result name" });
    await waitFor(() => expect(document.activeElement).toBe(resultName));
    expect(screen.getByText("Name the result, so later steps can use it.")).toBeTruthy();
    await user.type(resultName, "open");

    const sets = screen.getAllByRole("button", { name: "Set fields" });
    await user.click(sets[sets.length - 1]!);
    expect(options("Step 3, record")).toEqual(["The trigger record", "Records found as open"]);
    // Step 1 comes before the Find, so it cannot use it.
    expect(screen.queryByRole("combobox", { name: "Step 1, record" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, record" }), "open");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, field 1" }), "Title");
    await user.type(screen.getByRole("textbox", { name: "Step 3, Title" }), "Seen");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do.slice(1)).toEqual([
      { kind: "find", condition: 'record.Status == "Doing"', collection: null, as: "open", operation: null },
      { kind: "set", values: [{ field: "Title", value: { kind: "literal", value: "Seen" } }], records: "open", operation: null },
    ]);
  }, 30_000);

  it("names an added record in another Collection, and sets its fields later", async () => {
    const { written } = makeBridge(read([summary({ ...stamp, when: { kind: "record-added", table: null } })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, Collection" }), "Log");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Step 2, field 1" }), "Entry");
    await user.type(screen.getByRole("textbox", { name: "Step 2, result name" }), "entry");
    const sets = screen.getAllByRole("button", { name: "Set fields" });
    await user.click(sets[sets.length - 1]!);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, record" }), "entry");
    // The added record's fields, not this Collection's.
    expect(options("Step 3, field 1")).toEqual(["Choose a field", "Entry"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 3, field 1" }), "Entry");
    await user.type(screen.getByRole("textbox", { name: "Step 3, Entry" }), "Done");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do.slice(1)).toEqual([
      { kind: "add-record", values: [{ field: "Entry", value: { kind: "literal", value: "" } }], collection: "Log", as: "entry", operation: null },
      { kind: "set", values: [{ field: "Entry", value: { kind: "literal", value: "Done" } }], records: "entry", operation: null },
    ]);
  }, 30_000);

  it("finds a dataset's own records by several fields with is only, and keeps a formula it cannot show as rows", async () => {
    const table: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS)]]), actions: [] };
    const saved: Automation = { ...stamp, when: { kind: "record-added", table: "Invoices" }, do: [
      { kind: "find", condition: "record.Points > 3", collection: null, as: "big", operation: null },
    ] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={table} />);
    await openBuilder(user);
    expect((screen.getByRole("textbox", { name: "Step 1, condition formula" }) as HTMLInputElement).value).toBe("record.Points > 3");
    expect(options("Step 1, table")).toEqual(["Invoices"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, records to find" }), "rows");
    expect(options("Step 1, condition 1, comparison")).toEqual(["is"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, condition 1, field" }), "Points");
    await user.type(screen.getByRole("textbox", { name: "Step 1, condition 1, value" }), "3");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, condition 2, field" }), "Status");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, condition 2, value" }), "Done");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[0]).toEqual({ ...saved.do[0], condition: 'record.Points == 3 && record.Status == "Done"' });
  }, 30_000);

  it("reads from a Collection a step cannot change, keeps a condition rows cannot hold as a formula, and edits a Find on another table there", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "find", condition: 'record.Title == "a" && record.Status == "Doing"', collection: null, as: "both", operation: null },
    ] };
    makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    const { unmount } = render(<Panel />);
    await openBuilder(user);
    // A document Collection's Find checks one field, so two stay a formula.
    expect((screen.getByRole("combobox", { name: "Step 1, records to find" }) as HTMLSelectElement).value).toBe("formula");
    // Budget can be read, though no step can change it.
    await waitFor(() => expect(options("Step 1, Collection")).toEqual(["Tasks", "Log", "Budget"]));
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    // No step can change Budget, so an Add a record offers it disabled, with why.
    expect(options("Step 2, Collection")).toEqual(["Tasks", "Log", "Budget (ana@dohc.test cannot edit Budget.)"]);
    expect((screen.getByRole("option", { name: "Budget (ana@dohc.test cannot edit Budget.)" }) as HTMLOptionElement).disabled).toBe(true);
    unmount();

    // Opened on Invoices, a Find the file pinned to Refunds reads Refunds, and a Set on what it found takes Refunds' fields.
    const table: AutomationTable = { name: "Invoices", tables: new Map([
      ["Invoices", datasetTable(FIELDS, "invoices.list:read")],
      ["Refunds", datasetTable([{ name: "Amount", type: "number" }], "refunds.list:read", "refunds.edit:edit")],
    ]), actions: [] };
    const refunds: Automation = { ...stamp, when: { kind: "record-added", table: "Invoices" }, do: [
      { kind: "find", condition: "true", collection: null, as: "refunds", operation: "refunds.list" },
      { kind: "set", values: [{ field: "Amount", value: { kind: "literal", value: 0 } }], records: "refunds", operation: "refunds.edit" },
    ] };
    const { written } = makeBridge(read([summary(refunds)]));
    render(<Panel table={table} />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement).value).toBe("Refunds");
    expect((screen.getByRole("combobox", { name: "Step 2, record" }) as HTMLSelectElement).value).toBe("refunds");
    expect(options("Step 2, field 1")).toEqual(["Amount"]);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(refunds.do);

    // Moving the Find to Invoices leaves the Set's Refunds operation behind, so saving pins one on Invoices.
    await openBuilder(user, "Stamp the finish date!");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, table" }), "Invoices");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2), SLOW);
    expect(written[1]!.automations[0]!.do).toEqual([
      { ...refunds.do[0], operation: null },
      { ...refunds.do[1], operation: null },
    ]);
  }, 30_000);

  it("keeps a Find and a Set on the trigger's table editable after the trigger moves there and the automation opens again", async () => {
    const table: AutomationTable = { name: "Invoices", tables: new Map([
      ["Invoices", datasetTable(FIELDS, "invoices.list:read")],
      ["Refunds", datasetTable([{ name: "Amount", type: "number" }], "refunds.list:read")],
    ]), actions: [] };
    const { written } = makeBridge(read([summary({ ...stamp, when: { kind: "record-added", table: "Invoices" }, do: [] })]), [], { roundTripWrites: true });
    const user = userEvent.setup();
    const { unmount } = render(<Panel table={table} />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Table" }), "Refunds");
    await user.click(screen.getByRole("button", { name: "Find records" }));
    expect((screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement).value).toBe("Refunds");
    await user.type(screen.getByRole("textbox", { name: "Step 1, result name" }), "all");
    const sets = screen.getAllByRole("button", { name: "Set fields" });
    await user.click(sets[sets.length - 1]!);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, record" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Amount");
    await user.type(screen.getByRole("textbox", { name: "Step 2, Amount" }), "1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    // Main pins these steps to Refunds' operations when it saves; this bridge keeps them as sent. Either way
    // a Find reads Refunds, so both steps open for editing again, from Refunds' panel now.
    expect(written[0]!.automations[0]!.do[0]).toMatchObject({ kind: "find", operation: null });
    unmount();
    render(<Panel table={{ ...table, name: "Refunds" }} />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement).value).toBe("Refunds");
    expect(options("Step 2, field 1")).toEqual(["Amount"]);
  }, 30_000);

  it("asks a Find and an Add record on a schedule which table they use, and offers only tables that can", async () => {
    const table: AutomationTable = { name: "Invoices", tables: new Map([
      ["Invoices", datasetTable(FIELDS, "invoices.create:create")],
      ["Refunds", datasetTable([{ name: "Amount", type: "number" }], "refunds.list:read", "refunds.create:create")],
    ]), actions: [] };
    const nightly: Automation = { ...stamp, when: { kind: "schedule", every: "day", at: "02:00", timezone: "UTC" }, do: [] };
    const { written } = makeBridge(read([summary(nightly)]));
    const user = userEvent.setup();
    render(<Panel table={table} />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "Find records" }));
    const picker = screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement;
    expect(picker.value).toBe("");
    expect([...picker.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["Choose a table", true], ["Invoices (cannot find records)", true], ["Refunds", false],
    ]);
    await user.type(screen.getByRole("textbox", { name: "Step 1, result name" }), "all");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 1, table" })));
    expect(screen.getByText("Choose a table.")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, table" }), "Refunds");
    const adds = screen.getAllByRole("button", { name: "Add a record" });
    await user.click(adds[adds.length - 1]!);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, table" }), "Invoices");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([
      { kind: "find", condition: "true", collection: null, as: "all", operation: "refunds.list" },
      { kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "" } }], collection: null, as: null, operation: "invoices.create" },
    ]);
  }, 30_000);

  it("keeps a Find on a Collection it can no longer read, with why beside it", async () => {
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [{ kind: "find", condition: "true", collection: "Budget", as: "bills", operation: null }] })]));
    bridge.listAutomationTargets.mockResolvedValue({ collections: [
      { kind: "document", path: "Tasks", name: "Tasks", stopped: null, findStopped: null },
      { kind: "document", path: "Log", name: "Log", stopped: null, findStopped: "ana@dohc.test cannot view Log." },
      { kind: "document", path: "Budget", name: "Budget", stopped: "ana@dohc.test cannot edit Budget.", findStopped: "ana@dohc.test cannot view Budget." },
    ] });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    // The Find edits once main has said what Budget is.
    const picker = await screen.findByRole("combobox", { name: "Step 1, Collection" }) as HTMLSelectElement;
    await waitFor(() => expect([...picker.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["Tasks", false], ["Log (ana@dohc.test cannot view Log.)", true], ["Budget (ana@dohc.test cannot view Budget.)", false],
    ]));
    expect(picker.value).toBe("Budget");
    expect(within(screen.getByTestId("builder-step-0")).getByText("ana@dohc.test cannot view Budget.")).toBeTruthy();
  }, 30_000);

  it("keeps a result name a later step uses, and says where a renamed one is missing", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "find", condition: "true", collection: null, as: "all", operation: null },
      { kind: "set", values: [{ field: "Title", value: { kind: "literal", value: "x" } }], records: "all", operation: null },
    ] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect((screen.getByRole("combobox", { name: "Step 1, records to find" }) as HTMLSelectElement).value).toBe("always");
    const name = screen.getByRole("textbox", { name: "Step 1, result name" });
    await user.clear(name);
    await user.type(name, "every");
    // The Set step still names "all", which no earlier step names now.
    expect(options("Step 2, record")).toEqual(["The trigger record", "all", "Records found as every"]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const record = screen.getByRole("combobox", { name: "Step 2, record" });
    await waitFor(() => expect(document.activeElement).toBe(record), SLOW);
    expect(document.getElementById(record.getAttribute("aria-describedby")!)?.textContent)
      .toBe("No step before this one in its list names that result. Move this step after the step that names it.");
    await user.selectOptions(record, "every");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ ...saved.do[0], as: "every" }, { ...saved.do[1], records: "every" }]);
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

  it("refuses Save while another dataset's tables load, focusing the step's Collection, and calls no field missing before a table is chosen", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "add-record", values: [{ field: "Amount", value: { kind: "literal", value: 1 } }], collection: "Ledger", as: null, operation: null },
    ] };
    const { bridge } = ledgerBridge(read([summary(saved)]));
    let describe = (_: { kind: "description"; dataset: DatasetDescription }) => {};
    bridge.dataset.mockImplementationOnce(() => new Promise((resolve) => { describe = resolve; }));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const collection = await screen.findByRole("combobox", { name: "Step 1, Collection" });
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledTimes(1));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(collection), SLOW);
    expect(document.getElementById(collection.getAttribute("aria-describedby")!)?.textContent)
      .toBe("dohc is still reading the tables of Ledger. Try again in a moment.");
    describe({ kind: "description", dataset: LEDGER_DATASET });
    const table = await screen.findByRole("combobox", { name: "Step 1, table" });
    expect(collection.getAttribute("aria-describedby")).toBeNull();
    // Both tables could hold Amount, so nothing says it is missing until a table is chosen.
    expect(screen.queryByText("Amount is not a field in Ledger.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(table), SLOW);
    expect(screen.getByText("Choose a table.")).toBeTruthy();
  }, 30_000);

  it("refuses Save while another dataset's actions load, focusing the action, not the step's Remove", async () => {
    const saved: Automation = { ...stamp, do: [{ kind: "invoke", collection: "Ledger", operation: "entries.post", input: [] }] };
    const { bridge, written } = ledgerBridge(read([summary(saved)]));
    bridge.dataset.mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const action = await screen.findByRole("combobox", { name: "Step 1, action" });
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledTimes(1));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(action), SLOW);
    expect(document.getElementById(action.getAttribute("aria-describedby")!)?.textContent)
      .toBe("dohc is still reading the actions of Ledger. Try again in a moment.");
    expect(written).toEqual([]);
  }, 30_000);

  it("calls no field of a Find in another dataset missing while its tables load or before it names a table", async () => {
    const saved: Automation = { ...stamp, do: [{ kind: "find", condition: 'record.Payee == "rent"', collection: "Ledger", as: "rent", operation: null }] };
    const { bridge } = ledgerBridge(read([summary(saved)]));
    let describe = (_: { kind: "description"; dataset: DatasetDescription }) => {};
    bridge.dataset.mockImplementationOnce(() => new Promise((resolve) => { describe = resolve; }));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await screen.findByRole("combobox", { name: "Step 1, condition 1, field" });
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Payee is not a field in Ledger.")).toBeNull();
    describe({ kind: "description", dataset: LEDGER_DATASET });
    const table = await screen.findByRole("combobox", { name: "Step 1, table" });
    expect((table as HTMLSelectElement).value).toBe("");
    expect(screen.queryByText("Payee is not a field in Ledger.")).toBeNull();
    // Once a table is chosen, its fields are known: Payee is in Payees, not Entries.
    await user.selectOptions(table, "Entries");
    expect(await screen.findByText("Payee is not a field in Ledger.")).toBeTruthy();
  }, 30_000);

  it("says another dataset's actions are loading, not the action's name, until their labels come", async () => {
    const saved: Automation = { ...stamp, do: [{ kind: "invoke", collection: "Ledger", operation: "entries.post", input: [] }] };
    const { bridge } = ledgerBridge(read([summary(saved)]));
    let describe = (_: { kind: "description"; dataset: DatasetDescription }) => {};
    bridge.dataset.mockImplementationOnce(() => new Promise((resolve) => { describe = resolve; }));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await screen.findByRole("combobox", { name: "Step 1, action" });
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledTimes(1));
    expect(options("Step 1, action")).toEqual([["Loading actions", false]]);
    describe({ kind: "description", dataset: LEDGER_DATASET });
    await waitFor(() => expect(options("Step 1, action")).toEqual([["Post (Entries)", false], [`Void (Entries) (${VOID_STOPPED})`, true]]));
  }, 30_000);

  it("finds records in another dataset with is, and sets fields on them from that table", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "find", condition: 'record.Memo == "rent" && record.Amount == 2', collection: "Ledger", as: "rent", operation: "entries.list" },
      { kind: "set", values: [{ field: "Amount", value: { kind: "literal", value: 0 } }], records: "rent", operation: "entries.edit" },
    ] };
    const { written } = ledgerBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    // A dataset's Find compares several fields with is, so the saved condition reads as rows.
    const mode = await screen.findByRole("combobox", { name: "Step 1, records to find" }) as HTMLSelectElement;
    expect(mode.value).toBe("rows");
    expect(options("Step 1, condition 1, comparison").map(([name]) => name)).toEqual(["is"]);
    expect((screen.getByRole("combobox", { name: "Step 1, table" }) as HTMLSelectElement).value).toBe("Entries");
    expect(options("Step 2, record").map(([name]) => name)).toEqual(["The trigger record", "Records found as rent in Ledger"]);
    expect(options("Step 2, field 1").map(([name]) => name)).toEqual(["Memo", "Amount"]);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(saved.do);
  }, 30_000);

  it("runs another dataset's actions by their labels, offers one out of reach disabled, and adds one from a document Collection", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "invoke", collection: "Ledger", operation: "entries.post", input: [{ key: "id", value: { kind: "literal", value: "e1" } }] },
    ] };
    const { written } = ledgerBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const action = await screen.findByRole("combobox", { name: "Step 1, action" });
    expect(options("Step 1, action")).toEqual([["Post (Entries)", false], [`Void (Entries) (${VOID_STOPPED})`, true]]);
    expect(options("Step 1, Collection")).toEqual([["Ledger", false]]);
    // Post has a reverse, so nothing says it can't be undone.
    expect(screen.queryByText("Post can't be undone.")).toBeNull();
    expect((action as HTMLSelectElement).value).toBe("entries.post");
    await user.clear(screen.getByRole("textbox", { name: "Step 1, id" }));
    await user.type(screen.getByRole("textbox", { name: "Step 1, id" }), "e2");
    const runs = screen.getAllByRole("button", { name: "Run an action" });
    await user.click(runs[runs.length - 1]!);
    expect((screen.getByRole("combobox", { name: "Step 2, action" }) as HTMLSelectElement).value).toBe("entries.post");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([
      { kind: "invoke", collection: "Ledger", operation: "entries.post", input: [{ key: "id", value: { kind: "literal", value: "e2" } }] },
      { kind: "invoke", collection: "Ledger", operation: "entries.post", input: [] },
    ]);
  }, 30_000);

  it("keeps a step in a Collection dohc cannot reach as its sentence, with main's reason, and offers it disabled", async () => {
    const archive: Target = {
      kind: "dataset", path: "Archive", name: "Archive", datasetId: null, operations: [],
      stopped: "The dataset host for Archive is unavailable.", findStopped: "The dataset host for Archive is unavailable.", editStopped: "The dataset host for Archive is unavailable.", actionsStopped: "The dataset host for Archive is unavailable.",
    };
    const generatedOnly = "Notes's operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.";
    const authored: Target = { ...LEDGER, path: "Notes", name: "Notes", datasetId: "00000000-0000-4000-8000-000000000302", stopped: generatedOnly, findStopped: generatedOnly, editStopped: generatedOnly };
    const saved: Automation = { ...stamp, do: [
      { kind: "add-record", values: [{ field: "Amount", value: { kind: "literal", value: 1 } }], collection: "Archive", as: null, operation: null },
    ] };
    const { bridge } = ledgerBridge(read([summary(saved)]), [...DOCUMENTS, archive, authored]);
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const step = screen.getByTestId("builder-step-0");
    expect(await within(step).findByText("The dataset host for Archive is unavailable.")).toBeTruthy();
    expect(within(step).queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Find records" }));
    expect(options("Step 2, Collection")).toEqual([
      ["Tasks", false], ["Log", false], ["Archive (The dataset host for Archive is unavailable.)", true], [`Notes (${generatedOnly})`, true],
    ]);
    // Notes' actions still run, so a new action step offers them.
    expect(screen.getByRole("button", { name: "Run an action" })).toBeTruthy();
    expect(bridge.dataset).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps a Set's saved operation in another dataset, and drops it once the Find it changes moves elsewhere", async () => {
    // This dataset has an edit of the same name, which says nothing about where the Set's records are.
    const table: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS, "entries.edit:edit")]]), actions: [] };
    const saved: Automation = { ...stamp, when: { kind: "record-added", table: "Invoices" }, do: [
      { kind: "find", condition: "true", collection: "Ledger", as: "rent", operation: "entries.list" },
      { kind: "set", values: [{ field: "Amount", value: { kind: "literal", value: 0 } }], records: "rent", operation: "entries.edit" },
    ] };
    const { written } = ledgerBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel table={table} />);
    await openBuilder(user);
    await screen.findByRole("combobox", { name: "Step 1, table" });
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual(saved.do);

    await openBuilder(user, "Stamp the finish date!");
    await screen.findByRole("combobox", { name: "Step 1, table" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, Collection" }), "Log");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2), SLOW);
    expect(written[1]!.automations[0]!.do).toEqual([
      { ...saved.do[0], collection: "Log", operation: null },
      { ...saved.do[1], operation: null },
    ]);
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

  it("finds records in a document Collection from a dataset, with that Collection's fields", async () => {
    const table: AutomationTable = { name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS, "invoices.list:read")]]), actions: [] };
    const { written } = ledgerBridge(read([summary({ ...stamp, when: { kind: "record-added", table: "Invoices" } })]));
    const user = userEvent.setup();
    render(<Panel table={table} />);
    await openBuilder(user);
    await user.click(screen.getByRole("button", { name: "Find records" }));
    await waitFor(() => expect(options("Step 2, Collection").map(([name]) => name)).toEqual(["Tasks", "Log", "Ledger"]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, Collection" }), "Log");
    expect(screen.queryByRole("combobox", { name: "Step 2, table" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, records to find" }), "rows");
    expect(options("Step 2, condition 1, comparison").map(([name]) => name)).toEqual(["is", "contains"]);
    await waitFor(() => expect(options("Step 2, condition 1, field").map(([name]) => name)).toContain("Entry"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, condition 1, field" }), "Entry");
    await user.type(screen.getByRole("textbox", { name: "Step 2, condition 1, value" }), "Paid");
    await user.type(screen.getByRole("textbox", { name: "Step 2, result name" }), "paid");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[1]).toEqual({ kind: "find", condition: 'record.Entry == "Paid"', collection: "Log", as: "paid", operation: null });
  }, 30_000);
});

describe("the builder's Groups", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));
  const GROUPS = [
    { name: "Board", slug: "board", ref: "Board", readStopped: "ana@dohc.test cannot read Board.", postStopped: "ana@dohc.test cannot post in Board." },
    { name: "Trip", slug: "trip", ref: "Trip", readStopped: null, postStopped: null },
  ];
  const options = (name: string) => [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options]
    .map((option) => [option.textContent, option.disabled]);

  it("starts an automation from a Group's messages and posts in a Group, offering only Groups it can use", async () => {
    const { bridge, written } = makeBridge(read([]));
    bridge.listAutomationGroups.mockResolvedValue({ groups: GROUPS });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    // Groups are read only once a Group choice is on screen.
    expect(bridge.listAutomationGroups).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "group-message");
    await waitFor(() => expect(bridge.listAutomationGroups).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Tasks" }));
    await waitFor(() => expect(options("Group")).toEqual([["Choose a Group", true], ["Board (ana@dohc.test cannot read Board.)", true], ["Trip", false]]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Group" }), "Trip");
    await user.type(screen.getByRole("textbox", { name: "Starts with" }), " /task");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Remove the space at the start.")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Starts with" }));
    await user.type(screen.getByRole("textbox", { name: "Starts with" }), "/task");

    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Post in a Group" }));
    // The Groups are on hand now, so a new post starts in the first Group it can post in.
    expect((screen.getByRole("combobox", { name: "Step 1, Group" }) as HTMLSelectElement).value).toBe("Trip");
    await user.type(screen.getByRole("textbox", { name: "Step 1, message" }), "New task: ");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, insert value" }), "message.body");
    expect((screen.getByRole("textbox", { name: "Step 1, message" }) as HTMLTextAreaElement).value).toBe("New task: {message.body}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]).toMatchObject({
      when: { kind: "group-message", group: "Trip", startsWith: "/task" },
      do: [{ kind: "post", text: "New task: {message.body}", group: "Trip" }],
    });
  }, 30_000);

  it("chooses and writes Groups that share a name by slug, and says when a saved name matches two", async () => {
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [
      { kind: "post", text: "Done", group: "Plans" },
      { kind: "post", text: "Done", group: "plans-2" },
    ] })]));
    bridge.listAutomationGroups.mockResolvedValue({ groups: [
      { name: "Plans", slug: "plans", ref: "plans", readStopped: null, postStopped: null },
      { name: "Plans", slug: "plans-2", ref: "plans-2", readStopped: null, postStopped: null },
    ] });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect(await within(screen.getByTestId("builder-step-0")).findByText("More than one Group is called Plans. Choose one.")).toBeTruthy();
    expect(options("Step 2, Group")).toEqual([["Plans, plans", false], ["Plans, plans-2", false]]);
    expect((screen.getByRole("combobox", { name: "Step 2, Group" }) as HTMLSelectElement).value).toBe("plans-2");
    expect(within(screen.getByTestId("builder-step-1")).queryByText(/More than one Group/u)).toBeNull();
  }, 30_000);

  it("says Groups are unavailable in a shared view, and reports a failed read once", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [{ kind: "post", text: "Done", group: "" }, { kind: "post", text: "Done", group: "Trip" }] })]));
    bridge.listAutomationGroups.mockResolvedValueOnce({ status: "unavailable" });
    const user = userEvent.setup();
    const { unmount } = render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(options("Step 1, Group")[0]).toEqual(["Groups are unavailable here", true]));
    // A saved Group says so too.
    expect(within(screen.getByTestId("builder-step-1")).getByText("Groups are unavailable in a shared view.")).toBeTruthy();
    unmount();

    bridge.listAutomationGroups.mockRejectedValue(new Error("offline"));
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(options("Step 1, Group")[0]).toEqual(["Groups could not be listed", true]));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(bridge.listAutomationGroups.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(onError.mock.calls.filter(([message]) => message === "dohc could not list the Groups an automation can use.")).toHaveLength(1);
  }, 30_000);

  it("reads nothing from a Try again once no Group is being chosen, and reports the next failure with its own", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [{ kind: "post", text: "Done", group: "Trip" }] })]));
    bridge.listAutomationGroups.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not list the Groups an automation can use.", expect.any(Error), expect.any(Function)));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    const calls = bridge.listAutomationGroups.mock.calls.length;
    act(() => (onError.mock.calls[0]![2] as () => void)());
    expect(bridge.listAutomationGroups.mock.calls.length).toBe(calls);

    // A new Post in a Group reads again, and a failure then is reported with a Try again that reads.
    bridge.listAutomationGroups.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Post in a Group" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    const again = bridge.listAutomationGroups.mock.calls.length;
    act(() => (onError.mock.calls[1]![2] as () => void)());
    expect(bridge.listAutomationGroups.mock.calls.length).toBe(again + 1);
  }, 30_000);

  it("keeps a saved Group it cannot use or find, says why, and shows a message's brace problem beside it", async () => {
    const { bridge, written } = makeBridge(read([summary({ ...stamp, do: [
      { kind: "post", text: "Done", group: "Board" },
      { kind: "post", text: "Done", group: "Old" },
      // A file may name a Group by its slug.
      { kind: "post", text: "Done", group: "trip" },
    ] })]));
    bridge.listAutomationGroups.mockResolvedValue({ groups: GROUPS });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const board = screen.getByTestId("builder-step-0");
    expect(await within(board).findByText("ana@dohc.test cannot post in Board.")).toBeTruthy();
    expect((within(board).getByRole("combobox", { name: "Step 1, Group" }) as HTMLSelectElement).value).toBe("Board");
    expect(within(screen.getByTestId("builder-step-1")).getByText("This computer has no Group named Old. Choose another.")).toBeTruthy();
    expect(within(screen.getByTestId("builder-step-2")).queryByText(/no Group named/u)).toBeNull();

    const message = screen.getByRole("textbox", { name: "Step 1, message" });
    await user.clear(message);
    await user.type(message, "Done {{record.Title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(board).findByText(/^Check each \{expression\} in the message/u, undefined, SLOW)).toBeTruthy();
    expect(message.getAttribute("aria-invalid")).toBe("true");
    expect(written).toEqual([]);
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
  const options = (name: string) => [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options]
    .map((option) => [option.textContent, option.disabled]);
  const chosen = (name: string) => {
    const select = screen.getByRole("combobox", { name }) as HTMLSelectElement;
    return select.options[select.selectedIndex]?.textContent;
  };
  const literal = (value: string) => ({ kind: "literal" as const, value });

  it("sends a direct message only where a conversation exists, or to a person a formula names", async () => {
    const { bridge, written } = makeBridge(read([]));
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: PEOPLE });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Changes to" }), "Done");
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    // People are read only once a step that names them is on screen.
    expect(bridge.listAutomationPeople).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send a direct message" }));
    await waitFor(() => expect(bridge.listAutomationPeople).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Tasks" }));
    await waitFor(() => expect(options("Step 1, person 1")).toEqual([
      ["Choose a person", true], [`You (${TO_YOU})`, true], ["ana@dohc.test", false], [`bob@dohc.test (${NO_DM_BOB})`, true], ["Formula", false],
    ]));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 1, person 1" }));
    expect(screen.getByTestId("builder-step-0").textContent).toContain("Send a direct message");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose a person.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Step 1, person 1" }).getAttribute("aria-invalid")).toBe("true");

    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, person 1" }), "ana@dohc.test");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 1, person 2" })));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, person 2" }), "Formula");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const formula = screen.getByRole("textbox", { name: "Step 1, person 2, formula" });
    expect(document.getElementById(formula.getAttribute("aria-describedby")!)?.textContent).toBe("Write a formula.");
    await user.type(formula, "person.id");
    // A formula's person gets the message only through a conversation they already have.
    expect(screen.getByText("dohc sends it only to a person you already have a direct message with.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Step 1, message" }), "Done");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([
      { kind: "direct-message", text: "Done", to: [literal("user-ana"), { kind: "formula", expression: "person.id" }] },
    ]);
  }, 30_000);

  it("notifies people and you, and keeps a saved person it cannot reach or find with why", async () => {
    const { bridge, written } = makeBridge(read([summary({ ...stamp, do: [
      { kind: "notify", text: "Done", to: [literal("user-ana"), literal("user-gone")] },
    ] })]));
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: PEOPLE });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const step = screen.getByTestId("builder-step-0");
    expect(await within(step).findByText("ana@dohc.test cannot view Tasks.")).toBeTruthy();
    expect(step.textContent).toContain("Notify");
    expect(options("Step 1, person 1")).toEqual([
      ["You", false], ["ana@dohc.test (ana@dohc.test cannot view Tasks.)", false], ["bob@dohc.test", false], ["Formula", false],
    ]);
    expect(chosen("Step 1, person 2")).toBe("Someone not listed");
    expect(within(step).getByText("dohc cannot find this person among the people this workspace is shared with. Choose someone else.")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, person 2" }), "You");
    await user.click(screen.getByRole("button", { name: "Remove person 1 from step 1" }));
    // Focus moves to the row that took its place.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove person 1 from step 1" })));
    expect(screen.getByTestId("builder-step-0").textContent).toContain("Notify you");
    await user.click(screen.getByRole("button", { name: "Remove person 1 from step 1" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add person" })));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add a person.")).toBeTruthy();
    expect(written).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, person 1" }), "You");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ kind: "notify", text: "Done", to: [literal("user-owner")] }]);
  }, 30_000);

  it("reads people again when a share changes while editing, and reports a failed read once", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [{ kind: "direct-message", text: "Done", to: [literal("user-ana")] }] })]));
    const holdListeners: Array<(event: { workspaceId: string }) => void> = [];
    bridge.onAutomationHoldsChanged.mockImplementation((listener: (event: { workspaceId: string }) => void) => {
      holdListeners.push(listener);
      return () => undefined;
    });
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: PEOPLE });
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(chosen("Step 1, person 1")).toBe("ana@dohc.test"));
    const stopped = "bob@dohc.test cannot post in your direct message with ana@dohc.test.";
    expect(screen.queryByText(stopped)).toBeNull();

    // Bob gets Edit on Tasks, so a run could no longer post in the direct message.
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: PEOPLE.map((person) =>
      person.userId === "user-ana" ? { ...person, dmStopped: stopped } : person) });
    // A reply for another workspace reads nothing.
    act(() => holdListeners.forEach((listener) => listener({ workspaceId: "ws-2" })));
    const before = bridge.listAutomationPeople.mock.calls.length;
    act(() => holdListeners.forEach((listener) => listener({ workspaceId: "ws-1" })));
    expect(await within(screen.getByTestId("builder-step-0")).findByText(stopped)).toBeTruthy();
    expect(bridge.listAutomationPeople.mock.calls.length).toBeGreaterThan(before);
    // The saved person stays chosen, with why.
    expect(chosen("Step 1, person 1")).toBe(`ana@dohc.test (${stopped})`);

    bridge.listAutomationPeople.mockRejectedValue(new Error("offline"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listAutomationPeople.mock.calls.length).toBeGreaterThanOrEqual(before + 3));
    expect(onError.mock.calls.filter(([message]) => message === "dohc could not list the people an automation can message.")).toHaveLength(1);
    // What it last read stays on screen.
    expect(chosen("Step 1, person 1")).toBe(`ana@dohc.test (${stopped})`);
  }, 30_000);

  it("says why people are not listed in a shared view, while dohc waits for the roster, or after a failed first read", async () => {
    // A person not chosen yet, and a saved one dohc cannot name without the list.
    const saved = read([summary({ ...stamp, do: [{ kind: "direct-message", text: "Done", to: [literal(""), literal("user-ana")] }] })]);
    const { bridge } = makeBridge(saved);
    bridge.listAutomationPeople.mockResolvedValueOnce({ status: "unavailable" });
    const user = userEvent.setup();
    const first = render(<Panel />);
    await openBuilder(user);
    expect(await screen.findByText("People are unavailable in a shared view.")).toBeTruthy();
    expect(options("Step 1, person 1")[0]).toEqual(["People are unavailable here", true]);
    expect(chosen("Step 1, person 2")).toBe("A saved person");
    first.unmount();

    bridge.listAutomationPeople.mockResolvedValueOnce({ status: "waiting", reason: "dohc cannot check who can edit Tasks yet." });
    const second = render(<Panel />);
    await openBuilder(user);
    expect(await screen.findByText("dohc cannot check who can edit Tasks yet.")).toBeTruthy();
    expect(options("Step 1, person 1")[0]).toEqual(["Waiting for the list of people", true]);
    expect(chosen("Step 1, person 2")).toBe("A saved person");
    second.unmount();

    bridge.listAutomationPeople.mockRejectedValueOnce(new Error("offline"));
    render(<Panel />);
    await openBuilder(user);
    expect(await screen.findByText("dohc could not list the people this workspace is shared with.")).toBeTruthy();
    expect(options("Step 1, person 1")[0]).toEqual(["People could not be listed", true]);
    expect(chosen("Step 1, person 2")).toBe("A saved person");
  }, 30_000);

  it("reads nothing from a Try again once no step names people, and reports the next failure with its own", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(read([summary({ ...stamp, do: [{ kind: "direct-message", text: "Done", to: [literal("user-ana")] }] })]));
    bridge.listAutomationPeople.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not list the people an automation can message.", expect.any(Error), expect.any(Function)));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    const calls = bridge.listAutomationPeople.mock.calls.length;
    const retry = onError.mock.calls[0]![2] as () => void;
    act(() => retry());
    expect(bridge.listAutomationPeople.mock.calls.length).toBe(calls);

    // A new step that names people reads again, and a failure then is reported with a Try again that reads.
    bridge.listAutomationPeople.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Send a direct message" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    const again = bridge.listAutomationPeople.mock.calls.length;
    act(() => (onError.mock.calls[1]![2] as () => void)());
    expect(bridge.listAutomationPeople.mock.calls.length).toBe(again + 1);
  }, 30_000);

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

  it("offers only you in a workspace never shared, signed out, and never shows how steps name you", async () => {
    const { bridge, written } = makeBridge({ status: "missing", you: "install-here" });
    bridge.listAutomationPeople.mockResolvedValue({ status: "listed", people: [
      { userId: "install-here", name: "you", you: true, dmStopped: TO_YOU, noticeStopped: null },
    ] });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Changes to" }), "Done");
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(screen.queryByRole("button", { name: "Notify" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Notify you" }));
    await waitFor(() => expect(options("Step 1, person 1")).toEqual([["You", false], ["Formula", false]]));
    await user.click(screen.getByRole("button", { name: "Send a direct message" }));
    await waitFor(() => expect(options("Step 2, person 1")).toEqual([["Choose a person", true], [`You (${TO_YOU})`, true], ["Formula", false]]));
    expect(within(screen.getByTestId("builder-step-1")).getByText("No other people are listed for this workspace.")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("install-here");
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    await user.type(screen.getByRole("textbox", { name: "Step 1, message" }), "Task done");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ kind: "notify", text: "Task done", to: [literal("install-here")] }]);
  }, 30_000);
});

describe("the builder's schedule", () => {
  const NOW = Date.UTC(2026, 8, 25, 10);
  // The builder shows a schedule's next run in the schedule's own time zone, and names it.
  const nextRun = (ms: number, timeZone: string) => `Next run ${new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone,
  }).format(ms)}, ${timeZone}`;
  const monthly: Automation = {
    ...stamp,
    id: "rent",
    name: "Pay rent",
    when: { kind: "schedule", every: "month", at: "08:00", days: [31], timezone: "Asia/Calcutta" },
    do: [{ kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "Rent" } }], collection: null, as: null, operation: null }],
  };
  const checkboxes = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("checkbox");
  const box = (group: string, name: string) => within(screen.getByRole("group", { name: group })).getByRole("checkbox", { name });
  const value = (name: string) => (screen.getByRole("combobox", { name }) as HTMLSelectElement).value;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a weekly schedule, asks for a day, and says a set step has no record to change", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { written } = makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "schedule");
    expect(value("Repeats")).toBe("day");
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("09:00");
    expect(value("Time zone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(within(screen.getByRole("combobox", { name: "Time zone" })).getAllByRole("option")[0]!.textContent).toBe("UTC");
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "week");
    expect(checkboxes("Days").filter((day) => (day as HTMLInputElement).checked)).toEqual([box("Days", "Mon")]);
    await user.click(box("Days", "Mon"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose at least one day.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box("Days", "Mon")));
    expect(written).toEqual([]);

    await user.click(box("Days", "Fri"));
    await user.click(box("Days", "Wed"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Time zone" }), "Europe/London");
    const time = screen.getByLabelText("Time");
    // While the time is empty there is no next run to show, and no problem with the time zone.
    fireEvent.change(time, { target: { value: "" } });
    expect(screen.queryByText(/Next run|does not know/u)).toBeNull();
    fireEvent.change(time, { target: { value: "07:30" } });
    // Wednesday 30 September, 7:30 in London, which is 6:30 UTC in summer time.
    expect(screen.getByText(nextRun(Date.UTC(2026, 8, 30, 6, 30), "Europe/London"))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(screen.getByTestId("builder-step-0")).findByText("This trigger has no record to set fields on.", undefined, SLOW)).toBeTruthy();
    expect(written).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, field 1" }), "Title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.when).toEqual({ kind: "schedule", every: "week", at: "07:30", days: ["wed", "fri"], timezone: "Europe/London" });
  }, 30_000);

  it("keeps a time zone the file names by an older name, and a month's last days, as written", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { written } = makeBridge(read([summary(monthly)]));
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "Pay rent" }));
    expect(value("Time zone")).toBe("Asia/Calcutta");
    expect(checkboxes("Days of the month").filter((day) => (day as HTMLInputElement).checked)).toEqual([box("Days of the month", "31")]);
    expect(screen.getByText("In a shorter month, a later day runs on the month's last day.")).toBeTruthy();
    // 30 September is that month's last day; 8:00 in India is 2:30 UTC.
    expect(screen.getByText(nextRun(Date.UTC(2026, 8, 30, 2, 30), "Asia/Calcutta"))).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.when).toEqual(monthly.when);

    await user.click(await screen.findByRole("button", { name: "Pay rent!" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "hour");
    expect(value("Minutes past the hour")).toBe(":00");
    await user.selectOptions(screen.getByRole("combobox", { name: "Minutes past the hour" }), ":45");
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "weekday");
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("09:45");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(2), SLOW);
    expect(written[1]!.automations[0]!.when).toEqual({ kind: "schedule", every: "weekday", at: "09:45", timezone: "Asia/Calcutta" });
  }, 30_000);

  it("asks for a formula instead of field rows on a schedule, and says when no computer runs schedules", async () => {
    const { bridge, written } = makeBridge(read([summary({ ...monthly, if: "record.Points == 3" })]));
    bridge.readScheduleHost.mockResolvedValue({ kind: "relay", generation: 1, hostInstallId: null, handoverFrom: null, computers: [] });
    const onOpenScheduleSettings = vi.fn();
    const user = userEvent.setup();
    render(<Panel onOpenScheduleSettings={onOpenScheduleSettings} />);
    await user.click(await screen.findByRole("button", { name: "Pay rent" }));
    const note = await within(screen.getByRole("region", { name: "When" })).findByTestId("schedule-host-missing");
    await user.click(within(note).getByRole("button", { name: "Choose a computer" }));
    expect(onOpenScheduleSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This trigger has no record to compare. Choose Always, or write a formula.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Condition" })));
    expect(written).toEqual([]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition" }), "always");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
  }, 30_000);

  it("runs a new action on a schedule without the record's id", async () => {
    makeBridge(read([]));
    const user = userEvent.setup();
    render(<Panel table={{ name: "Invoices", tables: new Map([["Invoices", datasetTable(FIELDS)]]),
      actions: [{ name: "invoices.remind", label: "Remind", table: "Invoices", reversible: true }] }} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "schedule");
    await user.click(screen.getByRole("button", { name: "Run an action" }));
    expect(screen.queryByRole("textbox", { name: "Step 2, input 1 name" })).toBeNull();
  });
});

describe("an automation's runs", () => {
  const failed = run({
    claimId: "atc_failed", state: "failed", error: "ana@dohc.test cannot edit Budget",
    writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Finished on", before: null, after: "2026-09-25" }],
  });
  const stopped = run({ claimId: "atc_stopped", state: "failed", error: "chain-stopped", neverStarted: true, chainStopped: true });
  const TOO_LARGE = "This change was too large for dohc to start automations for every record. Change fewer records at a time.";
  const unclaimed = run({ claimId: "atc_unclaimed", state: "failed", error: TOO_LARGE, neverStarted: true });

  it("reads only the next page for older runs, shows it loading, and keeps it through a refresh", async () => {
    const { bridge } = makeBridge(read([summary(stamp)]));
    let older: (() => void) | null = null;
    const newest = run({ claimId: "atc_new", createdAtMs: 2, writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Done", before: null, after: true }] });
    bridge.listCollectionAutomationRuns.mockImplementation(async (payload) => {
      if (payload?.before === undefined) return { status: "listed", runs: [newest], next: "2:atc_new" };
      await new Promise<void>((resolve) => { older = resolve; });
      return { status: "listed", runs: [run({ claimId: "atc_older", createdAtMs: 1 })], next: null };
    });
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    await screen.findByTestId("automation-run-atc_new");
    const calls = () => bridge.listCollectionAutomationRuns.mock.calls.length;
    const shown = calls();
    await userEvent.click(screen.getByRole("button", { name: "Older runs" }));
    const button = screen.getByRole("button", { name: "Older runs" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => older!());
    await screen.findByTestId("automation-run-atc_older");
    // One read, of the next page only.
    expect(calls()).toBe(shown + 1);
    expect(bridge.listCollectionAutomationRuns).toHaveBeenLastCalledWith({ workspaceId: "ws-1", automationId: "collection:Tasks#stamp", before: "2:atc_new" });
    expect(screen.queryByRole("button", { name: "Older runs" })).toBeNull();
    // The refresh after an Undo reads the newest page only, and the older page stays.
    await userEvent.click(within(screen.getByTestId("automation-run-atc_new")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls()).toBe(shown + 2));
    expect(bridge.listCollectionAutomationRuns).toHaveBeenLastCalledWith({ workspaceId: "ws-1", automationId: "collection:Tasks#stamp" });
    expect(screen.getByTestId("automation-run-atc_older")).toBeDefined();
  });

  it("says so when the run a notice names is no longer in run history", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(read([summary(stamp)]), [run({ claimId: "atc_new" })]);
    render(<Panel onError={onError} focus={{ automationId: "collection:Tasks#stamp", run: "atc_gone", seq: 1 }} />);
    await screen.findByTestId("automation-run-atc_new");
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "This run is no longer in run history. dohc keeps runs for 30 days after they end.", expect.any(Error),
    ));
    expect(bridge.getCollectionAutomationRun).toHaveBeenCalledTimes(1);
  });

  it("opens the run a notice names, first and marked when no page shown holds it, though its automation was deleted", async () => {
    const scrolled = vi.fn();
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    onTestFinished(() => { Element.prototype.scrollIntoView = scrollIntoView; });
    const { bridge } = makeBridge(read([summary(stamp)]), [run({ claimId: "atc_new" })]);
    bridge.getCollectionAutomationRun.mockResolvedValue({ status: "found", run: failed });
    render(<Panel focus={{ automationId: "collection:Tasks#gone", run: "atc_failed", seq: 1 }} />);
    const opened = await screen.findByTestId("automation-run-atc_failed");
    expect(bridge.getCollectionAutomationRun).toHaveBeenCalledWith({ workspaceId: "ws-1", automationId: "collection:Tasks#gone", claimId: "atc_failed", onServer: false });
    expect(screen.getByTestId("automation-runs").firstElementChild).toBe(opened);
    expect(opened.getAttribute("aria-current")).toBe("true");
    // Its changes show without a click.
    expect(opened.textContent).toContain("Plan · Finished on: empty → 2026-09-25");
    expect(scrolled).toHaveBeenCalled();
    expect(screen.getByTestId("automation-run-atc_new").getAttribute("aria-current")).toBeNull();
  });

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

  it("shows dataset changes in run history", async () => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    makeBridge(read([summary(stamp)]), [run({ writes: [
      { kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", expectedVersion: 1, version: 2,
        fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] },
      { kind: "dataset-created", rules, operationId: "create", tableId: "table-1", recordId: "invoice-2", version: 1, deletes: [] },
      { kind: "dataset-kept", datasetId: "data", tableId: "table", recordId: "invoice-3", fieldId: "status", field: "Status", planned: "Closed", current: "Pending" },
      { kind: "dataset-skipped", datasetId: "data", tableId: "table", recordId: "invoice-4", reason: "The record was removed" },
    ] })]);
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    const row = await screen.findByTestId("automation-run-atc_1");
    expect(row.textContent).toContain("Changed 1 field and added 1 record");
    await userEvent.click(within(row).getByRole("button", { name: "Show 4 changes" }));
    expect(row.textContent).toContain("invoice-1 · Status: Open → Closed");
    expect(row.textContent).toContain("Added invoice-2");
    expect(row.textContent).toContain("invoice-3 · Status: kept Pending");
    expect(row.textContent).toContain("invoice-4 · The record was removed.");
  });

  it("offers Undo for a dataset run's edits and says which added records stay", async () => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    const { bridge } = makeBridge(read([summary(stamp)]), [
      run({ writes: [{ kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", expectedVersion: 1, version: 2,
        fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] }] }),
      run({ claimId: "atc_added", writes: [{ kind: "dataset-created", rules, operationId: "create", tableId: "table-1", recordId: "invoice-2", version: 1, deletes: [] }] }),
    ]);
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({ ...NOTHING_UNDONE, reverted: 1, kept: 1, irreversible: 1 });
    const onNotice = vi.fn();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} onNotice={onNotice} />);
    // A run that only added records no delete reaches has nothing Undo can put back.
    expect(within(await screen.findByTestId("automation-run-atc_added")).queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(within(screen.getByTestId("automation-run-atc_1")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      "Undid 1 change. 1 added record stays. The Collection's rules do not let dohc undo 1 change.",
    ));
  });

  it("names the action a run ran, and says its changes stay when the run's edits are undone", async () => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    const { bridge } = makeBridge(read([summary(stamp)]), [
      run({ writes: [
        { kind: "dataset-action", rules, operationId: "settle", tableId: "table-1", name: "Settle", revision: 4 },
        { kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", expectedVersion: 1, version: 2, fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] },
      ] }),
      run({ claimId: "atc_action", writes: [{ kind: "dataset-action", rules, operationId: "settle", tableId: "table-1", name: "Settle", revision: 5 }] }),
    ]);
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({ ...NOTHING_UNDONE, reverted: 1, actions: 1 });
    const onNotice = vi.fn();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} onNotice={onNotice} />);
    const row = await screen.findByTestId("automation-run-atc_1");
    expect(row.textContent).toContain("Ran 1 action and changed 1 field");
    await userEvent.click(within(row).getByRole("button", { name: "Show 2 changes" }));
    expect(row.textContent).toContain("Ran Settle");
    // A run that only ran an action has nothing Undo can put back.
    expect(within(screen.getByTestId("automation-run-atc_action")).queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Undid 1 change. 1 action can't be undone."));
  });

  it("offers Undo for a run whose action has a reverse, and says it undid the action", async () => {
    const rules = { datasetId: "dataset-1", revision: 1, revisionSha256: "a".repeat(64) };
    const { bridge } = makeBridge(read([summary(stamp)]), [
      run({ writes: [{ kind: "dataset-action", rules, operationId: "hold", tableId: "table-1", name: "Hold", revision: 4, undo: { id: "invoice-1", status: "Open" } }] }),
    ]);
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({ ...NOTHING_UNDONE, actionsReversed: 1 });
    const onNotice = vi.fn();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} onNotice={onNotice} />);
    const row = await screen.findByTestId("automation-run-atc_1");
    await userEvent.click(within(row).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Undid 1 action."));
  });

  it("shows a sent message without offering record Undo", async () => {
    makeBridge(read([summary(stamp, { lastRun: { state: "done", atMs: Date.now() } })]), [
      run({ writes: [{ kind: "message", messageId: "message-1", name: "Trip" }] }),
    ]);
    render(<Panel />);
    await userEvent.click(await screen.findByRole("button", { name: /^Runs\. The last run finished/ }));
    const row = await screen.findByTestId("automation-run-atc_1");
    expect(row.textContent).toContain("Sent 1 message");
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Show 1 change" }));
    expect(row.textContent).toContain("Sent a message to Trip");
  });

  it("shows what a run changed and says what Undo skipped", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "failed", atMs: Date.now() } })]), [failed]);
    const onNotice = vi.fn();
    render(<Panel onNotice={onNotice} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Runs\. The last run failed/ }));
    const row = await screen.findByTestId("automation-run-atc_failed");
    await userEvent.click(within(row).getByRole("button", { name: "Show 1 change" }));
    expect(row.textContent).toContain("Plan · Finished on: empty → 2026-09-25");

    await userEvent.click(within(row).getByRole("button", { name: "Undo" }));
    expect(bridge.undoCollectionAutomationRun).toHaveBeenCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_failed", deletes: null, onServer: false,
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Undid 1 change. 1 field changed since then."));
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

  it("marks a run the server made, and runs its Try again and Undo on the server", async () => {
    const onServer = run({ ...failed, claimId: "atc_server", createdAtMs: failed.createdAtMs + 1,
      writes: [{ kind: "created", recordId: "rec_2", path: "Tasks/Pack.md" }] });
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "failed", atMs: Date.now() } })]), [failed], { serverRuns: [onServer] });
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({
      status: "undone", reverted: 0, removed: 1, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0, deleted: 0, keptChanged: 0, gone: 0,
    });
    const onNotice = vi.fn();
    render(<Panel onNotice={onNotice} focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    const row = await screen.findByTestId("automation-run-server-atc_server");
    expect(within(row).getByLabelText("Ran on your server")).toBeTruthy();
    // Newest first, across this computer and the server.
    expect(within(screen.getByTestId("automation-runs")).getAllByRole("listitem").map((item) => item.dataset.testid))
      .toEqual(["automation-run-server-atc_server", "automation-run-atc_failed"]);
    expect(within(screen.getByTestId("automation-run-atc_failed")).queryByLabelText("Ran on your server")).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Try again" }));
    expect(bridge.retryCollectionAutomation).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_server", startOver: false, onServer: true,
    });
    await userEvent.click(within(row).getByRole("button", { name: "Undo" }));
    expect(bridge.undoCollectionAutomationRun).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_server", deletes: null, onServer: true,
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Deleted 1 added record. History can restore them."));
  });

  it("pages the server independently and keeps its older rows when the head refreshes", async () => {
    const newest = run({ claimId: "server-new", createdAtMs: 30 });
    const older = run({ claimId: "server-old", createdAtMs: 10 });
    const { bridge, replaceFile } = makeBridge(read([summary(stamp)]), [run({ claimId: "local", createdAtMs: 20 })]);
    bridge.listServerAutomationRuns.mockImplementation(async (input) => input?.before
      ? { runs: [older], next: null } : { runs: [newest], next: "30:server-new" });
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    await userEvent.click(await screen.findByRole("button", { name: "Older runs" }));
    expect(await screen.findByTestId("automation-run-server-server-old")).toBeTruthy();
    expect(bridge.listServerAutomationRuns).toHaveBeenCalledWith({ workspaceId: "ws-1", automationId: "collection:Tasks#stamp", before: "30:server-new" });
    expect(within(screen.getByTestId("automation-runs")).getAllByRole("listitem").map((row) => row.dataset.testid))
      .toEqual(["automation-run-server-server-new", "automation-run-local", "automation-run-server-server-old"]);
    replaceFile(read([summary(stamp)]));
    await waitFor(() => expect(bridge.listServerAutomationRuns).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("automation-run-server-server-old")).toBeTruthy();
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

  it("says when the server has no runs either, and still shows this computer's runs when the server fails", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: null })]), [], { serverRuns: [] });
    const onError = vi.fn();
    render(<Panel onError={onError} focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 1 }} />);
    expect(await screen.findByText("This automation has not run on this computer or your server yet.")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    cleanup();
    bridge.listCollectionAutomationRuns.mockResolvedValue({ status: "listed", runs: [failed], next: null });
    bridge.listServerAutomationRuns.mockRejectedValue(new Error("Your server answered with 500."));
    render(<Panel onError={onError} focus={{ automationId: "collection:Tasks#stamp", run: null, seq: 2 }} />);
    expect(await screen.findByTestId("automation-run-atc_failed")).toBeTruthy();
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "dohc could not read this automation's runs on your server.", expect.any(Error), expect.any(Function),
    ));
  });
});

describe("the builder", () => {
  const openBuilder = async (user: ReturnType<typeof userEvent.setup>, name = "Stamp the finish date") =>
    await user.click(await screen.findByRole("button", { name }));

  it("makes \"when Status becomes Done, set Finished on to today\" in three actions", async () => {
    const { written } = makeBridge({ status: "missing" });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    // The value reads as "Status to Done": one choice lists the field's options.
    await user.selectOptions(screen.getByRole("combobox", { name: "Changes to" }), "Done");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({
      expectedContentHash: null,
      reformat: false,
      automations: [{
        id: "when-status-becomes-done-set-finished-on-to-today",
        name: "When Status becomes Done, set Finished on to today",
        enabled: true,
        when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: null },
        if: null,
        do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null, operation: null }],
      }],
    });
    expect(await screen.findByTestId("automation-when-status-becomes-done-set-finished-on-to-today")).toBeTruthy();
  });

  it("notifies you and wakes your agent in a workspace never shared, and never shows how steps name you", async () => {
    const { written } = makeBridge({ status: "missing", you: "install-here" });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Changes to" }), "Done");
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Notify you" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Write a message.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Step 1, message" }), "Task done");
    await user.click(screen.getByRole("button", { name: "Wake your agent" }));
    await user.type(screen.getByRole("textbox", { name: "Step 2, message" }), "Plan the next task");
    expect(screen.getByTestId("builder-step-0").textContent).toContain("Notify you");
    expect(screen.getByTestId("builder-step-1").textContent).toContain("Wake your agent");
    expect(document.body.innerHTML).not.toContain("install-here");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.do).toEqual([
      { kind: "notify", text: "Task done", to: [{ kind: "literal", value: "install-here" }] },
      { kind: "wake-agent", text: "Plan the next task", person: "install-here" },
    ]);
  });

  it("keeps a message's lines, and says how to fix a brace it cannot read", async () => {
    const told: Automation = { ...stamp, do: [{ kind: "notify", text: "Done\nNext: review", to: [{ kind: "literal", value: "install-here" }] }] };
    const { written } = makeBridge({ status: "read", contentHash: HASH, automations: [summary(told)], addsStay: [], you: "install-here" });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    const message = screen.getByRole("textbox", { name: "Step 1, message" }) as HTMLTextAreaElement;
    expect(message.value).toBe("Done\nNext: review");
    // userEvent reads "{{" as one "{".
    await user.type(message, " {{");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Check each {expression} in the message: close its brace and fix its formula. To write a brace itself, type {{ or }}.", undefined, SLOW)).toBeTruthy();
    expect(written).toEqual([]);
  });

  it("offers no step for you where steps cannot name you", async () => {
    makeBridge({ status: "missing" });
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    expect(screen.queryByRole("button", { name: "Notify you" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wake your agent" })).toBeNull();
  });

  it("edits conditions as rows, keeps a number while it is typed, and keeps steps it cannot edit", async () => {
    const find = { kind: "find" as const, condition: 'record.Status == "Doing"', collection: null, as: "open", operation: null };
    const edited: Automation = { ...stamp, if: "record.Points == 3", do: [...stamp.do, find] };
    const { written } = makeBridge(read([summary(edited)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);

    expect((screen.getByRole("combobox", { name: "Condition" }) as HTMLSelectElement).value).toBe("rows");
    const value = screen.getByRole("textbox", { name: "Condition 1, value" }) as HTMLInputElement;
    expect(value.value).toBe("3");
    expect((screen.getByRole("combobox", { name: "Step 2, condition 1, value" }) as HTMLSelectElement).value).toBe("Doing");
    await user.clear(value);
    await user.type(value, "-");
    // A minus sign alone stays put, and is not a number yet.
    expect((screen.getByRole("textbox", { name: "Condition 1, value" }) as HTMLInputElement).value).toBe("-");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a number.")).toBeTruthy();
    expect(written).toEqual([]);

    await user.type(screen.getByRole("textbox", { name: "Condition 1, value" }), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations).toEqual([{ ...edited, if: "record.Points == -5" }]);
  });

  it("shows a code step's code, opens the file a step runs, and keeps both steps as the file wrote them", async () => {
    const code = "const total = record => record.Count * 2;\nreturn { output: total(ctx.record) };";
    const coded: Automation = { ...stamp, do: [...stamp.do, { kind: "run", code, as: "total" }, { kind: "run-file", file: "scripts/notify.js", as: null }] };
    const { written } = makeBridge(read([summary(coded)]));
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(<Panel onOpenFile={onOpenFile} />);
    await openBuilder(user);

    expect(within(screen.getByTestId("builder-step-1")).getByText("Run code")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Step 2, code" }) as HTMLTextAreaElement).value).toBe(code);
    // Lines stay whole, so a syntax error's line number is the line on screen.
    expect(screen.getByRole("textbox", { name: "Step 2, code" }).getAttribute("wrap")).toBe("off");
    const file = screen.getByTestId("builder-step-2");
    expect((within(file).getByRole("textbox", { name: "Step 3, file" }) as HTMLInputElement).value).toBe("scripts/notify.js");
    await user.click(within(file).getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("Tasks/scripts/notify.js");

    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations).toEqual([{ ...coded, name: "Stamp the finish date!" }]);
  });

  it("writes code in a step, inside an If too, shows its syntax error without running it, and saves it with its result name", async () => {
    const titled = { kind: "set" as const, values: [{ field: "Title", value: { kind: "literal" as const, value: "x" } }], records: null, operation: null };
    const { written } = makeBridge(read([summary({ ...stamp, do: [{ kind: "if", if: "record.Points > 1", do: [titled], otherwise: [] }] })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.click(within(screen.getByRole("group", { name: "Step 1, Do" })).getByRole("button", { name: "Run code" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 3, code source" }));
    const code = screen.getByRole("textbox", { name: "Step 3, code" });
    await user.type(code, "const total = 2;{enter}return {{ total: total + };");
    expect(await screen.findByText("The code has a syntax error. Unexpected token on line 2.", undefined, SLOW)).toBeTruthy();
    expect(code.getAttribute("aria-invalid")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(written).toEqual([]);

    await user.clear(code);
    await user.type(code, "return {{ total: 2 };");
    await user.type(screen.getByRole("textbox", { name: "Step 3, result name" }), "doubled");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[0]).toMatchObject({ kind: "if", do: [titled, { kind: "run", code: "return { total: 2 };", as: "doubled" }] });
  }, 30_000);

  it("keeps code past the bound whole and says so, and names a field called run's formula error as a formula's", async () => {
    const saved: Automation = { ...stamp, do: [
      { kind: "set", values: [{ field: "run", value: { kind: "formula", expression: "1 +" } }], records: null, operation: null },
      { kind: "run", code: "return 1;", as: null },
    ] };
    const { written } = makeBridge(read([summary(saved)]));
    const user = userEvent.setup();
    render(<Panel fields={[...FIELDS, { name: "run", type: "text" }]} />);
    await openBuilder(user);
    expect(await screen.findByText("This formula has a syntax error. Unexpected token.", undefined, SLOW)).toBeTruthy();
    const code = screen.getByRole("textbox", { name: "Step 2, code" }) as HTMLTextAreaElement;
    const long = `return ${JSON.stringify("x".repeat(8_000))};`;
    fireEvent.change(code, { target: { value: long } });
    expect(code.value).toBe(long);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This code is longer than 8,000 characters. Move it to a file.")).toBeTruthy();
    expect(written).toEqual([]);
  }, 30_000);

  it("moves code into a file it creates, keeps the code while the step names a file, and refuses a path outside the folder", async () => {
    const { bridge, written } = makeBridge(read([summary({ ...stamp, do: [{ kind: "run", code: "return 1;", as: null }] })]));
    const checkBy = bridge.checkCollectionAutomation.getMockImplementation()!;
    bridge.checkCollectionAutomation.mockImplementation(async (payload: { automation: Automation }) => ({
      ...(await checkBy(payload)),
      missingFiles: payload.automation.do.flatMap((step) => (step.kind === "run-file" && step.file === "scripts/one.js" ? [step.file] : [])),
    }));
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(<Panel onOpenFile={onOpenFile} />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, code source" }), "run-file");
    const file = screen.getByRole("textbox", { name: "Step 1, file" });
    await user.type(file, "../one.js");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Write the path inside its folder, with / between folders, and no .. or leading /.", undefined, SLOW)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open file" }) as HTMLButtonElement).disabled).toBe(true);
    expect(written).toEqual([]);

    await user.clear(file);
    await user.type(file, "scripts/one.js");
    expect(await screen.findByText("Tasks has no file scripts/one.js. Create it to write the code there.", undefined, SLOW)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open file" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Create file" }));
    // The file starts with the code the step held.
    await waitFor(() => expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "Tasks/scripts/one.js", initialText: "return 1;" }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("Tasks/scripts/one.js"));

    // Switching back finds the code again.
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, code source" }), "run");
    expect((screen.getByRole("textbox", { name: "Step 1, code" }) as HTMLTextAreaElement).value).toBe("return 1;");
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, code source" }), "run-file");
    expect((screen.getByRole("textbox", { name: "Step 1, file" }) as HTMLInputElement).value).toBe("scripts/one.js");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do).toEqual([{ kind: "run-file", file: "scripts/one.js", as: null }]);
  }, 30_000);

  it("shows a formula's syntax error beside it and does not save until it is fixed", async () => {
    const { written, bridge } = makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition" }), "formula");
    await user.type(screen.getByRole("textbox", { name: "Condition formula" }), "record.Points ==");
    expect(await screen.findByText("This formula has a syntax error. Unexpected token.", undefined, SLOW)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(written).toEqual([]);

    await user.type(screen.getByRole("textbox", { name: "Condition formula" }), " 3");
    // Main checks the whole draft.
    await waitFor(() => expect(bridge.checkCollectionAutomation).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", collectionPath: "Tasks", automation: expect.objectContaining({ if: "record.Points == 3" }),
    }), SLOW);
    await waitFor(() => expect(screen.queryByText(/syntax error/)).toBeNull(), SLOW);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.if).toBe("record.Points == 3");
  }, 30_000);

  it("shows a syntax error in an action's input on its step, inside an If too, and does not save", async () => {
    const settle: Automation = { ...stamp, id: "settle", name: "Settle", do: [{
      kind: "if", if: "true",
      do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [{ key: "note", value: { kind: "literal", value: "x" } }] }],
      otherwise: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [{ key: "id", value: { kind: "formula", expression: "record.id +" } }] }],
    }] };
    const { written, bridge } = makeBridge(read([summary(settle)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Settle");
    await waitFor(() => expect(bridge.checkCollectionAutomation).toHaveBeenCalled(), SLOW);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^The formula for id has a syntax error\./u, undefined, SLOW)).toBeTruthy();
    expect(written).toEqual([]);
  }, 30_000);

  it("never saves what the file contract refuses: a removed record's fields, or what main's check turns down", async () => {
    const { written } = makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "record-removed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A removed record has no fields to set. Choose another trigger, or remove this step.")).toBeTruthy();
    expect(written).toEqual([]);
    // No control reads that problem, so focus goes into the step, never to a control that moves or removes it.
    await waitFor(() => expect(screen.getByTestId("builder-step-0").contains(document.activeElement)).toBe(true), SLOW);
    expect(document.activeElement?.getAttribute("aria-label")).not.toMatch(/^(Move|Remove) step/u);

    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "record-added");
    // A new Add a record step starts with a field to fill in.
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    expect(screen.getByRole("combobox", { name: "Step 2, field 1" })).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Title");
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "=Stamp");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Only a value can be a formula, so this cannot start with =.")).toBeTruthy();
    expect(written).toEqual([]);
  });

  it("names a missing field, shows each step's reach, and offers a Collection a step cannot reach disabled, with why", async () => {
    const missing: Automation = { ...stamp, do: [{ kind: "set", values: [{ field: "Done on", value: { kind: "literal", value: "x" } }], records: null, operation: null }] };
    const budget = { kind: "add-record" as const, values: [], collection: "Budget", as: null, operation: null };
    const find = { kind: "find" as const, condition: 'record.Status == "Open"', collection: "Budget", as: "bills", operation: null };
    makeBridge(read([summary({ ...missing, do: [...missing.do, budget, find] }, {
      cannotRun: "Done on is not a field in Tasks.",
      reach: { kind: "checked", steps: [
        { verdict: "allowed" },
        { verdict: "stopped", reason: "ana@dohc.test cannot edit Budget." },
        { verdict: "stopped", reason: "ana@dohc.test cannot view Budget." },
      ] },
    })]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);

    expect(screen.getAllByText("Done on is not a field in Tasks.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("builder-step-2").textContent).toContain("ana@dohc.test cannot view Budget.");
    const collection = await screen.findByRole("combobox", { name: "Step 2, Collection" }) as HTMLSelectElement;
    expect(await screen.findByText("ana@dohc.test cannot edit Budget.")).toBeTruthy();
    expect([...collection.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["Tasks", false], ["Log", false], ["Budget (ana@dohc.test cannot edit Budget.)", false],
    ]);
    await user.selectOptions(collection, "Log");
    await user.click(within(screen.getByTestId("builder-step-1")).getByRole("button", { name: "Add field" }));
    expect(await screen.findByRole("option", { name: "Entry" })).toBeTruthy();
    expect(screen.queryByText("ana@dohc.test cannot edit Budget.")).toBeNull();
  });

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

  it("does not drop an edit to an automation someone deleted, and adds it back on the next Save", async () => {
    const { written, replaceFile } = makeBridge(read([summary(stamp), summary(nudge)]));
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    replaceFile(read([summary(nudge)]));
    await waitFor(() => expect(screen.queryByTestId("automation-nudge")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      '"Stamp the finish date" was deleted from automations.yaml while you were editing, so dohc did not save. Save again to add it back.',
      null,
    ));
    expect(written).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations.map((automation) => automation.id)).toEqual(["nudge", "stamp"]);
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

  it("keeps a draft with changes when the panel goes away, and opens it again", async () => {
    makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    const first = render(<Panel />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), " v2");
    first.unmount();

    render(<Panel />);
    expect((await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Stamp the finish date v2");
  });

  it("holds the draft still while it saves, and while the file cannot be read", async () => {
    const { bridge, replaceFile } = makeBridge(read([summary(stamp)]));
    let answer: (result: WriteCollectionAutomationsResult) => void = () => undefined;
    bridge.writeCollectionAutomations.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(<Panel onOpenFile={onOpenFile} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // A disabled fieldset disables what it holds.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" }).matches(":disabled")).toBe(true));
    answer({ status: "conflict" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" }).matches(":disabled")).toBe(false));

    replaceFile({
      status: "read", contentHash: HASH, addsStay: [],
      automations: [summary(stamp), { valid: false, id: "Broken", name: "Broken", diagnostics: [{ code: "invalid-id", path: "/automations/1/id" }] }],
    });
    expect(await screen.findByText("dohc cannot read every automation in automations.yaml, so you cannot save this now.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Stamp the finish date!");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("Tasks/automations.yaml");
  });

  it("keeps focus with a step it moves, and moves it to a neighbor or a new row", async () => {
    const two: Automation = { ...stamp, do: [
      ...stamp.do,
      { kind: "set", values: [{ field: "Title", value: { kind: "literal", value: "Done" } }], records: null, operation: null },
    ] };
    makeBridge(read([summary(two)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);

    await user.click(screen.getByRole("button", { name: "Move step 1 down" }));
    // The step moved to the end, so focus is on its other arrow.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move step 2 up" })));
    expect(screen.getByTestId("builder-step-1").textContent).toContain("Finished on");
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove step 1" })));
    await user.click(screen.getByRole("button", { name: "Set fields" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Step 2, field 1" })));
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
  const otherwise = (automation: Automation) => (automation.do[0] as Extract<Automation["do"][number], { kind: "if" }>).otherwise;

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

  it("edits a step inside an If and keeps the steps around it", async () => {
    const { written } = makeBridge(read([summary(everyKind)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Every kind");
    const value = screen.getByRole("textbox", { name: "Step 5, Title" });
    await user.clear(value);
    await user.type(value, "D");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    const saved = written[0]!.automations[0]!;
    expect(otherwise(saved)).toEqual([{ ...otherwise(everyKind)[0], values: title("D") }, otherwise(everyKind)[1]]);
    expect({ ...saved, name: everyKind.name, do: saved.do.slice(1) }).toEqual({ ...everyKind, do: everyKind.do.slice(1) });
  }, 30_000);

  it("does not save a step moved above the Find it changes, says so on the step, and focuses it", async () => {
    const { written } = makeBridge(read([summary(everyKind)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Every kind");
    await user.click(screen.getByRole("button", { name: "Move step 4 up" }));
    await user.click(screen.getByRole("button", { name: "Move step 3 up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const moved = screen.getByTestId("builder-step-1");
    expect((await within(moved).findByText(/^No step before this one in its list names that result\./u, undefined, SLOW))).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(moved).getByRole("combobox", { name: "Step 2, record" })));
    expect(written).toEqual([]);
  }, 30_000);

  it("shows main's findings on the nested step and control they name, and focuses the first", async () => {
    const { bridge, written } = makeBridge(read([summary(everyKind)]));
    bridge.checkCollectionAutomation.mockResolvedValue({
      diagnostics: [{ code: "duplicate-value", path: "/automations/0/do/0/do/1/as" }],
      formulaProblems: [{ path: "/do/0/otherwise/0/set/Title", problem: "Unexpected token." }],
      cannotRun: null, missingFiles: [],
    });
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Every kind");
    // A syntax error shows as it happens, beside its control.
    const value = screen.getByRole("textbox", { name: "Step 5, Title" });
    await waitFor(() => expect(value.getAttribute("aria-invalid")).toBe("true"), SLOW);
    expect(document.getElementById(value.getAttribute("aria-describedby")!)?.textContent).toBe("This formula has a syntax error. Unexpected token.");
    expect(within(screen.getByTestId("builder-step-2")).queryByText("Another step already uses this name.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const find = screen.getByTestId("builder-step-2");
    expect(await within(find).findByText("Another step already uses this name.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(find).getByRole("textbox", { name: "Step 3, result name" })));
    // One announcement for the Save, not one per problem.
    expect(screen.getByText("2 problems. The first is focused.").getAttribute("role")).toBe("status");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    // Another refusal with the same count is announced again.
    const said = screen.getByRole("status").textContent;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(said));
    expect(written).toEqual([]);
  }, 30_000);

  it("moves focus within a branch as its steps go, and asks for a step in an empty Do", async () => {
    const { written } = makeBridge(read([summary(everyKind)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Every kind");
    const second = screen.getByTestId("builder-step-1");
    await user.click(within(second).getByRole("button", { name: "Remove Title from step 2" }));
    await user.click(within(second).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(document.activeElement).toBe(within(second).getByRole("combobox", { name: "Step 2, field 1" })));
    await user.click(screen.getByRole("button", { name: "Remove step 5" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove step 5" })));
    await user.click(screen.getByRole("button", { name: "Remove step 5" }));
    const otherwiseGroup = screen.getByRole("group", { name: "Step 1, Otherwise" });
    await waitFor(() => expect(document.activeElement).toBe(within(otherwiseGroup).getByRole("button", { name: "Set fields" })));
    for (let removed = 0; removed < 3; removed += 1) await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    const doGroup = screen.getByRole("group", { name: "Step 1, Do" });
    const add = within(doGroup).getByRole("button", { name: "Set fields" });
    await waitFor(() => expect(document.activeElement).toBe(add));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(doGroup).findByText("Add a step.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(add));
    expect(written).toEqual([]);

    await user.click(add);
    await waitFor(() => expect(document.activeElement).toBe(within(doGroup).getByRole("combobox", { name: "Step 2, field 1" })));
    await user.selectOptions(document.activeElement!, "Title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations[0]!.do[0]).toEqual({ ...everyKind.do[0], do: [{ kind: "set", values: title(""), records: null, operation: null }], otherwise: [] });
  }, 30_000);

  it("shows a problem with an action input's name beside the name", async () => {
    const settle: Automation = { ...stamp, id: "settle", name: "Settle", do: [{ kind: "invoke", collection: null, operation: "invoices.settle", input: [
      { key: "__proto__", value: { kind: "literal", value: "x" } },
    ] }] };
    makeBridge(read([summary(settle)]));
    const user = userEvent.setup();
    render(<Panel table={{ name: "Tasks", tables: new Map([["Tasks", datasetTable(FIELDS)]]), actions: [] }} />);
    await openBuilder(user, "Settle");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const name = screen.getByRole("textbox", { name: "Step 1, input 1 name" });
    await waitFor(() => expect(document.activeElement).toBe(name), SLOW);
    expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent)
      .toBe("__proto__, prototype, and constructor cannot name an input.");
    expect(screen.getByRole("textbox", { name: "Step 1, __proto__" }).getAttribute("aria-invalid")).toBeNull();
  }, 30_000);

  it("adds no step past 25, says why, and keeps the steps it has editable", async () => {
    const full: Automation = { ...stamp, do: Array.from({ length: 25 }, () => ({ kind: "set" as const, values: title("x"), records: null, operation: null })) };
    makeBridge(read([summary(full)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    expect((screen.getByRole("button", { name: "Set fields" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("An automation holds at most 25 steps. Remove a step to add another.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Step 25, Title" }), "y");
    expect((screen.getByRole("textbox", { name: "Step 25, Title" }) as HTMLInputElement).value).toBe("xy");
    await user.click(screen.getByRole("button", { name: "Remove step 25" }));
    expect((screen.getByRole("button", { name: "Set fields" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/at most 25 steps/u)).toBeNull();
  }, 30_000);

  it("keeps a multi-select field's value a list", async () => {
    const { written } = makeBridge(read([summary(stamp)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 1, field 1" }), "Tags");
    await user.selectOptions(screen.getByRole("listbox", { name: "Step 1, Tags" }), ["urgent", "home"]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.do).toEqual([
      { kind: "set", values: [{ field: "Tags", value: { kind: "literal", value: ["urgent", "home"] } }], records: null, operation: null },
    ]);
  });

  it("checks a Try again from the toast against the file again, and never writes over a change made since", async () => {
    const { bridge, written, writeResults, replaceFile } = makeBridge(read([summary(stamp)]));
    writeResults.push({ status: "conflict" });
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("automations.yaml changed while you were editing.", null, expect.any(Function)));
    const tryAgain = onError.mock.calls[0]![2] as () => void;

    // Someone switched it off meanwhile.
    replaceFile(read([summary({ ...stamp, enabled: false })]));
    await waitFor(() => expect(bridge.listCollectionAutomations.mock.calls.length).toBeGreaterThan(2));
    tryAgain();
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(
      '"Stamp the finish date!" changed in automations.yaml while you were editing, so dohc did not save. Save again to replace it with yours.',
      null,
    ));
    expect(written).toHaveLength(1);
  });

  it.each(["existing", "new"])("keeps a newer %s draft after retrying an older save, then saves it against the acknowledged version", async (kind) => {
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

  it("keeps a different builder open when an earlier save finishes", async () => {
    const { bridge, written, replaceFile } = makeBridge(read([summary(stamp), summary(nudge)]));
    let finish!: (result: WriteCollectionAutomationsResult) => void;
    bridge.writeCollectionAutomations.mockImplementationOnce((payload) => {
      written.push(payload);
      return new Promise((resolve) => { finish = resolve; });
    });
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(await screen.findByTestId("automation-unsaved")).getByRole("button", { name: "Discard" }));
    await openBuilder(user, nudge.name);

    await act(async () => {
      replaceFile(read(written[0]!.automations.map((automation) => summary(automation))));
      finish({ status: "written", contentHash: HASH });
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" }).matches(":disabled")).toBe(false));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(nudge.name);
    expect(onError).not.toHaveBeenCalled();
  });

  it("can retry a save after its builder closes without closing another builder", async () => {
    const { bridge, written } = makeBridge(read([summary(stamp), summary(nudge)]));
    bridge.writeCollectionAutomations.mockRejectedValueOnce(new Error("Write unavailable"));
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const tryAgain = onError.mock.calls[0]![2] as () => void;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(await screen.findByTestId("automation-unsaved")).getByRole("button", { name: "Discard" }));
    await openBuilder(user, nudge.name);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");

    await act(async () => tryAgain());
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.name).toBe(`${stamp.name}!`);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" }).matches(":disabled")).toBe(false));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(`${nudge.name}!`);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("asks before the page closes the panel over changes, and keeps no draft once they are discarded", async () => {
    makeBridge(read([summary(stamp)]));
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Panel onClose={onClose} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    rerender(<Panel onClose={onClose} closeAsk={1} />);
    await user.click(within(await screen.findByTestId("automation-unsaved")).getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(<Panel />);
    expect(await screen.findByTestId("automation-stamp")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("checks the file again when the person agrees to the new layout, and writes nothing over a change since", async () => {
    const { bridge, written, writeResults, replaceFile } = makeBridge(read([summary(stamp)]));
    writeResults.push({ status: "reformats" });
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Panel onError={onError} />);
    await openBuilder(user);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("automations-reformat");
    const reads = bridge.listCollectionAutomations.mock.calls.length;
    replaceFile(read([summary({ ...stamp, enabled: false })]));
    await waitFor(() => expect(bridge.listCollectionAutomations.mock.calls.length).toBeGreaterThan(reads));
    await user.click(screen.getByTestId("automations-reformat-confirm"));
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(
      '"Stamp the finish date!" changed in automations.yaml while you were editing, so dohc did not save. Save again to replace it with yours.',
      null,
    ));
    expect(written).toHaveLength(1);
  });

  it("closes only for a close asked while it is open", async () => {
    makeBridge(read([summary(stamp)]));
    const onClose = vi.fn();
    // The page asked once before; this panel opened after that.
    const { rerender } = render(<Panel onClose={onClose} closeAsk={1} />);
    await screen.findByTestId("automation-stamp");
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Panel onClose={onClose} closeAsk={2} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
