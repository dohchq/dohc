// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ListCollectionAutomationRunsResult,
  ListCollectionAutomationsResult,
  RetryCollectionAutomationResult,
  UndoCollectionAutomationRunResult,
  WriteCollectionAutomationsPayload,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import { AutomationsPanel, useCollectionAutomations } from "./AutomationsPanel";
import type { Automation, ValidAutomationSummary } from "./automationSentence";
import { START_OVER_SENTENCE } from "./useAutomationRetry";

const HASH = "a".repeat(64);
const stamp: Automation = {
  id: "stamp",
  name: "Stamp the finish date",
  enabled: true,
  when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" } },
  if: null,
  do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null }],
};
const nudge: Automation = { ...stamp, id: "nudge", name: "Nudge the owner", when: { kind: "record-added" } };

function summary(automation: Automation, overrides: Partial<ValidAutomationSummary> = {}): ValidAutomationSummary {
  return {
    valid: true,
    automationId: `collection:Tasks#${automation.id}`,
    automation,
    definitionHash: "0123456789abcdef",
    unsupported: null,
    reach: { kind: "checked", steps: automation.do.map(() => ({ verdict: "allowed" as const })) },
    lastRun: null,
    ...overrides,
  };
}

function read(automations: ValidAutomationSummary[]): ListCollectionAutomationsResult {
  return { status: "read", contentHash: HASH, automations };
}

type Run = ListCollectionAutomationRunsResult["runs"][number];
const run = (overrides: Partial<Run>): Run => ({
  claimId: "atc_1", state: "done", error: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
  writes: [], definitionChanged: false, chainStopped: false, undone: false, ...overrides,
});

function makeBridge(file: ListCollectionAutomationsResult, runs: Run[] = []) {
  let current = file;
  const written: WriteCollectionAutomationsPayload[] = [];
  const writeResults: WriteCollectionAutomationsResult[] = [];
  const bridge = {
    listCollectionAutomations: vi.fn(async () => current),
    writeCollectionAutomations: vi.fn(async (payload: WriteCollectionAutomationsPayload) => {
      written.push(payload);
      const result = writeResults.shift() ?? { status: "written" as const, contentHash: "b".repeat(64) };
      if (result.status === "written") current = read(payload.automations.map((automation) => summary(automation)));
      return result;
    }),
    listCollectionAutomationRuns: vi.fn(async (): Promise<ListCollectionAutomationRunsResult> => ({ runs })),
    retryCollectionAutomation: vi.fn(async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued" })),
    undoCollectionAutomationRun: vi.fn(async (): Promise<UndoCollectionAutomationRunResult> =>
      ({ status: "undone", reverted: 1, removed: 0, changedSince: 1, missing: 0 })),
    confirmCollectionAutomationStep: vi.fn(async () => ({ status: "confirmed" as const })),
    onAutomationFailuresChanged: vi.fn(() => () => undefined),
    onAutomationHoldsChanged: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  return { bridge, written, writeResults };
}

function Panel(props: {
  focus?: { automationId: string; seq: number } | null;
  onNotice?: (message: string, undo?: () => void) => void;
  onError?: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onOpenFile?: (path: string) => void;
}) {
  const onError = props.onError ?? (() => undefined);
  const automations = useCollectionAutomations("ws-1", "Tasks", onError);
  return (
    <AutomationsPanel
      workspaceId="ws-1"
      collectionPath="Tasks"
      automations={automations}
      focus={props.focus ?? null}
      onClose={() => undefined}
      onOpenFile={props.onOpenFile ?? (() => undefined)}
      onError={onError}
      onNotice={props.onNotice ?? (() => undefined)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    expect(dialog.textContent).toContain("comments and hand formatting will be lost");
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
    await userEvent.keyboard("{ArrowDown}{Enter}");
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

    // The notice's Undo reads the file again itself: it outlives the panel.
    (onNotice.mock.calls[0]![1] as () => void)();
    await waitFor(() => expect(written).toHaveLength(3));
    expect(written[2]!.automations.map((automation) => automation.id)).toEqual(["stamp", "stamp-copy", "nudge"]);
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

  it("says an automation waits to check who can edit, and lets a person allow a held step", async () => {
    const held = summary(nudge, {
      automationId: "collection:Tasks#nudge",
      reach: { kind: "checked", steps: [{ verdict: "held", stoppedFor: "bob@dohc.test", seq: 7, target: "Budget", action: "change" }] },
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
      workspaceId: "ws-1", automationId: "collection:Tasks#nudge", definitionHash: "0123456789abcdef", step: 0, seq: 7,
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
