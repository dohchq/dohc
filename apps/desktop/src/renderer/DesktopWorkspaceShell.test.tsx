// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceUiState } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

const WORKSPACE: Workspace = {
  workspaceId: "ws-shell-test",
  rootPath: "/home/ice/dohc/personal",
  kind: "personal",
  mode: "local-first",
};

const SYNC_STATUS = {
  state: "synced" as const,
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
};

const STORED_STATE: WorkspaceUiState = {
  version: 1,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 320,
  tabs: ["notes/b.md"],
  activeTab: "notes/b.md",
  historyVisible: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeBridge(uiStatePromise: Promise<WorkspaceUiState | null>) {
  return {
    getWorkspaceUiState: vi.fn(() => uiStatePromise),
    setWorkspaceUiState: vi.fn(
      async (_payload: { workspaceId: string; state: WorkspaceUiState }) => undefined,
    ),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [
        { path: "notes/a.md", kind: "file" as const },
        { path: "notes/b.md", kind: "file" as const },
      ],
    })),
    openWorkspace: vi.fn(async () => SYNC_STATUS),
    getSyncStatus: vi.fn(async () => SYNC_STATUS),
    listChangeSets: vi.fn(async () => ({ changeSets: [] })),
    getAgentRunStatus: vi.fn(async () => ({
      mcpEnabled: false,
      activeRun: null,
      lastRun: null,
    })),
    readWorkspaceText: vi.fn(async () => ({ text: "# Doc\n", truncated: false })),
    writeWorkspaceText: vi.fn(async () => ({ path: "notes/a.md", recorded: true })),
    collabToken: vi.fn(async () => ({ available: false as const })),
    onWorkspaceActivity: vi.fn(() => () => {}),
    onMenuCommand: vi.fn(() => () => {}),
    onUpdateState: vi.fn(() => () => {}),
  };
}

function renderShell(bridge: ReturnType<typeof makeBridge>) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(
    <DesktopWorkspaceShell
      workspace={WORKSPACE}
      workspaces={[WORKSPACE]}
      onSwitchWorkspace={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// THE merge-on-load race (codex P2): the load gate used to compare COMMITTED
// state (wbRef, synced in a passive effect) against defaults. A user action
// whose commit/effects had not flushed yet read as "untouched", and the
// stored state clobbered it. The gate must be a ref set SYNCHRONOUSLY inside
// the mutation, before React even queues the update.
describe("ui-state merge-on-load", () => {
  it("a user open QUEUED before the load resolves wins over stored state (the exact stale-ref race)", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    const row = await screen.findByText("notes/a.md");

    await act(async () => {
      // Resolve the load FIRST (queues its .then as a microtask), then click
      // via a RAW dispatch: React commits the open synchronously but defers
      // passive effects (a scheduler macrotask), so when the awaited
      // microtask runs the .then, wbRef still holds the stale default. Only
      // the synchronous touched-ref can know the user already acted.
      stored.resolve(STORED_STATE);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    // The user's open survived; the stored tabs did NOT clobber it.
    expect(screen.getByTestId("tab-notes/a.md")).toBeTruthy();
    expect(screen.queryByTestId("tab-notes/b.md")).toBeNull();
    // And the pre-load action is durable: it gets written (immediate write on
    // load-settle, then the debounced writer once the commit lands).
    await waitFor(
      () => {
        const states = bridge.setWorkspaceUiState.mock.calls.map(
          ([payload]) => payload.state,
        );
        expect(
          states.some((state) => state.tabs.includes("notes/a.md")),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("stored state applies when the user touched nothing before the load", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    await screen.findByText("notes/a.md");

    await act(async () => {
      stored.resolve(STORED_STATE);
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-notes/b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-notes/b.md").dataset.active).toBe("true");
  });
});

// Spurious file-open-start marks (codex P2): a no-op click on the already-
// active row used to mark anyway — no remount/measure follows, so the stale
// mark corrupts the NEXT open's latency measure.
describe("file-open-start marking", () => {
  it("marks on a real open, but NOT on a no-op click on the already-active file", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => name === "file-open-start").length;

    const row = await screen.findByText("notes/a.md");
    await user.click(row);
    await screen.findByTestId("tab-notes/a.md");
    expect(openStartCalls()).toBe(1);

    // Re-clicking the active row is a no-op open: no remount, no mark.
    await user.click(row);
    expect(openStartCalls()).toBe(1);

    // A different file is a real open again.
    await user.click(screen.getByText("notes/b.md"));
    await screen.findByTestId("tab-notes/b.md");
    expect(openStartCalls()).toBe(2);

    mark.mockRestore();
  });
});
