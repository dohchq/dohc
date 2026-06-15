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
import { ImportExportDialog } from "./ImportExportDialog";

const bridge = {
  importWorkspaceFiles: vi.fn(async () => ({ imported: ["receipt.md"] })),
  exportWorkspaceZip: vi.fn(async () => ({ path: "/tmp/workspace.zip" })),
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
