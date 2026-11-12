// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { OwnerLiveQuarantine, SyncStatusResult } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

// The chip's step shows only once the engine holds the note, so each note here
// is bound to a live session.
vi.mock("./collab/useEngineDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./collab/useEngineDoc")>();
  const doc = new Y.Doc();
  const engine = { available: true, doc, saveState: { kind: "saved-here" }, readOnlyWhileEditing: false, saveError: null, removalInProgress: null };
  return { ...actual, useEngineDoc: () => engine };
});

// A refused note's chip opens Live documents at its row, where Try again,
// Stop and Save recovery copy are.
describe("the step beside a refused note's chip", () => {
  const ROW: OwnerLiveQuarantine = { objectId: "object-a", path: "a.md", reason: "invalid-update", storedOn: "this-computer",
    incident: "outbox:delivery:0", recovery: "paused" };
  const withRows = (...rows: OwnerLiveQuarantine[]): SyncStatusResult => ({ ...SYNC_STATUS, ownerLiveQuarantines: rows });

  async function openNote() {
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "a.md")!;
    await user.click(row);
    await screen.findByTestId("view-markdown");
    return user;
  }

  it("opens Live documents at the note's row", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(ROW));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "other.md", objectId: "object-other", status: "ready" as const, canResume: false },
      { path: "a.md", objectId: "object-a", status: "ready" as const, canResume: false, quarantine: "paused" as const },
    ] }));
    renderShell(bridge);
    const user = await openNote();
    const open = await screen.findByTestId("markdown-save-state-action");
    expect(open.textContent).toBe("Open Live documents");
    await user.click(open);
    const dialog = within(await screen.findByTestId("live-documents-dialog"));
    expect((await dialog.findByTestId("live-document-row-a.md")).getAttribute("aria-current")).toBe("true");
    expect(dialog.getByTestId("live-document-row-other.md").getAttribute("aria-current")).toBeNull();
    // It opens the list, and retries, stops or copies nothing itself.
    expect(bridge.retryOwnerLiveQuarantine).not.toHaveBeenCalled();
    expect(bridge.saveOwnerLiveRecoveryCopy).not.toHaveBeenCalled();
  });

  it("leaves the next workspace's note alone when the first workspace's status answers late", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let current: Workspace = WORKSPACE;
    let answerLate: ((status: SyncStatusResult) => void) | null = null;
    bridge.getSyncStatus = vi.fn(async () => current.workspaceId === WORKSPACE.workspaceId ? withRows(ROW) : SYNC_STATUS);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell key={workspace.workspaceId} workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(WORKSPACE));
    const user = await openNote();
    await user.click(await screen.findByTestId("markdown-save-state-action"));
    expect(await screen.findByTestId("live-documents-dialog")).toBeTruthy();
    // The first workspace asks again, and its answer is still out at the switch.
    bridge.getSyncStatus.mockImplementationOnce(() => new Promise((resolve) => { answerLate = resolve; }));
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(answerLate).not.toBeNull());
    current = OTHER_WORKSPACE;
    view.rerender(shell(OTHER_WORKSPACE));
    await openNote();
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await act(async () => answerLate!(withRows(ROW)));
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).not.toBe("read-only");
    expect(screen.queryByTestId("markdown-save-state-action")).toBeNull();
  });
});
