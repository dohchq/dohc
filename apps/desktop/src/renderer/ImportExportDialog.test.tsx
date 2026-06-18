// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataFragmentSummary } from "../ipc/bridgeContract";
import { ImportExportDialog } from "./ImportExportDialog";

const sharedFragment: DataFragmentSummary = {
  fragmentId: "fragment-1",
  sourceWorkspaceId: "source-ws",
  sourcePath: "notes/day.md",
  title: "Apple count",
  preview: "10 apples",
  contentType: "text/plain",
  createdBy: "user-1",
  createdAt: "2026-06-18T00:00:00.000Z",
  recipientEmail: "me@dohc.test",
};

const bridge = {
  importWorkspaceFiles: vi.fn(async () => ({ imported: ["receipt.md"] })),
  exportWorkspaceZip: vi.fn(async () => ({ path: "/tmp/workspace.zip" })),
  cloudStatus: vi.fn(async () => ({
    connected: true,
    email: "me@dohc.test",
    serverUrl: "https://cloud.dohc.test",
    workspaceSynced: true,
  })),
  listDataFragments: vi.fn(async () => ({ fragments: [sharedFragment] })),
  createDataFragment: vi.fn(async (payload: {
    workspaceId: string;
    sourcePath?: string;
    body: string;
    recipientEmail: string;
  }) => ({
    fragment: {
      ...sharedFragment,
      fragmentId: "fragment-created",
      sourceWorkspaceId: payload.workspaceId,
      sourcePath: payload.sourcePath ?? null,
      title: payload.body,
      preview: payload.body,
      recipientEmail: payload.recipientEmail,
    },
  })),
  readDataFragment: vi.fn(async () => ({
    fragment: { ...sharedFragment, body: "10 apples" },
  })),
  revokeDataFragment: vi.fn(async () => undefined),
  readWorkspaceText: vi.fn(async () => ({ text: "I ate", truncated: false })),
  writeWorkspaceText: vi.fn(async () => undefined),
  getDroppedFilePaths: vi.fn(() => ["/outside/drop.md"]),
};

vi.mock("./bridge", () => ({
  bridge: () => bridge,
}));

function renderDialog(activePath: string | null = "notes/plan.md") {
  return render(
    <ImportExportDialog
      workspaceId="ws-import-export"
      activePath={activePath}
      onImported={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImportExportDialog", () => {
  it("imports files through the existing workspace import bridge and refreshes the shell", async () => {
    const onImported = vi.fn();
    render(
      <ImportExportDialog
        workspaceId="ws-import-export"
        activePath="notes/plan.md"
        onImported={onImported}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId("import-files-action"));

    await waitFor(() => {
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
      });
    });
    expect(onImported).toHaveBeenCalledOnce();
    expect((await screen.findByTestId("import-export-status")).textContent).toContain(
      "Imported 1 file.",
    );
  });

  it("exports the whole workspace and the active file through bounded zip IPC", async () => {
    const user = userEvent.setup();
    renderDialog("notes/plan.md");

    await user.click(screen.getByTestId("export-workspace-action"));
    await waitFor(() => {
      expect(bridge.exportWorkspaceZip).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
      });
    });

    await user.click(screen.getByTestId("export-current-action"));
    await waitFor(() => {
      expect(bridge.exportWorkspaceZip).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
        relativePath: "notes/plan.md",
      });
    });
    expect((await screen.findByTestId("import-export-status")).textContent).toContain(
      "/tmp/workspace.zip",
    );
  });

  it("keeps current-file export disabled when no tab is active", () => {
    renderDialog(null);
    expect(
      (screen.getByTestId("export-current-action") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("imports dropped files through the preload-resolved droppedPaths seam", async () => {
    renderDialog("notes/plan.md");
    const file = new File(["# Drop\n"], "drop.md", { type: "text/markdown" });
    const zone = screen.getByTestId("import-drop-zone");

    fireEvent.drop(zone, {
      dataTransfer: {
        files: [file],
      },
    });

    await waitFor(() => {
      expect(bridge.getDroppedFilePaths).toHaveBeenCalledWith([file]);
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
        droppedPaths: ["/outside/drop.md"],
      });
    });
  });

  it("exports selected data to dohc Cloud instead of copying a whole file", async () => {
    const user = userEvent.setup();
    render(
      <ImportExportDialog
        workspaceId="ws-import-export"
        activePath="notes/plan.md"
        selectedText="10 apples"
        onImported={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect((screen.getByTestId("fragment-text") as HTMLTextAreaElement).value).toBe(
      "10 apples",
    );
    await screen.findByText("Connected as me@dohc.test");
    await user.type(screen.getByTestId("fragment-recipient-email"), "peer@dohc.test");
    await user.click(screen.getByTestId("export-fragment-action"));

    await waitFor(() => {
      expect(bridge.createDataFragment).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
        sourcePath: "notes/plan.md",
        body: "10 apples",
        contentType: "text/plain",
        recipientEmail: "peer@dohc.test",
      });
    });
    expect((await screen.findByTestId("import-export-status")).textContent).toContain(
      "Exported selected data to peer@dohc.test.",
    );
  });

  it("imports a Cloud data fragment into the active file instead of requiring a whole-file export", async () => {
    const onImported = vi.fn();
    render(
      <ImportExportDialog
        workspaceId="ws-import-export"
        activePath="notes/plan.md"
        selectedText="10 apples"
        onImported={onImported}
        onClose={vi.fn()}
      />,
    );

    expect((screen.getByTestId("fragment-text") as HTMLTextAreaElement).value).toBe(
      "10 apples",
    );
    await screen.findByText("Apple count");
    expect(screen.getByTestId("shared-fragment-preview").textContent).toContain(
      "10 apples",
    );
    await userEvent.click(screen.getByTestId("import-fragment-action"));

    await waitFor(() => {
      expect(bridge.readDataFragment).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
        fragmentId: "fragment-1",
      });
      expect(bridge.writeWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-import-export",
        relativePath: "notes/plan.md",
        text: "I ate\n10 apples",
      });
    });
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("shows a clear Cloud-required state when the workspace is not synced", async () => {
    bridge.cloudStatus.mockResolvedValueOnce({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: false,
    });
    renderDialog("notes/plan.md");

    expect(
      await screen.findByText("Sync this workspace to dohc Cloud to exchange data fragments."),
    ).toBeTruthy();
    expect((screen.getByTestId("export-fragment-action") as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("strips Electron IPC prefixes before displaying errors", async () => {
    bridge.exportWorkspaceZip.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:export-workspace-zip': Error: Export too large",
      ),
    );
    renderDialog("notes/plan.md");

    await userEvent.click(screen.getByTestId("export-workspace-action"));

    const status = await screen.findByTestId("import-export-status");
    expect(status.textContent).toContain("Export too large");
    expect(status.textContent).not.toContain("Error invoking remote method");
  });
});
