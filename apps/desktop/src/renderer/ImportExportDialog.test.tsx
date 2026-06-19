// @vitest-environment jsdom
import {
  cleanup,
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
  it("keeps file and archive import/export out of the data-fragment dialog", async () => {
    renderDialog("notes/plan.md");

    expect(await screen.findByText("Data fragments")).toBeTruthy();
    expect(screen.queryByText("Files and archives")).toBeNull();
    expect(screen.queryByTestId("import-files-action")).toBeNull();
    expect(screen.queryByTestId("export-workspace-action")).toBeNull();
    expect(screen.queryByTestId("export-current-action")).toBeNull();
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
    bridge.createDataFragment.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:create-data-fragment': Error: no verified user with that email",
      ),
    );
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

    await screen.findByText("Connected as me@dohc.test");
    await user.type(screen.getByTestId("fragment-recipient-email"), "missing@dohc.test");
    await user.click(screen.getByTestId("export-fragment-action"));

    const status = await screen.findByTestId("import-export-status");
    expect(status.textContent).toContain("no verified user with that email");
    expect(status.textContent).not.toContain("Error invoking remote method");
  });
});
