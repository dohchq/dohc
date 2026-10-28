// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import { saveProblem } from "@dohc/workspace-contracts/save-state";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "../workspaces/workspaceTextLimits";
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
  // When set, every open inspector gets the session whatever its own retry
  // key, as panes sharing one engine lease do.
  sharedLease: false,
}));
const retryKeys = engine.retryKeys;
// The large lossy note needs a note past the WYSIWYG limit, not the limit
// itself. A small limit keeps it small, so opening it stays fast on a busy host.
vi.mock("../workspaces/workspaceTextLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspaces/workspaceTextLimits")>()),
  WYSIWYG_MARKDOWN_THRESHOLD_BYTES: 64 * 1024,
}));

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
      return engine.sharedLease || (input.retryKey ?? 0) === engine.boundRetryKey
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

// `headSha256` is the head of the file the session opened on.
function engineState(doc: Y.Doc, changedOutside: UseEngineDoc["changedOutside"], headSha256?: string): UseEngineDoc {
  return {
    available: true,
    headSha256,
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
    engine.sharedLease = false;
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
    engine.state = engineState(markdownToYDoc(versionA), null, "a".repeat(64));
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    fireEvent.click(await screen.findByTestId("lossy-note-edit-anyway"));
    fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    // Another app writes version B, and the note reloads.
    disk = { text: versionB, contentHash: "b".repeat(64) };
    setEngine(engineState(markdownToYDoc(versionA), state, "a".repeat(64)));
    if (state === "unsaved") fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(retryKeys).toEqual([0, 1]));
    setEngine(engineState(markdownToYDoc(versionB), null, "b".repeat(64)));

    await screen.findByTestId("lossy-note-notice");
    expect(document.querySelector('[data-testid="markdown-editor"][contenteditable="true"]')).toBeNull();
  });

  // Panes on one note share its engine session, so one pane's reload hands
  // every pane the new bytes. Edit anyway covers only the bytes it confirmed.
  it.each([true, false])("rereads another pane before Edit anyway after a shared reload (lossy: %s)", async (lossy) => {
    const filler = "A paragraph that makes this note larger than read mode's limit.\n\n".repeat(1_100);
    const versionA = `# Readme\n\n<details>\n\nVersion A.\n</details>\n\n${filler}`;
    const versionB = lossy
      ? `# Readme\n\n<details>\n\nVersion B, from another app.\n</details>\n\n${filler}`
      : `# Readme\n\nVersion B, from another app.\n\n* A list item.\n\n${filler}`;
    expect(isLossyMarkdown(versionB)).toBe(lossy);
    expect(versionB).not.toBe(`${yDocToMarkdown(markdownToYDoc(versionB))}\n`);
    expect(versionA.length).toBeGreaterThan(WYSIWYG_MARKDOWN_THRESHOLD_BYTES);
    const hashA = createHash("sha256").update(versionA).digest("hex");
    const hashB = createHash("sha256").update(versionB).digest("hex");
    let disk = { text: versionA, contentHash: hashA };
    const bridge = makeBridge();
    vi.mocked(bridge.readWorkspaceText).mockImplementation(async () => ({ ...disk, truncated: false }));
    vi.stubGlobal("dohcDesktop", bridge);
    engine.closedWhenDisabled = true;
    engine.sharedLease = true;
    engine.state = engineState(seededFrom(versionA, hashA), null, hashA);
    render(
      <>
        <div data-testid="pane-1"><FileInspector workspaceId="ws-1" path="a.md" /></div>
        <div data-testid="pane-2"><FileInspector workspaceId="ws-1" path="a.md" /></div>
      </>,
    );
    const pane1 = within(screen.getByTestId("pane-1"));
    const pane2 = within(screen.getByTestId("pane-2"));
    for (const pane of [pane1, pane2]) {
      fireEvent.click(await pane.findByTestId("lossy-note-edit-anyway"));
      fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    }
    await waitFor(() => expect(pane2.queryByTestId("lossy-note-notice")).toBeNull());

    // Another app writes version B over unsaved text, and pane 1 reloads it
    // into the session both panes share.
    disk = { text: versionB, contentHash: hashB };
    setEngine(engineState(seededFrom(versionA, hashA), "unsaved", hashA));
    fireEvent.click(await pane1.findByRole("button", { name: "Reload" }));
    setEngine(engineState(seededFrom(versionB, hashB), null, hashB));

    await waitFor(() => expect(pane2.getByTestId("view-markdown").textContent).toContain("Version B, from another app."));
    if (lossy) {
      expect(screen.getByTestId("pane-2").querySelector('[contenteditable="true"]')).toBeNull();
      fireEvent.click(await pane2.findByTestId("lossy-note-edit-anyway"));
      fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    }
    await waitFor(() => expect(pane2.queryByTestId("lossy-note-notice")).toBeNull());
    await waitFor(() => expect(pane2.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(pane2.getByTestId("markdown-editor").textContent).toContain("Version B, from another app.");
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it.each(["path", "workspace", "request"] as const)("drops a stale-pane reread after its %s changes", async (changed) => {
    const versionA = "# Readme\n\n<details>\n\nVersion A.\n</details>\n";
    const versionB = versionA.replace("Version A.", "Version B, from another app.");
    const other = "# Other note\n\nCurrent text.\n";
    const bridge = makeBridge();
    vi.mocked(bridge.readWorkspaceText).mockResolvedValue({ text: versionA, contentHash: "a".repeat(64), truncated: false });
    vi.stubGlobal("dohcDesktop", bridge);
    engine.closedWhenDisabled = true;
    engine.sharedLease = true;
    engine.state = engineState(seededFrom(versionA, "a".repeat(64)), null, "a".repeat(64));
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={0} />);
    fireEvent.click(await screen.findByTestId("lossy-note-edit-anyway"));
    fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    const readsBeforeReload = vi.mocked(bridge.readWorkspaceText).mock.calls.length;
    let answer!: (read: Awaited<ReturnType<DohcDesktopBridge["readWorkspaceText"]>>) => void;
    vi.mocked(bridge.readWorkspaceText).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    setEngine(engineState(seededFrom(versionB, "b".repeat(64)), null, "b".repeat(64)));
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalledTimes(readsBeforeReload + 1));
    expect(screen.queryByTestId("lossy-note-edit-anyway")).toBeNull();

    vi.mocked(bridge.readWorkspaceText).mockResolvedValue({ text: other, contentHash: "c".repeat(64), truncated: false });
    setEngine(engineState(markdownToYDoc(other), null, "c".repeat(64)));
    view.rerender(<FileInspector workspaceId={changed === "workspace" ? "ws-2" : "ws-1"} path={changed === "path" ? "b.md" : "a.md"} refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("Current text."));
    await act(async () => { answer({ text: versionB, contentHash: "b".repeat(64), truncated: false }); });
    expect(screen.getByTestId("view-markdown").textContent).toContain("Current text.");
    expect(screen.getByTestId("view-markdown").textContent).not.toContain("Version B, from another app.");
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });
});

// A session the engine seeded from `markdown`, which records it as its source
// under the content hash its read gave.
function seededFrom(markdown: string, contentHash: string): Y.Doc {
  const doc = markdownToYDoc(markdown);
  doc.getMap("meta").set("dohcMarkdownSource", markdown);
  doc.getMap("meta").set("dohcMarkdownSourceSha256", contentHash);
  doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", createHash("sha256").update(yDocToMarkdown(doc)).digest("hex"));
  return doc;
}
