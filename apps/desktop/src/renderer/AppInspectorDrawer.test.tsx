// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppInspectorDrawer } from "./AppInspectorDrawer";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";

let datasetMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  datasetMock = vi.fn(async (request: Record<string, unknown>) => {
    if (request.action === "list") {
      return {
        kind: "list",
        datasets: [
          {
            datasetId: "11111111-1111-4111-8111-111111111101",
            datasetPath: "ledger/dataset.json",
            name: "Ledger",
            revision: 1,
            revisionSha256: "a".repeat(64),
            tables: [],
            operations: [],
          },
        ],
        nextCursor: null,
      };
    }
    if (request.action === "trace") {
      return {
        kind: "trace",
        limit: 50,
        entries: [
          {
            atMs: 1700000000000,
            operation: "listEntries",
            durationMs: 4,
            statementCount: 1,
            rowsRead: 12,
            changesetBytes: 0,
            callerKind: "owner",
            revision: 3,
            status: "ok",
            refusalCode: null,
          },
        ],
      };
    }
    if (request.action === "sql") {
      if (String(request.sql).startsWith("DELETE")) {
        throw new Error(
          "Only read-only SELECT queries against this Collection's approved tables are allowed.",
        );
      }
      if (request.explain) {
        return {
          kind: "sql",
          columns: ["id", "parent", "notused", "detail"],
          rows: [[2, 0, 0, "SEARCH ledger USING INDEX idx_cents"]],
          truncated: false,
          durationMs: 1,
          revision: 3,
          explain: true,
        };
      }
      return {
        kind: "sql",
        columns: ["id", "cents"],
        rows: [["e1", 1250]],
        truncated: false,
        durationMs: 2,
        revision: 3,
        explain: false,
      };
    }
    throw new Error(`Unexpected dataset action ${String(request.action)}`);
  });
  Object.defineProperty(window, "dohcDesktop", {
    configurable: true,
    value: { platform: "win32", dataset: datasetMock },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppInspectorDrawer", () => {
  it("loads trace rows, supports keyboard tabs/run/escape, and displays refusal errors", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <WorkspaceSessionProvider workspaceId="ws-1">
        <AppInspectorDrawer workspaceId="ws-1" onClose={onClose} />
      </WorkspaceSessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-inspector-trace-row")).toBeTruthy();
    });
    expect(screen.getByText("listEntries")).toBeTruthy();
    expect(screen.getByText("4 ms")).toBeTruthy();
    expect(screen.getByText("r3")).toBeTruthy();

    const traceTab = screen.getByTestId("app-inspector-tab-trace");
    traceTab.focus();
    fireEvent.keyDown(traceTab, { key: "ArrowRight" });
    const input = await screen.findByTestId("app-inspector-sql-input");
    fireEvent.change(input, { target: { value: "SELECT id, cents FROM ledger" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("app-inspector-sql-row")).toBeTruthy();
    });
    expect(screen.getByText("1250")).toBeTruthy();
    expect(screen.getByTestId("app-inspector-sql-meta").textContent).toContain("1 row");

    await user.click(screen.getByTestId("app-inspector-sql-explain"));
    await waitFor(() => {
      expect(screen.getByText(/SEARCH ledger USING INDEX/)).toBeTruthy();
    });
    expect(screen.getByTestId("app-inspector-sql-meta").textContent).toContain("Query plan");

    fireEvent.change(input, { target: { value: "DELETE FROM ledger" } });
    await user.click(screen.getByTestId("app-inspector-sql-run"));
    await waitFor(() => {
      expect(screen.getByTestId("app-inspector-sql-error").textContent).toContain(
        "Only read-only SELECT queries",
      );
    });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows why the Collection list was refused", async () => {
    datasetMock.mockResolvedValueOnce({
      kind: "collections-refused",
      refusal: {
        kind: "elsewhere",
        words: "This workspace's Collections run on Studio Mac.",
        computer: "Studio Mac",
      },
    });
    render(
      <WorkspaceSessionProvider workspaceId="ws-1">
        <AppInspectorDrawer workspaceId="ws-1" onClose={() => {}} />
      </WorkspaceSessionProvider>,
    );
    expect(await screen.findByText("This workspace's Collections run on Studio Mac.")).toBeTruthy();
  });
});
