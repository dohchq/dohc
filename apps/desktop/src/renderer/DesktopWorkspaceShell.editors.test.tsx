// @vitest-environment jsdom
import { installGraphFixture } from "../testing/graphPage.fixture";
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RefreshSharedViewResult, SyncDmsResult, WriteWorkspaceTextPayload, WorkspaceUiState } from "../ipc/bridgeContract";
import { type Workspace } from "./DesktopWorkspaceShell";
import { CHATS_TAB_PATH } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import { sharedViewRefusalWords } from "../testing/sharedViewRefusal.fixture";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, STORED_STATE, storedStateWithTabs, storedTabs, DM_GRAPH_NODE, CANONICAL_DM, dmSyncResult, makeBridge, renderShell, enterMarkdownSource, shellBootstrapProps, makeShareBridge } from "./DesktopWorkspaceShell.testHarness";

function checkRefusalCopy(text: string, cause?: string) {
  const lines = text.split("\n");
  expect(lines[0], "Copy starts with the refusal").toBe(`Error: ${sharedViewRefusalWords}`);
  for (const line of lines) {
    expect(line, "Each copied line is one fact").toMatch(/^[^:]+: .+$/);
    expect(line, "Copied facts omit the wire code").not.toContain("[share-collision-record]");
    expect(line, "Copied facts omit the capture class").not.toContain("CapturePartialFailureError");
  }
  for (const line of lines.slice(1)) expect(line, "Copied facts do not repeat the refusal").not.toContain(sharedViewRefusalWords);
  expect(lines.filter(line => line.startsWith("Cause:")), "Copy keeps only the filesystem cause").toEqual(cause ? [`Cause: ${cause}`] : []);
}

// Opens a notice's Details unless it is open, then copies its report. A
// plain click moves no pointer, so copying a row doesn't read it and close
// its toast.
async function copyDetails(notice: HTMLElement) {
  const closed = within(notice).queryByRole("button", { name: "Details" });
  if (closed) await act(async () => { fireEvent.click(closed); });
  await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "Copy details" })); });
}

// One share's durable skip record, as the registry holds it.
const SKIPPED_RECORD = {
  ops: [
    {
      originId: "origin-granter",
      originSeq: 7,
      opKind: "moment.append",
      code: "share-boundary-violation",
      detail:
        "replicated moment is outside the share boundary: the share " +
        "granted version main, the relay offered version version-other",
      atMs: 1000,
    },
  ],
  more: 1,
  generation: 3,
};

describe("editor groups", () => {
  function fileTreeRow(path: string): HTMLElement {
    return screen
      .getAllByTestId("tree-row")
      .find((row) => row.dataset.path === path)!;
  }

  it("copies the active tab right with Ctrl+\\ and collapses the group after its last tab closes", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    renderShell(bridge);
    expect(await screen.findByTestId("view-markdown")).toBeTruthy();

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(2),
    );
    expect(screen.getByRole("region", { name: "Editor group 2" }).dataset.active).toBe(
      "true",
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    expect(within(left).getByTestId("tab-a.md")).toBeTruthy();
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(within(left).getByTestId("view-markdown")).toBeTruthy();
    expect(await within(right).findByTestId("view-markdown")).toBeTruthy();

    await userEvent.click(fileTreeRow("b.md"));
    expect(await within(right).findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(
      () => {
        const persisted = bridge.setWorkspaceUiState.mock.calls
          .map(([payload]) => payload.state)
          .find(
            (state) =>
              state.editorGroups.length === 2 &&
              state.editorGroups[0]?.tabs.includes("a.md") &&
              state.editorGroups[1]?.tabs.includes("a.md") &&
              state.editorGroups[1]?.tabs.includes("b.md"),
          );
        expect(persisted?.activeEditorGroup).toBe(persisted?.editorGroups[1]?.id);
      },
    );
    // Press Ctrl+W again the moment the first close shows, before React runs
    // that commit's passive effects. A loaded machine produced this order.
    const tabsLeftAfterFirstClose = new Promise<string[]>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (within(right).queryByTestId("tab-b.md") !== null) return;
        observer.disconnect();
        clearTimeout(timeout);
        const tabs = within(right).queryAllByRole("tab").map((tab) => tab.dataset.testid ?? "");
        fireEvent.keyDown(window, { key: "w", ctrlKey: true });
        resolve(tabs);
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("tab-b.md never closed"));
      }, getConfig().asyncUtilTimeout);
      observer.observe(right, { childList: true, subtree: true });
    });
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(await tabsLeftAfterFirstClose).toEqual(["tab-a.md"]);
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1),
    );
    expect(screen.queryByTestId("tab-b.md")).toBeNull();
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
  });

  it("keeps the newest open when two duplicate-file flushes resolve out of order", async () => {
    const aSave = deferred<{ status: "written"; contentHash: string }>();
    const bSave = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          {
            id: "left",
            tabs: ["race-a.md"],
            activeTab: "race-a.md",
            size: 1 / 3,
          },
          {
            id: "middle",
            tabs: ["race-b.md"],
            activeTab: "race-b.md",
            size: 1 / 3,
          },
          {
            id: "right",
            tabs: ["race-c.md"],
            activeTab: "race-c.md",
            size: 1 / 3,
          },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: ["race-a.md", "race-b.md", "race-c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    // The rich editor's canonical serialization ends a paragraph with a
    // blank line. Keep this concurrency test's untouched third document in
    // that form so a delayed editor normalization is not mistaken for a user
    // edit while the two intended drafts race.
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "# Doc\n\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    bridge.writeWorkspaceText = vi.fn((payload: WriteWorkspaceTextPayload) =>
      payload.relativePath === "race-a.md" ? aSave.promise : bSave.promise,
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(3),
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const middle = screen.getByRole("region", { name: "Editor group 2" });
    const right = screen.getByRole("region", { name: "Editor group 3" });
    await user.type(await enterMarkdownSource(user, left), "Left draft");
    await user.type(await enterMarkdownSource(user, middle), "Middle draft");
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("tab-dirty")
          .map((dot) => dot.closest('[role="tab"]')?.getAttribute("data-testid")),
      ).toEqual(["tab-race-a.md", "tab-race-b.md"]),
    );

    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(fileTreeRow("race-a.md"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText.mock.calls.at(-1)?.[0].relativePath).toBe(
        "race-a.md",
      ),
    );
    await user.click(fileTreeRow("race-b.md"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(bridge.writeWorkspaceText.mock.calls[1]?.[0].relativePath).toBe(
      "race-b.md",
    );

    await act(async () => {
      bSave.resolve({ status: "written", contentHash: "b".repeat(64) });
      await bSave.promise;
    });
    await waitFor(() =>
      expect(within(right).getByTestId("tab-race-b.md").dataset.active).toBe(
        "true",
      ),
    );

    await act(async () => {
      aSave.resolve({ status: "written", contentHash: "a".repeat(64) });
      await aSave.promise;
    });
    await waitFor(() =>
      expect(within(right).getByTestId("tab-race-b.md").dataset.active).toBe(
        "true",
      ),
    );
    expect(within(right).queryByTestId("tab-race-a.md")).toBeNull();
  });

  it("closes an imported database in every group before its Undo reaches main", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["data.csv"], "data.csv")));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "data.csv", kind: "file" as const }],
      folders: [] as string[],
    }));
    // Past the preview's 500 rows, so the bound offers Import to SQLite.
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "name\n" + Array.from({ length: 501 }, (_, row) => `row ${row}`).join("\n"),
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    const undone = deferred<{ trashed: boolean }>();
    // The database tabs still showing when Undo reaches main.
    const shownAtUndo: number[] = [];
    const undoDatabaseImport = vi.fn(() => {
      shownAtUndo.push(screen.queryAllByTestId("tab-data.sqlite").length);
      return undone.promise;
    });
    Object.assign(bridge, {
      importToDatabase: vi.fn(async () => ({ operationId: "dohc-operation:import-1", path: "data.sqlite", tableName: "data", rowCount: 501 })),
      undoDatabaseImport,
      // The database views stay loading; this test is about their tabs.
      readWorkspaceDatabase: vi.fn(() => new Promise(() => {})),
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("csv-bound-import"));
    await screen.findByTestId("tab-data.sqlite");
    await user.click(screen.getByTestId("create-editor-group-right"));
    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = await screen.findByRole("region", { name: "Editor group 2" });
    await waitFor(() => expect(within(right).getByTestId("tab-data.sqlite")).toBeTruthy());
    expect(within(left).getByTestId("tab-data.sqlite")).toBeTruthy();

    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Undo" }));

    // Both tabs are gone before Undo reaches main, so no view holds the file.
    await waitFor(() => expect(undoDatabaseImport).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId, operationId: "dohc-operation:import-1" }));
    expect(shownAtUndo).toEqual([0]);
    expect(screen.getByTestId("tab-data.csv")).toBeTruthy();
    await act(async () => undone.resolve({ trashed: true }));
  });
});

describe("ui-state merge-on-load", () => {
  it("drops saved state answered after the shell changes workspaces", async () => {
    const first = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(first.promise);
    bridge.getWorkspaceUiState
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(storedStateWithTabs(["b.md"], "b.md"));
    // One mounted shell changes workspace, so A's answer can only be dropped
    // by the response guard, not by an unmount.
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(WORKSPACE));
    // A's read must be in flight, or the switch only cancels it before it starts.
    await waitFor(() => expect(bridge.getWorkspaceUiState).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId }));

    view.rerender(shell(OTHER_WORKSPACE));
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();

    await act(async () => {
      first.resolve(storedStateWithTabs(["a.md"], "a.md"));
      await first.promise;
    });

    expect(screen.getByTestId("tab-b.md"), "omit the response guard's cleanup invalidation. The first workspace's late answer replaces b.md with a.md here.").toBeTruthy();
    expect(screen.queryByTestId("tab-a.md")).toBeNull();
  });

  it("a file opened under the cover opens alongside the saved tabs (the exact stale-ref race)", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    const row = await screen.findByText("a");
    await waitFor(() => expect(bridge.getWorkspaceUiState).toHaveBeenCalledOnce());

    await act(async () => {
      // Resolve the load first (queues its .then as a microtask), then click
      // via a raw dispatch, before the saved layout commits.
      stored.resolve(STORED_STATE);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
    await waitFor(() => {
      const states = bridge.setWorkspaceUiState.mock.calls.map(([payload]) => storedTabs(payload.state));
      expect(states.some((tabs) => tabs.includes("a.md") && tabs.includes("b.md"))).toBe(true);
    });
  });

  // Journey 2: rolling back a rename left `assets/alpha-renamed.png`
  // in Open Editors for a path that no longer existed — through a restart,
  // because nothing reconciled the restored tabs against the workspace.

  // A shared workspace lists its files twice on open: once at mount, once
  // after refreshShareView pulls the changed paths. Reconciling against
  // whichever landed first would either miss a remote delete or judge the
  // restored tabs against a pre-pull snapshot.

  it("keeps a refresh that can't read the share collision record in Notices until a refresh completes", async () => {
    const words =
      "dohc did not update these shared files because it could not read .dohc/local/share-refresh/share-collision-record.json. " +
      "It keeps a refresh from replacing your own files.";
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    const refused: RefreshSharedViewResult = {
      ok: false,
      changedPaths: 0,
      errorKind: "collision-record",
      errorMessage: words,
      errorCause: "EBUSY: resource busy or locked",
    };
    const refreshed: RefreshSharedViewResult = {
      ok: true,
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    };
    const retried = deferred<RefreshSharedViewResult>();
    const retriedAgain = deferred<RefreshSharedViewResult>();
    const refresh = vi.fn<() => Promise<RefreshSharedViewResult>>()
      .mockResolvedValueOnce(refused)
      .mockReturnValueOnce(retried.promise)
      .mockReturnValueOnce(retriedAgain.promise);
    bridge.refreshSharedView = refresh;
    // userEvent's setup gives the test a clipboard to read.
    userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(words);
    expect(toast.textContent).not.toContain("Couldn't refresh the shared view.");
    await navigator.clipboard.writeText("");
    await copyDetails(toast);
    checkRefusalCopy(await navigator.clipboard.readText(), refused.errorCause);
    // The record still keeps the person's own files apart, so its row has no ×.
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = within(notices).getByText(words, { exact: false }).closest<HTMLElement>("[data-notice-row]")!;
    expect(within(row).queryByRole("button", { name: "Dismiss notice" })).toBeNull();
    await navigator.clipboard.writeText("");
    await copyDetails(row);
    checkRefusalCopy(await navigator.clipboard.readText(), refused.errorCause);

    // Try again closes Notices and runs the refresh. The row stays while it runs.
    const refreshButton = () => screen.getByTestId("shared-view-refresh") as HTMLButtonElement;
    const refusalRow = async () => {
      fireEvent.click(screen.getByTestId("notice-center-toggle"));
      return within(await screen.findByTestId("notice-center")).queryByText(words, { exact: false })?.closest<HTMLElement>("[data-notice-row]") ?? null;
    };
    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(refreshButton().disabled).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(2);
    const pendingRow = await refusalRow();
    expect(pendingRow).not.toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));

    // A refresh that fails for another reason has not completed, so the row stays.
    retried.resolve({ ok: false, changedPaths: 0, errorMessage: "Sign in to your server first." });
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    const keptRow = await refusalRow();
    expect(keptRow).not.toBeNull();

    // The refresh that completes ends the row.
    fireEvent.click(within(keptRow!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(refreshButton().disabled).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(3);
    retriedAgain.resolve(refreshed);
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    expect(screen.queryByTestId("workspace-shell-error")?.textContent ?? "").not.toContain(words);
    expect(await refusalRow()).toBeNull();
  });

  it("repaints changed files and removes generic chat before an ended share becomes read-only", async () => {
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs(["b.md"], "b.md")),
    );
    bridge.listFileChats.mockResolvedValue({
      fileObjectId: "share-object-1",
      threads: [
        {
          id: "thread-before-end",
          title: "Before end",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });
    const outcomes = [
      {
        ok: true as const,
        status: "unchanged" as const,
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      },
      {
        ok: true as const,
        status: "ended" as const,
        changedPaths: 1,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      },
    ];
    bridge.refreshSharedView = vi.fn(async () => {
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No refresh outcome left.");
      return outcome;
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "edit",
        genericChatWritable: true,
      },
    });

    await screen.findByTestId("tab-b.md");
    await userEvent.click(await screen.findByTestId("linked-chat-open"));
    expect(await screen.findByTestId("linked-chat-readonly-note")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const listCallsBeforeEnd = bridge.listWorkspaceFiles.mock.calls.length;
    const readCallsBeforeEnd = bridge.readWorkspaceText.mock.calls.length;

    await userEvent.click(screen.getByTestId("shared-view-refresh"));

    let listCallsWhenEnded = 0;
    let readCallsWhenEnded = 0;
    await waitFor(() => {
      expect(screen.getByTestId("shared-view-banner").dataset.ended).toBe("true");
      listCallsWhenEnded = bridge.listWorkspaceFiles.mock.calls.length;
      readCallsWhenEnded = bridge.readWorkspaceText.mock.calls.length;
    });
    expect(listCallsWhenEnded).toBeGreaterThan(listCallsBeforeEnd);
    expect(readCallsWhenEnded).toBeGreaterThan(readCallsBeforeEnd);
    expect(
      screen.queryByTestId("share-changes-send"),
      "an ended share still offers changes it can no longer send",
    ).toBeNull();
    expect(
      screen.queryByTestId("linked-chat-composer"),
      "an ended share still offers generic chat it can no longer send",
    ).toBeNull();
  });

  // A shared view has no recorder, so its refresh is what meets a store a
  // newer dohc migrated. Main records the refusal; the workspace stops with
  // the update actions, and the refresh adds no toast of its own.
  it("stops a shared view whose store a newer build migrated", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const refused = {
      ...SYNC_STATUS,
      historyShareView: true,
      historyCaptureFailed: true as const,
      engineStoreRefused: "migrated-by-newer-build" as const,
      engineStoreRefusedDetail:
        "a newer build ran migration 5 (from-a-newer-build), which this build does not define",
    };
    bridge.refreshSharedView = vi.fn(async () => {
      bridge.getSyncStatus = vi.fn(async () => refused);
      throw new Error("migrated-by-newer-build: a newer build ran migration 5");
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "edit",
      },
    });

    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId });
    });
    const blocked = await screen.findByTestId("workspace-update-required");
    expect(blocked.textContent).toContain(
      "A newer version of dohc updated this workspace's data store.",
    );
    expect(within(blocked).getByRole("button", { name: "Check for updates" })).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("keeps a late refresh from replacing the newer workspace notice", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    const first = deferred<RefreshSharedViewResult>();
    const second = deferred<RefreshSharedViewResult>();
    let refreshCall = 0;
    bridge.refreshSharedView = vi.fn(() =>
      refreshCall++ === 0 ? first.promise : second.promise,
    );
    const firstWorkspace: Workspace = {
      ...WORKSPACE,
      workspaceId: "ws-first",
      shareView: {
        shareId: "share-first",
        granterEmail: "first@dohc.test",
        access: "edit",
      },
    };
    const secondWorkspace: Workspace = {
      ...WORKSPACE,
      workspaceId: "ws-second",
      shareView: {
        shareId: "share-second",
        granterEmail: "second@dohc.test",
        access: "edit",
      },
    };
    const rendered = renderShell(bridge, firstWorkspace, [
      firstWorkspace,
      secondWorkspace,
    ]);
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <DesktopWorkspaceShell
        workspace={secondWorkspace}
        workspaces={[firstWorkspace, secondWorkspace]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: ["docs/new-pull.md"],
        unjournalablePaths: [
          { path: "docs/new-local.md", reason: "non-utf8" },
        ],
        refusedOps: 0,
        refusedDetail: null,
      });
      await second.promise;
    });
    expect((await screen.findByTestId("shared-view-excluded")).title).toBe("docs/new-local.md");

    await act(async () => {
      first.resolve({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: ["docs/stale-pull.md"],
        unjournalablePaths: [
          { path: "docs/stale-local.md", reason: "oversized-text" },
        ],
        refusedOps: 0,
        refusedDetail: null,
      });
      await first.promise;
    });
    expect(screen.getByTestId("shared-view-excluded").title).toBe("docs/new-local.md");
  });

  // A refused op is skipped and the pull keeps going, so the shared view goes
  // on looking healthy while it quietly stops carrying part of what the
  // granter shares. The warning comes from the RECORD, not from the last
  // refresh: the cursor has committed past those ops, so a quiet refresh must
  // not clear it and a restart must not lose it.
  it("says so when a share's record holds ops its pulls skipped", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([])),
    );
    // A refresh that finds nothing new. The warning must survive it.
    bridge.refreshSharedView = vi.fn(async () => ({
      ok: true as const,
      status: "unchanged" as const,
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    }));
    const dismiss = vi.fn(
      async (_payload: { workspaceId: string; generation: number }) => undefined,
    );
    bridge.dismissShareSkips = dismiss;
    // The record the shell re-reads. Dismissing does not delete it: main
    // raises acknowledgedGeneration and the ops stay, so the fixture models
    // that rather than a record that vanishes.
    let acknowledged = 0;
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            skippedOps: {
              ...SKIPPED_RECORD,
              acknowledgedGeneration: acknowledged,
            },
          },
        },
      ],
    }));
    dismiss.mockImplementation(async (payload) => {
      acknowledged = payload.generation;
      return undefined;
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
        skippedOps: SKIPPED_RECORD,
      },
    });

    const lines = await screen.findAllByTestId("shared-view-refused");
    const boundary = lines.find(
      (line) => line.getAttribute("data-kind") === "boundary",
    );
    expect(
      boundary?.textContent,
      "reading the last refresh instead of the record clears the warning while the content is still missing",
    ).toContain("dohc skipped 1 update outside what this share covers");
    expect(boundary?.textContent).toContain("granter@dohc.test");
    expect(boundary?.getAttribute("title")).toContain("version-other");
    // The overflow keeps no class, so it names no cause and sends the reader
    // nowhere.
    const overflow = lines.find(
      (line) => line.getAttribute("data-kind") === "unknown",
    );
    expect(overflow?.textContent).toContain(
      "dohc skipped 1 more update from this share",
    );
    expect(overflow?.textContent).not.toContain("granter@dohc.test");

    // The only honest recovery this surface has: the user says they have seen
    // it. That is recorded durably — and it hides the warning rather than
    // deleting the evidence, because the content it names is gone for good.
    await userEvent.click(
      screen.getAllByTestId("shared-view-refused-dismiss")[0]!,
    );
    expect(dismiss).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      // The generation on screen: a refusal recorded since this render is not
      // acknowledged by this click.
      generation: SKIPPED_RECORD.generation,
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId("shared-view-refused")).toHaveLength(0);
    });
  });

  // P1: closing a dirty tab unmounts the inspector mid-draft, and its cleanup
  // flushes best-effort to a path that no longer exists. resolveWorkspaceFile
  // requires the file, the write fails, the failure is swallowed — the draft
  // would be gone with no error and no way back.
  it("never closes a restored tab with an unsaved draft, and closes it once saved", async () => {
    const listing = (...paths: string[]) => ({ visibility: { status: "ready" as const, rules: [] },
      files: paths.map((path) => ({ path, kind: "file" as const })),
      folders: [] as string[],
    });
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    renderShell(bridge);

    // Type into the restored tab's document without letting it settle.
    await screen.findByTestId("view-markdown");
    await user.type(await enterMarkdownSource(user), "Draft!");
    await screen.findByTestId("tab-dirty");
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();

    // The file disappears from the workspace while that draft is unsaved.
    bridge.listWorkspaceFiles = vi.fn(async () => listing("b.md"));
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });

    // The tab stays open, so the draft still has somewhere to live.
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-dirty")).toBeTruthy();

    // Once the draft settles, the deferred close completes.
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByTestId("tab-a.md")).toBeNull();
    });
  });

  // A failure is not an answer, so it cannot make an older snapshot
  // authoritative for closing: the listing that failed may have been the one
  // that would have shown a file pulled back in. The close waits for a
  // success issued after the failure. It is not blocked forever — the next
  // successful listing re-enables it — and correctness beats eagerness for
  // work that cannot be undone.
  it("waits for a listing that succeeds after a failure before closing", async () => {
    const older = deferred<{ visibility: { status: "ready"; rules: [] };
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    const third = deferred<{ visibility: { status: "ready"; rules: [] };
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    // Keep Chats closed; the listing and both live editors subscribe to activity.
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs(["b.md", "gone.md"], "b.md"),
        aboutVisible: false,
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() => {
      issued += 1;
      return issued === 1 ? older.promise : issued === 2 ? newer : third.promise;
    });
    renderShell(bridge);

    await waitFor(() => {
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(bridge.workspaceActivitySubscriberCount()).toBe(3);
      expect(screen.getByTestId("tab-gone.md")).toBeTruthy();
    });
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The older listing commits, but a newer request is still in flight.
    await act(async () => {
      older.resolve({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "b.md", kind: "file" }], folders: [] });
      await older.promise;
    });
    expect(await screen.findByTestId("tab-gone.md")).toBeTruthy();

    // The newer request fails. Everything has settled now, but that failure
    // could have been the listing that would have shown the file pulled back
    // in, so the older snapshot cannot authorise a close.
    await act(async () => {
      failNewer(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("tab-gone.md")).toBeTruthy();

    // A listing issued after the failure answers, and still does not have the
    // file. Now the close is authorised.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await act(async () => {
      third.resolve({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "b.md", kind: "file" }], folders: [] });
      await third.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  // Cancelling on every workbench write would make this seam hostile: a user
  // who clicks a DM and then adjusts the sidebar would lose the click when the
  // final width commits — and the syncDms failure branch is isCurrent-gated
  // too, so nothing would surface. Only a destination change cancels.
  it("keeps an in-flight DM navigation through a sidebar width drag", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    installGraphFixture(bridge, {
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    });
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("graph-file-row").some(row => row.dataset.path?.startsWith("chat-thread:"))).toBe(true));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Drag the sidebar edge. Its one release commit does not move the active
    // tab.
    const panel = screen.getByTestId("side-panel");
    expect(panel.style.width).toBe("240px");
    const handle = screen.getByTestId("sidebar-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1 });
    await waitFor(() => expect(panel.style.width).toBe("420px"));

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });

    expect(await screen.findByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeTruthy();
  });

  // The session signal reaches the SHELL: cloudStatus derives the presence
  // collaboration, so a sign-out must tear the old account's presence down
  // (abort its long poll) and re-query the status immediately — not when
  // some later refresh notices.
  it("tears presence down and re-queries cloud status on a session change", async () => {
    const user = userEvent.setup();
    const sessionListeners: Array<
      (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void
    > = [];
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH),
        aboutVisible: false,
      }),
    );
    bridge.onCloudSessionChanged = vi.fn(
      (
        callback: (event: {
          sessionKey: string | null;
          phase: "changing" | "ready";
        }) => void,
      ) => {
        sessionListeners.push(callback);
        return () => {};
      },
    );
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      relayUrl: "wss://relay.dohc.test",
      workspaceSynced: true,
    }));
    bridge.listChatChannels = vi.fn(async () => ({
      channels: [
        {
          id: "channel-team",
          name: "team",
          slug: "team",
          kind: "channel" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
          threadCount: 0,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    }));
    const presence = Object.assign(bridge, {
      listChatChannelShares: vi.fn(async () => ({
        joined: [],
        sessionKey: "session-a",
        relay: { state: "answered" as const, granted: [], received: [], removed: [] },
      })),
      presencePublish: vi.fn(async () => ({
        ok: true as const,
        snapshot: { version: 1, peers: [] },
      })),
      presencePoll: vi.fn(() => new Promise(() => {})),
      presenceCancel: vi.fn(async () => ({ ok: true as const })),
    });
    renderShell(presence);

    // Select a channel from the sidebar: presence engages in the editor.
    await screen.findByTestId("chats-personal-feed");
    await user.click(screen.getByTestId("activity-chats"));
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(presence.presencePublish).toHaveBeenCalled());
    // The list stays mounted beside the live tab and holds no transport of
    // its own: the channel topic has exactly one publisher, the page.
    expect(screen.getByTestId("side-panel").querySelector('[data-testid="chats-view"]')).toBeTruthy();
    const channelPublishes = (presence.presencePublish.mock.calls as unknown as [{ topic: string; incarnationId: string }][])
      .map(([payload]) => payload)
      .filter((payload) => payload.topic === "channel-team");
    expect(channelPublishes.length).toBeGreaterThan(0);
    expect(new Set(channelPublishes.map((payload) => payload.incarnationId)).size).toBe(1);
    const statusQueries = bridge.cloudStatus.mock.calls.length;

    // Sign out. The signal alone must tear presence down — the collaboration
    // rebuilds dormant off the dropped status — and re-query the status.
    act(() => {
      for (const listener of sessionListeners) {
        listener({ sessionKey: null, phase: "ready" });
      }
    });
    await waitFor(() => expect(presence.presenceCancel).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.cloudStatus.mock.calls.length).toBeGreaterThan(statusQueries),
    );
  });

  // Chat mocks the Chats PAGE needs to load its feed and a thread. The base
  // engine bridge only stubs the navigator's overview surface.
  function chatsPageBridge(uiState: WorkspaceUiState) {
    const bridge = makeBridge(Promise.resolve(uiState));
    const syncAnswers: Array<(value: SyncDmsResult) => void> = [];
    bridge.syncDms = vi.fn(
      () =>
        new Promise<SyncDmsResult>((resolve) => {
          syncAnswers.push(resolve);
        }),
    );
    bridge.listChatChannels = vi.fn(async () => ({
      channels: [
        {
          id: "channel-team",
          name: "team",
          slug: "team",
          kind: "channel" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
          threadCount: 1,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    }));
    installGraphFixture(bridge, {
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    });
    return Object.assign(bridge, {
      syncAnswers,
      listPersonalChatFeed: vi.fn(async () => ({
        items: [
          {
            message: { presentation: { group: "fixture", hue: null, self: false },
              id: "message-feed",
              threadId: "thread-team",
              authorKind: "human" as const,
              authorDisplayName: "You",
              body: "Feed update worth revisiting",
              createdAtMs: 1,
            },
            thread: {
              id: "thread-team",
              title: "Feed thread",
              createdAtMs: 1,
              updatedAtMs: 1,
              channelId: "channel-team",
              messageCount: 1,
              lastReadSequence: 1,
              unreadCount: 0,
            },
            channel: {
              id: "channel-team",
              name: "team",
              slug: "team",
              kind: "channel" as const,
            },
            reactions: [],
            matchedBy: ["channel" as const],
          },
        ],
      })),
      listChatMessages: vi.fn(async () => ({
        messages: [
          { presentation: { group: "fixture", hue: null, self: false },
            id: "message-feed",
            threadId: "thread-team",
            authorKind: "human" as const,
            authorDisplayName: "You",
            body: "Feed update worth revisiting",
            createdAtMs: 1,
          },
        ],
      })),
      listChatReactions: vi.fn(async () => ({ reactions: [], viewerAuthorId: "you" })),
      listChatThreadDecisions: vi.fn(async () => ({ decisions: [] })),
      listChatThreadAttachments: vi.fn(async () => ({ attachments: [] })),
      chatRunRecordsForThread: vi.fn(async () => ({ runs: {} })),
      chatDispatchStateForThread: vi.fn(async () => ({
        liveRunId: null, liveTriggerMessageId: null,
        pendingCount: 0,
        paused: false,
      })),
      markChatThreadRead: vi.fn(async () => ({ lastReadSequence: 1, revision: 1 })),
    });
  }

  const CHATS_PAGE_STATE: WorkspaceUiState = {
    ...storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH),
    aboutVisible: false,
  };

  // The Chats PAGE's feed/backlink click is a COMMAND. It must cancel a
  // pending DM lookup synchronously in the click — the passive nav report is
  // an effect that flushes after the microtask queue, so a DM answer landing
  // in the same tick as the click would pass its isCurrent() check first and
  // remount the page over the message the user just jumped to.
  it("discards a DM answer that lands in the same tick as a page feed click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // The page mounts on the Chats tab; go to the Feed.
    await screen.findByTestId("chats-personal-feed");
    const post = await screen.findByText("Feed update worth revisiting");
    const postButton = post.closest("button")!;

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("graph-file-row").some(row => row.dataset.path?.startsWith("chat-thread:"))).toBe(true));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    // Collapse the sidebar so only the Chats page answers the queries below.
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user clicks the feed item: the
    // answer's continuation is queued first, and the click handler runs
    // before it does. Only a cancellation issued before the next macrotask
    // wins this race — the passive nav report flushes too late.
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM]));
      postButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // The feed click opens its channel once; the delayed DM opens no tab.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore + 1);
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();

  });

  // The same race through the back button: every BackHeader and the keyboard
  // shortcut route through goBack, which must issue the same synchronous
  // command — a DM answer queued in the tick of the Back click would
  // otherwise pass its isCurrent() check and remount the DM over the channel
  // the user went back to.

  // The same race through "New message": the compose screen opens with a
  // direct nav write, and a DM answer queued in the same tick would remount
  // the DM over the compose the user just opened.

  // The awaited form of the same click: a feed item carrying a focus target
  // navigates in place (openConversation -> command + report), and the DM
  // answers late. The destination write must cancel it.

  // The in-thread reply-parent jump. It is the one command in the page
  // that writes NO navigation — it only scrolls — so every other seam here
  // (the destination write, the remount, the nav report) sees nothing move.
  // A DM lookup that answers afterwards would still replace the page with the
  // conversation the user left, taking away the message they just jumped to.

  // The surviving mutant from the review: openFile's heading-target
  // invalidation. A heading jump into the ALREADY-ACTIVE file moves no tab,
  // so mutateWb's transition check cannot see it — only openFile's own
  // `if (target)` branch cancels the pending DM.

  // A request that is merely in flight has not answered anything, and a
  // request that fails never will. Superseding on ISSUE would drop the only
  // answer there is and leave the explorer empty with nothing to retry it.

  // Listings resolve out of order (the mount listing can overtake the one the
  // share pull triggered). An older snapshot committing last would show a
  // stale tree and, worse, make the reconciliation read a live file as
  // deleted and close its tab.

  // Either load can win. When the listing lands first there is nothing
  // restored to judge yet, so the restore itself has to re-run the check —
  // otherwise the missing tab survives and gets written back out.

  // The scoping earns its keep here: only stored tabs are eligible, so a
  // listing that raced a create cannot close what the user just opened.

  it("stored state applies when the user touched nothing before the load", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    await screen.findByText("a");

    await act(async () => {
      stored.resolve(STORED_STATE);
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    expect((await screen.findByTestId("side-panel")).style.width).toBe("320px");
    expect((await screen.findByTestId("about-rail")).style.width).toBe("360px");
  });
});
