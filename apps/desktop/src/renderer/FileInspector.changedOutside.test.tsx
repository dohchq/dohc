// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { saveProblem } from "@dohc/workspace-contracts/save-state";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { EngineDocInput } from "./collab/engineDocLease";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import { FileInspector } from "./FileInspector";
import { CHANGED_OUTSIDE_NOTICE } from "./MarkdownView";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";

// The engine session as the test sets it, and every retry key the inspector
// asked for. A new retry key closes the session and opens it again: until the
// test sets the reopened session, the note is opening, as with the real hook.
// Setting the session re-renders its subscribers, as a real update does.
const engine = vi.hoisted(() => ({
  state: undefined as unknown as UseEngineDoc,
  listeners: new Set<() => void>(),
  retryKeys: [] as number[],
  boundRetryKey: 0,
  // When set, a session the inspector keeps closed reads as closed, as with
  // the real hook.
  closedWhenDisabled: false,
}));
const retryKeys = engine.retryKeys;
vi.mock("./collab/useEngineDoc", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    engine.listeners.add(listener);
    return () => engine.listeners.delete(listener);
  };
  return {
    useEngineDoc: (input: EngineDocInput) => {
      if (engine.retryKeys.at(-1) !== input.retryKey) engine.retryKeys.push(input.retryKey ?? 0);
      const state = useSyncExternalStore(subscribe, () => engine.state);
      if (engine.closedWhenDisabled && input.enabled === false) {
        return { ...state, available: false, opening: false, doc: null, changedOutside: null };
      }
      return (input.retryKey ?? 0) === engine.boundRetryKey
        ? state
        : { ...state, available: false, opening: true, doc: null, changedOutside: null };
    },
  };
});
function setEngine(state: UseEngineDoc): void {
  act(() => {
    engine.state = state;
    engine.boundRetryKey = engine.retryKeys.at(-1) ?? 0;
    for (const listener of [...engine.listeners]) listener();
  });
}

function engineState(doc: Y.Doc, changedOutside: UseEngineDoc["changedOutside"]): UseEngineDoc {
  return {
    available: true,
    opening: false,
    doc,
    objectId: "object-1",
    versionId: "version-1",
    saveState: changedOutside === "unsaved" ? saveProblem("changed-on-disk", "The file changed on disk.") : { kind: "saved-here" },
    saveError: null,
    authorCapacity: false,
    notInVersion: false,
    documentUnavailable: false,
    liveHostUnavailable: false,
    engineMayHoldDocument: false,
    artifactAssetsInvalid: false,
    deletedWhileEditing: false,
    goneCause: null,
    deletedDraftId: null,
    recoveryAssets: null,
    permanentFailureWhileEditing: false,
    changedOutside,
    outsideWriteWaiting: false,
    unsavedEditsPending: () => false,
    readOnlyWhileEditing: false,
    readOnlyDraftId: null,
    readOnlyCause: null,
    retryReplacement: null,
    replacedDraftIds: [],
    removalInProgress: null,
    artifactAssets: [],
    readArtifactAsset: async () => {
      throw new Error("no artifact asset");
    },
    flushPendingLocalUpdates: async () => undefined,
  };
}

function makeBridge(): DohcDesktopBridge {
  return {
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn(async () => ({ text: "# Plan\n", truncated: false, contentHash: "sha256:test" })),
    writeWorkspaceText: vi.fn(async () => ({ status: "written" as const, contentHash: "sha256:test" })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" as const }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    writeWorkspaceAsset: vi.fn(async () => undefined),
  } as unknown as DohcDesktopBridge;
}

describe("FileInspector when an open note changed outside dohc", () => {
  beforeEach(() => {
    retryKeys.length = 0;
    engine.boundRetryKey = 0;
    engine.closedWhenDisabled = false;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("dohcDesktop", makeBridge());
  });

  afterEach(() => {
    cleanup();
    resetSharedLocalDocumentsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The note as the person has it: its file read, and its session bound.
  async function openNote(props: { onButtonError?: ReportButtonError; markdown?: string } = {}): Promise<void> {
    engine.state = engineState(markdownToYDoc(props.markdown ?? "# Plan\n"), null);
    render(<FileInspector workspaceId="ws-1" path="a.md" onButtonError={props.onButtonError} />);
    await waitFor(() => expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("reopens a note with nothing unsaved and says Reloaded for a moment", async () => {
    await openNote();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    // The reopened session shows the disk version.
    setEngine(engineState(markdownToYDoc("# Written outside dohc\n"), null));
    const chip = screen.getByTestId("markdown-save-state");
    expect(chip.getAttribute("data-state")).toBe("reloaded");
    expect(chip.textContent).toBe("Reloaded");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved");
    expect(retryKeys).toEqual([0, 1]);
  });

  it("reloads by itself again for a later change that shows new text", async () => {
    await openNote();
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    setEngine(engineState(markdownToYDoc("# First outside change\n"), null));
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
    // A second outside write a few seconds later reloads too, with no notice.
    setEngine(engineState(markdownToYDoc("# First outside change\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1, 2]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    setEngine(engineState(markdownToYDoc("# Second outside change\n"), null));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
  });

  it("reloads by itself after a frontmatter-only change, and again for a body change", async () => {
    await openNote();
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    // The first outside change touched only the frontmatter.
    setEngine(engineState(markdownToYDoc("---\ntitle: Trip\n---\n# Plan\n"), null));
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
    setEngine(engineState(markdownToYDoc("---\ntitle: Trip\n---\n# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1, 2]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    setEngine(engineState(markdownToYDoc("---\ntitle: Trip\n---\n# Plan for Lisbon\n"), null));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
  });

  // Frontmatter keeps int64 values past the safe range as bigints, and
  // negative zero as its own value. The reload compares them as the model does.
  it("reloads by itself over bigint frontmatter, before and after the reload", async () => {
    const before = "---\nexact: 9007199254740993\nnested:\n  exact: 9007199254740995\n---\n# Plan\n";
    await openNote({ markdown: before });
    setEngine(engineState(markdownToYDoc(before), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    const after = "---\nexact: 9007199254740997\nnested:\n  exact: 9007199254740999\n---\n# Plan\n";
    setEngine(engineState(markdownToYDoc(after), null));
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
    setEngine(engineState(markdownToYDoc(after), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1, 2]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
  });

  it("reloads by itself after a change from -0.0 to 0.0 alone, and again for a body change", async () => {
    await openNote({ markdown: "---\nvalue: -0.0\n---\n# Plan\n" });
    setEngine(engineState(markdownToYDoc("---\nvalue: -0.0\n---\n# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    setEngine(engineState(markdownToYDoc("---\nvalue: 0.0\n---\n# Plan\n"), null));
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
    setEngine(engineState(markdownToYDoc("---\nvalue: 0.0\n---\n# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1, 2]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    setEngine(engineState(markdownToYDoc("---\nvalue: 0.0\n---\n# Plan for Lisbon\n"), null));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("reloaded");
  });

  it("asks instead of reloading again when the reopened note shows the same text", async () => {
    await openNote();
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    // The reopen came back on the old text, so the change was not taken in.
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    expect(await screen.findByTestId("changed-outside-notice")).toBeTruthy();
    expect(retryKeys).toEqual([0, 1]);
  });

  it("does not reload by itself over an edit main has not confirmed", async () => {
    await openNote();
    setEngine({ ...engineState(markdownToYDoc("# Plan typed\n"), "saved"), unsavedEditsPending: () => true });
    expect(await screen.findByTestId("changed-outside-notice")).toBeTruthy();
    expect(retryKeys).toEqual([0]);
  });

  it("stays on the notice and reports Try again when capture has not recorded the new version", async () => {
    const onButtonError = vi.fn();
    await openNote({ onButtonError });
    setEngine(engineState(markdownToYDoc("# Plan\n"), "saved"));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    // The reopen was refused: capture still holds the change.
    setEngine({ ...engineState(markdownToYDoc("# Plan\n"), null), available: false, doc: null, outsideWriteWaiting: true });
    expect(await screen.findByTestId("changed-outside-notice")).toBeTruthy();
    await waitFor(() => expect(onButtonError).toHaveBeenCalledTimes(1));
    const [message, , retry, identity] = onButtonError.mock.calls[0]!;
    expect(message).toBe('dohc could not open the new version of "a.md". History has not recorded it yet.');
    expect(identity).toBe("outside-write-waiting:ws-1:a.md");
    // Nothing reopens until the person chooses Try again or Reload.
    expect(retryKeys).toEqual([0, 1]);
    act(() => (retry as () => void)());
    await waitFor(() => expect(retryKeys).toEqual([0, 1, 2]));
  });

  it("keeps unsaved text until the person chooses Reload", async () => {
    await openNote();
    setEngine(engineState(markdownToYDoc("# Plan typed\n"), "unsaved"));
    const notice = await screen.findByTestId("changed-outside-notice");
    expect(notice.textContent).toContain(CHANGED_OUTSIDE_NOTICE);
    expect(screen.getByTestId("markdown-save-state").getAttribute("title")).toBe(CHANGED_OUTSIDE_NOTICE);
    expect(retryKeys).toEqual([0]);
    const reload = screen.getByRole("button", { name: "Reload" });
    reload.focus();
    expect(document.activeElement).toBe(reload);
    fireEvent.click(reload);
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
  });

  // Edit anyway covers the bytes the person confirmed. A lossy note (CONTEXT.md)
  // that another app replaces reloads as a new open, checked again.
  it.each(["saved", "unsaved"] as const)("asks for Edit anyway again when an outside write reloads a lossy note (%s)", async (state) => {
    const versionA = "# Readme\n\n<details>\n\nVersion A.\n</details>\n";
    const versionB = "# Readme\n\n<details>\n\nVersion B, from another app.\n</details>\n";
    let disk = { text: versionA, contentHash: "a".repeat(64) };
    const bridge = makeBridge();
    vi.mocked(bridge.readWorkspaceText).mockImplementation(async () => ({ ...disk, truncated: false }));
    vi.stubGlobal("dohcDesktop", bridge);
    engine.closedWhenDisabled = true;
    engine.state = engineState(markdownToYDoc(versionA), null);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    fireEvent.click(await screen.findByTestId("lossy-note-edit-anyway"));
    fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    // Another app writes version B, and the note reloads.
    disk = { text: versionB, contentHash: "b".repeat(64) };
    setEngine(engineState(markdownToYDoc(versionA), state));
    if (state === "unsaved") fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    setEngine(engineState(markdownToYDoc(versionB), null));

    await screen.findByTestId("lossy-note-notice");
    expect(document.querySelector('[data-testid="markdown-editor"][contenteditable="true"]')).toBeNull();
  });
});
