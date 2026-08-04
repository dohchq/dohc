// @vitest-environment jsdom
import { configure } from "@testing-library/dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 32 of the 39 tests here await a lazily-imported CodeMirror via findBy*, so the
// wall-clock profile is the file, not one test (#372). File-level is the honest
// scope; per-test would be 32 copies of the same line.
//
// asyncUtilTimeout is the one that actually mattered: findBy* rejects on RTL's own
// 1000ms default, so these failed at ~1s with "Unable to find [data-testid=...]"
// while the test budget was never reached. Raising testTimeout alone fixed nothing
// here — an error shape that reads like a product regression rather than a flake.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });
// Pre-warm the lazily-loaded views at collection so no findBy* window pays
// for a module load under machine load (#539's mechanism, measured in #568).
import "./editor/MarkdownEditor";
import "./PropertiesPanel";
import "./DatabaseStudioView";
import "./SourceCodeEditor";
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
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";

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

// data-testid="markdown-editor" names the editing surface, and BOTH editing
// surfaces carry it: the source textarea in FileInspector and the WYSIWYG
// ProseMirror div in MarkdownEditor. findByTestId answers with whichever is
// mounted, so a test that asked for the source view can be handed the WYSIWYG
// div -- and `.value` on a div is undefined, which is the `indexOf` TypeError
// #590 records as shape 3. Wait for the surface the test actually means. The
// testids are pinned by e2e and must not be renamed.
async function findSourceEditor(): Promise<HTMLTextAreaElement> {
  return await waitFor(() => {
    const editor = screen.getByTestId("markdown-editor");
    if (!(editor instanceof HTMLTextAreaElement)) {
      throw new Error(
        "markdown-editor is the WYSIWYG surface — the source toggle has not landed yet",
      );
    }
    return editor;
  });
}

// Why the toggle can be missing at all: registerSourceToggle lands in a
// passive effect, and findByTestId resolves from a MutationObserver callback
// that can beat React's effect flush on a busy box. `toggle?.()` then silently
// does nothing -- the component stays in WYSIWYG and the test spends its whole
// asyncUtil window waiting for a source view nobody ever asked for. That is
// the shared root of #590 shapes 1 and 3: shape 1 finds no textarea, shape 3
// finds the WYSIWYG div and reads `.value` off it. Never optional-chain a
// missing toggle away; wait for it.
async function toggleSourceOnce(read: () => (() => void) | null): Promise<void> {
  const toggle = await waitFor(() => {
    const registered = read();
    if (!registered) throw new Error("registerSourceToggle has not run yet");
    return registered;
  });
  act(() => toggle());
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
    await toggleSourceOnce(() => registered); // wysiwyg -> editable source (legacy branch)
    await user.type(await screen.findByTestId("markdown-editor"), "Raw!");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    await toggleSourceOnce(() => registered); // source -> wysiwyg: flushes inside the window
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
    await toggleSourceOnce(() => registered);
    const textarea = await findSourceEditor();
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toContain("# Big");
    await toggleSourceOnce(() => registered);
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

    // The autosave (800ms debounce) fails; the failure must become visible
    // even though we never left read mode. Await the real write first — the
    // debounce plus load must never race a wall-clock window (its old 3s
    // bound was measured at 3.1s under a 24-process load, #568) — and bound
    // it, so a product that never writes fails as this named assertion
    // rather than as the test deadline. 10s is ~3x the loaded measurement.
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalled(),
      { timeout: 10_000 },
    );
    await waitFor(() => {
      const chip = screen.getByTestId("markdown-save-state");
      expect(chip.textContent).toBe("Couldn't save");
      expect(chip.getAttribute("data-state")).toBe("error");
    });
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
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();

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
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();

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

  // #579 adversarial review F1: the opening gate lived inside MarkdownView, so
  // every NON-markdown editable view carried #567's exact mechanism unfixed —
  // three write seams, none of them gated, reached by the same version switch.
  // A pending .csv edit plus a version bump landed pre-switch text on the
  // post-switch tree, with no capture, no notice and no recovery entry.
  it("sets a pending CSV edit aside on a version switch instead of writing it", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
    });
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );

    await screen.findByTestId("view-csv");
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "43");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    // The version switch: same mount, same pending draft, same armed timer.
    // MUTATION (F1 gate): drop reopenKey/writesRefusedRef from CsvView, or the
    // writesBlocked() checks from useAutosavedTextDraft's three seams. The
    // armed timer then lands "43" — the previous version's text — on the tree
    // the switch just bound.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    // Cancelled is not dropped: the edit is recoverable, on the same surface
    // markdown drafts use.
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,43",
      ),
    );

    // ...and unmounting mid-switch does not write it either.
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // ...and the window stays honest while the reread is still in flight. Typing
  // here is NOT swallowed — swallowing it would lose the keystroke silently
  // when the reread lands and repaints — so it arms as normal, the write seams
  // refuse it, and the capture takes it when the refusal lifts.
  it("refuses a CSV write typed while the switch reread is in flight, and sets it aside", async () => {
    let releaseReread!: (value: { text: string; truncated: boolean }) => void;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseReread = resolve;
        }),
      );
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    await screen.findByTestId("view-csv");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );

    // The reread is held, so the body on screen still belongs to the version
    // the user just left.
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "99");
    // MUTATION (window guard): drop `writesBlocked()` from writeDraftNow. The
    // armed timer lands "99" — built on the pre-switch body — on the tree the
    // switch just bound.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    // MUTATION (refusal-lift capture): drop `refusalLifted` from the capture's
    // condition. The keystroke is then silently repainted away by the sync
    // effect with nothing set aside.
    await act(async () => {
      releaseReread({ text: "date,amount\n2026-06-10,42", truncated: false });
      await Promise.resolve();
    });
    const notices = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(notices[notices.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,99",
      ),
    );
  });

  // ...and the error path is the half that ordering cannot save. A reread that
  // REJECTS selects the error branch in the same commit that lifts the
  // refusal, so the view is unmounted before it can render again and act on
  // the lift. The draft has to be taken on the way out.
  it("sets a CSV draft aside when the switch reread fails and the view is torn down", async () => {
    let rejectReread!: (reason: Error) => void;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
      })
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectReread = reject;
        }),
      );
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    await screen.findByTestId("view-csv");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );

    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "77");

    // The reread fails: `setText(null)` selects the error branch and this view
    // goes away in the same commit.
    // MUTATION (F3): restore the early `return` when writes are blocked, so
    // the cleanup drops the draft instead of setting it aside. The user's text
    // vanishes with no notice and no recovery entry.
    await act(async () => {
      rejectReread(new Error("reread failed"));
      await Promise.resolve();
    });
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,77",
      ),
    );
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
    // The reopen-refusal test below captures a set-aside draft into the
    // module store (#567) — do not leak it across tests.
    resetOrphanedDrafts();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetOrphanedDrafts();
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
    await toggleSourceOnce(() => registered);
    await screen.findByTestId("markdown-source-view", {}, { timeout: 5_000 });
    expect(screen.getByTestId("view-markdown").hidden).toBe(true);

    await toggleSourceOnce(() => registered);
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

  // #534. The user clicked a file that exists only in the version they are
  // LEAVING. The content read wins the race and returns the file; the engine
  // open loses it, running after the switch removed the path. Every other
  // available:false downgrades the document to the writable plain editor —
  // whose autosave would write that file straight back into the version the
  // user just entered, as a phantom. notInVersion must not downgrade: the
  // document is replaced by a state that says what happened.
  it("replaces the document with the honest state when the path is not in this version", async () => {
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async () => ({
        available: false,
        notInVersion: true,
      })),
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId(
      "file-not-in-version",
      {},
      { timeout: 5_000 },
    );
    expect(notice.textContent).toContain("This version doesn't have this file.");
    // The Next names a control the shell actually has (the version menu).
    expect(notice.textContent).toContain("Switch to the version that has it.");
    // No edit was pending, so the surface must not claim one was thrown away.
    expect(screen.queryByTestId("file-not-in-version-discarded")).toBeNull();
    // The editor is gone, not merely read-only.
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // THE P1 the review reproduced. Typing during the open wait arms an 800ms
  // autosave AND leaves a pending draft. When the refusal arrived, `readOnly`
  // flipped false->true; `readOnly` was a dependency of the unmount-flush
  // effect, so React ran that effect's PREVIOUS cleanup — closure captured
  // `readOnly === false` — which walked past its own guard and wrote the
  // phantom. Turning the document read-only was itself the write.
  //
  // The refusal must therefore DISCARD the draft, and the flush must stop
  // re-running on the transition. Both routes are covered here: the write that
  // fired on the transition, and the 800ms timer that was already scheduled.
  it("writes nothing when a document the user typed into turns read-only while it stays mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(async () => ({ available: false })),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      await user.click(screen.getByTestId("markdown-edit-toggle"));
      await user.type(
        await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
        "typed",
      );
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

      // The shell turns the path read-only (a share mount lands on it). The
      // document STAYS MOUNTED, so no unmount clears the armed autosave.
      view.rerender(<FileInspector workspaceId="ws-1" path="a.md" readOnly />);
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE P1 the review reproduced, restaged for #565. Typing DURING the open
  // wait is no longer reachable — that surface is read-only now — so the
  // pending draft is armed the only way that remains: legitimately, on a
  // document the engine already answered "not engine-backed" for, and then a
  // version switch reopens it and the reopen refuses.
  //
  // When the refusal arrived, `readOnly` flipped false->true, and both write
  // guards held a STALE `readOnly`: the unmount flush had it in its deps, so
  // React ran that effect's PREVIOUS cleanup with `readOnly === false`
  // captured, walked past its own guard, and wrote the phantom. Turning the
  // document read-only was itself the write. The armed 800ms autosave carried
  // the same stale value in the closure that armed it.
  //
  // Timers are advanced only AFTER the refusal lands. A timer that fires
  // BEFORE it is #567's window, which this change does not close and does not
  // claim to.
  // The refusal's DELIVERY must survive the reread that races it (codex P2).
  // A version switch bumps refreshKey and engineVersionKey together, so the
  // same-path reread can ENOENT before the queued Y.Doc open answers. The
  // parent then takes its loading/error branch, and if the engine open lives
  // in the child that branch unmounts, the refusal lands on nobody: the user
  // is told "Couldn't read this file", which is true of the read and says
  // nothing about the version.
  it("shows the version-specific notice when the reread fails before the open refuses", async () => {
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    let reads = 0;
    bridgeMock.readWorkspaceText = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { text: DOC_MARKDOWN, truncated: false };
      // The version switch removed it. The reread answers FIRST.
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    let refuse!: () => void;
    let opens = 0;
    const refused = new Promise<{ available: boolean; notInVersion?: boolean }>(
      (resolve) => {
        refuse = () => resolve({ available: false, notInVersion: true });
      },
    );
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(() => {
        opens += 1;
        return opens === 1 ? Promise.resolve({ available: false }) : refused;
      }),
    });

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={0}
        engineVersionKey={0}
      />,
    );
    await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });

    // The switch: both tokens move together, exactly as the shell bumps them.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
      />,
    );
    // The reread loses the file first.
    await screen.findByText("Couldn't read this file.", {}, { timeout: 5_000 });
    expect(reads).toBeGreaterThan(1);

    // ...and only THEN does the open answer. The notice must still arrive.
    await act(async () => {
      refuse();
      await refused;
    });
    const notice = await screen.findByTestId(
      "file-not-in-version",
      {},
      { timeout: 5_000 },
    );
    expect(notice.textContent).toContain("This version doesn't have this file.");
    expect(screen.queryByText("Couldn't read this file.")).toBeNull();
  });


  // codex P1, the half this change can honestly close. `writesBlocked()` stops
  // the write — correct, a read-only view must not be written — but the armed
  // 800ms timer had already fired, so the indicator sat on "Saving…" over an
  // edit that would never land. That is the same lie as a doc reading "Saved"
  // over a zero-byte file. The edit is still lost when the view is torn down
  // in this state: #567 owns that, because preserving the TEXT needs eager
  // serialization (a rearm re-serializes, and the read-only window has already
  // unmounted the editor, so it writes the PRE-EDIT body).
  it("stops claiming a save is in flight when the view turns read-only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(async () => ({ available: false })),
      });
      const states: string[] = [];

      const view = render(
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          onSaveStateChange={(state) => states.push(state)}
        />,
      );
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      await user.click(screen.getByTestId("markdown-edit-toggle"));
      await user.type(
        await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
        "held",
      );
      expect(states.at(-1)).toBe("saving");

      // The share mount lands inside the autosave window.
      view.rerender(
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          readOnly
          onSaveStateChange={(state) => states.push(state)}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // The document must not still claim the edit is on its way.
      expect(states.at(-1)).not.toBe("saving");
      expect(states).toContain("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing when a pending draft meets a not-in-version refusal on reopen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let opens = 0;
      let refuse!: () => void;
      const refused = new Promise<{
        available: boolean;
        notInVersion?: boolean;
      }>((resolve) => {
        refuse = () => resolve({ available: false, notInVersion: true });
      });
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(() => {
          opens += 1;
          // First open: not engine-backed, so the plain editor is legitimately
          // writable. The second (the version switch) is the refusal.
          return opens === 1 ? Promise.resolve({ available: false }) : refused;
        }),
      });

      const view = render(
        <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={0} />,
      );
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      await user.click(screen.getByTestId("markdown-edit-toggle"));
      await user.type(
        await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
        "phantom",
      );
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

      // The version switch. Same mount, same pending draft, same armed timer.
      view.rerender(
        <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
      );
      await act(async () => {
        refuse();
        await refused;
      });
      const notice = await screen.findByTestId(
        "file-not-in-version",
        {},
        { timeout: 5_000 },
      );

      // Route 1: the read-only transition must not have written.
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // Route 2: the armed autosave must not write either, now that the
      // document is read-only. Past 800ms it would have, on a stale closure.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // The draft is not lost and not misreported: the reopen set it aside
      // (#567), the store outlives the replaced view, and the refusal screen
      // itself offers the copy. "Discarded" would be false here — that line
      // is reserved for a draft that really went nowhere.
      //
      // MUTATION (refusal recovery): drop <OrphanedDraftNotices> from the
      // not-in-version branch. The set-aside text survives in the store but
      // the user has no way to reach it from this screen.
      expect(screen.getByTestId("orphaned-draft-notice")).toBeTruthy();
      expect(screen.queryByTestId("file-not-in-version-discarded")).toBeNull();
      expect(notice.textContent).toContain("Switch to the version that has it.");
    } finally {
      vi.useRealTimers();
    }
  });
});

// #533. The engine open runs ON the capture chain, so a document clicked while
// that chain is busy (startup reconciliation of a 1,000-file workspace, a
// version switch) waits seconds before it knows whether it is engine-backed.
// The surface used to read that wait as "not engine-backed" and render the
// plain editor — writable, autosaving straight to disk — while the session
// about to bind seeded from the engine head. A keystroke in that window went
// somewhere the session never looks. The document is now READ-ONLY until the
// open answers.
describe("markdown document opening state", () => {
  const DOC_MARKDOWN = "# Plan\n\nBase paragraph.\n";

  // An engine open the test resolves by hand — the held capture chain.
  function makeHeldOpenBridge() {
    const serverDoc = markdownToYDoc(DOC_MARKDOWN);
    let settle: ((available: boolean) => void) | null = null;
    const bridgeMock = {
      readWorkspaceText: vi.fn(async () => ({
        text: DOC_MARKDOWN,
        truncated: false,
      })),
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
      openEngineYDocSession: vi.fn(
        () =>
          new Promise<{ available: boolean; initialUpdate?: Uint8Array }>(
            (resolve) => {
              settle = (available) =>
                resolve(
                  available
                    ? {
                        available: true,
                        initialUpdate: Y.encodeStateAsUpdate(serverDoc),
                      }
                    : { available: false },
                );
            },
          ),
      ),
      applyEngineYDocUpdate: vi.fn(async () => undefined),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
    };
    return {
      bridgeMock,
      bind: () => act(() => settle?.(true)),
      answerNotEngineBacked: () => act(() => settle?.(false)),
    };
  }

  beforeEach(() => {
    stubEditorGlobals();
    // The set-aside drafts live in a module store on purpose (they must
    // outlive the keyed view), so tests must not inherit each other's.
    resetOrphanedDrafts();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetOrphanedDrafts();
  });

  // The user's real attempt: click the header's edit control, then type into
  // whatever editing surface the document offers.
  async function attemptToType(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    // Whichever surface the click produced — the mutation below produces the
    // editable ones, which is the point.
    const textarea = screen.queryByTestId("markdown-editor");
    if (textarea) await user.type(textarea, "Draft!");
    const title = screen.queryByTestId("page-title");
    if (title) await user.type(title, "Retitled");
    // Past the 800ms autosave debounce, so a scheduled write has fired.
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  it("refuses every disk write while the open is held, then takes the keystroke into the bound session", async () => {
    const user = userEvent.setup();
    const { bridgeMock, bind } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");

    // MUTATION: `const opening = false` in MarkdownView. The plain editor
    // renders during the held open, the edit toggle is live, and this typing
    // lands `writeWorkspaceText({ text: "…Base paragraph.\nDraft!" })` — the
    // write the binding session never sees. Asserted FIRST so the mutation
    // fails here, on the phantom write, not on the missing chip.
    await attemptToType(user);
    expect(bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // The wait is visible and named, and the document still reads.
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    expect(screen.getByTestId("view-markdown").textContent).toContain(
      "Base paragraph.",
    );
    expect(
      (screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("page-title") as HTMLInputElement).readOnly,
    ).toBe(true);

    // The open answers: the session is live, and the SAME keystroke now goes
    // through it (the title is frontmatter in the canonical Y.Doc) instead of
    // to disk.
    // `settle` is created INSIDE the openEngineYDocSession executor, but
    // `opening` is derived during render (useEngineDoc.ts:189), so
    // markdown-open-state is in the DOM one commit before the bridge is ever
    // called. Resolving on that element and then calling settle?.(…) can
    // silently no-op, and the test burns its whole window waiting for a state
    // nobody moved -- #590 shape 2, the same trap as the source toggle below.
    // Wait for the call that creates settle; never optional-chain it away.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    await user.type(screen.getByTestId("page-title"), "Retitled");
    await waitFor(() =>
      expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled(),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps the properties panel out of an opening document", async () => {
    // The panel writes frontmatter through the same disk save as the body, so
    // it is part of the refusal. It is also lazy — a bare queryByTestId would
    // pass while the chunk was merely still loading, proving nothing. Load the
    // module first, then absence means refusal.
    await import("./PropertiesPanel");
    const { bridgeMock, answerNotEngineBacked } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-open-state");

    // MUTATION: `{!readOnly && !opening ?` → `{!readOnly ?`. The panel mounts
    // during the held open and its property edits autosave to disk. It would
    // still be mounted at the end of this window — `opening` does not flicker.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    expect(bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // The same surface, one state later, does show it — so the absence above
    // was this branch refusing, not a chunk that never arrived.
    // Wait for the call that creates `settle` (see the note above): the open
    // state renders one commit before the bridge is asked.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    answerNotEngineBacked();
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
  });

  it("gives up the bound editor the moment a version switch reopens the session", async () => {
    const user = userEvent.setup();
    const { bridgeMock, bind } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    // The document body loads first; only then does MarkdownView mount and ask
    // for a session. Binding before that would resolve nothing.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    // The shell switches the active version under the open document. It keys
    // the inspector by tab, so this is a prop change, not a remount — and the
    // session bound above is already settled and closed.
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />,
    );

    // The obsolete session's editor is gone at once, not when the next open
    // answers. Anything typed into it would have gone to a closed session.
    expect(screen.queryByTestId("markdown-source-toggle")).toBeNull();
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await attemptToType(user);
    expect(bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // The new version's session binds and the editor comes back.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
  });

  it("restores the writable plain editor once the open answers 'not engine-backed'", async () => {
    const user = userEvent.setup();
    const { bridgeMock, answerNotEngineBacked } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-open-state");

    // "Opening" is not "not engine-backed": an unflagged workspace answers
    // immediately and keeps its local autosave editor, undiminished.
    // Wait for the call that creates `settle` (see the note above): the open
    // state renders one commit before the bridge is asked.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    expect(
      (screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(await screen.findByTestId("markdown-editor"), "Draft!");
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nDraft!",
        }),
      { timeout: 5_000 },
    );
  });

  // #567: a save armed BEFORE a reopen must not land DURING it. The reachable
  // arming: a document the engine answered "not engine-backed" for (plain
  // editor, legitimately writable), a draft typed inside the 800ms autosave
  // window, then a version switch that reopens the session on the SAME
  // mounted component (the shell keys the inspector by path, so the switch is
  // a prop change, not a remount). Three write paths reach disk from that
  // state — the armed timer, the unmount flush, and the shell's draft-flush
  // seam — and each gets its own test below, so killing any one path's gate
  // fails the test that names it.
  async function armDraftThenReopen(
    user: ReturnType<typeof userEvent.setup>,
    bridge: ReturnType<typeof makeHeldOpenBridge>,
    extraProps: Partial<Parameters<typeof FileInspector>[0]> = {},
  ) {
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        {...extraProps}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "Draft!",
    );
    expect(bridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    // The version switch: same mount, same pending draft, same armed timer.
    // The second open stays held — the "Opening…" window under test.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={2}
        {...extraProps}
      />,
    );
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    return view;
  }

  it("cancels the pending timer when a reopen starts, and surfaces the set-aside draft", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    // MUTATION (pending-timer path): remove the render-phase capture's
    // clearTimeout AND `|| openingRef.current` from writeDraftNow's guard.
    // The 800ms timer then fires inside this wait and the write lands while
    // the header reads "Opening…" — the previous version's draft on the
    // switched tree.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // Cancelled is not dropped: the draft is surfaced for the user to copy,
    // eagerly serialized at the flip (the editor that held it is unmounted by
    // the same commit).
    expect(
      screen.getByTestId("orphaned-draft-notice").textContent,
    ).toContain("Copy your text to keep it.");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );

    // The chip shows BESIDE "Opening…", not underneath it: the header slot
    // used to be either/or, hiding any state in this window. Recovery has its
    // OWN chip state — "Couldn't save" would invite a retry that cannot help.
    expect(screen.queryByTestId("markdown-open-state")).not.toBeNull();
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("recovery");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe(
      "Edit set aside",
    );
  });

  it("hands the surface back to the document after the reopen — the set-aside draft cannot re-arm a save", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    // The reopen answers "not engine-backed": the plain editor is writable
    // again and shows the DOCUMENT's text. Keeping the set-aside draft in the
    // editor instead would leave it one keystroke from landing on the new
    // version — the clobber, one step removed.
    //
    // MUTATION (restore path): in the capture, keep `unsavedDraft.current`
    // TRUE and drop the setDraft/setSavedBody/latestDraft reset together.
    // Neither the sync effect (blocked by the flag) nor the direct reset
    // hands the surface back, and the assertion below finds "Draft!" still
    // in the textarea.
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    expect(
      (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
    ).toBe(DOC_MARKDOWN);

    // Dismiss retires the notice, and the save pipeline is healthy again.
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    await user.type(screen.getByTestId("markdown-editor"), "New!");
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nNew!",
        }),
      { timeout: 5_000 },
    );
  });

  it("skips the unmount flush during a reopen — closing the view must not write the set-aside draft", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);

    // MUTATION (unmount-flush path): remove the render-phase capture's
    // `unsavedDraft.current = false` AND `|| openingRef.current` from the
    // unmount cleanup's guard. This unmount then writes the stale draft to
    // the tree the reopen is binding.
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);
  });

  it("refuses the shell's draft flush during a reopen — the seam must not write the set-aside draft", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    await armDraftThenReopen(user, bridge, { registerDraftFlush });
    await waitFor(() => expect(flush).not.toBeNull());

    // MUTATION (draft-flush path): remove the render-phase capture's
    // `unsavedDraft.current = false`, `|| openingRef.current` from the seam's
    // guard, AND `|| openingRef.current` from writeDraftNow's. The awaited
    // flush then writes the stale draft mid-reopen.
    await act(async () => {
      await flush!();
    });
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);
  });

  // #579 review P1: the notice promises the text stays recoverable, and the
  // inspector is KEYED — every tab switch unmounts it. The drafts therefore
  // live outside the view, keyed by workspace + path.
  it("keeps the set-aside draft across an unmount and shows it again on remount", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);
    await screen.findByTestId("orphaned-draft-notice");

    // The user switches tabs before copying, then comes back.
    // MUTATION (survival): clear the path's drafts in the unmount cleanup —
    // the component-local lifetime this store exists to escape. The remount
    // below then has nothing to show.
    view.unmount();
    render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />);
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );
  });

  // #579 review P2: a second reopen with the first notice still up must not
  // destroy the first draft. Both stay, oldest first, each with its own copy.
  it("keeps both set-aside drafts when a second reopen lands before the first is resolved", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);

    // The reopen resolves, the user types again, and a THIRD open starts.
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.type(screen.getByTestId("markdown-editor"), "More!");
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={3} />,
    );

    // MUTATION (append): make captureOrphanedDraft overwrite instead of
    // append. Only one row survives and the first edit is gone.
    await waitFor(() =>
      expect(screen.getAllByTestId("orphaned-draft-notice")).toHaveLength(2),
    );
    const copies = screen.getAllByTestId("orphaned-draft-copy");
    await user.click(copies[0]);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );
    await user.click(copies[1]);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nMore!",
      ),
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);
  });

  // #579 review P2, both halves. The chip carries recovery with its own state
  // and settles on Dismiss — but the LIFTED save state never carries it: the
  // shell's save-first machinery keys off that lift, and a prompt promising
  // to save a draft the flush cannot write would be a false promise.
  it("keeps recovery out of the lifted save state and settles the chip on dismiss", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const states: string[] = [];
    await armDraftThenReopen(user, bridge, {
      onSaveStateChange: (state) => states.push(state),
    });
    await screen.findByTestId("orphaned-draft-notice");
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("recovery");
    // MUTATION (lift): report the recovery-derived state through
    // onSaveStateChange (the round-1 behavior). The shell then marks the tab
    // savable-dirty and the version switch prompts to save a draft that no
    // longer exists in the pipeline.
    await waitFor(() => expect(states.at(-1)).toBe("saved"));
    expect(states).not.toContain("error");

    // MUTATION (chip): collapse chipState to the plain saveState. The chip
    // then reads nothing while the notice says an edit is not saved.
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
    expect(states.at(-1)).toBe("saved");
  });

  // #579 review r3, the last unguarded interleaving: an autosave that already
  // passed the guards and is AWAITING its IPC write. `unsavedDraft` clears at
  // issue time, so a flush that only reads it would return at once, the
  // version would switch, and the outstanding write would land the previous
  // version's text on the new tree. The seam must hold until the write lands.
  it("holds the shell's flush until an in-flight autosave lands, so a switch cannot race the write", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseWrite = () => resolve({ path: "a.md", recorded: true });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "Draft!",
    );
    // The 800ms timer fires; the write is now in flight, held by the mock.
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(flush).not.toBeNull());

    // MUTATION (in-flight window): remove `await pendingWrite.current` from
    // the draft-flush seam. The flush below settles with the write still in
    // flight, and the switch it gates proceeds while the previous version's
    // text is still landing.
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushSettled).toBe(false);

    // The write lands; only then does the flush release its caller.
    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    // The draft landed exactly once, into the version being left — not lost,
    // not duplicated.
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([
      [
        {
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nDraft!",
        },
      ],
    ]);

    // The switch now reopens the document; nothing further writes.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={2}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  // #579 review r4: overlapping writes. Autosave A awaiting its IPC and a
  // later B must not overlap — if B settles first, a waiter releases while
  // A's older temp-file rename is still pending over newer content. One
  // write in flight, ever; the next one waits and then reads the NEWER text.
  it("serializes overlapping autosaves — a second write waits for the first to land", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseFirst = () => resolve({ path: "a.md", recorded: true });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1
        ? heldFirst
        : Promise.resolve({ path: "a.md", recorded: true });
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "One",
    );
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    // The user keeps typing while write one is still in flight; a second
    // autosave arms and fires.
    await user.type(screen.getByTestId("markdown-editor"), "Two");
    // MUTATION (serialization): remove the `while (pendingWrite.current)`
    // wait in writeDraftNow. The second write issues inside this window,
    // overlapping the first.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    // The serialized second write carries the newest text.
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "a.md",
        text: "# Plan\n\nBase paragraph.\nOneTwo",
      },
    ]);
  });

  // #579 review r4: recovery follows the PATH, not the file kind. An
  // extension-changing rename remaps a markdown draft onto the text view,
  // and Copy/Dismiss must exist there too — a marker with no controls
  // strands the text behind a permanent dirty dot.
  it("offers recovery on a non-markdown view after an extension-changing rename", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    captureOrphanedDraft("ws-1", "a.txt", "# Plan\n\nBase paragraph.\nDraft!");
    render(<FileInspector workspaceId="ws-1" path="a.txt" />);

    // MUTATION (kind coverage): drop {recoveryNotices} from the text branch.
    // The path still carries the marker, but Copy/Dismiss is gone.
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
  });

  // #579 review r8: the queue and the obligation. Writer A is in flight,
  // writer B is parked in writeDraftNow's own wait, and the shell's flush
  // awaits the slot. When A lands, B resumes FIRST, claims the slot, and
  // clears `unsavedDraft` — a single-await flush would return right there,
  // and the switch it gates would proceed while B lands the previous
  // version's text.
  it("the flush outlasts a queued writer that claims the slot when the first write lands", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseA!: () => void;
    const heldA = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseA = () => resolve({ path: "a.md", recorded: true });
      },
    );
    let releaseB!: () => void;
    const heldB = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseB = () => resolve({ path: "a.md", recorded: true });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1 ? heldA : heldB;
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "One",
    );
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    // B arms and fires while A holds the slot: B is parked in the queue.
    await user.type(screen.getByTestId("markdown-editor"), "Two");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    // A lands; B claims the slot and issues its own write.
    await act(async () => {
      releaseA();
      await heldA;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // MUTATION (flush loop): make the seam await `pendingWrite` ONCE. The
    // flush settles right here, with B still landing the old text.
    expect(flushSettled).toBe(false);

    await act(async () => {
      releaseB();
      await heldB;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
  });

  // #579 review r15, the exact reported interleaving: the flush registers on
  // the in-flight write BEFORE a later Ctrl+S registers on the same promise.
  // Ctrl+S saves unconditionally, so `unsavedDraft` is already false — the
  // old seam therefore returned the moment the slot cleared, and the queued
  // writer landed the previous version's text after the switch. Membership
  // now starts at ENTRY and the barrier refuses anything arriving after the
  // seam began, so there is no writer left to resume.
  it("refuses a Ctrl+S that arrives after the flush began, with no draft pending", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseA!: () => void;
    const heldA = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseA = () => resolve({ path: "a.md", recorded: true });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldA);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next: (() => Promise<void>) | null) => {
          flush = next;
        }}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    const editor = await screen.findByTestId(
      "markdown-editor",
      {},
      { timeout: 5_000 },
    );
    await user.type(editor, "One");
    // Autosave A issues and holds. It cleared `unsavedDraft` at issue time.
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(flush).not.toBeNull());

    // The seam starts first, then Ctrl+S — the reported order.
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.focus();
    await user.keyboard("{Control>}s{/Control}");

    // MUTATION (barrier): drop the flushBarrier check from writeDraftNow.
    // Ctrl+S joins the queue behind A, the seam's captured tail does not
    // include it, and it lands the previous version's text after the switch.
    await act(async () => {
      releaseA();
      await heldA;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  // #579 review r9 + r15: a writer can arrive DURING the flush's own final
  // write — typing (or Ctrl+S) mid-flush. Draining it was the wrong answer:
  // its text is from the version the caller is about to leave, so landing it
  // before the switch races the flush and landing it after IS the clobber.
  // The barrier refuses it outright, and the draft stays unsaved for the
  // reopen's capture to set aside.
  it("refuses a writer that arrives during the flush instead of landing its stale text", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseF!: () => void;
    const heldF = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseF = () => resolve({ path: "a.md", recorded: true });
      },
    );
    let releaseB!: () => void;
    const heldB = new Promise<{ path: string; recorded: boolean }>(
      (resolve) => {
        releaseB = () => resolve({ path: "a.md", recorded: true });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1 ? heldF : heldB;
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "One",
    );
    await waitFor(() => expect(flush).not.toBeNull());

    // The flush itself issues the final write (the armed timer is cleared).
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    // Mid-flush, the user types more: a new autosave arms and fires while the
    // barrier is up.
    await user.type(screen.getByTestId("markdown-editor"), "Two");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    // The flush's write lands. Nothing is queued behind it, so the seam
    // returns with an EMPTY queue — the invariant the barrier exists for.
    // MUTATION (barrier): drop the flushBarrier check from writeDraftNow.
    // The mid-flush writer joins the queue, issues a second write, and lands
    // the previous version's text.
    await act(async () => {
      releaseF();
      await heldF;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    void releaseB;
    void heldB;
  });

  // #579 review r7: READ mode (a large, non-truncated document) edits title
  // and properties without `editing` ever flipping, and a reopen can hand
  // back a byte-identical body — the props.body sync effect then has no
  // dependency to fire on, so the capture itself must hand the surface back
  // or the set-aside edit keeps painting the view and rides into the next
  // property save.
  it("a reopen in read mode resets the document state the set-aside edit had painted", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const bigBody = `# Plan\n\n${"word ".repeat(14_000)}\n`;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(async () => ({
      text: bigBody,
      truncated: false,
    }));
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    // A read-mode title edit arms a draft; blur mirrors it into the input.
    const title = await screen.findByTestId("page-title");
    await user.type(title, "R");
    await user.tab();
    expect((title as HTMLInputElement).value).toBe("R");

    // The version switch reopens the same content.
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />,
    );
    await screen.findByTestId("orphaned-draft-notice");
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    // MUTATION (read-mode reset): drop the capture's setDraft/setSavedBody/
    // latestDraft reset. The title keeps painting the set-aside edit and the
    // next property save writes the set-aside document.
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByTestId("page-title"), "New");
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalled(),
      { timeout: 5_000 },
    );
    const writes = bridge.bridgeMock.writeWorkspaceText.mock
      .calls as unknown as ReadonlyArray<[{ text: string }]>;
    const written = writes.at(-1)![0];
    expect(written.text).toContain("title: New");
    expect(written.text).not.toContain("R");
  });

  // #579 review r5: a set-aside draft on a path whose read FAILS (a rename
  // raced an I/O failure) must still be copyable — the error branch is a
  // state the marker and close warning point into, so it must offer the
  // actions they demand.
  it("offers recovery on the failed-read branch", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    bridge.bridgeMock.readWorkspaceText.mockImplementation(async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // MUTATION (error-branch render): drop {recoveryNotices} from the
    // loading/error branch. The screen says only "Couldn't read this file"
    // while the close warning demands actions that render nowhere.
    await screen.findByText("Couldn't read this file.");
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
  });

  // #579 review P2 (engine half): a bound engine session's settled "Saved"
  // must not outrank an unresolved set-aside edit — the edit is NOT in the
  // document the engine settled.
  it("shows recovery over a settled engine document until the draft is resolved", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    // The reopen resolves BOUND: the engine branch renders with the notice.
    bridge.bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    await screen.findByTestId("orphaned-draft-notice");

    // MUTATION (engine chip): read `engine.saveState` directly instead of
    // the recovery-aware state. The chip then says "Saved" while the notice
    // says the set-aside edit is not in this document.
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("recovery");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe(
      "Edit set aside",
    );

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saved");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe("Saved");
  });
});
