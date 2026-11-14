// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { SyncStatusResult } from "../ipc/bridgeContract";
import { SYNC_STATUS, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// The engine has saved the note on this computer, as it has for a new note
// whose first file waits for its editor to be left.
vi.mock("./collab/useEngineDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./collab/useEngineDoc")>();
  const doc = new Y.Doc();
  const engine = {
    available: true,
    doc,
    saveState: { kind: "saved-here" },
    readOnlyWhileEditing: false,
    saveError: null,
    removalInProgress: null,
  };
  return { ...actual, useEngineDoc: () => engine };
});

describe("an open new note on a link", () => {
  async function openNote() {
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;
    await user.click(row);
    await screen.findByTestId("view-markdown");
  }
  const chipState = () => screen.getByTestId("markdown-save-state").getAttribute("data-state");

  it("says pending share until main stops listing it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status: SyncStatusResult = {
      ...SYNC_STATUS,
      notSentWhileOpen: ["a.md"],
      pendingShareWhileOpen: ["a.md"],
    };
    bridge.getSyncStatus = vi.fn(async () => status);
    renderShell(bridge);
    await openNote();
    await waitFor(() => expect(chipState()).toBe("pending-share"));
    // Sent, or its link ended: main lists it no more.
    status = { ...SYNC_STATUS };
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(chipState()).toBe("saved"));
  });

  it("still says saved when no link covers it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => ({ ...SYNC_STATUS, notSentWhileOpen: ["a.md"] }));
    renderShell(bridge);
    await openNote();
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(chipState()).toBe("saved");
  });
});
