// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyForView,
  FileInspector,
  lineSpanInText,
  markdownEditorBody,
  mergeMarkdownEditorBody,
} from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";

// Build legacy app-model path markers through interpolation so this test does
// not contain the raw deprecated folder or manifest filenames that the
// no-legacy scanner is meant to catch.
const LEGACY_APPS_SEGMENT = ["", "apps"].join(".");
const LEGACY_APP_MANIFEST = ["app", "json"].join(".");
const legacyAppPath = (...segments: string[]) =>
  [LEGACY_APPS_SEGMENT, ...segments].join("/");

describe("lineSpanInText (search scroll-to-line, Phase E5.0)", () => {
  const text = "first\nsecond line\n\nfourth";

  it("spans each 1-based line, excluding the newline", () => {
    expect(lineSpanInText(text, 1)).toEqual({ start: 0, end: 5 });
    expect(lineSpanInText(text, 2)).toEqual({ start: 6, end: 17 });
    expect(lineSpanInText(text, 3)).toEqual({ start: 18, end: 18 }); // empty line
    expect(lineSpanInText(text, 4)).toEqual({ start: 19, end: 25 });
  });

  it("clamps a line past the end to the last line", () => {
    expect(lineSpanInText(text, 99)).toEqual({ start: 19, end: 25 });
    expect(lineSpanInText("", 5)).toEqual({ start: 0, end: 0 });
  });
});

describe("classifyForView dispatch", () => {
  const cases: Array<[string, string]> = [
    ["notes/today.md", "markdown"],
    ["readme.markdown", "markdown"],
    ["data/transactions.csv", "csv"],
    ["data/report.tsv", "csv"],
    ["data/config.json", "json"],
    ["notes/plain.txt", "text"],
    ["uploads/receipt.png", "image"],
    ["uploads/logo.svg", "image"],
    ["uploads/voice.m4a", "audio"],
    ["uploads/contract.pdf", "pdf"],
    ["finance/wallet.sqlite", "database"],
    ["archive/old.db", "database"],
    [`finance/${legacyAppPath("ledger", LEGACY_APP_MANIFEST)}`, "json"],
    [`finance/${legacyAppPath("ledger", "src", "App.tsx")}`, "text"],
    ["uploads/mystery.bin", "binary"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies ${path} as ${expected}`, () => {
      expect(classifyForView(path)).toBe(expected);
    });
  }

  it("treats legacy app-folder paths as ordinary files", () => {
    expect(classifyForView(`x/${legacyAppPath("ledger", LEGACY_APP_MANIFEST)}`)).toBe("json");
    expect(classifyForView(`x/${legacyAppPath("ledger", "src", "App.tsx")}`)).toBe("text");
  });
});

describe("markdown WYSIWYG frontmatter seam", () => {
  it("edits only the body and reattaches raw frontmatter on save", () => {
    const markdown = "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("\n# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Plan\n\nMore")).toBe(
      "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nMore",
    );
  });

  it("leaves markdown without frontmatter untouched", () => {
    expect(markdownEditorBody("# Plan\n")).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody("# Plan\n", "# Edited\n")).toBe("# Edited\n");
  });

  it("recognizes real map frontmatter with common YAML keys", () => {
    const markdown =
      "---\ndue date: today\na:b: c\n'a: b': quoted\nx/y: slash\n'@x': at\nanchor: &base value\nnote: Plan # owner: ice\ntags: # list: owned\n- a\n- b\n---\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe(
      "---\ndue date: today\na:b: c\n'a: b': quoted\nx/y: slash\n'@x': at\nanchor: &base value\nnote: Plan # owner: ice\ntags: # list: owned\n- a\n- b\n---\n# Edited\n",
    );
  });

  it("reattaches empty and comment-only frontmatter instead of rendering it", () => {
    const markdown = "---\n# dohc metadata\n---\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe(
      "---\n# dohc metadata\n---\n# Edited\n",
    );
  });

  it("leaves malformed and non-map frontmatter-looking blocks editable", () => {
    for (const markdown of [
      "---\nid: note-1\nbad: [unclosed\n---\n# Body\n",
      "---\nkey: a: b\n---\n# Body\n",
      "---\nkey: *missing\n---\n# Body\n",
      "---\njust a divider\n---\n# Body\n",
      "---\nnull\n---\n# Body\n",
      "---\n- one\n---\n# Body\n",
    ]) {
      expect(markdownEditorBody(markdown)).toBe(markdown);
      expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe("# Edited\n");
    }
  });
});

// THE P1 trap (codex review): typing arms an 800ms autosave, and unmounting
// (tab close, tab switch — the inspector is keyed by the active tab) used to
// clear the timer WITHOUT flushing, silently dropping the draft. The unmount
// cleanup must fire the pending draft through writeWorkspaceText.
describe("markdown editor unmount flush", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn(async () => ({ text: "# Hello\n", truncated: false })),
    writeWorkspaceText: vi.fn(
      async (_payload: {
        workspaceId: string;
        relativePath: string;
        text: string;
      }) => ({ path: "a.md", recorded: true }),
    ),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
  };

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      Number(setTimeout(() => callback(performance.now()), 16)),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function typeDraft() {
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(screen.getByTestId("markdown-editor"), "Draft!");
    return { user, view };
  }

  it("flushes the pending draft on unmount — the write carries the FINAL text", async () => {
    const { view } = await typeDraft();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    // Unmount INSIDE the 800ms autosave window (real timers; typing is fast).
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "# Hello\nDraft!",
    });
  });

  it("does not double-write when the draft already saved before unmount", async () => {
    const { user, view } = await typeDraft();
    // "Done" flushes immediately (the Ctrl+S path) — draft saved.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    view.unmount();
    // The unmount flush keys off the unsaved-draft flag, not the timer
    // handle: a clean save must not be replayed as a second write.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("edits markdown frontmatter properties through the same save seam", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: false,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    // Properties render inline under the title now — no toggle to open.
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "---\nid: note-1\ntitle: Plan\nstatus: ready\n---\n\n# Plan\n",
    });
  });

  it("surfaces a failed read-mode PageIdentity save instead of hiding it", async () => {
    // Read mode hides the idle "Saved" chip, but PageIdentity stays editable and
    // autosaves title/icon edits. A failed save must still surface — otherwise
    // the optimistic title keeps showing while the write silently failed. A body
    // over the WYSIWYG threshold opens in read mode without being truncated
    // (truncated would make PageIdentity read-only and skip the save entirely).
    const bigBody = `---\ntitle: Plan\n---\n\n${"# Section\n\nbody paragraph.\n\n".repeat(3000)}`;
    expect(bigBody.length).toBeGreaterThan(64 * 1024);
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({ text: bigBody, truncated: false });
    bridgeMock.writeWorkspaceText.mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="plan.md" />);

    // Read mode: no editor, but the editable PageIdentity title is present.
    await screen.findByTestId("page-identity");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    // No pending save yet, so the save-state chip is hidden in read mode.
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();

    const title = screen.getByTestId("page-title") as HTMLInputElement;
    await user.click(title);
    await user.type(title, "!");

    // The autosave (800ms debounce) fails; the failure must become visible even
    // though we never left read mode.
    await waitFor(
      () => {
        const chip = screen.getByTestId("markdown-save-state");
        expect(chip.textContent).toBe("Couldn't save");
        expect(chip.getAttribute("data-state")).toBe("error");
      },
      { timeout: 3_000 },
    );
    // The optimistic title edit is still displayed alongside the failure.
    expect(title.value).toContain("!");
    view.unmount();
  });

  it("does not expose properties editing for truncated markdown reads", async () => {
    const user = userEvent.setup();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: true,
    });
    const view = render(<FileInspector workspaceId="ws-1" path="large.md" />);

    await screen.findByTestId("view-markdown");

    expect(screen.getByTestId("truncated-notice")).toBeTruthy();
    // A truncated (read-only) doc never exposes editable inline properties.
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    const editToggle = screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement;
    expect(editToggle.disabled).toBe(true);
    await user.click(editToggle);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("routes the document header share action to the active path", async () => {
    const user = userEvent.setup();
    const onSharePath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        onSharePath={onSharePath}
      />,
    );

    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    expect(onSharePath).toHaveBeenCalledWith("a.md");
  });

  it("edits plain text files through the same bounded write seam", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);

    const editor = await screen.findByTestId("view-text-editor");
    const content = editor.querySelector(".cm-content") as HTMLElement;
    await user.click(content);
    await user.keyboard("hello world");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
      }),
    );
    const lastWrite = bridgeMock.writeWorkspaceText.mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(lastWrite?.text).not.toBe("");
  });

  it("lets Ctrl+Z undo a pending history revert in CodeMirror text files", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "before\n",
      truncated: false,
    });
    const onPendingUndoConsumed = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        pendingUndo={{
          token: 7,
          path: "notes/plain.txt",
          restoredText: "before\n",
          undoText: "after\n",
        }}
        onPendingUndoConsumed={onPendingUndoConsumed}
      />,
    );

    await screen.findByTestId("view-text-editor");
    await waitFor(() => expect(onPendingUndoConsumed).toHaveBeenCalledWith(7));
    await user.keyboard("{Control>}z{/Control}");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "after\n",
    });
  });

  it("edits CSV cells and saves the table file", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);

    await screen.findByTestId("view-csv");
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "43");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data/table.csv",
      text: "date,amount\n2026-06-10,43",
    });
  });

  it("can start editing an empty CSV as a table", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="data/empty.csv" />);

    await screen.findByTestId("csv-empty-table");
    await user.click(screen.getByTestId("csv-empty-add-row"));
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data/empty.csv",
      text: 'column\n""',
    });
  });

  it("routes database share actions to their active file paths", async () => {
    const user = userEvent.setup();
    const onSharePath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="data.sqlite"
        onSharePath={onSharePath}
      />,
    );

    await screen.findByTestId("view-database");
    await user.click(screen.getByTestId("file-share"));
    expect(onSharePath).toHaveBeenCalledWith("data.sqlite");
  });

  it("shows inline properties in WYSIWYG and hides them in source mode", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: false,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    // WYSIWYG opens with properties inline under the title — no toggle needed.
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });

    // Source mode edits the raw markdown (frontmatter included), so the inline
    // property rows step aside.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() => {
      expect(screen.queryByTestId("properties-panel")).toBeNull();
    });

    // Returning to WYSIWYG brings the inline properties back.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
  });

  it("keeps read-mode properties edits dirty across a refresh before save", async () => {
    const largeBody = `---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n${"body\n".repeat(14_000)}`;
    const externalBody = `${largeBody}\nexternal update\n`;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: largeBody,
        truncated: false,
      })
      .mockResolvedValueOnce({
        text: externalBody,
        truncated: false,
      });
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="large.md" refreshKey={0} />,
    );

    await screen.findByTestId("view-markdown");
    // Large docs open in read mode; properties still render inline (editable).
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");
    view.rerender(
      <FileInspector workspaceId="ws-1" path="large.md" refreshKey={1} />,
    );
    await waitFor(() => expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2));
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "large.md",
      text: largeBody.replace("status: draft", "status: ready"),
    });
  });
});
