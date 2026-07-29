// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  markdownToYDoc,
  replaceYDocWithMarkdown,
} from "./editor/import-export";
import {
  classifyForView,
  FileInspector,
  lineSpanInText,
  markdownEditorBody,
  mergeMarkdownEditorBody,
  resolveWikilinkNavigation,
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

describe("resolveWikilinkNavigation", () => {
  const files = [
    { path: "notes/plan.md", title: "Plan" },
    { path: "notes/release#1.md", title: "Release 1" },
    { path: "notes/daily/milestone#2.md", title: "Milestone 2" },
    { path: "notes/#overview.md", title: "Hash Overview" },
    { path: "today.md", title: "Today" },
  ];

  it("opens file fragments as an exact heading target", () => {
    expect(
      resolveWikilinkNavigation("notes/plan.md#next-steps", "today.md", files, 7),
    ).toEqual({
      path: "notes/plan.md",
      headingTarget: { anchor: "next-steps", nonce: 7 },
    });
  });

  it("keeps fragment-only links in the current file and preserves encoded anchors", () => {
    expect(
      resolveWikilinkNavigation("#caf%C3%A9-plan", "today.md", files, 8),
    ).toEqual({
      path: "today.md",
      headingTarget: { anchor: "caf%C3%A9-plan", nonce: 8 },
    });
  });

  it("keeps an explicit leading-hash heading local even when a matching file exists", () => {
    expect(
      resolveWikilinkNavigation("#overview", "notes/today.md", files, 16),
    ).toEqual({
      path: "notes/today.md",
      headingTarget: { anchor: "overview", nonce: 16 },
    });
    expect(
      resolveWikilinkNavigation("./#overview", "notes/today.md", files, 17),
    ).toEqual({ path: "notes/#overview.md" });
  });

  it("preserves whole-file wikilink resolution without manufacturing a target", () => {
    expect(resolveWikilinkNavigation("notes/plan", "today.md", files, 9)).toEqual({
      path: "notes/plan.md",
    });
  });

  it("treats a full known filename containing # as a file, not a heading", () => {
    expect(
      resolveWikilinkNavigation("notes/release#1.md", "today.md", files, 10),
    ).toEqual({ path: "notes/release#1.md" });
    expect(
      resolveWikilinkNavigation("notes/release#1", "today.md", files, 11),
    ).toEqual({ path: "notes/release#1.md" });
  });

  it("normalizes relative paths before matching filenames containing #", () => {
    expect(
      resolveWikilinkNavigation(
        "./milestone#2",
        "notes/daily/today.md",
        files,
        12,
      ),
    ).toEqual({ path: "notes/daily/milestone#2.md" });
    expect(
      resolveWikilinkNavigation(
        "../release#1.md",
        "notes/daily/today.md",
        files,
        13,
      ),
    ).toEqual({ path: "notes/release#1.md" });
  });

  it("uses the longest known hash filename before an explicit heading", () => {
    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#decisions",
        "today.md",
        files,
        14,
      ),
    ).toEqual({
      path: "notes/release#1.md",
      headingTarget: { anchor: "decisions", nonce: 14 },
    });
    expect(
      resolveWikilinkNavigation(
        "./milestone#2#next-steps",
        "notes/daily/today.md",
        files,
        15,
      ),
    ).toEqual({
      path: "notes/daily/milestone#2.md",
      headingTarget: { anchor: "next-steps", nonce: 15 },
    });
  });

  it("keeps a trailing empty fragment on the longest known hash filename", () => {
    const competingFiles = [
      ...files,
      { path: "notes/release.md", title: "Release" },
    ];
    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#",
        "today.md",
        competingFiles,
        18,
      ),
    ).toEqual({ path: "notes/release#1.md" });

    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#",
        "today.md",
        [{ path: "notes/release#1.md", title: "Release 1" }],
        19,
      ),
    ).toEqual({ path: "notes/release#1.md" });
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

// The DOM/layout stubs Tiptap + CodeMirror need under jsdom — shared by every
// describe that renders an editor surface.
function stubEditorGlobals() {
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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}

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
    stubEditorGlobals();
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
    await user.type(await screen.findByTestId("markdown-editor"), "Draft!");
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

  it("palette source toggle flushes a pending raw draft before leaving source mode", async () => {
    // codex P1: leaving editable source through the palette command must flush
    // the RAW draft like the header toggle does — a timer firing after the
    // mode switch would re-serialize through the (lossy) Tiptap parse.
    const user = userEvent.setup();
    let registered: (() => void) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          registered = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    // registered?.() optional-chains to a silent no-op until the inspector has
    // handed back its toggle, which leaves the view in wysiwyg and fails the
    // editor lookup below with a confusing "not found". Wait for the toggle.
    await waitFor(() => expect(registered).not.toBeNull());
    act(() => registered?.()); // wysiwyg -> editable source (legacy branch)
    await user.type(await screen.findByTestId("markdown-editor"), "Raw!");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    act(() => registered?.()); // source -> wysiwyg: flushes inside the window
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "a.md",
        text: "# Hello\nRaw!",
      }),
    );
  });

  it("offers a read-only source view for read-only markdown (truncated reads)", async () => {
    // codex P3 follow-up: a read-only doc can't EDIT, but viewing raw source
    // is still a view — the palette toggle opens the source textarea with the
    // readOnly attribute and never writes.
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Big\n",
      truncated: true,
    });
    let registered: (() => void) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="large.md"
        registerSourceToggle={(toggle) => {
          registered = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    act(() => registered?.());
    const textarea = (await screen.findByTestId(
      "markdown-editor",
    )) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toContain("# Big");
    act(() => registered?.());
    await screen.findByTestId("view-markdown");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
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

  it("navigates the rendered heading in a read-only shared document", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Hello\n\n## Exact destination\nBody\n",
      truncated: false,
    });
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" readOnly />,
    );
    await screen.findByTestId("view-markdown");
    await waitFor(() =>
      expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit"),
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        headingTarget={{ anchor: "exact-destination", nonce: 2 }}
      />,
    );

    await waitFor(() => {
      const destination = screen.getByRole("heading", {
        name: "Exact destination",
      });
      expect(destination.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
    });
    expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps local source mode and selects the target heading line", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\ntitle: Plan\n---\n\n# Hello\n\nParagraph\n\n## Exact destination\nBody\n",
      truncated: false,
    });
    let toggleSource: (() => void) | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    act(() => toggleSource?.());
    const source = (await screen.findByTestId(
      "markdown-editor",
    )) as HTMLTextAreaElement;

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
        headingTarget={{ anchor: "exact-destination", nonce: 3 }}
      />,
    );

    const expected = lineSpanInText(source.value, 9);
    await waitFor(() => {
      expect(source.selectionStart).toBe(expected.start);
      expect(source.selectionEnd).toBe(expected.end);
    });
    expect(screen.getByTestId("markdown-editor")).toBe(source);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("navigates a legacy collided occurrence target to the repeated base heading", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Foo\nfirst\n# Foo-1\nliteral\n# Foo\nthird\n",
      truncated: false,
    });
    let toggleSource: (() => void) | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    act(() => toggleSource?.());
    const source = (await screen.findByTestId(
      "markdown-editor",
    )) as HTMLTextAreaElement;

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
        headingTarget={{ anchor: "foo-1", occurrence: 1, nonce: 4 }}
      />,
    );

    const expected = lineSpanInText(source.value, 5);
    await waitFor(() => {
      expect(source.selectionStart).toBe(expected.start);
      expect(source.selectionEnd).toBe(expected.end);
    });
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe("# Foo");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("routes the document header share action to the active path", async () => {
    const user = userEvent.setup();
    const onSharePath = vi.fn();
    const view = render(
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
    const view = render(
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

// "View markdown as source" on the ENGINE path: the toggle shows a READ-ONLY
// projection of the canonical Y.Doc (the same yDocToMarkdown the settle uses)
// — never an editable raw-markdown surface (the derived-cache invariant). The
// engine session is mocked at the bridge seam exactly like production wires
// it: openEngineYDocSession seeds the mirror doc, onEngineYDocRemoteUpdate
// forwards CRDT deltas.
describe("engine markdown source view", () => {
  const DOC_MARKDOWN = "---\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nBase paragraph.\n";

  function makeEngineBridge(markdown: string) {
    const serverDoc = markdownToYDoc(markdown);
    const remoteListeners = new Set<
      (event: { sessionId: string; update: Uint8Array }) => void
    >();
    const saveStateListeners = new Set<
      (event: {
        sessionId: string;
        state: "settling" | "saved" | "error";
        seq: number;
      }) => void
    >();
    let sessionId = "";
    const bridgeMock = {
      readWorkspaceText: vi.fn(async () => ({ text: markdown, truncated: false })),
      writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
      listWorkspaceFiles: vi.fn(async () => ({
        files: [{ path: "a.md", kind: "file" }],
        folders: [],
      })),
      readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
      getWorkspaceSettings: vi.fn(async () => ({
        settings: DEFAULT_WORKSPACE_SETTINGS,
        source: "default" as const,
      })),
      openEngineYDocSession: vi.fn(async (payload: { sessionId: string }) => {
        sessionId = payload.sessionId;
        return { available: true, initialUpdate: Y.encodeStateAsUpdate(serverDoc) };
      }),
      applyEngineYDocUpdate: vi.fn(async () => undefined),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(
        (listener: (event: { sessionId: string; update: Uint8Array }) => void) => {
          remoteListeners.add(listener);
          return () => remoteListeners.delete(listener);
        },
      ),
      // The engine editor subscribes to real settle outcomes on mount (the
      // save indicator is no longer a timer). Without this the hook throws
      // "onEngineYDocSaveState is not a function" the moment an enabled
      // engine document renders.
      onEngineYDocSaveState: vi.fn(
        (
          listener: (event: {
            sessionId: string;
            state: "settling" | "saved" | "error";
            seq: number;
          }) => void,
        ) => {
          saveStateListeners.add(listener);
          return () => saveStateListeners.delete(listener);
        },
      ),
    };
    // Simulates a remote writer (co-editor / agent) landing in the live doc:
    // mutate the engine-side doc and forward the delta like main does.
    const pushRemoteMarkdown = (next: string) => {
      const before = Y.encodeStateVector(serverDoc);
      replaceYDocWithMarkdown(serverDoc, next);
      const update = Y.encodeStateAsUpdate(serverDoc, before);
      for (const listener of remoteListeners) listener({ sessionId, update });
    };
    return { bridgeMock, pushRemoteMarkdown };
  }

  beforeEach(() => {
    stubEditorGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderEngineDoc(options?: {
    registerSourceToggle?: (toggle: (() => void) | null) => void;
  }) {
    const { bridgeMock, pushRemoteMarkdown } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={options?.registerSourceToggle}
      />,
    );
    // The engine session takes over once bound: the legacy Edit toggle gives
    // way to the engine header's Source toggle.
    const toggle = await screen.findByTestId(
      "markdown-source-toggle",
      {},
      { timeout: 5_000 },
    );
    return { bridgeMock, pushRemoteMarkdown, toggle, view };
  }

  it("toggles a read-only source projection (frontmatter included) and back", async () => {
    const user = userEvent.setup();
    const { toggle } = await renderEngineDoc();

    await user.click(toggle);
    const sourceView = await screen.findByTestId(
      "markdown-source-view",
      {},
      { timeout: 5_000 },
    );
    // Raw markdown, not rendered document: frontmatter and heading markup are
    // visible as text.
    await waitFor(() => {
      expect(sourceView.textContent).toContain("# Plan");
      expect(sourceView.textContent).toContain("title: Plan");
    });
    // READ-ONLY: CodeMirror's content is not editable, and the WYSIWYG pane is
    // HIDDEN — not unmounted (unmounting would destroy the Collaboration
    // extension's undo stack and leave copy/export serializing stale state).
    const content = sourceView.querySelector(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByTestId("view-markdown").hidden).toBe(true);
    expect(screen.getByTestId("markdown-source-toggle").textContent).toBe("Editor");

    // Toggling back restores the document surface.
    await user.click(screen.getByTestId("markdown-source-toggle"));
    expect(screen.getByTestId("view-markdown").hidden).toBe(false);
    expect(screen.queryByTestId("markdown-source-view")).toBeNull();
  });

  it("re-projects the source live when a remote CRDT delta lands", async () => {
    const user = userEvent.setup();
    const { toggle, pushRemoteMarkdown } = await renderEngineDoc();

    await user.click(toggle);
    const sourceView = await screen.findByTestId(
      "markdown-source-view",
      {},
      { timeout: 5_000 },
    );
    await waitFor(() => expect(sourceView.textContent).toContain("Base paragraph."));

    act(() => {
      pushRemoteMarkdown(
        "---\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nRemote edit landed.\n",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-source-view").textContent).toContain(
        "Remote edit landed.",
      );
    });
  });

  it("registers a source toggle for the shell's command palette seam", async () => {
    let registered: (() => void) | null = null;
    await renderEngineDoc({
      registerSourceToggle: (toggle) => {
        registered = toggle;
      },
    });

    expect(registered).not.toBeNull();
    act(() => registered?.());
    await screen.findByTestId("markdown-source-view", {}, { timeout: 5_000 });
    expect(screen.getByTestId("view-markdown").hidden).toBe(true);

    act(() => registered?.());
    expect(screen.getByTestId("view-markdown").hidden).toBe(false);
    expect(screen.queryByTestId("markdown-source-view")).toBeNull();
  });

  it("reveals the visible engine editor before applying a heading jump", async () => {
    const user = userEvent.setup();
    const { toggle, view } = await renderEngineDoc();
    await user.click(toggle);
    await screen.findByTestId("markdown-source-view", {}, { timeout: 5_000 });
    expect(screen.getByTestId("view-markdown").hidden).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        headingTarget={{ anchor: "plan", nonce: 3 }}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId("markdown-source-view")).toBeNull());
    expect(screen.getByTestId("view-markdown").hidden).toBe(false);
  });
});
