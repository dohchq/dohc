// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CHATS_TAB_PATH } from "./workbench/workbenchState";
import { STORED_STATE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// These three cases test shell limits, persistence, and recovery. Keep the
// shell and Chats real; file content does not participate in those decisions.
// Editor flushing and close races stay in DesktopWorkspaceShell.editors.test.tsx.
vi.mock("./FileInspector", async (importOriginal) => {
  const original = await importOriginal<typeof import("./FileInspector")>();
  const { useEffect } = await import("react");
  return {
    ...original,
    FileInspector(props: Parameters<typeof original.FileInspector>[0]) {
      useEffect(() => {
        if (props.surfaceKey) {
          props.onSurfaceReady?.(props.path, props.surfaceKey);
        }
      }, [props.onSurfaceReady, props.path, props.surfaceKey]);
      return null;
    },
  };
});

describe("editor group limits", () => {
  function fileTreeRow(path: string): HTMLElement {
    return screen
      .getAllByTestId("tree-row")
      .find((row) => row.dataset.path === path)!;
  }

  it("explains the 100 open-tab limit when Split Right cannot create a group", async () => {
    const editorGroups = Array.from({ length: 100 }, (_, index) => ({
      id: `group-${index}`,
      tabs: [`file-${index}.md`],
      activeTab: `file-${index}.md`,
      size: 0.01,
    }));
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups,
        activeEditorGroup: "group-0",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: editorGroups.map((group) => ({
        path: group.activeTab,
        kind: "file" as const,
      })),
      folders: [],
    }));
    renderShell(bridge);

    await screen.findByTestId("tab-file-0.md");
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });

    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain(
      "This workspace has 100 open tabs; the limit is 100. Close a tab to create an editor group.",
    );
    expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(100);
    expect(screen.getByRole("region", { name: "Editor group 1" }).dataset.active).toBe(
      "true",
    );
    fireEvent(window, new Event("beforeunload"));
    const [persisted] = bridge.setWorkspaceUiState.mock.calls.at(-1)!;
    expect(persisted.state.editorGroups).toHaveLength(100);

    await userEvent.click(
      within(screen.getByRole("region", { name: "Editor group 100" })).getByRole(
        "button",
        { name: "Close file-99.md" },
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(99),
    );
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(100),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("explains the 100 open-tab limit when a file cannot open", async () => {
    const editorGroups = Array.from({ length: 100 }, (_, index) => ({
      id: `group-${index}`,
      tabs: [`file-${index}.md`],
      activeTab: `file-${index}.md`,
      size: 0.01,
    }));
    const unopenedPath = "file-100.md";
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups,
        activeEditorGroup: "group-0",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [
        ...editorGroups.map((group) => ({
          path: group.activeTab,
          kind: "file" as const,
        })),
        { path: unopenedPath, kind: "file" as const },
      ],
      folders: [],
    }));
    renderShell(bridge);

    await screen.findByTestId("tab-file-0.md");
    await userEvent.click(fileTreeRow(unopenedPath));

    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain(
      "This workspace has 100 open tabs; the limit is 100. Close a tab to open this file.",
    );
    expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(100);
    expect(screen.queryByTestId(`tab-${unopenedPath}`)).toBeNull();
    fireEvent(window, new Event("beforeunload"));
    const [persisted] = bridge.setWorkspaceUiState.mock.calls.at(-1)!;
    expect(persisted.state.recentFiles ?? []).not.toContain(unopenedPath);
  });

  it("reports lifecycle ownership before the open-tab limit for Chats", async () => {
    const fileGroups = Array.from({ length: 99 }, (_, index) => ({
      id: `group-${index}`,
      tabs: [`file-${index}.md`],
      activeTab: `file-${index}.md`,
      size: 0.01,
    }));
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          ...fileGroups,
          {
            id: "chats",
            tabs: [CHATS_TAB_PATH],
            activeTab: CHATS_TAB_PATH,
            size: 0.01,
          },
        ],
        activeEditorGroup: "chats",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: fileGroups.map((group) => ({
        path: group.activeTab,
        kind: "file" as const,
      })),
      folders: [],
    }));
    renderShell(bridge);

    await screen.findByTestId("tab-dohc://chats");
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });

    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain(
      "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
    );
    expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(100);
  });

});
