// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ListCollectionAutomationRunsResult,
  ListCollectionAutomationsResult,
  ListAutomationTargetsResult,
  RetryCollectionAutomationResult,
  ScheduleHostResult,
  UndoCollectionAutomationRunResult,
  WriteCollectionAutomationsPayload,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { parseAutomationsFile, writeAutomationsFile } from "@dohc/workspace-contracts/automations";
import { expressionProblem } from "@dohc/automation-executor/automation-plan";
import { automationCount, AutomationsPanel, resetKeptAutomationDraftsForTests, useCollectionAutomations } from "./AutomationsPanel";
import type { Automation, ValidAutomationSummary } from "./automationSentence";
import type { AutomationTable } from "./automationDraft";
import { START_OVER_SENTENCE } from "./useAutomationRetry";

const HASH = "a".repeat(64);
const FIELDS: FieldDefinition[] = [
  { name: "Title", type: "text" },
  { name: "Status", type: "select", options: ["Doing", "Done"] },
  { name: "Finished on", type: "date" },
  { name: "Points", type: "number" },
  { name: "Tags", type: "multi-select", options: ["urgent", "later", "home"] },
];
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

function read(automations: ValidAutomationSummary[]): ListCollectionAutomationsResult {
  return { status: "read", contentHash: HASH, automations };
}

type Run = Extract<ListCollectionAutomationRunsResult, { status: "listed" }>["runs"][number];
const run = (overrides: Partial<Run>): Run => ({
  claimId: "atc_1", state: "done", error: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
  writes: [], definitionChanged: false, chainStopped: false, undone: false, ...overrides,
});

function makeBridge(file: ListCollectionAutomationsResult, runs: Run[] = [], options: { holdsUnreadable?: boolean; roundTripWrites?: boolean } = {}) {
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
    listCollectionAutomationRuns: vi.fn(async (): Promise<ListCollectionAutomationRunsResult> => ({ status: "listed", runs })),
    listAutomationHolds: vi.fn(async () => ({ holds: [], unreadable: holdsUnreadable })),
    resetAutomationHolds: vi.fn(async () => {
      holdsUnreadable = false;
      return { status: "reset" as const };
    }),
    revealAutomationHolds: vi.fn(async () => undefined),
    retryCollectionAutomation: vi.fn(async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued", press: false })),
    undoCollectionAutomationRun: vi.fn(async (): Promise<UndoCollectionAutomationRunResult> =>
      ({ status: "undone", reverted: 1, removed: 0, changedSince: 1, missing: 0, kept: 0, irreversible: 0, actions: 0 })),
    confirmCollectionAutomationStep: vi.fn(async () => ({ status: "confirmed" as const })),
    listAutomationTargets: vi.fn(async (): Promise<ListAutomationTargetsResult> => ({ collections: [
      { path: "Tasks", name: "Tasks", stopped: null },
      { path: "Log", name: "Log", stopped: null },
      { path: "Budget", name: "Budget", stopped: "ana@dohc.test cannot edit Budget." },
    ] })),
    getCollection: vi.fn(async ({ collectionPath }: { collectionPath: string }) => ({
      path: collectionPath, status: "valid", reasons: [], recordCount: 0,
      schema: { name: null, description: null, views: [], fields: collectionPath === "Log" ? [{ name: "Entry", type: "text" }] : [] },
    })),
    // Main's check, for real: the file contract's writer and the formula parser.
    checkCollectionAutomation: vi.fn(async ({ automation, formulas }: { automation: Automation; formulas: string[] }) => {
      const written = writeAutomationsFile([{ status: "valid", automation }]);
      return {
        diagnostics: written.status === "refused" ? written.diagnostics : [],
        formulaProblems: formulas.map(expressionProblem),
      };
    }),
    onAutomationRunsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      failureListeners.push(listener);
      return () => undefined;
    }),
    onAutomationHoldsChanged: vi.fn(() => () => undefined),
    readScheduleHost: vi.fn(async (_payload: { workspaceId: string }): Promise<ScheduleHostResult> => ({ kind: "this-computer" })),
    onScheduleHostChanged: vi.fn((listener: (workspaceId: string) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    }),
    onCloudSessionChanged: vi.fn(() => () => undefined),
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

function Panel(props: {
  workspaceId?: string;
  table?: AutomationTable;
  onRunUndone?: () => void;
  fields?: FieldDefinition[];
  focus?: { automationId: string; seq: number } | null;
  onNotice?: (message: string, undo?: () => void) => void;
  onError?: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onOpenFile?: (path: string) => void;
  onOpenScheduleSettings?: () => void;
  closeAsk?: number;
  onClose?: () => void;
}) {
  const onError = props.onError ?? (() => undefined);
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
      closeAsk={props.closeAsk ?? 0}
      onClose={props.onClose ?? (() => undefined)}
      onOpenFile={props.onOpenFile ?? (() => undefined)}
      onOpenScheduleSettings={props.onOpenScheduleSettings ?? (() => undefined)}
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
    answerUndo({ status: "undone", reverted: 1, removed: 0, changedSince: 0, missing: 0, kept: 0, irreversible: 0, actions: 0 });
    await waitFor(() => expect(bridge.listCollectionAutomations).toHaveBeenCalledWith({ workspaceId: "ws-2", collectionPath: "Tasks" }));
    expect(screen.queryByTestId("automations-reformat")).toBeNull();
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("turns editing off and offers the file when an automation cannot be read", async () => {
    const { bridge } = makeBridge({
      status: "read", contentHash: HASH,
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
      reach: { kind: "checked", steps: [{ verdict: "held", step: "operation:invoices.edit", stoppedFor: "bob@dohc.test", seq: 7, target: "Budget", action: "change" }] },
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
      workspaceId: "ws-1", automationId: "collection:Tasks#nudge", definitionHash: "0123456789abcdef", step: "operation:invoices.edit", seq: 7,
    });
  });
});

describe("a dataset table's ⚡ panel", () => {
  const onInvoices: Automation = { ...stamp, when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: "Invoices" } };
  const onRefunds: Automation = { ...nudge, id: "refund", name: "Log refunds", when: { kind: "record-added", table: "Refunds" } };
  const anyTable: Automation = { ...nudge, id: "any", name: "Any table" };
  const file = read([summary(onInvoices), summary(onRefunds), summary(anyTable)]);
  const INVOICES: AutomationTable = { name: "Invoices", operations: new Set(["invoices.create", "invoices.edit"]), tables: new Set(["Invoices", "Refunds"]) };
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

  it("starts a new automation on this table, adds records only here, and asks for no other Collection", async () => {
    const { bridge, written } = makeBridge(read([summary(onRefunds)]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "New automation" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "record-added");
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    const picker = screen.getByRole("combobox", { name: "Step 2, Collection" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Invoices"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Step 2, field 1" }), "Title");
    await user.type(screen.getByRole("textbox", { name: "Step 2, Title" }), "Log");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1), SLOW);
    expect(written[0]!.automations).toEqual([onRefunds, expect.objectContaining({ when: { kind: "record-added", table: "Invoices" } })]);
    expect(bridge.listAutomationTargets).not.toHaveBeenCalled();
  });

  it("leaves an Add record that adds to another table as the file wrote it", async () => {
    const addsRefund: Automation = { ...onInvoices, do: [{ kind: "add-record", values: [{ field: "Title", value: { kind: "literal", value: "Refund" } }], collection: null, as: null, operation: "refunds.create" }] };
    makeBridge(read([summary(addsRefund)]));
    const user = userEvent.setup();
    render(<Panel table={INVOICES} />);
    await user.click(await screen.findByRole("button", { name: "Stamp the finish date" }));
    const step = screen.getByTestId("builder-step-0");
    expect(within(step).queryByRole("combobox")).toBeNull();
    expect(step.textContent).toContain("Step 1");
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
    makeBridge(read([summary(onInvoices)]), [run({ writes: [{ kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", version: 2,
      fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] }] })]);
    const onRunUndone = vi.fn();
    render(<Panel table={INVOICES} onRunUndone={onRunUndone} focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} />);
    await userEvent.click(within(await screen.findByTestId("automation-run-atc_1")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onRunUndone).toHaveBeenCalledOnce());
  });
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
    { installId: "me", label: "DESKTOP-1", lastSeenMs: NOW, thisComputer: true },
    { installId: "laptop", label: "Ice's laptop", lastSeenMs: NOW - 86_400_000, thisComputer: false },
  ];
  const relay = (hostInstallId: string | null, handoverFrom: string | null = null): ScheduleHostResult =>
    ({ kind: "relay", generation: 3, hostInstallId, handoverFrom, computers });

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

describe("an automation's runs", () => {
  const failed = run({
    claimId: "atc_failed", state: "failed", error: "ana@dohc.test cannot edit Budget",
    writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Finished on", before: null, after: "2026-09-25" }],
  });
  const stopped = run({ claimId: "atc_stopped", state: "failed", error: "chain-stopped", chainStopped: true });

  it("opens from a notice, offers Try again except for a chain stop, and confirms a changed automation first", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "failed", atMs: Date.now() } })]), [failed, stopped]);
    bridge.retryCollectionAutomation.mockResolvedValueOnce({ status: "definition-changed", repeatsMessages: false });
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} />);

    const failedRow = await screen.findByTestId("automation-run-atc_failed");
    expect(failedRow.textContent).toContain("ana@dohc.test cannot edit Budget.");
    expect(within(screen.getByTestId("automation-run-atc_stopped")).queryByRole("button", { name: "Try again" })).toBeNull();

    await userEvent.click(within(failedRow).getByRole("button", { name: "Try again" }));
    expect(bridge.retryCollectionAutomation).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_failed", startOver: false,
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
      { kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", version: 2,
        fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] },
      { kind: "dataset-created", rules, operationId: "create", tableId: "table-1", recordId: "invoice-2", version: 1 },
      { kind: "dataset-kept", recordId: "invoice-3", fieldId: "status", field: "Status", planned: "Closed", current: "Pending" },
      { kind: "dataset-skipped", recordId: "invoice-4", reason: "The record was removed" },
    ] })]);
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} />);
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
      run({ writes: [{ kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", version: 2,
        fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] }] }),
      run({ claimId: "atc_added", writes: [{ kind: "dataset-created", rules, operationId: "create", tableId: "table-1", recordId: "invoice-2", version: 1 }] }),
    ]);
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({
      status: "undone", reverted: 1, removed: 0, kept: 1, changedSince: 0, missing: 0, irreversible: 1, actions: 0,
    });
    const onNotice = vi.fn();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} onNotice={onNotice} />);
    // A run that only added records has nothing Undo can put back.
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
        { kind: "dataset-edit", rules, operationId: "edit", tableId: "table-1", recordId: "invoice-1", version: 2, fields: [{ fieldId: "status", field: "Status", before: "Open", after: "Closed" }] },
      ] }),
      run({ claimId: "atc_action", writes: [{ kind: "dataset-action", rules, operationId: "settle", tableId: "table-1", name: "Settle", revision: 5 }] }),
    ]);
    bridge.undoCollectionAutomationRun.mockResolvedValueOnce({
      status: "undone", reverted: 1, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 1,
    });
    const onNotice = vi.fn();
    render(<Panel focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} onNotice={onNotice} />);
    const row = await screen.findByTestId("automation-run-atc_1");
    expect(row.textContent).toContain("Ran 1 action and changed 1 field");
    await userEvent.click(within(row).getByRole("button", { name: "Show 2 changes" }));
    expect(row.textContent).toContain("Ran Settle");
    // A run that only ran an action has nothing Undo can put back.
    expect(within(screen.getByTestId("automation-run-atc_action")).queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Undid 1 change. 1 action can't be undone."));
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
      workspaceId: "ws-1", automationId: "collection:Tasks#stamp", claimId: "atc_failed",
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Undid 1 change. 1 field changed since then."));
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
    expect(screen.getByTestId("builder-step-1").textContent).toContain('find records where record.Status == "Doing"');
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
    // Every formula in the draft is checked together, the step's today() too.
    await waitFor(() => expect(bridge.checkCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: "ws-1", formulas: ["record.Points == 3", "today()"],
    })), SLOW);
    await waitFor(() => expect(screen.queryByText(/syntax error/)).toBeNull(), SLOW);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.automations[0]!.if).toBe("record.Points == 3");
  }, 30_000);

  it("shows a syntax error in an action's input on its step, inside an If too, and does not save", async () => {
    const settle: Automation = { ...stamp, id: "settle", name: "Settle", do: [{
      kind: "if", if: "true",
      do: [{ kind: "invoke", operation: "invoices.settle", input: [{ key: "note", value: { kind: "literal", value: "x" } }] }],
      otherwise: [{ kind: "invoke", operation: "invoices.settle", input: [{ key: "id", value: { kind: "formula", expression: "record.id +" } }] }],
    }] };
    const { written, bridge } = makeBridge(read([summary(settle)]));
    const user = userEvent.setup();
    render(<Panel />);
    await openBuilder(user, "Settle");
    await waitFor(() => expect(bridge.checkCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ formulas: ["record.id +"] })), SLOW);
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

  it("names a missing field, shows each step's reach, and offers only Collections a step can reach", async () => {
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
    const collection = screen.getByRole("combobox", { name: "Step 2, Collection" }) as HTMLSelectElement;
    expect(await screen.findByText("ana@dohc.test cannot edit Budget.")).toBeTruthy();
    expect([...collection.options].map((option) => option.textContent)).toEqual(["Tasks", "Budget", "Log"]);
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
    rerender(<Panel focus={{ automationId: "collection:Tasks#stamp", seq: 1 }} />);
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
      status: "read", contentHash: HASH,
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
