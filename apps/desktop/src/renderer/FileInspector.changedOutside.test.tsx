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
import { FileInspector } from "./FileInspector";
import { CHANGED_OUTSIDE_NOTICE } from "./MarkdownView";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";

// The engine session as the test sets it, and every retry key the inspector
// asked for. A new retry key closes the session and opens it again.
let engineDocState: UseEngineDoc;
const retryKeys: number[] = [];
vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: (input: EngineDocInput) => {
    if (retryKeys.at(-1) !== input.retryKey) retryKeys.push(input.retryKey ?? 0);
    return engineDocState;
  },
}));

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
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("dohcDesktop", makeBridge());
  });

  afterEach(() => {
    cleanup();
    resetSharedLocalDocumentsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reopens a note with nothing unsaved and says Reloaded for a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    engineDocState = engineState(markdownToYDoc("# Plan\n"), "saved");
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    expect(screen.queryByTestId("changed-outside-notice")).toBeNull();
    // The reopened session shows the disk version.
    engineDocState = engineState(markdownToYDoc("# Written outside dohc\n"), null);
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" />);
    const chip = screen.getByTestId("markdown-save-state");
    expect(chip.getAttribute("data-state")).toBe("reloaded");
    expect(chip.textContent).toBe("Reloaded");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved");
    expect(retryKeys).toEqual([0, 1]);
  });

  it("keeps unsaved text until the person chooses Reload", async () => {
    engineDocState = engineState(markdownToYDoc("# Plan typed\n"), "unsaved");
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
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
});
