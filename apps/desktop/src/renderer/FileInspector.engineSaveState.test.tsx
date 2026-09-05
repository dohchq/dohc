// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineDocSaveState } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";

// WS-G2-C-2: the engine Y.Doc is the PRIMARY editing surface,
// so its in-flight/settling save state must reach the SHELL TAB's dirty dot via
// onSaveStateChange — not just the header. The local saveState never leaves
// "saved" on the engine path, so before the fix the tab dot was dead while the
// engine was settling.
//
// The real hook publishes save-state transitions through its own React state
// (useEngineDoc's publish()), re-rendering FileInspector from inside — a memo
// on the component cannot elide it. The mock must deliver the same way, so it
// is a subscribable store read via useSyncExternalStore, not a mutable module
// object read once per parent render.
const engineDocStore = vi.hoisted(() => {
  let state = {
    available: false,
    doc: null as Y.Doc | null,
    saveState: "saved" as EngineDocSaveState,
  };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    set(partial: Partial<typeof state>) {
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("./collab/useEngineDoc", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEngineDoc: () =>
      useSyncExternalStore(engineDocStore.subscribe, engineDocStore.getSnapshot),
  };
});

describe("engine save-state lifts to the shell tab dirty dot", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn(async () => ({ text: "# Hello\n", truncated: false })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
  };

  beforeEach(() => {
    engineDocStore.set({ available: true, doc: new Y.Doc(), saveState: "saved" });
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
    engineDocStore.set({ available: false, doc: null, saveState: "saved" });
  });

  it("lifts the engine's in-flight settle state to onSaveStateChange, returning to saved after settle", async () => {
    // A pending settle: the engine reports "saving" while it projects the edit.
    engineDocStore.set({ saveState: "saving" });
    const onSaveStateChange = vi.fn();
    render(
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

    // The settle completes: the engine publishes "saved" from inside the
    // component, exactly like the real hook — no parent re-render involved
    // (FileInspector is memoized, so a shallow-equal parent render is elided).
    act(() => engineDocStore.set({ saveState: "saved" }));
    expect(onSaveStateChange).toHaveBeenLastCalledWith("saved");
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved");
  });

  it("says the save failed instead of Saved when the engine reports an error", async () => {
    // AUDIT-SILENTSAVE: the visible half of the fix. A failed settle means the
    // file on disk is behind the editor — the header must say so, and the tab
    // dot must stay dirty.
    engineDocStore.set({ saveState: "error" });
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

  it("names the blocker when another program holds the file", async () => {
    // A file-locked settle is transient by contract — the engine keeps
    // the write pending and retries by itself. The chip must name the blocker
    // and say the edits are safe, not advise another edit.
    engineDocStore.set({ saveState: "file-locked" });
    const onSaveStateChange = vi.fn();
    render(
      <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
    );

    const header = await screen.findByTestId("markdown-save-state");
    expect(header.getAttribute("data-state")).toBe("file-locked");
    expect(header.textContent).toBe("File in use");
    // The copy claims the durable Y.Doc state, never a completed History
    // entry: with typing continuing under a held lock, the newest edits are
    // journaled but not yet settled into a moment.
    expect(header.getAttribute("title")).toContain("Another program has this file open");
    expect(header.getAttribute("title")).toContain("dohc has your edits saved");
    expect(header.getAttribute("title")).not.toContain("history");
    expect(header.getAttribute("title")).toContain("retries until the file is free");
    // The tab dot stays dirty: the disk is behind this document.
    await waitFor(() =>
      expect(onSaveStateChange).toHaveBeenLastCalledWith("error"),
    );
  });

  it("names the outside edit when the file changed on disk", async () => {
    // The settle committed, but the FILE holds an edit made outside dohc
    // that dohc refuses to overwrite. "Couldn't save" would be wrong twice —
    // the document IS saved, and another edit cannot help.
    engineDocStore.set({ saveState: "changed-on-disk" });
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
