// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
function change(revision: number, recordedAtMs: number | null, datasetId = BUDGET, name = "Budget"): TimelineEntry {
  return { kind: "collection", datasetId, name, sortAtMs: recordedAtMs ?? DAY - 5_000, change: {
    revision, operation: "addRow", callerReference: null, recordedAtMs, approvedRevisionHash: "a".repeat(64), changesetBytes: 10, attachmentCount: 0,
    automation: { automationId: "automations.yaml#stamp", depth: 1, name: "Stamp the date" },
  } };
}

function view(props: Partial<Parameters<typeof EngineHistoryView>[0]> = {}) {
  const calls = { open: vi.fn(), retry: vi.fn(), openCollection: vi.fn() };
  const collections: HistoryCollections = new Map([[BUDGET, { name: "Budget", open: calls.openCollection }], [GUESTS, { name: "Guests" }]]);
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
    const collection = screen.getByRole("button", { name: "Open Collection Budget" });
    expect(collection.textContent).toContain("addRow");
    expect(collection.textContent).toContain("Automation Stamp the date");
    fireEvent.click(collection);
    expect(calls.openCollection).toHaveBeenCalledOnce();
    // Collection changes carry no undo, so the timeline offers none.
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("states no date for a Collection change main could not date", () => {
    view({ entries: [file("m-1"), change(4, null, GUESTS, "Guests")] });
    expect(screen.getByTestId("history-collection-date-unknown").textContent).toBe("Date unknown");
    const headings = screen.getAllByTestId("engine-history-day-heading");
    expect(headings.at(-1)!.textContent).toBe("Date unknown");
    expect(headings.at(-1)!.hasAttribute("datetime")).toBe(false);
    // A Collection this computer cannot open is a row, not a control.
    expect(screen.queryByRole("button", { name: "Open Collection Guests" })).toBeNull();
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
    expect(screen.getByTestId("history-sources-omitted").textContent).toBe("History includes up to 128 Collections. 12 more are left out.");
    expect(screen.queryByTestId("history-sources-retry")).toBeNull();
  });

  it("shows a Collection that did not load as unavailable, not as empty History", () => {
    const calls = view({ unavailableSources: [{ datasetId: GUESTS }] });
    const state = screen.getByTestId("history-collections-unavailable");
    expect(state.textContent).toContain("dohc could not load changes from Guests.");
    expect(screen.queryByText("No changes yet")).toBeNull();
    fireEvent.click(screen.getByTestId("history-sources-retry"));
    expect(calls.retry).toHaveBeenCalledOnce();
  });

  it("says No changes yet only for a complete page", () => {
    view();
    expect(screen.getByText("No changes yet")).toBeTruthy();
    expect(screen.queryByTestId("history-sources-notice")).toBeNull();
  });
});
