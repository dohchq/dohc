// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ListCollectionAutomationRunsResult,
  ListCollectionAutomationsResult,
  ListAutomationTargetsResult,
  RetryCollectionAutomationResult,
  UndoCollectionAutomationRunResult,
  WriteCollectionAutomationsPayload,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { parseAutomationsFile, writeAutomationsFile } from "@dohc/workspace-contracts/automations";
import { expressionProblem } from "../../automations/automationPlan";
import { AutomationsPanel, resetKeptAutomationDraftsForTests, useCollectionAutomations } from "./AutomationsPanel";
import type { Automation, ValidAutomationSummary } from "./automationSentence";
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
    retryCollectionAutomation: vi.fn(async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued" })),
    undoCollectionAutomationRun: vi.fn(async (): Promise<UndoCollectionAutomationRunResult> =>
      ({ status: "undone", reverted: 1, removed: 0, changedSince: 1, missing: 0 })),
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
    onAutomationFailuresChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      failureListeners.push(listener);
      return () => undefined;
    }),
    onAutomationHoldsChanged: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  // Another writer changes the file; the panel reads it again, as it does
  // when a run settles.
  const replaceFile = (next: ListCollectionAutomationsResult) => {
    current = next;
    for (const listener of failureListeners) listener({ workspaceId: "ws-1" });
  };
  return { bridge, written, writeResults, replaceFile };
}

function Panel(props: {
  workspaceId?: string;
  fields?: FieldDefinition[];
  focus?: { automationId: string; seq: number } | null;
  onNotice?: (message: string, undo?: () => void) => void;
  onError?: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onOpenFile?: (path: string) => void;
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
      automations={automations}
      fields={props.fields ?? FIELDS}
      focus={props.focus ?? null}
      closeAsk={props.closeAsk ?? 0}
      onClose={props.onClose ?? (() => undefined)}
      onOpenFile={props.onOpenFile ?? (() => undefined)}
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
    answerUndo({ status: "undone", reverted: 1, removed: 0, changedSince: 0, missing: 0 });
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

describe("an automation's runs", () => {
  const failed = run({
    claimId: "atc_failed", state: "failed", error: "ana@dohc.test cannot edit Budget",
    writes: [{ kind: "field", recordId: "rec_1", path: "Tasks/Plan.md", field: "Finished on", before: null, after: "2026-09-25" }],
  });
  const stopped = run({ claimId: "atc_stopped", state: "failed", error: "chain-stopped", chainStopped: true });

  it("opens from a notice, offers Try again except for a chain stop, and confirms a changed automation first", async () => {
    const { bridge } = makeBridge(read([summary(stamp, { lastRun: { state: "failed", atMs: Date.now() } })]), [failed, stopped]);
    bridge.retryCollectionAutomation.mockResolvedValueOnce({ status: "definition-changed" });
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
