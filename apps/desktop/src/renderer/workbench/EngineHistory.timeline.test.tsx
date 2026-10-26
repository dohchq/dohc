// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fragment, type ReactNode } from "react";
import type { EngineMomentRecord, TimelineEntry } from "../../ipc/bridgeContract";
import { EngineHistoryView, type HistoryCollections } from "./EngineHistory";

// This suite checks what each row says and offers, not viewport measurement.
// The real virtualizer is covered by history-virtualization.spec.ts.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({ data, renderItem, ListFooterComponent }: {
    data: unknown[];
    renderItem: (props: { item: unknown; index: number }) => ReactNode;
    ListFooterComponent: ReactNode;
  }) => (
    <>
      {data.map((item, index) => (
        <Fragment key={index}>{renderItem({ item, index })}</Fragment>
      ))}
      {ListFooterComponent}
    </>
  ),
}));

afterEach(cleanup);

const BUDGET = "00000000-0000-4000-8000-000000000001";
const GUESTS = "00000000-0000-4000-8000-000000000002";
const DAY = new Date(2026, 9, 16, 12).getTime();

function file(id: string, overrides: Partial<EngineMomentRecord> = {}): TimelineEntry {
  return { kind: "file", moment: { id, versionId: "main", path: "notes/plan.md", recordedAtMs: DAY, operation: "write", origin: "local-file", momentOrder: 1, ...overrides } };
}
const version: TimelineEntry = { kind: "version", version: { id: "draft", workspaceId: "workspace", kind: "named", name: "Draft", createdAtMs: DAY - 1_000 } };
const workspaceStart: TimelineEntry = { kind: "version", version: { id: "main", workspaceId: "workspace", kind: "main", name: "Main", createdAtMs: DAY - 9_000 } };
function change(revision: number, recordedAtMs: number | null, datasetId = BUDGET, name = "Budget",
  options: { sortAtMs?: number | null; rulesApprovedBy?: string | null } = {}): TimelineEntry {
  // A rules change has the engine's fixed operation and a schema; only it
  // can carry the agent that approved it.
  const rules = options.rulesApprovedBy !== undefined;
  return { kind: "collection", datasetId, name, sortAtMs: options.sortAtMs !== undefined ? options.sortAtMs : recordedAtMs ?? DAY - 5_000, change: {
    revision, operation: rules ? "Fields and rules" : "addRow", callerReference: null, recordedAtMs, approvedRevisionHash: "a".repeat(64),
    changesetBytes: 10, attachmentCount: 0,
    ...(rules ? {
      schema: { previousRevisionHash: "b".repeat(64), revisionHash: "a".repeat(64) },
      approvalAgent: { kind: "agent" as const, label: options.rulesApprovedBy ?? null, labelSource: "agent-declared" as const },
    } : { automation: { automationId: "automations.yaml#stamp", depth: 1, name: "Stamp the date" } }),
  } };
}

function view(props: Partial<Parameters<typeof EngineHistoryView>[0]> = {}) {
  const calls = { open: vi.fn(), retry: vi.fn(), openHistory: vi.fn() };
  // Budget's definition is loaded and labels its operation; Guests' is not.
  const collections: HistoryCollections = new Map([
    [BUDGET, { name: "Budget", operationLabels: new Map([["addRow", "Add row"]]), openHistory: calls.openHistory }],
    [GUESTS, { name: "Guests" }],
  ]);
  render(
    <EngineHistoryView entries={[]} hasMore={false} loadingMore={false} onLoadMore={() => {}}
      onOpenMoment={calls.open} collections={collections} onRetry={calls.retry} {...props} />,
  );
  return calls;
}

describe("History timeline rows", () => {
  it("shows files, versions and Collection changes as one list, each with its own way in", () => {
    const calls = view({ entries: [file("m-1"), version, change(4, DAY - 2_000)] });
    const rows = screen.getAllByRole("listitem").filter((row) => row.dataset.historyKey);
    expect(rows.map((row) => row.dataset.testid)).toEqual(["engine-moment", "history-version", "history-collection-change"]);

    fireEvent.click(screen.getByTestId("engine-moment-open"));
    expect(calls.open).toHaveBeenCalledWith("m-1", "notes/plan.md");
    expect(rows[1]!.textContent).toContain("Created version Draft");
    expect(rows[1]!.querySelector("button")).toBeNull();
    // A file's row opens its change, and so does a Collection's: its History.
    const collection = screen.getByRole("button", { name: "Open Collection history for Budget" });
    expect(collection.textContent).toContain("Automation Stamp the date");
    fireEvent.click(collection);
    expect(calls.openHistory).toHaveBeenCalledOnce();
    // The Undo is in that History, so the timeline offers none.
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("opens a Collection's History from the keyboard", async () => {
    const user = userEvent.setup();
    const calls = view({ entries: [change(4, DAY - 2_000)] });
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Collection history for Budget" }));
    await user.keyboard("{Enter}");
    expect(calls.openHistory).toHaveBeenCalledOnce();
    await user.keyboard(" ");
    expect(calls.openHistory).toHaveBeenCalledTimes(2);
  });

  // The operation's name is the definition's ID, not the person's words.
  it("titles a Collection change with its operation's label, else by its Collection", () => {
    view({ entries: [change(4, DAY - 2_000), change(2, DAY - 3_000, GUESTS, "Guests")] });
    const [labelled, unlabelled] = screen.getAllByRole("listitem").filter((row) => row.dataset.historyKey);
    expect(labelled!.querySelector(".font-medium")!.textContent).toBe("Add row");
    expect(labelled!.textContent).not.toContain("addRow");
    expect(unlabelled!.querySelector(".font-medium")!.textContent).toBe("Changed Guests");
    expect(unlabelled!.querySelector(".font-mono:last-child")!.textContent).toBe("addRow");
    // The title already names the Collection, so the meta line does not.
    expect(unlabelled!.querySelector("[id]")!.textContent).not.toContain("Guests");
    // The row's name says what it opens; the change describes it.
    const button = screen.getByRole("button", { name: "Open Collection history for Budget" });
    const description = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("Budget");
    expect(description?.textContent).toContain("Stamp the date");
  });

  it("names the agent that approved a Collection's rules first, in the agent's voice", () => {
    view({ entries: [change(4, DAY - 2_000, BUDGET, "Budget", { rulesApprovedBy: "trip-agent" }), change(3, DAY - 3_000, BUDGET, "Budget", { rulesApprovedBy: null })] });
    const agents = screen.getAllByTestId("history-collection-agent");
    expect(agents.map((agent) => agent.textContent)).toEqual(["trip-agent", "Agent"]);
    expect(agents[0]!.className).toContain("text-agent");
    expect(agents[0]!.parentElement!.firstElementChild).toBe(agents[0]);
  });

  // The engine names every rules change "Fields and rules". That is not an
  // ID to show in mono, and no definition labels it.
  it("titles a rules change in words and names its Collection, without an operation", () => {
    view({ entries: [change(4, DAY - 2_000, GUESTS, "Guests", { rulesApprovedBy: "trip-agent" })] });
    const row = screen.getAllByRole("listitem").find((item) => item.dataset.historyKey)!;
    expect(row.querySelector(".font-medium")!.textContent).toBe("Changed fields and rules");
    const meta = row.querySelector("[id]")!;
    expect(meta.textContent).toContain("Guests");
    expect(meta.textContent).not.toContain("Fields and rules");
  });

  it("marks where the workspace started, not a version someone created", () => {
    view({ entries: [file("m-1"), workspaceStart] });
    const marker = screen.getAllByRole("listitem").find((row) => row.dataset.testid === "history-version")!;
    expect(marker.textContent).toContain("Workspace created");
    expect(marker.textContent).not.toContain("Created version");
  });

  it("keeps an undated Collection change under the day main placed it, and says its date is unknown", () => {
    view({ entries: [file("m-1"), change(4, null, GUESTS, "Guests", { sortAtMs: DAY - 4_000 }), file("m-0", { recordedAtMs: DAY - 6_000 })] });
    expect(screen.getByTestId("history-collection-date-unknown").textContent).toBe("Date unknown");
    const headings = screen.getAllByTestId("engine-history-day-heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).not.toBe("Date unknown");
    // A Collection this computer cannot open is a row, not a control.
    expect(screen.queryByRole("button", { name: "Open Collection history for Guests" })).toBeNull();
  });

  it("gives a change with no date and no placement its own Date unknown heading", () => {
    view({ entries: [file("m-1"), change(4, null, GUESTS, "Guests", { sortAtMs: null })] });
    const headings = screen.getAllByTestId("engine-history-day-heading");
    expect(headings).toHaveLength(2);
    expect(headings[1]!.textContent).toBe("Date unknown");
    expect(headings[1]!.hasAttribute("datetime")).toBe(false);
  });
});

describe("History timeline changes", () => {
  const nova = { kind: "agent" as const, agentId: "nova", agentRunId: "run" };
  const agentEdit = (id: string, minutes: number): TimelineEntry =>
    file(id, { recordedAtMs: DAY - minutes * 60_000, agentAuthorName: "Nova", summary: "Updated plan.md", authors: [nova], authorPresentations: [{ group: "nova", hue: null, self: false }] });

  it("draws each change on one line: who, the file, its folder, and the time", () => {
    view({ entries: [agentEdit("m-2", 0), file("m-1", { recordedAtMs: DAY - 3_600_000 })] });
    const [agent, local] = screen.getAllByTestId("engine-moment-open");
    // The agent's square avatar leads, and its name follows in the agent voice.
    expect(agent!.querySelector('[title="Nova"]')?.className).toContain("rounded");
    expect(agent!.querySelector('[title="Nova"]')?.className).not.toContain("rounded-full");
    expect(screen.getAllByTestId("engine-moment-source")[0]!.textContent).toBe("Nova");
    // A local edit leads with its origin's mark, says its folder, and keeps
    // its origin in words for screen readers.
    expect(local!.querySelector('[title="Local file edit"] .lucide-hard-drive')).not.toBeNull();
    expect(local!.textContent).toContain("plan.mdnotes");
    expect(local!.textContent).not.toContain("Edited");
    expect(screen.getAllByTestId("engine-moment-source")[1]!.className).toBe("sr-only");
  });

  it("folds an agent's edits to one file into one row that opens the newest and lists the rest", () => {
    const calls = view({ entries: [agentEdit("m-3", 0), agentEdit("m-2", 5), agentEdit("m-1", 9)] });
    expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(1);
    // The run's head names its file; each edit's summary is listed under it.
    expect(screen.getByTestId("engine-moment-open").textContent).toMatch(/^plan\.mdNova/);
    const toggle = screen.getByTestId("engine-moment-run-toggle");
    expect(toggle.textContent).toBe("3");
    expect(toggle.getAttribute("aria-label")).toBe("3 changes");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("engine-moment-open"));
    expect(calls.open).toHaveBeenCalledWith("m-3", "notes/plan.md");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getAllByTestId("engine-moment-open");
    expect(rows.map((row) => row.dataset.momentId)).toEqual(["m-3", "m-2", "m-1"]);
    fireEvent.click(rows[2]!);
    expect(calls.open).toHaveBeenLastCalledWith("m-1", "notes/plan.md");
  });

  it("marks the open change, and only it, as selected", () => {
    view({ entries: [file("m-2"), file("m-1")], openMomentId: "m-1" });
    const [other, open] = screen.getAllByTestId("engine-moment-open");
    expect(open!.getAttribute("aria-current")).toBe("true");
    expect(open!.className.split(" ")).toContain("bg-selected");
    expect(other!.hasAttribute("aria-current")).toBe(false);
    expect(other!.className.split(" ")).not.toContain("bg-selected");
  });

  it("marks a run's open edit on the run's row or under it", () => {
    view({ entries: [agentEdit("m-2", 0), agentEdit("m-1", 5)], openMomentId: "m-2" });
    const run = screen.getByTestId("engine-moment-run");
    expect(screen.getByTestId("engine-moment-open").getAttribute("aria-current")).toBe("true");
    expect(run.firstElementChild!.className.split(" ")).toContain("bg-selected");
  });

  const describedBy = (control: HTMLElement) => {
    const id = control.getAttribute("aria-describedby");
    return id === null ? null : document.getElementById(id)?.textContent;
  };

  // The open change may be one a collapsed row hides. The row shows it holds
  // it without opening; aria-current stays on the change itself.
  it("marks a collapsed run that holds the open change, until it opens", () => {
    view({ entries: [agentEdit("m-2", 0), agentEdit("m-1", 5)], openMomentId: "m-1" });
    const row = screen.getByTestId("engine-moment-run").firstElementChild!;
    const toggle = screen.getByTestId("engine-moment-run-toggle");
    expect(row.className.split(" ")).toContain("bg-selected");
    expect(screen.getByTestId("engine-moment-open").hasAttribute("aria-current")).toBe(false);
    expect(describedBy(toggle)).toBe("Includes the open change");
    fireEvent.click(toggle);
    expect(row.className.split(" ")).not.toContain("bg-selected");
    expect(describedBy(toggle)).toBeNull();
    expect(screen.getAllByTestId("engine-moment-open")[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("marks a collapsed pass that holds the open change, until it opens", () => {
    view({ entries: [file("p-2", { correlationId: "pass" }), file("p-1", { correlationId: "pass", path: "notes/other.md" })], openMomentId: "p-1" });
    const toggle = screen.getByTestId("engine-moment-group-toggle");
    expect(toggle.className.split(" ")).toContain("bg-selected");
    expect(describedBy(toggle)).toBe("Includes the open change");
    fireEvent.click(toggle);
    expect(toggle.className.split(" ")).not.toContain("bg-selected");
    expect(screen.getAllByTestId("engine-moment-open")[1]!.getAttribute("aria-current")).toBe("true");
  });

  // The name says what a row opens. Its description tells one edit of the
  // file from the next: what it did, who made it, and when.
  it("describes each change by what it did, who made it, and when", () => {
    view({ entries: [
      agentEdit("m-3", 0),
      agentEdit("m-2", 5),
      file("m-1", { recordedAtMs: DAY - 3_600_000, namedAuthor: { userId: "sam", label: "Sam Rivera" },
        authors: [{ kind: "named", userId: "sam", grantId: "grant-sam", grantGeneration: 1 }] }),
    ] });
    fireEvent.click(screen.getByTestId("engine-moment-run-toggle"));
    const [newest, earlier, person] = screen.getAllByTestId("engine-moment-open").map(describedBy);
    expect(newest).toMatch(/^Updated plan\.md, Agent Nova, /);
    expect(earlier).toMatch(/^Updated plan\.md, Agent Nova, /);
    expect(earlier).not.toBe(newest);
    expect(person).toMatch(/^Edited plan\.md, Sam Rivera, /);
  });
});

describe("History timeline sources", () => {
  it("names the Collections a partial page is missing, and Try again reads again", () => {
    const calls = view({ entries: [file("m-1")], unavailableSources: [{ datasetId: BUDGET }, { datasetId: "00000000-0000-4000-8000-000000000009" }] });
    expect(screen.getByTestId("history-sources-unavailable").textContent).toBe("dohc could not load changes from Budget and 1 more.");
    fireEvent.click(screen.getByTestId("history-sources-retry"));
    expect(calls.retry).toHaveBeenCalledOnce();
    expect(screen.getByTestId("engine-moment-open")).toBeTruthy();
  });

  it("counts the Collections the source limit left out, without a retry that cannot help", () => {
    view({ entries: [file("m-1")], omittedSources: 12, hasMore: true });
    expect(screen.getByTestId("history-sources-omitted").textContent).toBe(
      "History includes up to 128 Collections. 12 more are left out. To see a Collection's changes, open it and choose History.");
    expect(screen.queryByTestId("history-sources-retry")).toBeNull();
  });

  it("shows a Collection that did not load as unavailable, not as empty History", () => {
    const calls = view({ unavailableSources: [{ datasetId: GUESTS }] });
    const state = screen.getByTestId("history-collections-unavailable");
    expect(state.textContent).toContain("dohc could not load changes from Guests.");
    expect(screen.queryByText("No changes yet.")).toBeNull();
    fireEvent.click(screen.getByTestId("history-sources-retry"));
    expect(calls.retry).toHaveBeenCalledOnce();
  });

  it("says History is paused beside the Collections an empty paused page is missing", () => {
    const calls = view({ unavailableSources: [{ datasetId: GUESTS }], paused: true });
    const state = screen.getByTestId("history-collections-unavailable");
    expect(within(state).getByTestId("history-paused").textContent).toBe("History paused");
    expect(state.textContent).toContain("dohc could not load changes from Guests.");
    fireEvent.click(within(state).getByTestId("history-sources-retry"));
    expect(calls.retry).toHaveBeenCalledOnce();
  });

  it("says No changes yet only for a complete page", () => {
    view();
    const line = screen.getByText("No changes yet.");
    // The picture is decorative and there is no second line or action.
    expect(line.parentElement!.textContent).toBe("No changes yet.");
    expect(line.previousElementSibling!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByTestId("history-sources-notice")).toBeNull();
  });
});
