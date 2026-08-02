// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineDocSaveState } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";

// WS-G2-C-2 (CodeRabbit fix): the engine Y.Doc is the PRIMARY editing surface,
// so its in-flight/settling save state must reach the SHELL TAB's dirty dot via
// onSaveStateChange — not just the header. The local saveState never leaves
// "saved" on the engine path, so before the fix the tab dot was dead while the
// engine was settling. This mock lets us drive the engine's save state directly.
const engineDocState: {
  available: boolean;
  doc: Y.Doc | null;
  saveState: EngineDocSaveState;
} = { available: false, doc: null, saveState: "saved" };

vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: () => engineDocState,
}));

describe("engine save-state lifts to the shell tab dirty dot", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn(async () => ({ text: "# Hello\n", truncated: false })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
  };

  beforeEach(() => {
    engineDocState.available = true;
    engineDocState.doc = new Y.Doc();
    engineDocState.saveState = "saved";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    engineDocState.available = false;
    engineDocState.doc = null;
    engineDocState.saveState = "saved";
  });

  it("lifts the engine's in-flight settle state to onSaveStateChange, returning to saved after settle", async () => {
    // A pending settle: the engine reports "saving" while it projects the edit.
    engineDocState.saveState = "saving";
    const onSaveStateChange = vi.fn();
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
    );

    // The engine editor mounts once the file text loads (async IPC).
    const header = await screen.findByTestId("markdown-save-state");
    // The tab-level dirty indicator (onSaveStateChange) receives the ENGINE's
    // in-flight state — not the stuck-"saved" local state — so the dot is alive.
    // (waitFor, not a bare assert: the lift is a passive effect, so a sibling's
    // mount work can push it a tick past when the header first paints.)
    await waitFor(() =>
      expect(onSaveStateChange).toHaveBeenLastCalledWith("saving"),
    );
    // And the header agrees.
    expect(header.getAttribute("data-state")).toBe("saving");

    // The settle completes: the engine returns to "saved" and that too is lifted.
    engineDocState.saveState = "saved";
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
    );
    expect(onSaveStateChange).toHaveBeenLastCalledWith("saved");
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved");
  });

  it("says the save failed instead of Saved when the engine reports an error", async () => {
    // AUDIT-SILENTSAVE: the visible half of the fix. A failed settle means the
    // file on disk is behind the editor — the header must say so, and the tab
    // dot must stay dirty.
    engineDocState.saveState = "error";
    const onSaveStateChange = vi.fn();
    render(
      <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
    );

    const header = await screen.findByTestId("markdown-save-state");
    expect(header.getAttribute("data-state")).toBe("error");
    expect(header.textContent).not.toContain("Saved");
    expect(header.textContent).toContain("Couldn't save");
    // Honest, non-alarming, and it names what actually happened.
    expect(header.getAttribute("title")).toContain(
      "dohc can't confirm the file on disk matches them",
    );
    await waitFor(() =>
      expect(onSaveStateChange).toHaveBeenLastCalledWith("error"),
    );
  });

  it("names the outside edit when the file changed on disk", async () => {
    // #338: the settle committed, but the FILE holds an edit made outside dohc
    // that dohc refuses to overwrite. "Couldn't save" would be wrong twice —
    // the document IS saved, and another edit cannot help.
    engineDocState.saveState = "changed-on-disk";
    const onSaveStateChange = vi.fn();
    render(
      <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
    );

    const header = await screen.findByTestId("markdown-save-state");
    expect(header.getAttribute("data-state")).toBe("changed-on-disk");
    expect(header.textContent).toBe("Changed on disk");
    expect(header.getAttribute("title")).toContain("changed outside dohc");
    expect(header.getAttribute("title")).toContain("Open History to restore your text");
    // The tab dot stays dirty: this document's text is not what the file holds.
    await waitFor(() =>
      expect(onSaveStateChange).toHaveBeenLastCalledWith("error"),
    );
  });
});
