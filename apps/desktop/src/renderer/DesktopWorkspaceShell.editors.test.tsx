// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import type { ReadWorkspaceTextPayload, RefreshSharedViewResult, SyncDmsResult, WriteWorkspaceTextPayload, WorkspaceUiState } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, pendingHeadingTargetForOpen, type Workspace } from "./DesktopWorkspaceShell";
import { WORKSPACE_ACTIVITY_REFRESH_DELAY_MS } from "./workspaceActivityCoalescer";
import { CHATS_TAB_PATH } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import { WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, STORED_STATE, storedStateWithTabs, storedTabs, isFileOpenStartMark, DM_GRAPH_NODE, CANONICAL_DM, dmSyncResult, makeBridge, renderShell, enterMarkdownSource, holdHistory, shellBootstrapProps, makeShareBridge, settleShareView } from "./DesktopWorkspaceShell.testHarness";

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

  it("keeps the close-selected neighbor when an older duplicate-file open finishes flushing", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          {
            id: "left",
            tabs: ["race-a.md"],
            activeTab: "race-a.md",
            size: 0.5,
          },
          {
            id: "right",
            tabs: ["b.md", "c.md"],
            activeTab: "c.md",
            size: 0.5,
          },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["race-a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "# Doc\n\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    await user.type(await enterMarkdownSource(user, left), "Draft");
    await waitFor(() =>
      expect(within(left).getByTestId("tab-dirty")).toBeTruthy(),
    );

    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(fileTreeRow("race-a.md"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    await user.click(
      within(within(right).getByTestId("tab-c.md")).getByRole("button", {
        name: "Close c.md",
      }),
    );
    await waitFor(() =>
      expect(within(right).queryByTestId("tab-c.md")).toBeNull(),
    );
    expect(within(right).getByTestId("tab-b.md").dataset.active).toBe("true");

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() =>
      expect(within(right).getByTestId("tab-b.md").dataset.active).toBe("true"),
    );
    expect(within(right).queryByTestId("tab-race-a.md")).toBeNull();
  });

  it("keeps a newer duplicate-file open when a delayed cross-group move completes", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
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
          { id: "middle", tabs: ["b.md"], activeTab: "b.md", size: 1 / 3 },
          { id: "right", tabs: ["c.md"], activeTab: "c.md", size: 1 / 3 },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["race-a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(3),
    );
    const left = screen.getByTestId("editor-group-left");
    const middle = screen.getByTestId("editor-group-middle");
    const right = screen.getByTestId("editor-group-right");
    await user.type(await enterMarkdownSource(user, left), " dirty");
    await waitFor(() => expect(within(left).getByTestId("tab-dirty")).toBeTruthy());
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => middle),
    });

    const source = within(left).getByTestId("tab-race-a.md");
    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(source, {
      buttons: 1,
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());

    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(fileTreeRow("race-a.md"));

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() => {
      expect(within(right).getByTestId("tab-race-a.md").dataset.active).toBe(
        "true",
      );
      expect(within(middle).getByTestId("tab-b.md").dataset.active).toBe("true");
      expect(within(middle).getByTestId("tab-race-a.md").dataset.active).not.toBe(
        "true",
      );
    });
  });

  it("keeps a newer duplicate-file open when a delayed split completes", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
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
          { id: "middle", tabs: ["b.md"], activeTab: "b.md", size: 1 / 3 },
          { id: "right", tabs: ["c.md"], activeTab: "c.md", size: 1 / 3 },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["race-a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(3),
    );
    const left = screen.getByTestId("editor-group-left");
    const right = screen.getByTestId("editor-group-right");
    await user.type(await enterMarkdownSource(user, left), " dirty");
    await waitFor(() => expect(within(left).getByTestId("tab-dirty")).toBeTruthy());

    await user.click(within(left).getByTestId("create-editor-group-right"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(fileTreeRow("race-a.md"));

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() => {
      expect(within(right).getByTestId("tab-race-a.md").dataset.active).toBe(
        "true",
      );
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(4);
    });
  });

  it("does not offer Split Right for the singleton Chats tab", async () => {
    renderShell(
      makeBridge(
        Promise.resolve(storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH)),
      ),
    );

    await screen.findByTestId("tab-dohc://chats");
    expect(
      (screen.getByTestId("create-editor-group-right") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("explains why a lifecycle-owned tab cannot create an editor group", async () => {
    const user = userEvent.setup();
    renderShell(
      makeBridge(
        Promise.resolve(storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH)),
      ),
    );

    await screen.findByTestId("tab-dohc://chats");
    expect(
      (screen.getByTestId("create-editor-group-right") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "New editor group right",
      ),
    );

    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain(
      "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
    );
    expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1);
  });

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

  it("keeps newer group focus when split creation finishes saving", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "# Doc\n\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    await user.type(await enterMarkdownSource(user, right), "Draft");
    await waitFor(() => expect(within(right).getByTestId("tab-dirty")).toBeTruthy());

    await user.click(within(right).getByTestId("create-editor-group-right"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    fireEvent.pointerDown(left);
    await waitFor(() => expect(left.dataset.active).toBe("true"));

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    const split = await screen.findByRole("region", { name: "Editor group 3" });
    expect(within(split).getByTestId("tab-b.md")).toBeTruthy();
    expect(left.dataset.active).toBe("true");
    expect(split.dataset.active).not.toBe("true");
  });

  it("keeps a newer tab focused when a delayed move creates a group", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("view-markdown");
    await user.type(await enterMarkdownSource(user), "Draft");
    await waitFor(() => expect(screen.getByTestId("tab-dirty")).toBeTruthy());

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    await user.click(screen.getByTestId("tab-b.md"));
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = await screen.findByRole("region", { name: "Editor group 2" });
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(within(left).getByTestId("tab-b.md").dataset.active).toBe("true");
    expect(left.dataset.active).toBe("true");
  });

  it("keeps a newer destination tab focused when a delayed drag completes", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          {
            id: "right",
            tabs: ["b.md", "c.md"],
            activeTab: "b.md",
            size: 0.5,
          },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    await user.type(await enterMarkdownSource(user, left), "Draft");
    await waitFor(() => expect(within(left).getByTestId("tab-dirty")).toBeTruthy());
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => right),
    });

    const source = within(left).getByTestId("tab-a.md");
    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(source, {
      buttons: 1,
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    await user.click(within(right).getByTestId("tab-c.md"));
    expect(within(right).getByTestId("tab-c.md").dataset.active).toBe("true");

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() => expect(within(left).queryByTestId("tab-a.md")).toBeNull());
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(within(right).getByTestId("tab-c.md").dataset.active).toBe("true");
    expect(right.dataset.active).toBe("true");
  });

  it("keeps a newer duplicate-file open in an empty drag destination", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 1 / 3 },
          { id: "middle", tabs: ["b.md"], activeTab: "b.md", size: 1 / 3 },
          { id: "right", tabs: [], activeTab: null, size: 1 / 3 },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "b.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "# Doc\n\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const middle = screen.getByRole("region", { name: "Editor group 2" });
    const right = screen.getByRole("region", { name: "Editor group 3" });
    await user.type(await enterMarkdownSource(user, left), "Left draft");
    await user.type(await enterMarkdownSource(user, middle), "Middle draft");
    await waitFor(() => {
      expect(within(left).getByTestId("tab-dirty")).toBeTruthy();
      expect(within(middle).getByTestId("tab-dirty")).toBeTruthy();
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => right),
    });

    const source = within(left).getByTestId("tab-a.md");
    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(source, {
      buttons: 1,
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });
    await waitFor(() =>
      expect(
        bridge.writeWorkspaceText.mock.calls.some(
          ([payload]) => payload.relativePath === "a.md",
        ),
      ).toBe(true),
    );

    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(fileTreeRow("b.md"));
    await waitFor(() =>
      expect(
        bridge.writeWorkspaceText.mock.calls.some(
          ([payload]) => payload.relativePath === "b.md",
        ),
      ).toBe(true),
    );
    expect(within(right).queryByTestId("tab-b.md")).toBeNull();

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() =>
      expect(within(right).getByTestId("tab-b.md").dataset.active).toBe("true"),
    );
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(right.dataset.active).toBe("true");
  });

  it("closes an empty editor group from its visible control", async () => {
    renderShell(
      makeBridge(
        Promise.resolve({
          ...STORED_STATE,
          editorGroups: [
            { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
            { id: "right", tabs: [], activeTab: null, size: 0.5 },
          ],
          activeEditorGroup: "right",
        }),
      ),
    );
    expect(await screen.findByTestId("view-markdown")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(2),
    );
    await userEvent.click(
      within(screen.getByRole("region", { name: "Editor group 2" })).getByRole(
        "button",
        { name: "Close editor group" },
      ),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: "Close editor group" })).toBeNull();
  });

  it("opens a file in the focused group even when another group already has it", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "right",
      }),
    );
    renderShell(bridge);
    await screen.findByRole("region", { name: "Editor group 2" });
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });

    await userEvent.click(fileTreeRow("a.md"));

    expect(within(left).getByTestId("tab-a.md")).toBeTruthy();
    expect(await within(right).findByTestId("tab-a.md")).toBeTruthy();
    expect(right.dataset.active).toBe("true");
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
    bridge.listWorkspaceFiles = vi.fn(async () => ({
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

  it.each([
    { destination: "an existing tab", navigate: "tab" as const },
    { destination: "another editor group", navigate: "group" as const },
  ])(
    "keeps $destination selected when an older duplicate-file open finishes flushing",
    async ({ navigate }) => {
      const save = deferred<{ status: "written"; contentHash: string }>();
      const bridge = makeBridge(
        Promise.resolve({
          ...STORED_STATE,
          editorGroups: [
            {
              id: "left",
              tabs: ["race-a.md"],
              activeTab: "race-a.md",
              size: 0.5,
            },
            {
              id: "right",
              tabs: ["b.md", "c.md"],
              activeTab: "c.md",
              size: 0.5,
            },
          ],
          activeEditorGroup: "right",
        }),
      );
      bridge.listWorkspaceFiles = vi.fn(async () => ({
        files: ["race-a.md", "b.md", "c.md"].map((path) => ({
          path,
          kind: "file" as const,
        })),
        folders: [],
      }));
      bridge.readWorkspaceText = vi.fn(async () => ({
        text: "# Doc\n\n",
        truncated: false as const,
        contentHash: "a".repeat(64),
      }));
      bridge.writeWorkspaceText = vi.fn(() => save.promise);
      const user = userEvent.setup();
      renderShell(bridge);

      await waitFor(() =>
        expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
      );
      const left = screen.getByRole("region", { name: "Editor group 1" });
      const right = screen.getByRole("region", { name: "Editor group 2" });
      await user.type(await enterMarkdownSource(user, left), "Draft");
      await waitFor(() =>
        expect(within(left).getByTestId("tab-dirty")).toBeTruthy(),
      );

      fireEvent.pointerDown(right);
      await waitFor(() => expect(right.dataset.active).toBe("true"));
      await user.click(fileTreeRow("race-a.md"));
      await waitFor(() =>
        expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1),
      );

      if (navigate === "tab") {
        await user.click(within(right).getByTestId("tab-b.md"));
        expect(within(right).getByTestId("tab-b.md").dataset.active).toBe(
          "true",
        );
      } else {
        fireEvent.pointerDown(left);
        await waitFor(() => expect(left.dataset.active).toBe("true"));
      }

      await act(async () => {
        save.resolve({ status: "written", contentHash: "b".repeat(64) });
        await save.promise;
      });

      if (navigate === "tab") {
        await waitFor(() =>
          expect(within(right).getByTestId("tab-b.md").dataset.active).toBe(
            "true",
          ),
        );
      } else {
        await waitFor(() => expect(left.dataset.active).toBe("true"));
        expect(right.dataset.active).not.toBe("true");
      }
      expect(within(right).queryByTestId("tab-race-a.md")).toBeNull();
    },
  );

  it.each([
    {
      destination: "Graph",
      tabPath: "dohc://graph",
      navigate: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByTestId("activity-graph"));
        await user.click(await screen.findByTestId("graph-open-tab"));
      },
    },
    {
      destination: "History",
      tabPath: "dohc://history",
      navigate: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByTestId("activity-history"));
        await user.click(await screen.findByTestId("history-open-tab"));
      },
    },
    {
      destination: "Chats",
      tabPath: "dohc://chats",
      navigate: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(await screen.findByTestId("chats-open-tab"));
      },
    },
    {
      destination: "Compare with Main",
      tabPath: "dohc://versions/compare/v-old",
      navigate: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(await screen.findByTestId("version-menu-button"));
        await user.click(await screen.findByTestId("version-compare"));
      },
    },
  ])(
    "keeps $destination selected when an older duplicate-file open finishes flushing",
    async ({ tabPath, navigate }) => {
      const save = deferred<{ status: "written"; contentHash: string }>();
      const bridge = makeBridge(
        Promise.resolve({
          ...STORED_STATE,
          editorGroups: [
            {
              id: "left",
              tabs: ["race-a.txt"],
              activeTab: "race-a.txt",
              size: 0.5,
            },
            {
              id: "right",
              tabs: ["b.md"],
              activeTab: "b.md",
              size: 0.5,
            },
          ],
          activeEditorGroup: "right",
        }),
      );
      bridge.listWorkspaceFiles = vi.fn(async () => ({
        files: ["race-a.txt", "b.md"].map((path) => ({
          path,
          kind: "file" as const,
        })),
        folders: [],
      }));
      bridge.readWorkspaceText = vi.fn(async () => ({
        text: "Draft base",
        truncated: false as const,
        contentHash: "a".repeat(64),
      }));
      bridge.writeWorkspaceText = vi.fn(() => save.promise);
      bridge.listWorkspaceVersions = vi.fn(async () => ({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "v-old",
            name: "Earlier draft",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: "v-old",
      }));
      const user = userEvent.setup();
      renderShell(bridge);
      await settleShareView();

      const left = await screen.findByRole("region", {
        name: "Editor group 1",
      });
      const right = screen.getByRole("region", { name: "Editor group 2" });
      const content = (await within(left).findByTestId("view-text-editor"))
        .querySelector(".cm-content") as HTMLElement;
      await user.click(content);
      await user.keyboard("{End} changed");
      await waitFor(() =>
        expect(within(left).getByTestId("view-text-save-state").dataset.state).toBe(
          "saving",
        ),
      );
      expect(within(left).getByTestId("tab-dirty")).toBeTruthy();

      fireEvent.pointerDown(right);
      await waitFor(() => expect(right.dataset.active).toBe("true"));
      await user.click(fileTreeRow("race-a.txt"));
      await waitFor(() =>
        expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1),
      );

      await navigate(user);
      await waitFor(() =>
        expect(within(right).getByTestId(`tab-${tabPath}`).dataset.active).toBe(
          "true",
        ),
      );

      await act(async () => {
        save.resolve({ status: "written", contentHash: "b".repeat(64) });
        await save.promise;
      });

      await waitFor(() =>
        expect(within(right).getByTestId(`tab-${tabPath}`).dataset.active).toBe(
          "true",
        ),
      );
      expect(right.dataset.active).toBe("true");
      expect(within(right).queryByTestId("tab-race-a.txt")).toBeNull();
    },
  );

  it.each([
    { destination: "a split group", navigate: "split" as const },
    { destination: "an existing group", navigate: "move" as const },
    { destination: "a new group", navigate: "move-new" as const },
  ])(
    "keeps $destination focused when an older duplicate-file open finishes flushing",
    async ({ navigate }) => {
      const save = deferred<{ status: "written"; contentHash: string }>();
      const bridge = makeBridge(
        Promise.resolve({
          ...STORED_STATE,
          editorGroups: [
            {
              id: "left",
              tabs: ["race-a.md"],
              activeTab: "race-a.md",
              size: 0.5,
            },
            {
              id: "right",
              tabs: ["b.md"],
              activeTab: "b.md",
              size: 0.5,
            },
          ],
          activeEditorGroup: "right",
        }),
      );
      bridge.listWorkspaceFiles = vi.fn(async () => ({
        files: ["race-a.md", "b.md"].map((path) => ({
          path,
          kind: "file" as const,
        })),
        folders: [],
      }));
      bridge.readWorkspaceText = vi.fn(async () => ({
        text: "# Doc\n\n",
        truncated: false as const,
        contentHash: "a".repeat(64),
      }));
      bridge.writeWorkspaceText = vi.fn(() => save.promise);
      bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
      Object.defineProperty(Element.prototype, "setPointerCapture", {
        configurable: true,
        value: vi.fn(),
      });
      Object.defineProperty(Element.prototype, "hasPointerCapture", {
        configurable: true,
        value: vi.fn(() => false),
      });
      const user = userEvent.setup();
      renderShell(bridge);

      await waitFor(() =>
        expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
      );
      const left = screen.getByRole("region", { name: "Editor group 1" });
      const right = screen.getByRole("region", { name: "Editor group 2" });
      await user.type(await enterMarkdownSource(user, left), "Draft");
      await waitFor(() =>
        expect(within(left).getByTestId("tab-dirty")).toBeTruthy(),
      );

      fireEvent.pointerDown(right);
      await waitFor(() => expect(right.dataset.active).toBe("true"));
      await user.click(fileTreeRow("race-a.md"));
      await waitFor(() =>
        expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1),
      );

      if (navigate === "split") {
        await user.click(within(right).getByTestId("create-editor-group-right"));
      } else if (navigate === "move-new") {
        fireEvent.contextMenu(within(right).getByTestId("tab-b.md"));
      } else {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: vi.fn(() => left),
        });
        const source = within(right).getByTestId("tab-b.md");
        fireEvent.pointerDown(source, {
          button: 0,
          pointerId: 9,
          clientX: 10,
        });
        fireEvent.pointerMove(source, {
          pointerId: 9,
          buttons: 1,
          clientX: 30,
          clientY: 40,
        });
        fireEvent.pointerUp(source, {
          pointerId: 9,
          clientX: 30,
          clientY: 40,
        });
      }

      const destination =
        navigate === "move"
          ? left
          : await screen.findByRole("region", { name: "Editor group 3" });
      await waitFor(() => expect(destination.dataset.active).toBe("true"));
      expect(within(destination).getByTestId("tab-b.md").dataset.active).toBe(
        "true",
      );

      await act(async () => {
        save.resolve({ status: "written", contentHash: "b".repeat(64) });
        await save.promise;
      });

      await waitFor(() => expect(destination.dataset.active).toBe("true"));
      expect(within(destination).getByTestId("tab-b.md").dataset.active).toBe(
        "true",
      );
      expect(within(right).queryByTestId("tab-race-a.md")).toBeNull();
    },
  );

  it("moves a tab into an empty editor group by pointer drag", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: [], activeTab: null, size: 0.5 },
        ],
        activeEditorGroup: "left",
      }),
    );
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    renderShell(bridge);
    await screen.findByRole("region", { name: "Editor group 2" });
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => right),
    });
    const source = within(left).getByTestId("tab-a.md");

    fireEvent.pointerDown(source, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(source, {
      pointerId: 7,
      buttons: 1,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerUp(source, { pointerId: 7, clientX: 30, clientY: 40 });

    await waitFor(() => expect(within(left).queryByTestId("tab-a.md")).toBeNull());
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(right.dataset.active).toBe("true");
  });

  it("shares one live document session when the active Markdown file is split", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    const doc = markdownToYDoc("# Shared\n");
    const openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageGeneration: 1,
    }));
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({
        accepted: true as const,
        updates: [],
      })),
    });
    renderShell(bridge);
    await screen.findByTestId("markdown-source-toggle");

    await userEvent.click(screen.getByTestId("create-editor-group-right"));

    await waitFor(() =>
      expect(screen.getAllByTestId("markdown-source-toggle")).toHaveLength(2),
    );
    expect(openEngineYDocSession).toHaveBeenCalledTimes(1);
  });

  it("keeps different surfaces visible and routes new opens to the focused group", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [
        { path: "a.md", kind: "file" as const },
        { path: "b.md", kind: "file" as const },
        { path: "data.csv", kind: "file" as const },
        { path: "other.csv", kind: "file" as const },
      ],
      folders: [] as string[],
    }));
    bridge.readWorkspaceText = vi.fn(async (payload: ReadWorkspaceTextPayload) => ({
      text: payload.relativePath.endsWith(".csv") ? "name,value\nAda,1\n" : "# Doc\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("view-markdown");

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = await screen.findByRole("region", { name: "Editor group 2" });
    await waitFor(() => expect(right.dataset.active).toBe("true"));

    await user.click(fileTreeRow("data.csv"));
    expect(await within(right).findByTestId("view-csv")).toBeTruthy();
    expect(within(left).getByTestId("view-markdown")).toBeTruthy();

    fireEvent.pointerDown(left);
    await user.click(fileTreeRow("other.csv"));
    expect(await within(left).findByTestId("tab-other.csv")).toBeTruthy();
    expect(within(right).getByTestId("tab-data.csv")).toBeTruthy();

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("tab-other.csv")).toBeNull());
    expect(screen.getByTestId("tab-data.csv")).toBeTruthy();
  });

  it("does not keep save-first state after a dirty editor unmounts", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("view-markdown");
    await user.type(await enterMarkdownSource(user), "Draft!");
    await screen.findByTestId("tab-dirty");

    await user.click(screen.getByTestId("tab-b.md"));
    await waitFor(() => expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true"));
    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);

    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    expect(screen.queryByTestId("version-switch-save-confirm")).toBeNull();
  });
});

describe("application menu command routing", () => {
  it("toggles the Chats panel when the command exists", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);
    await screen.findByTestId("chats-panel");
    // Flush the commit's passive effects before emitting: the menu-command
    // listener subscribes in an effect, and under load the panel's DOM node
    // appears before that effect runs.
    await act(async () => {});

    act(() => bridge.emitMenuCommand("toggle-chats"));
    await waitFor(() => expect(screen.queryByTestId("chats-panel")).toBeNull());

    act(() => bridge.emitMenuCommand("toggle-chats"));
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
  });

});

describe("heading-target file opens", () => {
  it("clears a prior section command on an ordinary open", () => {
    expect(
      pendingHeadingTargetForOpen("a.md", { anchor: "old-section", nonce: 1 }),
    ).toEqual({
      path: "a.md",
      target: { anchor: "old-section", nonce: 1 },
    });
    expect(pendingHeadingTargetForOpen("a.md")).toBeNull();
  });
});

describe("ui-state merge-on-load", () => {
  it("drops saved state answered after the shell changes workspaces", async () => {
    const first = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(first.promise);
    bridge.getWorkspaceUiState
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(storedStateWithTabs(["b.md"], "b.md"));
    const workspaces = [WORKSPACE, OTHER_WORKSPACE];
    const view = renderShell(bridge, WORKSPACE, workspaces);

    view.rerender(
      <DesktopWorkspaceShell
        workspace={OTHER_WORKSPACE}
        workspaces={workspaces}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();

    await act(async () => {
      first.resolve(storedStateWithTabs(["a.md"], "a.md"));
      await first.promise;
    });

    expect(screen.getByTestId("tab-b.md"), "omit the response guard's cleanup invalidation. The first workspace's late answer replaces b.md with a.md here.").toBeTruthy();
    expect(screen.queryByTestId("tab-a.md")).toBeNull();
  });

  it("restores saved state after a no-op focus before the load resolves", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);

    fireEvent.pointerDown(
      await screen.findByRole("region", { name: "Editor group 1" }),
    );
    await act(async () => {
      stored.resolve(STORED_STATE);
      await stored.promise;
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
  });

  it("a user open queued before the load resolves wins over stored state (the exact stale-ref race)", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    const row = await screen.findByText("a.md");

    await act(async () => {
      // Resolve the load first (queues its.then as a microtask), then click
      // via a raw dispatch: React commits the open synchronously but defers
      // passive effects (a scheduler macrotask), so when the awaited
      // microtask runs the .then, wbRef still holds the stale default. Only
      // the synchronous touched-ref can know the user already acted.
      stored.resolve(STORED_STATE);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    // The user's open survived; the stored tabs did not clobber it.
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.queryByTestId("tab-b.md")).toBeNull();
    // And the pre-load action is durable: it gets written (immediate write on
    // load-settle, then the debounced writer once the commit lands).
    await waitFor(
      () => {
        const states = bridge.setWorkspaceUiState.mock.calls.map(
          ([payload]) => payload.state,
        );
        expect(
          states.some((state) => storedTabs(state).includes("a.md")),
        ).toBe(true);
      },
    );
  });

  // Journey 2: rolling back a rename left `assets/alpha-renamed.png`
  // in Open Editors for a path that no longer existed — through a restart,
  // because nothing reconciled the restored tabs against the workspace.
  it("restores only the tabs whose files still exist", async () => {
    const bridge = makeBridge(
      Promise.resolve(
        storedStateWithTabs(["assets/alpha-renamed.png", "b.md"], "b.md"),
      ),
    );
    renderShell(bridge);

    // b.md is in the listing; the rolled-back path is not.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-assets/alpha-renamed.png")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    // And the ghost does not come back on the next launch.
    await waitFor(() => {
      const states = bridge.setWorkspaceUiState.mock.calls.map(
        ([payload]) => payload.state,
      );
      expect(states.some((state) => storedTabs(state).join() === "b.md")).toBe(true);
    });
  });

  // A shared workspace lists its files twice on open: once at mount, once
  // after refreshShareView pulls the changed paths. Reconciling against
  // whichever landed first would either miss a remote delete or judge the
  // restored tabs against a pre-pull snapshot.
  it("prunes a restored tab on a listing that lands after the share pull", async () => {
    const listing = (...paths: string[]) =>
      vi.fn(async () => ({
        files: paths.map((path) => ({ path, kind: "file" as const })),
        folders: [] as string[],
      }));
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md", "shared-gone.md"], "b.md")),
    );
    // The pre-pull listing still carries the file the granter deleted.
    bridge.listWorkspaceFiles = listing("a.md", "b.md", "shared-gone.md");
    const pull = deferred<RefreshSharedViewResult>();
    bridge.refreshSharedView = vi.fn(() => pull.promise);
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });

    // It survives that listing: nothing has said the file is gone yet.
    expect(await screen.findByTestId("tab-shared-gone.md")).toBeTruthy();

    // The pull lands, and the listing it triggers no longer has the file.
    bridge.listWorkspaceFiles = listing("a.md", "b.md");
    await act(async () => {
      pull.resolve({
        ok: true,
        status: "updated",
        changedPaths: 1,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      });
      await pull.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-shared-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  it("groups unjournalable files by cause and clears the notice when the share ends", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    const outcomes = [
      {
        ok: true as const,
        status: "unchanged" as const,
        changedPaths: 0,
        excludedPaths: ["docs/pull-skipped.md"],
        unjournalablePaths: [
          { path: "docs/oversized.md", reason: "oversized-text" as const },
          {
            path: "docs/replaced.md",
            reason: "non-file-replacement" as const,
          },
          {
            path: "docs/local.md",
            reason: "local-collision" as const,
          },
          { path: "docs/locked.md", reason: "unreadable" as const },
        ],
        refusedOps: 0,
        refusedDetail: null,
      },
      {
        ok: true as const,
        status: "ended" as const,
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [
          { path: "docs/stale-after-end.md", reason: "unreadable" as const },
        ],
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
      },
    });

    const notice = await screen.findByTestId("shared-view-excluded");
    expect(notice.className).toContain("min-w-0");
    expect(notice.className).toContain("max-w-[280px]");
    expect(notice.className).toContain("shrink");
    expect(notice.className).toContain("truncate");
    expect(notice.className).not.toContain("shrink-0");
    expect(notice.textContent).toContain(
      "dohc could not track changes in docs/oversized.md.",
    );
    expect(notice.textContent).toContain("10.0 MB text limit");
    expect(notice.textContent).toContain("Make the file smaller, then refresh.");
    expect(notice.textContent).toContain(
      "dohc could not track changes in docs/replaced.md.",
    );
    expect(notice.textContent).toContain(
      "A folder or another entry replaces this file.",
    );
    expect(notice.textContent).toContain(
      "Restore the file or move the conflicting entry, then refresh.",
    );
    expect(notice.textContent).toContain(
      "dohc could not receive docs/local.md.",
    );
    expect(notice.textContent).toContain(
      "A file from this machine already uses this path.",
    );
    expect(notice.textContent).toContain(
      "Move or remove the file, then refresh.",
    );
    expect(notice.textContent).toContain("dohc could not read docs/locked.md.");
    expect(notice.textContent).toContain(
      "Close anything using the file, or wait, then refresh.",
    );

    await userEvent.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() => {
      expect(screen.queryByTestId("shared-view-excluded")).toBeNull();
    });
    expect(screen.getByTestId("shared-view-banner").dataset.ended).toBe("true");
  });

  it("warns when a refresh quarantines the share collision record", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    bridge.refreshSharedView = vi.fn(async () => ({
      ok: true as const,
      status: "unchanged" as const,
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      collisionRecordQuarantined: true,
      refusedOps: 0,
      refusedDetail: null,
    }));
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });

    // A warning the person may need to act on: an error toast, then a row
    // in Notices. Nothing is inserted above the workbench.
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "dohc could not read this share's collision record, so it set the record aside. A refresh may overwrite local files that collided.",
    );
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

  it("repaints local repairs before reporting a failed share pull", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md"], "b.md")),
    );
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
        ok: false as const,
        changedPaths: 1,
        errorMessage: "relay failed",
      },
    ];
    bridge.refreshSharedView = vi.fn(async () => {
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No refresh outcome left.");
      return outcome as RefreshSharedViewResult;
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "edit",
      },
    });

    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const listCallsBeforeFailure = bridge.listWorkspaceFiles.mock.calls.length;
    const readCallsBeforeFailure = bridge.readWorkspaceText.mock.calls.length;

    await userEvent.click(screen.getByTestId("shared-view-refresh"));

    let listCallsWhenReported = 0;
    let readCallsWhenReported = 0;
    await waitFor(() => {
      const error = screen.getByTestId("workspace-shell-error");
      expect(error.textContent).toContain("Couldn't refresh the shared view.");
      expect(error.textContent).toContain("relay failed");
      listCallsWhenReported = bridge.listWorkspaceFiles.mock.calls.length;
      readCallsWhenReported = bridge.readWorkspaceText.mock.calls.length;
    });
    expect(listCallsWhenReported).toBeGreaterThan(listCallsBeforeFailure);
    expect(readCallsWhenReported).toBeGreaterThan(readCallsBeforeFailure);
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

  it("does not repaint a failed share pull when no paths changed", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md"], "b.md")),
    );
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
        ok: false as const,
        changedPaths: 0,
        errorMessage: "relay failed",
      },
    ];
    bridge.refreshSharedView = vi.fn(async () => {
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No refresh outcome left.");
      return outcome as RefreshSharedViewResult;
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "edit",
      },
    });

    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const listCallsBeforeFailure = bridge.listWorkspaceFiles.mock.calls.length;
    const readCallsBeforeFailure = bridge.readWorkspaceText.mock.calls.length;

    await userEvent.click(screen.getByTestId("shared-view-refresh"));

    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain("relay failed");
    expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(
      listCallsBeforeFailure,
    );
    expect(bridge.readWorkspaceText).toHaveBeenCalledTimes(
      readCallsBeforeFailure,
    );
  });

  it("keeps an ended share read-only when its changed-file listing fails", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md"], "b.md")),
    );
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
      },
    });

    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("listing failed"));

    await userEvent.click(screen.getByTestId("shared-view-refresh"));

    await waitFor(() => {
      expect(screen.getByTestId("shared-view-banner").dataset.ended).toBe("true");
    });
  });

  it("clears refresh loading before the durable skip-marker read settles", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    const registryReadsBeforeClick = bridge.getWorkspaceRegistry.mock.calls.length;
    const registryRead = deferred<{ workspaces: unknown[] }>();
    bridge.getWorkspaceRegistry.mockImplementationOnce(() => registryRead.promise);
    try {
      await userEvent.click(screen.getByTestId("shared-view-refresh"));
      await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          bridge.getWorkspaceRegistry.mock.calls.length,
          "refresh dropped the durable skip-marker read",
        ).toBeGreaterThan(registryReadsBeforeClick),
      );
      await waitFor(() =>
        expect(
          (screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled,
          "waiting for the skip-marker read leaves Refresh disabled",
        ).toBe(false),
      );
    } finally {
      registryRead.resolve({ workspaces: [] });
    }
  });

  it("clears the unjournalable notice once an ordinary refresh recovers", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])));
    const outcomes = [
      {
        ok: true as const,
        status: "unchanged" as const,
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [
          { path: "docs/locked.md", reason: "unreadable" as const },
        ],
        refusedOps: 0,
        refusedDetail: null,
      },
      {
        ok: true as const,
        status: "unchanged" as const,
        changedPaths: 0,
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
      },
    });

    await screen.findByTestId("shared-view-excluded");

    await userEvent.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() => {
      expect(screen.queryByTestId("shared-view-excluded")).toBeNull();
    });
    expect(screen.getByTestId("shared-view-banner").dataset.ended).toBeUndefined();
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
    expect((await screen.findByTestId("shared-view-excluded")).textContent).toContain(
      "docs/new-local.md",
    );

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
    expect(screen.getByTestId("shared-view-excluded").textContent).toContain(
      "docs/new-local.md",
    );
    expect(screen.getByTestId("shared-view-excluded").textContent).not.toContain(
      "docs/stale-local.md",
    );
  });

  // A refresh can record a refusal on an early page and then die on a later
  // one. The evidence is already durable at that point — reading it only on
  // the success path would keep it invisible until a lucky refresh.
  it("shows a refusal recorded by a refresh that then failed", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([])),
    );
    bridge.refreshSharedView = vi.fn(async () => {
      throw new Error("relay went away mid-page");
    });
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            skippedOps: {
              ops: [
                {
                  originId: "origin-granter",
                  originSeq: 4,
                  opKind: "moment.append",
                  code: "share-boundary-violation",
                  detail: "the share granted version main, the relay offered version other",
                  atMs: 1000,
                },
              ],
              more: 0,
              generation: 1,
            },
          },
        },
      ],
    }));
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });

    const refused = await screen.findByTestId("shared-view-refused");
    expect(
      refused.textContent,
      "reading the record only after a successful refresh hides evidence the failed one already wrote",
    ).toContain("dohc skipped 1 update outside what this share covers");
  });

  // The record is written during the pull, so a refusal that happens while
  // this shell is mounted has to appear without a remount. Reading the boot
  // snapshot in props would show it only after the workspace is reopened.
  it("shows a refusal recorded by a refresh that ran while the shell was open", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([])),
    );
    let recorded = false;
    bridge.refreshSharedView = vi.fn(async () => {
      // What the recorder does mid-pull: the registry now holds the skip.
      recorded = true;
      return {
        ok: true as const,
        status: "unchanged" as const,
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 1,
        refusedDetail: "the share granted version main, the relay offered version other",
      };
    });
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            ...(recorded
              ? {
                  skippedOps: {
                    ops: [
                      {
                        originId: "origin-granter",
                        originSeq: 7,
                        opKind: "moment.append",
                        code: "share-boundary-violation",
                        detail:
                          "the share granted version main, the relay offered version other",
                        atMs: 1000,
                      },
                    ],
                    more: 0,
                    generation: 3,
                  },
                }
              : {}),
          },
        },
      ],
    }));
    // Mounts with NO skip record: the shell's boot snapshot is healthy.
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        access: "view",
      },
    });

    const refused = await screen.findByTestId("shared-view-refused");
    expect(
      refused.textContent,
      "reading the boot snapshot hides a refusal until the workspace is reopened",
    ).toContain("dohc skipped 1 update outside what this share covers");
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
    const listing = (...paths: string[]) => ({
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

  // A provisional display-fill must not drive a destructive close: the pull
  // still in flight can carry back a file the older listing predates.
  it("defers closing a tab while a newer listing is still pending", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    const newer = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs(["b.md", "pulled.md"], "b.md"),
        chatsVisible: false,
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() =>
      ++issued === 1 ? older.promise : newer.promise,
    );
    renderShell(bridge);

    await waitFor(() => {
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(bridge.workspaceActivitySubscriberCount()).toBe(1);
      expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
    });
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The older listing lands first and does not know about pulled.md.
    await act(async () => {
      older.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await older.promise;
    });
    // It fills the display, but must not close anything: a newer answer is
    // still coming.
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();

    // The newer one carries the file back.
    await act(async () => {
      newer.resolve({
        files: [
          { path: "b.md", kind: "file" },
          { path: "pulled.md", kind: "file" },
        ],
        folders: [],
      });
      await newer.promise;
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
    expect(screen.getAllByText("pulled.md").length).toBeGreaterThan(0);
  });

  // Closing the active tab remounts the keyed inspector on its neighbour —
  // an open. Without the mark, that mount measure brackets a stale mark.
  it("marks file-open-start when closing the active tab hands over to a survivor", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md", "gone.md"], "gone.md")),
    );
    renderShell(bridge);

    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)).length;

    // Wait for the restore to land first, or the assertions below pass
    // vacuously against the empty default state.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    });
    expect(openStartCalls()).toBe(1);

    mark.mockRestore();
  });

  // A failure is not an answer, so it cannot make an older snapshot
  // authoritative for closing: the listing that failed may have been the one
  // that would have shown a file pulled back in. The close waits for a
  // success issued after the failure. It is not blocked forever — the next
  // successful listing re-enables it — and correctness beats eagerness for
  // work that cannot be undone.
  it("waits for a listing that succeeds after a failure before closing", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    const third = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    // Keep Chats closed so the subscribers are notifications and listing refresh.
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs(["b.md", "gone.md"], "b.md"),
        chatsVisible: false,
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() => {
      issued += 1;
      return issued === 1 ? older.promise : issued === 2 ? newer : third.promise;
    });
    renderShell(bridge);

    await waitFor(() => {
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(bridge.workspaceActivitySubscriberCount()).toBe(1);
      expect(screen.getByTestId("tab-gone.md")).toBeTruthy();
    });
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The older listing commits, but a newer request is still in flight.
    await act(async () => {
      older.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
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
      third.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await third.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  // Codex's scenario: the pull brings a file back, and the listing that would
  // have shown it is the one that failed. Closing on the pre-pull snapshot
  // would close a tab whose file exists.
  it("does not close on a pre-pull snapshot when the post-pull listing failed", async () => {
    const prePull = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failPostPull!: (error: Error) => void;
    const postPull = new Promise<never>((_resolve, reject) => {
      failPostPull = reject;
    });
    const afterPull = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    // The subscriber count below pins the shell's listing refresh listener
    // (notifications subscribes first). The Chats panel subscribes too, from
    // a lazy chunk whose load time depends on whether an earlier test already
    // imported it, so this stored state keeps the panel closed.
    const bridge = holdHistory(
      makeBridge(
        Promise.resolve({
          ...storedStateWithTabs(["b.md", "pulled.md"], "b.md"),
          chatsVisible: false,
        }),
      ),
    );
    bridge.listWorkspaceFiles = vi.fn(() => {
      issued += 1;
      return issued === 1
        ? prePull.promise
        : issued === 2
          ? postPull
          : afterPull.promise;
    });
    renderShell(bridge);

    await waitFor(
      () => {
        expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
        expect(bridge.workspaceActivitySubscriberCount()).toBe(1);
        expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
      },
    );
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The pre-pull snapshot commits; it predates the file coming back.
    await act(async () => {
      prePull.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await prePull.promise;
    });
    // The listing that would have carried the pulled file fails.
    await act(async () => {
      failPostPull(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();

    // A later listing confirms the file is really there. Still no close.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await act(async () => {
      afterPull.resolve({
        files: [
          { path: "b.md", kind: "file" },
          { path: "pulled.md", kind: "file" },
        ],
        folders: [],
      });
      await afterPull.promise;
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
  });

  // CodeRabbit: reconciling commits through the direct setter (it must not set
  // the touched flag), which also skips mutateWb's DM-navigation invalidation.
  // A DM navigation in flight would then still pass its isCurrent() check and
  // land its destination on top of the tab the close just activated.
  it("discards an in-flight DM navigation when closing a tab moves the active tab", async () => {
    const dmNode = {
      path: "chat-thread:dm-thread",
      kind: "chat-thread" as const,
      threadId: "dm-thread",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm" as const,
      title: "Direct message",
      incoming: 1,
      outgoing: 0,
    };
    const listing = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["b.md", "gone.md"], "gone.md")),
    );
    // The listing is held so the close cannot happen before the navigation.
    bridge.listWorkspaceFiles = vi.fn(() => listing.promise);
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [dmNode],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === dmNode.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Now the listing lands without the active tab's file, so the close runs
    // and hands over to the survivor.
    await act(async () => {
      listing.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await listing.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    // The navigation answers late. It is stale, so it must not open Chats
    // over the tab the close just activated.
    await act(async () => {
      sync.resolve(dmSyncResult());
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
  });

  // The same invalidation from the other side: mutateWb is the seam every
  // user-driven transition routes through, so a file click has to cancel a
  // pending DM navigation. It incremented the pending request in place, and
  // since the navigation holds that very object, its isCurrent() compared the
  // object against itself and the cancellation did nothing.
  it("discards an in-flight DM navigation when the user opens a file", async () => {
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, { path: "a.md", title: "A", incoming: 0, outgoing: 0 }],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user goes somewhere else: opening a file is a plain mutateWb
    // transition, which is what must cancel the navigation.
    const afterNav = await screen.findAllByTestId("graph-file-row");
    await user.click(afterNav.find((row) => row.dataset.path === "a.md")!);
    expect((await screen.findByTestId("tab-a.md")).dataset.active).toBe("true");

    // The navigation answers late, with the DM it would have opened. It is
    // stale, so it must not open Chats over the file the user just opened.
    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  });

  // A chat thread opening in the panel moves no tab either, and it is the
  // destination change that conflicts most directly: the user chose another
  // conversation, so the DM they walked away from must not arrive as a tab on
  // top of it.
  it("discards an in-flight DM navigation when another chat thread opens in the panel", async () => {
    const fileThreadNode = {
      path: "chat-thread:file-thread",
      kind: "chat-thread" as const,
      threadId: "file-thread",
      title: "Notes discussion",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, fileThreadNode],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user picks a different conversation. It has no channel metadata, so
    // it opens in the panel — no tab moves.
    const afterNav = await screen.findAllByTestId("graph-file-row");
    await user.click(afterNav.find((row) => row.dataset.path === fileThreadNode.path)!);
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();
  });

  // The third seam of the same kind, and the reason the predicate now lives at
  // the destination write: with the Chats tab already active, moving to
  // another channel changes the chat destination while the active tab stays
  // put, so neither the tab check nor onChatsNav (which openChatsNavInTab
  // bypasses by writing the ref itself) can see it.
  it("discards an in-flight DM navigation when another channel opens in the active Chats tab", async () => {
    const channelNode = (id: string, name: string, title: string) => ({
      path: `chat-thread:${id}`,
      kind: "chat-thread" as const,
      threadId: id,
      channelId: `channel-${id}`,
      channelName: name,
      channelSlug: name,
      channelKind: "channel" as const,
      title,
      incoming: 1,
      outgoing: 0,
    });
    const first = channelNode("thread-planning", "planning", "Planning discussion");
    const second = channelNode("thread-hiring", "hiring", "Hiring discussion");
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, first, second],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Open a channel conversation in the Chats TAB, with the graph still in
    // the sidebar. Every navigation from here leaves the active tab alone.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === first.path)!);
    const chatsTab = await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent(first.channelId)}`);
    expect(chatsTab.dataset.active).toBe("true");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === DM_GRAPH_NODE.path,
      )!,
    );
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user moves to a different conversation. The tab never moves.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === second.path,
      )!,
    );
    expect(screen.getByTestId(`tab-dohc://chats/channel/${encodeURIComponent(second.channelId)}`).dataset.active).toBe("true");

    // Collapse the sidebar so the graph's own row labels stop matching, and
    // only the Chats surface answers the queries below. Re-selecting the
    // active view toggles the panel — a workbench write that moves no tab, so
    // it must not cancel the navigation either.
    await user.click(screen.getByTestId("activity-graph"));
    expect(await screen.findByText("Hiring discussion")).toBeTruthy();

    // The DM answers late. It must not remount Chats over the conversation the
    // user chose.
    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.getByText("Hiring discussion")).toBeTruthy();
    expect(screen.queryByText(CANONICAL_DM.name)).toBeNull();
  });

  // The positive direction, and the reason it is not optional: every
  // cancellation test above also passes when nothing ever lands, so a fix that
  // cancelled the navigation the moment it started would read as green.
  it("lands a DM navigation that nothing interrupts", async () => {
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });

    expect(await screen.findByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeTruthy();
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
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
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

  // A destination change inside the active file moves no tab, so the check
  // above cannot see it — but the user did navigate, and a late DM would open
  // Chats over the line they just jumped to.
  it("discards an in-flight DM navigation when a search result moves within the active file", async () => {
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // a.md is open and active, and a search has results inside it.
    await user.click(await screen.findByText("a.md"));
    expect((await screen.findByTestId("tab-a.md")).dataset.active).toBe("true");
    await user.click(screen.getByTestId("activity-search"));
    await user.type(screen.getByTestId("search-input"), "apples");
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());
    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    act(() => {
      bridge.emitSearchResults({
        searchId: searchPayload.searchId,
        entries: [
          {
            path: "a.md",
            line: 12,
            column: 9,
            preview: "I ate 10 apples",
            matchStart: 9,
            matchEnd: 15,
          },
        ],
        done: true,
        limitHit: false,
      });
    });
    await screen.findByTestId("search-result-row");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Back to the results and jump to the line. The tab never moves: a.md was
    // already active, so only the in-document destination changed.
    await user.click(screen.getByTestId("activity-search"));
    await user.click(await screen.findByTestId("search-result-row"));
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  });

  // The residual window the destination KEY cannot see: opening the chat
  // destination that is already open. Nothing about the key changed, the tab
  // does not move, and the panel reports nothing — yet the user issued an open
  // command, and a repeated backlink is the sharper form of it
  // (chatsNavigationRequiresRemount remounts the page for the message you
  // already focused, precisely so a second click scrolls back to it). The late
  // DM would replace that page. An explicit open therefore always cancels.
  it("discards an in-flight DM navigation when the open chat destination is commanded again", async () => {
    const channel = {
      path: "chat-thread:thread-planning",
      kind: "chat-thread" as const,
      threadId: "thread-planning",
      channelId: "channel-planning",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel" as const,
      title: "Planning discussion",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, channel],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Open the channel conversation in the Chats TAB, with the graph still in
    // the sidebar.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === channel.path)!);
    expect((await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent(channel.channelId)}`)).dataset.active).toBe("true");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === DM_GRAPH_NODE.path,
      )!,
    );
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Command the same conversation again. Every check the seam has says
    // nothing moved: same destination key, same active tab, same sidebar view.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === channel.path,
      )!,
    );
    expect(screen.getByTestId(`tab-dohc://chats/channel/${encodeURIComponent(channel.channelId)}`).dataset.active).toBe("true");

    // Collapse the sidebar so the graph's own row labels stop matching and
    // only the Chats surface answers the query below.
    await user.click(screen.getByTestId("activity-graph"));
    expect(await screen.findByText("Planning discussion")).toBeTruthy();

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.getByText("Planning discussion")).toBeTruthy();
    expect(screen.queryByText(CANONICAL_DM.name)).toBeNull();
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
        chatsVisible: false,
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
    await user.click(screen.getByTestId("titlebar-chats-sidebar"));
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(presence.presencePublish).toHaveBeenCalled());
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
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    return Object.assign(bridge, {
      syncAnswers,
      listPersonalChatFeed: vi.fn(async () => ({
        items: [
          {
            message: {
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
          {
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
        liveRunId: null,
        pendingCount: 0,
        paused: false,
      })),
      markChatThreadRead: vi.fn(async () => ({ lastReadSequence: 1, revision: 1 })),
    });
  }

  const CHATS_PAGE_STATE: WorkspaceUiState = {
    ...storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH),
    chatsVisible: false,
  };

  it.each([false, true])("offers the local agent mention only after opting in (runner enabled: %s)", async (enabled) => {
    const user = userEvent.setup();
    const bridge = Object.assign(chatsPageBridge(CHATS_PAGE_STATE), {
      listChatChannelShares: vi.fn(async () => ({
        joined: [], sessionKey: null,
        relay: { state: "answered" as const, granted: [], received: [], removed: [] },
      })),
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(<DesktopWorkspaceShell
      workspace={WORKSPACE}
      workspaces={[WORKSPACE]}
      {...shellBootstrapProps(bridge)}
      userSettings={{ source: "stored", settings: {
        ...DEFAULT_USER_SETTINGS,
        profile: enabled ? { agentName: "Nova" } : {},
        runner: { ...DEFAULT_USER_SETTINGS.runner, enabled, command: enabled ? "node agent.mjs" : "" },
      } }}
      onSwitchWorkspace={() => {}}
    />);
    await screen.findByTestId("chats-personal-feed");
    await user.click(screen.getByTestId("titlebar-chats-sidebar"));
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "@");
    const options = await screen.findAllByTestId("chats-new-thread-mention-option");
    expect(options.some((option) => option.dataset.candidateId === "agent:default")).toBe(enabled);
  });

  it("keeps Home open when a DM link cannot resolve and offers a retry", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);
    await screen.findByTestId("chats-personal-feed");
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const callsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms.mock.calls.length).toBe(callsBefore + 1));
    await act(async () => bridge.syncAnswers.at(-1)!(dmSyncResult([])));
    expect(await screen.findByTestId("workspace-shell-error-retry")).toBeTruthy();
    expect(screen.getByTestId("tab-dohc://chats").dataset.active).toBe("true");
    expect(screen.getByTestId("chats-personal-feed")).toBeTruthy();
    expect(screen.queryByTestId("chats-page-empty")).toBeNull();
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await act(async () => bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM])));
    expect(await screen.findByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeTruthy();
  });

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
  it("discards a DM answer that lands in the same tick as the Back click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // Land in a thread via the feed.
    await screen.findByTestId("chats-personal-feed");
    const post = await screen.findByText("Feed update worth revisiting");
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user presses Back.
    const backButton = screen.getByTestId("chats-thread-back");
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM]));
      backButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-channel-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // Same proof as the feed-click race: a DM answer that wins remounts the
    // page, which loads the overview again. The cancel won only if it
    // did not.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
  });

  // The same race through "New message": the compose screen opens with a
  // direct nav write, and a DM answer queued in the same tick would remount
  // the DM over the compose the user just opened.
  it("discards a DM answer that lands in the same tick as the New message click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // New message lives in the sidebar; the editor holds only a destination.
    await screen.findByTestId("chats-personal-feed");
    await user.click(screen.getByTestId("titlebar-chats-sidebar"));
    await screen.findByTestId("chats-view");
    await act(async () => {
      for (const answer of bridge.syncAnswers) answer(dmSyncResult());
      await Promise.resolve();
    });
    const newDmButton = await screen.findByTestId("chats-new-dm");

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user clicks "New message".
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM]));
      newDmButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-dm-new-title")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // The sidebar command mounts once; a late DM must not remount it again.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore + 1);
  });

  // The awaited form of the same click: a feed item carrying a focus target
  // navigates in place (openConversation -> command + report), and the DM
  // answers late. The destination write must cancel it.
  it("discards an in-flight DM navigation when a page feed click jumps to a message", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    await screen.findByTestId("chats-personal-feed");
    const post = await screen.findByText("Feed update worth revisiting");

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The user jumps to the message. The DM answers late; it is stale.
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    await act(async () => {
      bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM]));
      await Promise.resolve();
    });
    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
  });

  // The in-thread reply-parent jump. It is the one command in the page
  // that writes NO navigation — it only scrolls — so every other seam here
  // (the destination write, the remount, the nav report) sees nothing move.
  // A DM lookup that answers afterwards would still replace the page with the
  // conversation the user left, taking away the message they just jumped to.
  it("discards an in-flight DM navigation when a reply-parent jump scrolls in place", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    // A nested reply is what renders the parent backlink: the opening message,
    // a comment on it, and a reply to that comment.
    bridge.listChatMessages = vi.fn(async () => ({
      messages: [
        {
          id: "message-feed",
          threadId: "thread-team",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "Feed update worth revisiting",
          createdAtMs: 1,
        },
        {
          id: "message-comment",
          threadId: "thread-team",
          parentMessageId: "message-feed",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "A comment on it",
          createdAtMs: 2,
        },
        {
          id: "message-reply",
          threadId: "thread-team",
          parentMessageId: "message-comment",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "A reply to the comment",
          createdAtMs: 3,
        },
      ],
    }));
    renderShell(bridge);

    // Land in the thread via the feed.
    await screen.findByTestId("chats-personal-feed");
    const post = await screen.findByText("Feed update worth revisiting");
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    const backlink = await screen.findByTestId("chats-reply-context");

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user jumps to the parent.
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!(dmSyncResult([CANONICAL_DM]));
      backlink.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // The proof, as in the feed-click race: a DM answer that wins remounts the
    // page and loads the overview again. The cancel won only if it did not.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
  });

  // The surviving mutant from the review: openFile's heading-target
  // invalidation. A heading jump into the ALREADY-ACTIVE file moves no tab,
  // so mutateWb's transition check cannot see it — only openFile's own
  // `if (target)` branch cancels the pending DM.
  it("discards an in-flight DM navigation when a heading jump lands in the active file", async () => {
    const heading = {
      path: "a.md#plan",
      kind: "heading" as const,
      filePath: "a.md",
      headingAnchor: "plan",
      title: "Plan",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<SyncDmsResult>();
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs(["a.md"], "a.md"),
        chatsVisible: false,
      }),
    );
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, heading],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Jump to a heading in the file that is already the active tab: no tab
    // moves, only the in-document destination changes.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === heading.path,
      )!,
    );
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");

    await act(async () => {
      sync.resolve(dmSyncResult([CANONICAL_DM]));
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  });

  // A request that is merely in flight has not answered anything, and a
  // request that fails never will. Superseding on ISSUE would drop the only
  // answer there is and leave the explorer empty with nothing to retry it.
  it("commits an older listing when the newer request failed", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(() => (++issued === 1 ? older.promise : newer));
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    // Notifications subscribes immediately; the listing refresh listener is
    // the second live subscription and waits for workspace readiness.
    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));
    vi.useFakeTimers();
    try {
      act(() => {
        bridge.emitWorkspaceActivity();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    // The newer request fails. Nothing has been displayed yet.
    await act(async () => {
      failNewer(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.queryByText("a.md")).toBeNull();

    // The older answer arrives — and it is the only answer there is.
    await act(async () => {
      older.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
        ],
        folders: [],
      });
      await older.promise;
    });

    expect(await screen.findByText("a.md")).toBeTruthy();
    expect(screen.getByText("b.md")).toBeTruthy();
  });

  // Listings resolve out of order (the mount listing can overtake the one the
  // share pull triggered). An older snapshot committing last would show a
  // stale tree and, worse, make the reconciliation read a live file as
  // deleted and close its tab.
  it("ignores a listing that resolves after a newer one was issued", async () => {
    type Listing = {
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    };
    const older = deferred<Listing>();
    const newer = deferred<Listing>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...storedStateWithTabs(["b.md", "live.md"], "b.md"),
        chatsVisible: false,
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() =>
      ++issued === 1 ? older.promise : newer.promise,
    );
    renderShell(bridge);

    // A second listing is issued while the first is still in flight.
    await waitFor(() => {
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(bridge.workspaceActivitySubscriberCount()).toBe(1);
      expect(screen.getByTestId("tab-live.md")).toBeTruthy();
    });
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The newer one lands first and knows about live.md.
    await act(async () => {
      newer.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
          { path: "live.md", kind: "file" },
        ],
        folders: [],
      });
      await newer.promise;
    });
    expect(await screen.findByTestId("tab-live.md")).toBeTruthy();

    // Then the stale one, which predates live.md, arrives last.
    await act(async () => {
      older.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
        ],
        folders: [],
      });
      await older.promise;
    });

    // It commits nothing: the tab is open and the tree still lists the file
    // (its name renders in the explorer row, the open-editors row, and the
    // tab — the stale snapshot would have removed all three).
    expect(screen.getByTestId("tab-live.md")).toBeTruthy();
    expect(screen.getAllByText("live.md").length).toBeGreaterThan(0);
  });

  // Either load can win. When the listing lands first there is nothing
  // restored to judge yet, so the restore itself has to re-run the check —
  // otherwise the missing tab survives and gets written back out.
  it("prunes a restored tab when the file listing arrives before the stored state", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);

    // The listing lands first: a.md and b.md, no ghost.md.
    await screen.findByText("a.md");

    await act(async () => {
      stored.resolve(storedStateWithTabs(["b.md", "ghost.md"], "b.md"));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-ghost.md")).toBeNull();
    });
    await waitFor(() => {
      const states = bridge.setWorkspaceUiState.mock.calls.map(
        ([payload]) => payload.state,
      );
      expect(states.some((state) => storedTabs(state).includes("ghost.md"))).toBe(false);
      expect(states.some((state) => storedTabs(state).join() === "b.md")).toBe(true);
    });
  });

  // The scoping earns its keep here: only stored tabs are eligible, so a
  // listing that raced a create cannot close what the user just opened.
  it("never prunes a tab opened this session, whatever a later listing says", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    // b.md is restored; a.md is opened now.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("tab-a.md")).toBeTruthy();

    // A listing that knows about neither file arrives.
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [] as Array<{ path: string; kind: "file" }>,
      folders: [] as string[],
    }));
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-b.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
  });

  it("stored state applies when the user touched nothing before the load", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    await screen.findByText("a.md");

    await act(async () => {
      stored.resolve(STORED_STATE);
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    expect((await screen.findByTestId("side-panel")).style.width).toBe("320px");
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
  });
});
