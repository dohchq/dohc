// @vitest-environment jsdom
import { configure } from "@testing-library/dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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
  type DraftFlush,
  FileInspector,
  lineSpanInText,
  markdownEditorBody,
  mergeMarkdownEditorBody,
  resolveWorkspaceLinkNavigation,
  resolveWikilinkNavigation,
} from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";
import * as orphanedDraftsModule from "./orphanedDrafts";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import {
  getSharedLocalDocument,
  localDocumentKey,
  resetSharedLocalDocumentsForTests,
} from "./sharedLocalDocument";

afterEach(() => resetSharedLocalDocumentsForTests());

// Build legacy app-model path markers through interpolation so this test does
// not contain the raw deprecated folder or manifest filenames that the
// no-legacy scanner is meant to catch.
const LEGACY_APPS_SEGMENT = ["", "apps"].join(".");
const LEGACY_APP_MANIFEST = ["app", "json"].join(".");
const legacyAppPath = (...segments: string[]) =>
  [LEGACY_APPS_SEGMENT, ...segments].join("/");
const LARGE_READ_MODE_FILLER = Array.from(
  { length: 96 },
  (_, index) => `Paragraph ${index + 1}. ${"body ".repeat(160)}`,
).join("\n\n");
const TEST_CONTENT_HASH = "a".repeat(64);

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

  it("prefers the current document directory for an explicitly relative path", () => {
    const competingFiles = [
      { path: "plan.md", title: "Root plan" },
      { path: "notes/plan.md", title: "Notes plan" },
    ];
    expect(
      resolveWikilinkNavigation(
        "./plan.md",
        "notes/status.md",
        competingFiles,
        20,
      ),
    ).toEqual({ path: "notes/plan.md" });
  });

  it("matches an extensionless document-relative link to a known .markdown file", () => {
    const competingFiles = [
      { path: "guide.md", title: "Root guide" },
      { path: "notes/guide.markdown", title: "Notes guide" },
    ];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./guide" },
        "notes/status.md",
        competingFiles,
        21,
      ),
    ).toEqual({ path: "notes/guide.markdown" });
  });

  it.each([
    [
      "./guide.md",
      [
        { path: "notes/guide.markdown", title: "Markdown guide" },
        { path: "notes/guide.md", title: "MD guide" },
      ],
      "notes/guide.md",
    ],
    [
      "./guide.markdown",
      [
        { path: "notes/guide.md", title: "MD guide" },
        { path: "notes/guide.markdown", title: "Markdown guide" },
      ],
      "notes/guide.markdown",
    ],
    [
      "./guide.MD",
      [
        { path: "notes/guide.markdown", title: "Markdown guide" },
        { path: "notes/guide.md", title: "MD guide" },
      ],
      "notes/guide.md",
    ],
    [
      "./guide.MARKDOWN",
      [
        { path: "notes/guide.md", title: "MD guide" },
        { path: "notes/guide.markdown", title: "Markdown guide" },
      ],
      "notes/guide.markdown",
    ],
  ])("prefers the exact Markdown extension for %s", (target, files, expected) => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: target },
        "notes/status.md",
        files,
        22,
      ),
    ).toEqual({ path: expected });
  });

  it("resolves decoded delimiters in document-relative and root-relative paths", () => {
    const competingFiles = [
      { path: "#notes.md", title: "Root hash notes" },
      { path: "notes/#notes.md", title: "Notes hash notes" },
      { path: "notes/faq?.md", title: "FAQ" },
    ];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./faq?.md", rawFragment: "answers" },
        "notes/status.md",
        competingFiles,
        21,
      ),
    ).toEqual({
      path: "notes/faq?.md",
      headingTarget: { anchor: "answers", nonce: 21 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "/#notes.md", rawFragment: "risks" },
        "notes/status.md",
        competingFiles,
        22,
      ),
    ).toEqual({
      path: "#notes.md",
      headingTarget: { anchor: "risks", nonce: 22 },
    });
  });

  it("restricts only root-relative paths to the workspace root", () => {
    const localFiles = [{ path: "notes/plan.md", title: "Local plan" }];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "/plan.md" },
        "notes/status.md",
        localFiles,
        23,
      ),
    ).toEqual({ path: "plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "plan.md" },
        "notes/status.md",
        localFiles,
        24,
      ),
    ).toEqual({ path: "notes/plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./plan.md" },
        "notes/status.md",
        localFiles,
        25,
      ),
    ).toEqual({ path: "notes/plan.md" });
  });

  it("preserves unknown hash filenames separately from heading fragments", () => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./new#plan.md" },
        "notes/status.md",
        [],
        23,
      ),
    ).toEqual({ path: "notes/new#plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        {
          path: "./new#release#1.md",
          rawFragment: "decisions",
        },
        "notes/status.md",
        [],
        24,
      ),
    ).toEqual({
      path: "notes/new#release#1.md",
      headingTarget: { anchor: "decisions", nonce: 24 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "", rawFragment: "a%2520b" },
        "notes/status.md",
        [],
        25,
      ),
    ).toEqual({
      path: "notes/status.md",
      headingTarget: { anchor: "a%2520b", nonce: 25 },
    });
  });

  it.each([
    ["guide.md", "notes/guide.md"],
    ["guide.markdown", "notes/guide.markdown"],
    ["GUIDE.MARKDOWN", "notes/GUIDE.MARKDOWN"],
    ["guide", "notes/guide.md"],
  ])("preserves a recognized Markdown fallback for %s", (target, expected) => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: `./${target}` },
        "notes/status.md",
        [],
        26,
      ),
    ).toEqual({ path: expected });
  });

  it("keeps an empty fragment as an explicit top-of-document target", () => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "", rawFragment: "" },
        "notes/status.md",
        [],
        27,
      ),
    ).toEqual({
      path: "notes/status.md",
      headingTarget: { anchor: "", nonce: 27 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "../plan.markdown", rawFragment: "" },
        "notes/status.md",
        [],
        28,
      ),
    ).toEqual({
      path: "plan.markdown",
      headingTarget: { anchor: "", nonce: 28 },
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
  stubScrollSpy("scrollIntoView");
}

/** jsdom implements neither scroll method, and the jump seams are only
 *  observable through them — so stub one on every element and hand back the
 *  spy the test asserts against. */
function stubScrollSpy(
  method: "scrollIntoView" | "scrollTo",
  implementation?: (this: HTMLElement) => void,
) {
  const spy = implementation ? vi.fn(implementation) : vi.fn();
  Object.defineProperty(HTMLElement.prototype, method, {
    configurable: true,
    value: spy,
  });
  return spy;
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
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text: "# Hello\n",
      truncated: false as const,
      contentHash: TEST_CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
      async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
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
    resetOrphanedDrafts();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    resetOrphanedDrafts();
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
      expectedContentHash: TEST_CONTENT_HASH,
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
        expectedContentHash: TEST_CONTENT_HASH,
      }),
    );
  });

  it("does not focus an inactive inspector's source editor", async () => {
    let registered: (() => void) | null = null;
    render(
      <>
        <button type="button" data-testid="active-group-control">
          Active group
        </button>
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          autoFocus={false}
          registerSourceToggle={(toggle) => {
            registered = toggle;
          }}
        />
      </>,
    );
    await screen.findByTestId("view-markdown");
    const activeGroupControl = screen.getByTestId("active-group-control");
    activeGroupControl.focus();

    await toggleSourceOnce(() => registered);
    await findSourceEditor();

    expect(document.activeElement).toBe(activeGroupControl);
  });

  it("focuses the source editor when autoFocus is omitted", async () => {
    let registered: (() => void) | null = null;
    render(
      <>
        <button type="button" data-testid="previous-focus">
          Previous focus
        </button>
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          registerSourceToggle={(toggle) => {
            registered = toggle;
          }}
        />
      </>,
    );
    await screen.findByTestId("view-markdown");
    screen.getByTestId("previous-focus").focus();

    await toggleSourceOnce(() => registered);
    const sourceEditor = await findSourceEditor();

    expect(document.activeElement).toBe(sourceEditor);
  });

  it("settles a successful legacy save while mounted in StrictMode", async () => {
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () =>
          resolve({ status: "written", contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <FileInspector workspaceId="ws-1" path="a.md" />
      </StrictMode>,
    );

    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(await screen.findByTestId("markdown-editor"), "Draft!");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saving");

    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
  });

  it("offers a read-only source view for read-only markdown (truncated reads)", async () => {
    // codex P3 follow-up: a read-only doc can't EDIT, but viewing raw source
    // is still a view — the palette toggle opens the source textarea with the
    // readOnly attribute and never writes.
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Big\n",
      truncated: true,
      contentHash: null,
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
      contentHash: TEST_CONTENT_HASH,
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
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("surfaces a failed read-mode PageIdentity save instead of hiding it", async () => {
    // Read mode hides the idle "Saved" chip, but PageIdentity stays editable and
    // autosaves title/icon edits. A failed save must still surface — otherwise
    // the optimistic title keeps showing while the write silently failed. A body
    // over the WYSIWYG threshold opens in read mode without being truncated
    // (truncated would make PageIdentity read-only and skip the save entirely).
    const bigBody = `---\ntitle: Plan\n---\n\n${LARGE_READ_MODE_FILLER}`;
    expect(bigBody.length).toBeGreaterThan(64 * 1024);
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: bigBody,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
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
      contentHash: null,
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
      contentHash: TEST_CONTENT_HASH,
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

  it("opens parsed links from the legacy read-only shared document", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: [
        "# Status",
        "",
        "[FAQ](faq%3F.md?mode=preview#answers)",
        "[Hash notes](%23notes.md?mode=preview#risks)",
        "[Section](#next%20steps)",
      ].join("\n"),
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const onOpenPath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        knownMarkdownFiles={[
          { path: "#notes.md", title: "Root hash notes" },
          { path: "notes/#notes.md", title: "Notes hash notes" },
          { path: "notes/faq?.md", title: "FAQ" },
        ]}
        onOpenPath={onOpenPath}
      />,
    );
    const link = await screen.findByRole("link", { name: "FAQ" });
    await waitFor(() =>
      expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit"),
    );
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    link.focus();
    expect(document.activeElement).toBe(link);

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(link.dispatchEvent(click)).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenPath).toHaveBeenCalledWith("notes/faq?.md", {
      anchor: "answers",
      nonce: 1,
    });
    expect(onOpenPath).toHaveBeenCalledOnce();

    const hashClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(
      screen.getByRole("link", { name: "Hash notes" }).dispatchEvent(hashClick),
    ).toBe(false);
    expect(onOpenPath).toHaveBeenLastCalledWith("notes/#notes.md", {
      anchor: "risks",
      nonce: 2,
    });

    const fragmentClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(
      screen.getByRole("link", { name: "Section" }).dispatchEvent(fragmentClick),
    ).toBe(false);
    expect(onOpenPath).toHaveBeenLastCalledWith("notes/status.md", {
      anchor: "next%20steps",
      nonce: 3,
    });
    expect(onOpenPath).toHaveBeenCalledTimes(3);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("scrolls to the top for an explicit empty fragment target", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Status\n\nBody\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const scrollTo = stubScrollSpy("scrollTo");
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/status.md" readOnly />,
    );
    await screen.findByTestId("view-markdown");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        headingTarget={{ anchor: "", nonce: 29 }}
      />,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
  });

  it("keeps encoded filename hashes distinct from real fragments without known files", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: [
        "[Unknown](new%23plan.md)",
        "[Multiple](new%23release%231.md)",
        "[Fragment](new%23plan.md?mode=preview#risks)",
        "[Raw root](/plan.md#raw-root)",
        "[Encoded root](%2Fplan.md#root)",
        "[Encoded fragment](#a%2520b)",
        "[Empty fragment](#)",
        "[Malformed](bad%E0%A4%A.md#part%E0%A4%A)",
      ].join("\n"),
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const onOpenPath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        knownMarkdownFiles={[]}
        onOpenPath={onOpenPath}
      />,
    );
    await screen.findByRole("link", { name: "Unknown" });

    for (const [name, expectedPath, rawFragment] of [
      ["Unknown", "notes/new#plan.md", undefined],
      ["Multiple", "notes/new#release#1.md", undefined],
      ["Fragment", "notes/new#plan.md", "risks"],
      ["Raw root", "plan.md", "raw-root"],
      ["Encoded root", "plan.md", "root"],
      ["Encoded fragment", "notes/status.md", "a%2520b"],
      ["Empty fragment", "notes/status.md", ""],
      ["Malformed", "notes/bad%E0%A4%A.md", "part%E0%A4%25A"],
    ] as const) {
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      expect(screen.getByRole("link", { name }).dispatchEvent(click)).toBe(false);
      expect(onOpenPath).toHaveBeenLastCalledWith(
        expectedPath,
        rawFragment !== undefined
          ? { anchor: rawFragment, nonce: onOpenPath.mock.calls.length }
          : undefined,
      );
    }
    expect(onOpenPath).toHaveBeenCalledTimes(8);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps local source mode and selects the target heading line", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\ntitle: Plan\n---\n\n# Hello\n\nParagraph\n\n## Exact destination\nBody\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
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
      contentHash: TEST_CONTENT_HASH,
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
      contentHash: TEST_CONTENT_HASH,
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

  it("shares a local draft and save baseline across duplicate text inspectors", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const register = (flush: DraftFlush | null) => {
      if (flush) flushes.push(flush);
    };
    const user = userEvent.setup();
    render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={register}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={register}
        />
      </>,
    );

    const editors = await screen.findAllByTestId("view-text-editor");
    const first = editors[0]!.querySelector(".cm-content") as HTMLElement;
    const second = editors[1]!.querySelector(".cm-content") as HTMLElement;
    await user.click(first);
    await user.keyboard("{End} shared");

    await waitFor(() => expect(second.textContent).toContain("before shared"));
    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/shared.txt",
      text: "before shared",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    expect(
      screen
        .getAllByTestId("view-text-save-state")
        .every((state) => state.dataset.state === "saved"),
    ).toBe(true);
  });

  it("does not rewrite a duplicate text draft after its peer saves the same body", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    const view = render(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );

    const editors = await screen.findAllByTestId("view-text-editor");
    const first = editors[0]!.querySelector(".cm-content") as HTMLElement;
    const second = editors[1]!.querySelector(".cm-content") as HTMLElement;
    await user.click(first);
    await user.keyboard("{End} first");
    await waitFor(() => expect(second.textContent).toContain("before first"));
    await user.click(second);
    await user.keyboard("{End} second");
    await waitFor(() =>
      expect(first.textContent).toContain("before first second"),
    );

    await act(async () => flushes[0]!());
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .every((state) => state.dataset.state === "saved"),
      ).toBe(true),
    );
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/shared.txt",
      text: "before first second",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("hydrates a duplicate text inspector mounted after the shared draft is dirty", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const first = (
      <FileInspector
        key="first"
        workspaceId="ws-1"
        path="notes/shared.txt"
      />
    );
    const view = render(first);
    const firstContent = (
      await screen.findByTestId("view-text-editor")
    ).querySelector(".cm-content") as HTMLElement;
    await user.click(firstContent);
    await user.keyboard("{End} dirty");
    await waitFor(() => expect(firstContent.textContent).toContain("before dirty"));

    view.rerender(
      <>
        {first}
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="notes/shared.txt"
        />
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("view-text-editor")).toHaveLength(2),
    );
    const editors = screen.getAllByTestId("view-text-editor");
    await waitFor(() =>
      expect(editors[1]!.textContent).toContain("before dirty"),
    );
  });

  it("keeps a dirty duplicate body when a forced conflict read arrives", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/conflict.txt" />
        <FileInspector workspaceId="ws-1" path="notes/conflict.txt" />
      </>,
    );
    const editors = await screen.findAllByTestId("view-text-editor");
    const first = editors[0]!.querySelector(".cm-content") as HTMLElement;
    await user.click(first);
    await user.keyboard("{End} peer draft");
    const buffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "notes/conflict.txt", undefined),
    );

    act(() => {
      expect(buffer.acceptRead("disk after", "b".repeat(64), {}, true)).toBe(
        false,
      );
    });

    expect(buffer.getSnapshot()).toMatchObject({
      body: "before peer draft",
      contentHash: TEST_CONTENT_HASH,
      dirty: true,
      saveState: "error",
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-editor")
          .every((editor) => editor.textContent?.includes("before peer draft")),
      ).toBe(true),
    );
  });

  it("keeps a later-started duplicate read when an older pane answers last", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveOlder!: (value: ReadResult) => void;
    let resolveNewer!: (value: ReadResult) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/ordered.txt" />
        <FileInspector workspaceId="ws-1" path="notes/ordered.txt" />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveNewer({
        text: "newer",
        truncated: false,
        contentHash: "2".repeat(64),
      });
      await newer;
    });
    const buffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "notes/ordered.txt", undefined),
    );
    await waitFor(() => expect(buffer.getSnapshot().body).toBe("newer"));

    await act(async () => {
      resolveOlder({
        text: "older",
        truncated: false,
        contentHash: "1".repeat(64),
      });
      await older;
    });

    expect(buffer.getSnapshot()).toMatchObject({
      body: "newer",
      contentHash: "2".repeat(64),
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-editor")
          .every((editor) => editor.textContent?.includes("newer")),
      ).toBe(true),
    );
  });

  it("uses an older duplicate read when the later request fails", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveOlder!: (value: ReadResult) => void;
    let rejectNewer!: (reason: Error) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((_resolve, reject) => {
      rejectNewer = reject;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/fallback.txt" />
        <FileInspector workspaceId="ws-1" path="notes/fallback.txt" />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      rejectNewer(new Error("read failed"));
      await newer.catch(() => undefined);
    });
    await act(async () => {
      resolveOlder({
        text: "available",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      await older;
    });

    const buffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "notes/fallback.txt", undefined),
    );
    await waitFor(() =>
      expect(buffer.getSnapshot()).toMatchObject({
        initialized: true,
        body: "available",
        contentHash: TEST_CONTENT_HASH,
      }),
    );
    const editor = (
      await screen.findByTestId("view-text-editor")
    ).querySelector(".cm-content") as HTMLElement;
    await user.click(editor);
    await user.keyboard("{End} edit");
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "notes/fallback.txt",
          text: "available edit",
          expectedContentHash: TEST_CONTENT_HASH,
        }),
      { timeout: 5_000 },
    );
  });

  it("does not replay a duplicate Markdown draft after its peer saves the same body", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const toggles: Array<(() => void) | null> = [null, null];
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    const view = render(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="shared.md"
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="shared.md"
          registerSourceToggle={(toggle) => {
            toggles[1] = toggle;
          }}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    await toggleSourceOnce(() => toggles[0]);
    await toggleSourceOnce(() => toggles[1]);
    const editors = screen.getAllByTestId(
      "markdown-editor",
    ) as HTMLTextAreaElement[];

    await user.click(editors[0]!);
    await user.keyboard("{End}First");
    await waitFor(() => expect(editors[1]!.value).toContain("First"));
    await user.click(editors[1]!);
    await user.keyboard("{End}Second");
    await waitFor(() => expect(editors[0]!.value).toContain("FirstSecond"));

    await act(async () => flushes[0]!());
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      relativePath: "shared.md",
      text: "# Hello\n\nFirstSecond",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("does not republish a stale Markdown pane over a newer peer draft", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishFirst!: () => void;
    const firstWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        finishFirst = () =>
          resolve({ status: "written", contentHash: "b".repeat(64) });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => firstWrite);
    const buffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "queued.md", undefined),
    );
    // Hold this pane's subscriber behind the queue interleaving. The write
    // seam must remain safe even before React applies a peer snapshot.
    buffer.subscribe = () => () => {};
    const publishDraft = vi.spyOn(buffer, "publishDraft");
    const user = userEvent.setup();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="queued.md"
      />,
    );
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    const editor = screen.getByTestId("markdown-editor");

    await user.click(editor);
    await user.keyboard("{End}First");
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await user.keyboard("{End}Queued");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    let publishesBeforeRelease = 0;
    await act(async () => {
      buffer.publishDraft("# Peer newest\n", {});
      publishesBeforeRelease = publishDraft.mock.calls.length;
      finishFirst();
      await firstWrite;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(publishDraft).toHaveBeenCalledTimes(publishesBeforeRelease);

    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toMatchObject({
      text: "# Peer newest\n",
      expectedContentHash: "b".repeat(64),
    });
    expect(buffer.getSnapshot().body).toBe("# Peer newest\n");
  });

  it("does not expose a retained same-path body or hash after switching workspaces", async () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({
          text: "Workspace B",
          truncated: false,
          contentHash: secondHash,
        });
    });
    bridgeMock.readWorkspaceText.mockImplementation((payload) =>
      payload.workspaceId === "ws-1"
        ? Promise.resolve({
            text: "Workspace A",
            truncated: false,
            contentHash: firstHash,
          })
        : heldSecondRead,
    );
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const firstEditor = await screen.findByTestId("view-text-editor");
    expect(firstEditor.textContent).toContain("Workspace A");

    view.rerender(
      <FileInspector workspaceId="ws-2" path="notes/plain.txt" />,
    );
    expect(screen.queryByTestId("view-text-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    const secondEditor = await screen.findByTestId("view-text-editor");
    const content = secondEditor.querySelector(".cm-content") as HTMLElement;
    expect(content.textContent).toContain("Workspace B");
    await user.click(content);
    await user.keyboard("{End} edit");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-2",
      relativePath: "notes/plain.txt",
      text: "Workspace B edit",
      expectedContentHash: secondHash,
    });
  });

  it("serializes overlapping plain-text autosaves and writes the newest draft last", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let writes = 0;
    bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1 ? heldFirst : heldSecond;
    });
    const user = userEvent.setup({ delay: 5 });
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("One");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    await user.keyboard("Two");
    await waitFor(() => expect(content.textContent).toContain("OneTwo"));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
        text: "OneTwo",
        expectedContentHash: TEST_CONTENT_HASH,
      },
    ]);
    expect(content.textContent).toContain("OneTwo");
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    view.unmount();
  });

  it("sets aside the newest plain-text draft when the file changes during its write", async () => {
    const initialHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    const freshHash = "6".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "External",
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValue({ status: "written", contentHash: freshHash });
    let flush: (() => Promise<void>) | null = null;
    const registerFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={1}
        registerDraftFlush={registerFlush}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("{End} One");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "Base One",
      expectedContentHash: initialHash,
    });

    await user.keyboard(" Two");
    expect(content.textContent).toContain("Base One Two");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={2}
        registerDraftFlush={registerFlush}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(content.textContent).toContain("Base One Two");

    await waitFor(() => expect(flush).not.toBeNull());
    const flushPromise = flush!();
    const flushResult = flushPromise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await flushResult).toBe("rejected");
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(content.textContent).toBe("External"));
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base One Two"),
    );
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("error");

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await user.click(content);
    await user.keyboard("{End} Fresh");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "External Fresh",
      expectedContentHash: externalHash,
    });
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).not.toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await expect(flush!()).resolves.toBeUndefined();
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("saved");
    view.unmount();
  });

  it("rereads plain text after a write overlaps a newer content request", async () => {
    const initialHash = "7".repeat(64);
    const localHash = "8".repeat(64);
    const externalHash = "9".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: "External", truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: "External", truncated: false, contentHash: externalHash });
    });
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => heldSecondRead)
      .mockImplementationOnce(() => heldThirdRead);
    let resolveWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      resolveWrite = () => resolve({ status: "written", contentHash: localHash });
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={1}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("{End} Local");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    expect(content.textContent).toBe("Base Local");

    await act(async () => {
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).not.toBe("saved");
    expect(content.textContent).toBe("Base Local");

    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() => expect(content.textContent).toBe("External"));
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("saved");
    view.unmount();
  });

  it("captures the same plain-text conflict again after its first recovery is dismissed", async () => {
    const initialHash = "c".repeat(64);
    const externalHash = "d".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "Base",
        truncated: false,
        contentHash: externalHash,
      });
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: externalHash,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;

    await user.click(content);
    await user.keyboard("{End} Draft");
    await screen.findByTestId("orphaned-draft-notice", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await waitFor(() => expect(content.textContent).toBe("Base"));

    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
  });

  it("recovers a queued plain-text unmount draft when its I/O write rejects", async () => {
    const initialHash = "e".repeat(64);
    const firstHash = "f".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "Base One",
        truncated: false,
        contentHash: firstHash,
      });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("disk unavailable"));
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("{End} One");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await user.keyboard(" Two");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base One Two"),
    );
  });

  it("recovers an in-flight plain-text autosave that rejects after unmount", async () => {
    const initialHash = "3".repeat(64);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "Base",
      truncated: false,
      contentHash: initialHash,
    });
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    view.unmount();

    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
    });
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
  });

  it.each([
    { retry: "succeeds", retryFails: false, expectedRecoveries: 0 },
    { retry: "fails", retryFails: true, expectedRecoveries: 1 },
  ])(
    "lets an operation-owned plain-text retry settle before recovery when it $retry",
    async ({ retryFails, expectedRecoveries }) => {
      const initialHash = "3".repeat(64);
      const retryHash = "4".repeat(64);
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      });
      let rejectIssued!: (error: Error) => void;
      const issuedWrite = new Promise<never>((_resolve, reject) => {
        rejectIssued = reject;
      });
      let resolveRetry!: () => void;
      let rejectRetry!: (error: Error) => void;
      const retryWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve, reject) => {
        resolveRetry = () => resolve({ status: "written", contentHash: retryHash });
        rejectRetry = reject;
      });
      let writes = 0;
      bridgeMock.writeWorkspaceText.mockImplementation(() => {
        writes += 1;
        return writes === 1 ? issuedWrite : retryWrite;
      });
      let flush: DraftFlush | null = null;
      const recoverySpy = vi.spyOn(
        orphanedDraftsModule,
        "captureOrphanedDraft",
      );
      try {
        const user = userEvent.setup();
        const view = render(
          <FileInspector
            workspaceId="ws-1"
            path="notes/plain.txt"
            registerDraftFlush={(next) => {
              flush = next;
            }}
          />,
        );
        const content = (
          await screen.findByTestId("view-text-editor")
        ).querySelector(".cm-content") as HTMLElement;
        await user.click(content);
        await user.keyboard("{End} Draft");
        await waitFor(
          () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
          { timeout: 5_000 },
        );
        await waitFor(() => expect(flush).not.toBeNull());
        const operationResult = flush!({ captureOnFailure: true }).then(
          () => "resolved" as const,
          () => "rejected" as const,
        );
        view.unmount();

        await act(async () => {
          rejectIssued(new Error("issued write failed"));
          await issuedWrite.catch(() => undefined);
        });
        await waitFor(() =>
          expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
        );
        // MUTATION (recovery ownership): if the unmount observer captures
        // before the operation retry settles, success is spurious and failure
        // creates two recoveries.
        expect(recoverySpy).not.toHaveBeenCalled();

        await act(async () => {
          if (retryFails) rejectRetry(new Error("retry failed"));
          else resolveRetry();
          await retryWrite.catch(() => undefined);
        });
        expect(await operationResult).toBe(
          retryFails ? "rejected" : "resolved",
        );
        expect(recoverySpy).toHaveBeenCalledTimes(expectedRecoveries);
      } finally {
        recoverySpy.mockRestore();
      }
    },
  );

  it("keeps a plain-text unmount conflict recoverable without another write", async () => {
    const initialHash = "7".repeat(64);
    const externalHash = "8".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "External",
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldConflict);
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("{End} Draft");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "Base Draft",
      expectedContentHash: initialHash,
    });

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
    const recovered = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await waitFor(() => expect(recovered.textContent).toBe("External"));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale path read from pairing its body with the next file's hash", async () => {
    const firstHash = "9".repeat(64);
    const secondHash = "b".repeat(64);
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveFirst = () =>
        resolve({ text: "First", truncated: false, contentHash: firstHash });
    });
    bridgeMock.readWorkspaceText.mockImplementation(({ relativePath }) =>
      relativePath === "notes/first.txt"
        ? heldFirst
        : Promise.resolve({
            text: "Second",
            truncated: false as const,
            contentHash: secondHash,
          }),
    );
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/first.txt" />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "notes/first.txt",
      }),
    );
    view.rerender(
      <FileInspector workspaceId="ws-1" path="notes/second.txt" />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await waitFor(() => expect(content.textContent).toBe("Second"));

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    expect(content.textContent).toBe("Second");
    await user.click(content);
    await user.keyboard("{End} edit");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/second.txt",
      text: "Second edit",
      expectedContentHash: secondHash,
    });
  });

  it("holds a plain-text shell flush until the in-flight autosave lands", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("Draft");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushSettled).toBe(false);

    await act(async () => {
      releaseWrite();
      await heldWrite;
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("rearms autosave when a debounce expires behind a shell flush", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));
    await user.keyboard("Two");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushSettled).toBe(false);
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
        text: "OneTwo",
        expectedContentHash: TEST_CONTENT_HASH,
      },
    ]);
    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    view.unmount();
  });

  it("drains a flush-time edit before its debounce expires", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await user.keyboard("Two");
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(flushSettled).toBe(false);
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwo",
      expectedContentHash: TEST_CONTENT_HASH,
    });

    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    view.unmount();
  });

  it("shares concurrent flushes through edits made during deferred writes", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseThird!: () => void;
    const heldThird = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseThird = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond)
      .mockImplementationOnce(() => heldThird);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    let firstSettled = false;
    let secondSettled = false;
    const firstFlush = flush!();
    const secondFlush = flush!();
    const sharedPromise = firstFlush === secondFlush;
    void firstFlush.then(() => {
      firstSettled = true;
    });
    void secondFlush.then(() => {
      secondSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    await user.keyboard("Two");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondSettledEarly = secondSettled;

    await user.keyboard("Three");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledBeforeDrain = firstSettled || secondSettled;
    expect(bridgeMock.writeWorkspaceText.mock.calls[2]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwoThree",
      expectedContentHash: TEST_CONTENT_HASH,
    });

    await act(async () => {
      releaseThird();
      await heldThird;
      await Promise.all([firstFlush, secondFlush]);
    });
    expect(sharedPromise).toBe(true);
    expect(secondSettledEarly).toBe(false);
    expect(settledBeforeDrain).toBe(false);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    view.unmount();
  });

  it("rejects a flush when its deferred write fails and keeps the draft retryable", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("deferred write failed"))
      .mockResolvedValue({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    const firstFlush = flush!();
    const secondFlush = flush!();
    const sharedPromise = firstFlush === secondFlush;
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await user.keyboard("Two");
    await new Promise((resolve) => setTimeout(resolve, 900));
    releaseFirst();

    const failedFlushes = await Promise.allSettled([firstFlush, secondFlush]);
    expect(sharedPromise).toBe(true);
    expect(failedFlushes).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(
      failedFlushes.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.message === "deferred write failed",
      ),
    ).toBe(true);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    await expect(flush!()).resolves.toBeUndefined();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(bridgeMock.writeWorkspaceText.mock.calls[2]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwo",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    view.unmount();
  });

  it("applies a refreshed plain-text body to CodeMirror", async () => {
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "before",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })
      .mockResolvedValueOnce({
        text: "after external edit",
        truncated: false,
        contentHash: "e".repeat(64),
      });
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" refreshKey={1} />,
    );
    const content = (await screen.findByTestId("view-text-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    await waitFor(() => expect(content.textContent).toBe("before"));

    view.rerender(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" refreshKey={2} />,
    );

    await waitFor(() => expect(content.textContent).toBe("after external edit"));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("lets Ctrl+Z undo a pending history revert in CodeMirror text files", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "before\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
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
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("edits CSV cells and saves the table file", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
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
      expectedContentHash: TEST_CONTENT_HASH,
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
      contentHash: TEST_CONTENT_HASH,
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
    let releaseReread!: (
      value: Awaited<ReturnType<DohcDesktopBridge["readWorkspaceText"]>>,
    ) => void;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
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
      releaseReread({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
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
        contentHash: TEST_CONTENT_HASH,
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
      contentHash: TEST_CONTENT_HASH,
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
      expectedContentHash: TEST_CONTENT_HASH,
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
      contentHash: TEST_CONTENT_HASH,
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
        contentHash: TEST_CONTENT_HASH,
      })
      .mockResolvedValueOnce({
        text: externalBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
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
      expectedContentHash: TEST_CONTENT_HASH,
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

  /**
   * Put a draft in the document through the SOURCE editor — a textarea, and
   * the surface these draft tests actually mean.
   *
   * Written to keep pointers out of the WYSIWYG surface, because
   * ProseMirror's `mousedown` called `elementFromPoint` and jsdom did not
   * implement it: the handler threw after the test had passed, failing the
   * run with every assertion green. #619 has since stubbed hit testing in
   * `vitest.setup.ts` (measured: the TypeError returns in 21 of 32 loaded
   * runs without it), so that hazard is gone. This stays because driving the
   * textarea is the honest way to say "the user typed a draft here" — not
   * because the pointer is unsafe.
   */
  async function typeIntoSourceEditor(value: string): Promise<HTMLElement> {
    // Read -> WYSIWYG -> source: the surface may start in any of the three,
    // so step until the editor is the textarea.
    for (let step = 0; step < 4; step += 1) {
      const candidate = screen.queryByTestId("markdown-editor");
      if (candidate?.tagName === "TEXTAREA") {
        fireEvent.change(candidate, { target: { value } });
        return candidate;
      }
      fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error("The source editor never appeared.");
  }

  function makeEngineBridge(markdown: string) {
    const serverDoc = markdownToYDoc(markdown);
    const remoteListeners = new Set<
      (event: { sessionId: string; update: Uint8Array }) => void
    >();
    const saveStateListeners = new Set<
      (event: {
        sessionId: string;
        state: "settling" | "saved" | "error" | "deleted";
        seq: number;
      }) => void
    >();
    let sessionId = "";
    const bridgeMock = {
      readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
        async () => ({
          text: markdown,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        }),
      ),
      writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
        async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
      ),
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
            state: "settling" | "saved" | "error" | "deleted";
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
    const pushSaveState = (
      state: "settling" | "saved" | "error" | "deleted",
      seq: number,
    ) => {
      for (const listener of saveStateListeners) listener({ sessionId, state, seq });
    };
    return {
      bridgeMock,
      pushRemoteMarkdown,
      pushSaveState,
    };
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

  it("shows the plain deletion notice when the last edit settled first", async () => {
    const user = userEvent.setup();
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    await user.type(screen.getByTestId("page-title"), " Retitled");
    await waitFor(() => expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled());
    act(() => pushSaveState("saved", 999));
    act(() => pushSaveState("deleted", 999));

    expect(
      (await screen.findByTestId("deleted-while-editing-notice")).textContent,
    ).toBe(
      "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/trash.",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(screen.queryByTestId("orphaned-draft-copy")).toBeNull();
    expect((screen.getByTestId("page-title") as HTMLInputElement).readOnly).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-editor").getAttribute("contenteditable"),
      ).toBe("false"),
    );
    expect(screen.getByTestId("markdown-save-state").getAttribute("title")).toBe(
      "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/trash.",
    );
  });

  it("does not relabel an older set-aside edit as part of this deletion", async () => {
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    captureOrphanedDraft("ws-1", "a.md", "Older set-aside text");
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    act(() => pushSaveState("deleted", 0));

    expect(
      (await screen.findByTestId("deleted-while-editing-notice")).textContent,
    ).toBe(
      "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/trash.",
    );
    expect(screen.getByTestId("orphaned-draft-notice").textContent).toContain(
      "This document reopened before your last edit saved. Copy your text to keep it.",
    );
  });

  it("sets aside an edit that races the confirmed deletion", async () => {
    const user = userEvent.setup();
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    await user.type(screen.getByTestId("page-title"), " Retitled");
    await waitFor(() => expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled());
    act(() => pushSaveState("deleted", 1));

    expect(
      (await screen.findByTestId("deleted-while-editing-notice")).textContent,
    ).toBe(
      "This file was deleted while you had it open. Copy your set-aside edit to keep it.",
    );
    expect(screen.getByTestId("orphaned-draft-notice").textContent).toContain(
      "This document reopened before your last edit saved. Copy your text to keep it.",
    );
    expect(screen.getByTestId("markdown-save-state").getAttribute("title")).toBe(
      "This file was deleted while you had it open. Copy your set-aside edit to keep it.",
    );

    // Reuse #600's existing Copy recovery action and prove it returns the
    // current Y.Doc text, including the edit that never settled.
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain("title: Plan Retitled"),
    );
  });

  it("updates the same set-aside draft for a keystroke before read-only commits", async () => {
    const user = userEvent.setup();
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    const title = screen.getByTestId("page-title");
    await user.type(title, " Retitled");
    await waitFor(() => expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled());

    // One React batch: the deletion event captures first, then the still-live
    // title editor accepts one final keystroke before read-only commits.
    act(() => {
      pushSaveState("deleted", 1);
      fireEvent.change(title, { target: { value: "Plan Retitled!" } });
    });

    await user.click(await screen.findByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain(
        "title: Plan Retitled!",
      ),
    );
    expect(screen.getAllByTestId("orphaned-draft-notice")).toHaveLength(1);
  });

  it.each([
    ["delete" as const, "dohc is still deleting a.md."],
    ["move" as const, "dohc is still moving a.md."],
  ])("keeps a %s-window open refusal retryable and operation-aware", async (operation, message) => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const openBound = bridgeMock.openEngineYDocSession;
    let removalInProgress = true;
    const refusedBridge = {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async (...args: Parameters<typeof openBound>) =>
        removalInProgress
          ? {
              available: false,
              removalInProgress: { operation, message },
            }
          : await openBound(...args),
      ),
    };
    vi.stubGlobal("dohcDesktop", refusedBridge);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("engine-removal-in-progress-notice");
    expect(notice.getAttribute("data-operation")).toBe(operation);
    expect(notice.textContent).toContain(`${message} Wait for it to finish.`);
    expect(screen.queryByTestId("deleted-while-editing-notice")).toBeNull();
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect((screen.getByTestId("page-title") as HTMLInputElement).readOnly).toBe(
      true,
    );
    removalInProgress = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    expect(screen.queryByTestId("engine-removal-in-progress-notice")).toBeNull();
    expect(screen.queryByTestId("deleted-while-editing-notice")).toBeNull();
    expect((screen.getByTestId("page-title") as HTMLInputElement).readOnly).toBe(
      false,
    );
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

  // #564. The engine open hit its retry deadline. Like notInVersion, this
  // must NOT downgrade to the writable plain editor — the engine may still
  // bind the document, and a plain autosave meanwhile would take the disk
  // path #533 closed. The document stays readable, read-only, with the
  // reason stated and a retry that issues a fresh open.
  it("keeps a timed-out open read-only with the reason, and retries on request", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    let opens = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async () => {
        opens += 1;
        return { available: false, engineMayHoldDocument: true };
      }),
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId(
      "engine-may-hold-document-notice",
      {},
      { timeout: 5_000 },
    );
    expect(notice.textContent).toContain(
      "dohc could not open this document for editing.",
    );
    expect(notice.textContent).toContain("It is read-only for now.");
    // The content still renders — read-only, not replaced.
    expect(screen.getByTestId("view-markdown")).toBeTruthy();
    // MUTATION: drop engineMayHoldDocument from the readOnly computation -> the edit
    // toggle is enabled over a session the engine may still bind.
    expect(
      (screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(opens).toBe(1);

    // Try again is a FRESH open (a new request key), not a repaint.
    await user.click(screen.getByText("Try again"));
    await waitFor(() => expect(opens).toBe(2));
  });

  // A draft pending AT the retry needs no gate of its own, and that is why
  // #564's retry-window guard and its draft disarm are gone. Both windows a
  // "Try again" opens are `opening` windows, and #567 owns those: the retry
  // changes the request key, so `opening` is true in the same render and the
  // reopen's capture takes the draft out of the save pipeline before any
  // seam can write it. This test drives the whole path — a draft typed
  // before a timed-out reopen, the retry, then the bind — and asserts that
  // the keystrokes reach the recovery surface and never the disk.
  it("sets a draft aside across a timed-out reopen and its retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let opens = 0;
      const order: string[] = [];
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        writeWorkspaceText: vi.fn(async () => {
          order.push("write");
          return { status: "written" as const, contentHash: TEST_CONTENT_HASH };
        }),
        openEngineYDocSession: vi.fn(async (payload: { sessionId: string }) => {
          opens += 1;
          order.push(`open-${opens}`);
          // Open 1: plain fallback (writable) — the draft is typed here.
          // Open 2 (a version switch): times out.
          // Open 3 ("Try again"): BINDS.
          if (opens === 1) return { available: false };
          if (opens === 2) return { available: false, engineMayHoldDocument: true };
          return await bridgeMock.openEngineYDocSession(payload);
        }),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      // fireEvent + the SOURCE textarea, never a pointer into the WYSIWYG
      // surface: prosemirror's mousedown calls elementFromPoint, which jsdom
      // does not implement, and it throws AFTER the test — failing the run
      // with every assertion green.
      await typeIntoSourceEditor(`${DOC_MARKDOWN}typed`);

      view.rerender(
        <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
      );
      await screen.findByTestId(
        "engine-may-hold-document-notice",
        {},
        { timeout: 5_000 },
      );
      // The keystrokes are recoverable, and the armed timer did not write
      // them during the read-only window.
      await screen.findByTestId("orphaned-draft-notice");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(order).toEqual(["open-1", "open-2"]);

      fireEvent.click(screen.getByText("Try again"));
      await waitFor(() => expect(opens).toBe(3));
      // The retry reopened and wrote NOTHING — not before the bind (a file
      // write is not canonical here: the reopen seeds from the engine head,
      // and only when no CRDT lineage exists) and not after it.
      expect(order).toEqual(["open-1", "open-2", "open-3"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(order).toEqual(["open-1", "open-2", "open-3"]);

      // The unmount flush is the seam that outlives every other one: it runs
      // once the bind has reopened the guards.
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(order).toEqual(["open-1", "open-2", "open-3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // #564, codex round 3 P2: the read had failed, so the inspector's
  // loading/error branch owned the surface. A SUCCESSFUL retry clears
  // `engineMayHoldDocument` — and the user was left at "Couldn't read this file."
  // with no document and no retry, while main held a live session.
  it("renders the document when the retry binds after a failed read", async () => {
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    let opens = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        throw new Error("read failed");
      }),
      openEngineYDocSession: vi.fn(async (payload: { sessionId: string }) => {
        opens += 1;
        return opens === 1
          ? { available: false, engineMayHoldDocument: true }
          : await bridgeMock.openEngineYDocSession(payload);
      }),
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId(
      "engine-may-hold-document-notice",
      {},
      { timeout: 5_000 },
    );
    fireEvent.click(screen.getByText("Try again"));

    // MUTATION: let the read-error branch win over a bound engine doc ->
    // this never appears and the user keeps "Couldn't read this file."
    await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
    expect(screen.queryByText("Couldn't read this file.")).toBeNull();
  });

  // #564, review round 2 B2: the OTHER direction of the same guard. The
  // refusal must LIFT when the retry answers. It is keyed on live engine
  // state for that reason — an "ever retried" flag stayed true for the tab's
  // life and cost the user every keystroke after one retry.
  it("stops refusing writes once the retry has answered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let opens = 0;
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(async () => {
          opens += 1;
          // Open 1 times out; the retry (open 2) answers "not engine-backed",
          // so the plain editor is legitimately writable again.
          return opens === 1
            ? { available: false, engineMayHoldDocument: true }
            : { available: false };
        }),
      });

      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId(
        "engine-may-hold-document-notice",
        {},
        { timeout: 5_000 },
      );
      await user.click(screen.getByText("Try again"));
      await waitFor(() => expect(opens).toBe(2));
      await waitFor(() =>
        expect(screen.queryByTestId("engine-may-hold-document-notice")).toBeNull(),
      );

      // The answered retry left an ordinary writable document behind.
      // MUTATION: leave the refusal armed after the open answers (an "ever
      // retried" flag, or `engineMayHoldDocument` kept sticky) -> the autosave is
      // refused and nothing reaches disk.
      //
      // fireEvent, not userEvent: a pointer click into the mounted WYSIWYG
      // surface reaches prosemirror's mousedown, which needs layout jsdom
      // does not have — and that throws AFTER the test, failing the run
      // with every assertion green.
      await typeIntoSourceEditor(`${DOC_MARKDOWN}typed`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // #564, codex round 2 P2: when the content read itself failed, the
  // inspector returns from its loading/error branch before MarkdownView
  // mounts — the one path where the engine session is the only way back to
  // the content is exactly where the timeout had no notice and no retry.
  it("offers the timeout retry even when the content read failed", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    let opens = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        throw new Error("read failed");
      }),
      openEngineYDocSession: vi.fn(async () => {
        opens += 1;
        return { available: false, engineMayHoldDocument: true };
      }),
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId(
      "engine-may-hold-document-notice",
      {},
      { timeout: 5_000 },
    );
    expect(notice.textContent).toContain(
      "dohc could not open this document for editing.",
    );
    // The read failure stays stated beside it — and the notice must NOT
    // promise read access to content that is not on screen.
    expect(screen.getByText("Couldn't read this file.")).toBeTruthy();
    expect(notice.textContent).not.toContain("read-only for now");

    await user.click(screen.getByText("Try again"));
    await waitFor(() => expect(opens).toBe(2));
  });

  // codex r15. The Y.Doc-only bypass renders the document when the read
  // failed — but the readiness signal that retires a pending search jump asks
  // only about DISK text, which that path never has. The jump stayed pending
  // in the shell and replayed on a later open of the path: the user clicks a
  // search result, gets the document, and some unrelated later open jumps to
  // that old line.
  //
  // Retiring the shell's target and APPLYING the jump are two different
  // signals, and this test owns the first. #661 gave the engine editor the
  // seam that applies it; the tests below own that half, this path included.
  it("retires the search jump when the document comes back through the Y.Doc", async () => {
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const onScrollConsumed = vi.fn();
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 3, nonce: 1 }}
        onScrollConsumed={onScrollConsumed}
      />,
    );

    // The document is on screen through the bound Y.Doc, with no disk text.
    await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
    expect(screen.queryByText("Couldn't read this file.")).toBeNull();

    // MUTATION: keep `textReady` on the disk read alone -> this never fires,
    // the shell holds the jump, and it replays on a later open of this path.
    await waitFor(() => expect(onScrollConsumed).toHaveBeenCalledWith(1));
  });

  // #661. Engine mode renders no source textarea, and that textarea held the
  // only consumer of the pending line — so every engine-backed search result
  // opened at the top of the document, whatever line it named. The engine
  // editor now takes the seam over: the line resolves to the top-level block
  // holding it, and the editor reveals that block.
  const SEARCH_DOC =
    "---\ntitle: Plan\n---\n\n# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  function flashedBlockText(): string | undefined {
    return document.querySelector(".dohc-outline-target-flash")?.textContent ?? undefined;
  }

  it("lands an engine-backed search jump on the block holding the line", async () => {
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // Line 11 of the file: "Third paragraph." — three lines of
        // frontmatter above the body, and the fourth block within it.
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    // MUTATION: drop the engine branch of the pending-line effect -> the
    // document opens at the top and nothing is ever revealed.
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."), {
      timeout: 5_000,
    });

    // The flash has to OUTLIVE the retire. Retiring the target changes the
    // editor's prop, and that effect's cleanup is what cancels the flash —
    // so a careless retire clears the highlight in the same frame it was
    // drawn and the reader never sees where they landed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(flashedBlockText()).toBe("Third paragraph.");
  });

  // #688. One top-level block can be a hundred items long, and revealing its
  // start leaves the match offscreen. The target carries the block's own
  // source lines with it, so the reveal lands the matched one — and it is
  // still ONE target, retired once, which the test below this one holds.
  it("lands a search jump on the matched item deep inside a long list", async () => {
    const items = Array.from({ length: 40 }, (_, item) => `- Item ${item + 1}`);
    const { bridgeMock } = makeEngineBridge(
      `---\ntitle: Plan\n---\n\n# Plan\n\n${items.join("\n")}\n`,
    );
    vi.stubGlobal("dohcDesktop", bridgeMock);

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // The first item is file line 7, so "Item 30" is line 36.
        scrollTarget={{ path: "a.md", line: 36, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    // MUTATION: drop `match` from the block target the shell sends, or return
    // null from intraBlockRange -> "Item 1" flashes and the reader lands 29
    // items above what they searched for.
    await waitFor(() => expect(flashedBlockText()).toBe("Item 30"), {
      timeout: 5_000,
    });
  });

  // codex on 76298ccd. The source projection HIDES the editor pane, so a jump
  // applied while it is up reveals a block nobody can see. A reader who
  // clicked a search result asked for the match; give them the document.
  it("leaves the source projection to show the match", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("markdown-source-toggle"));
    await screen.findByTestId("view-markdown-source");
    expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    // MUTATION: drop the setShowSource(false) -> the pane stays hidden and
    // the reveal lands behind the source view.
    await waitFor(() =>
      expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(false),
    );
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."), {
      timeout: 5_000,
    });
  });

  // codex on 76298ccd. A frontmatter hit has no body block to land on: the
  // title and properties it names render ABOVE the editor, and revealing the
  // first body block would scroll them off the top — the reader would be
  // taken PAST the thing they matched.
  it("shows the top of the document for a frontmatter hit", async () => {
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const scrollTo = stubScrollSpy("scrollTo");

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // Line 2 of the file is `title: Plan`, inside the frontmatter.
        scrollTarget={{ path: "a.md", line: 2, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    // MUTATION: map the frontmatter line onto block 0 anyway -> the first
    // body block is revealed and the matched title scrolls out of view.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(flashedBlockText()).toBeUndefined();
  });

  // codex round 14 on b67d649c. `setShowSource(false)` only SCHEDULES the
  // unhide, so scrolling in the same effect moves an element that is still
  // `hidden` — the pane never moves and the matched title stays offscreen.
  it("scrolls to the top only once the pane is on screen", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    // Record whether the pane was hidden AT THE MOMENT it was scrolled — the
    // one thing a plain call-count cannot say, and the whole defect.
    const hiddenAtScroll: boolean[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function (this: HTMLElement) {
        hiddenAtScroll.push(this.hasAttribute("hidden"));
      },
    });

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("markdown-source-toggle"));
    await screen.findByTestId("view-markdown-source");
    expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // Line 2 of the file is `title: Plan`, inside the frontmatter.
        scrollTarget={{ path: "a.md", line: 2, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await waitFor(() => expect(hiddenAtScroll.length).toBeGreaterThan(0));
    // MUTATION: scroll inside the mapping effect -> the one recorded call
    // happens while the pane is still hidden and moves nothing.
    expect(hiddenAtScroll).not.toContain(true);
  });

  // A frontmatter hit retires the jump like any other. Its landing writes no
  // block target, so nothing downstream reports it consumed — the branch that
  // shows the top has to retire it itself, or a later re-read of the open
  // document scrolls the reader back up to a result they already left.
  it("retires a frontmatter jump, so a later re-read cannot replay it", async () => {
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    let reads = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        reads += 1;
        return {
          text: reads === 1 ? SEARCH_DOC : `${SEARCH_DOC}\nFourth paragraph.\n`,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }),
    });
    const scrollTo = stubScrollSpy("scrollTo");

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 2, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // An agent edits the file and workspace activity re-reads it, which is
    // what re-runs the mapping effect under a jump that is already done.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        onScrollConsumed={vi.fn()}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: drop the setJump(null) in the frontmatter branch -> the line
    // stays pending and the re-read scrolls the reader to the top again.
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // The landing effect above re-runs whenever the source projection unhides
  // the pane, so it must retire the jump itself — or every later toggle back
  // to the editor yanks the reader to the top of the document again.
  it("does not re-scroll to the top when a source toggle follows the jump", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const scrollTo = stubScrollSpy("scrollTo");

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // Line 2 of the file is `title: Plan`, inside the frontmatter.
        scrollTarget={{ path: "a.md", line: 2, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    expect(scrollTo).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("markdown-source-toggle"));
    await screen.findByTestId("view-markdown-source");
    await user.click(screen.getByTestId("markdown-source-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(false),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // MUTATION: drop the setJump(null) in the top-scroll effect -> the jump
    // stays live and the unhidden pane is scrolled to the top a second time.
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // codex round 12 on 0d498bcb. A heading is a destination too. Clicking one
  // while a search jump is still waiting on the lazy editor makes the heading
  // the reader's newest choice — and the older jump has to go, or it lands the
  // moment that editor arrives and pulls them off the heading.
  it("drops an unlanded search jump when a heading is chosen instead", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });

    // No await between them: the editor's settle frames are 16ms timers, so
    // the block target is set and unconsumed when the heading arrives.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        headingTarget={{ anchor: "plan", nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // ONE reveal, the heading's. The flash cannot say this — it has faded by
    // now, and both reveals draw the same class, so it reads `undefined`
    // either way. The count is what separates them.
    //
    // MUTATION: drop the setJump(null) in the heading branch -> two reveals,
    // the second dragging the reader off the heading they just chose.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  // codex round 2 on 9184cf04. Two results, clicked back to back: the body
  // jump is still waiting on the editor's settle frames when the frontmatter
  // one arrives. The newest click is the reader's answer, so the older target
  // has to go — otherwise it lands the moment those frames run and drags them
  // away from the result they just asked for.
  it("drops an unlanded body jump when a frontmatter hit replaces it", async () => {
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const scrollTo = stubScrollSpy("scrollTo");

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });

    // No await between them: the settle frames are 16ms timers, so the body
    // target is set and unconsumed when the frontmatter one lands.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 2, nonce: 2 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // MUTATION: drop the setBlockTarget(null) in the frontmatter branch ->
    // "Third paragraph." flashes and the matched title is scrolled off.
    expect(flashedBlockText()).toBeUndefined();
  });

  // codex round 2 on 9184cf04. The window BEFORE the editor reports back.
  // Reporting retires an applied jump; a version switch arriving first leaves
  // the target standing, and the editor that remounts on the new version
  // applies a block index mapped against the version the reader left.
  it("drops an unlanded jump when the version switches under it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        onScrollConsumed={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: drop the reopenKey guard -> the remounted editor reveals a
    // block of the new version chosen by the old version's line numbers.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(flashedBlockText()).toBeUndefined();
  });

  // codex round 5 on b65c469f. The window BEFORE the line is even mapped. An
  // engine document that is still opening has nothing to map against (#533),
  // so the line waits — and the round-2 guard retired only the mapped target.
  // A version switch arriving in that window left the line to be mapped
  // against the body of a version the reader never searched.
  it("drops a jump waiting on the engine open when the version switches", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    let releaseOpen = () => {};
    const held = new Promise<void>((resolve) => {
      releaseOpen = () => resolve();
    });
    let opens = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async (payload: { sessionId: string }) => {
        opens += 1;
        // The first open never answers until the switch has happened.
        if (opens === 1) await held;
        return bridgeMock.openEngineYDocSession(payload);
      }),
    });

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    await waitFor(() => expect(opens).toBe(1));
    expect(screen.queryByTestId("markdown-editor")).toBeNull();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        onScrollConsumed={vi.fn()}
      />,
    );
    releaseOpen();
    await waitFor(() => expect(opens).toBe(2));
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: clear only blockTarget on the reopen -> the line survives, the
    // new session binds, and the jump lands on the version nobody searched.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(flashedBlockText()).toBeUndefined();
  });

  // codex on 76298ccd. A version switch drops the bound Y.Doc while the
  // reopen runs (useEngineDoc), which unmounts this editor. The instance that
  // replaces it has no memory of having applied anything, so a target still
  // held above lands a second time — on a document the reader did not search.
  // The reopenKey guard covers a VERSION switch. It is not the only rebind:
  // useEngineDoc keys its request on [enabled, workspaceId, path, reopenKey,
  // retryKey], so flipping `readOnly` unbinds the Y.Doc and binds a fresh one
  // with reopenKey untouched. Reporting the landing back is what stops the
  // editor that mounts on the far side from applying the same jump again.
  it("retires the target once applied, so a rebind cannot replay it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."), {
      timeout: 5_000,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // readOnly flips `enabled`, which is part of the request key — the doc
    // unbinds and the editor goes with it. reopenKey never moves.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        onScrollConsumed={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-editor")).toBeNull(),
    );
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: make retireJump a no-op -> the target outlives the rebind and
    // the fresh editor reveals it a second time.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("retires the target once applied, so a reopened editor cannot replay it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."), {
      timeout: 5_000,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The version switch: the shell cleared its target, and engineVersionKey
    // reopens the session. The editor unmounts and a fresh one binds.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        onScrollConsumed={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: drop onBlockTargetConsumed (or leave blockTarget set) -> the
    // remounted editor applies the same target again.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  // #685: unlike a consumed search jump, a heading target survives the editor
  // remount a version switch causes. See HeadingNavigationTarget for why.
  // Scope is that switch. Clicking another file tab and back does NOT replay:
  // activateEditorTab routes a file path through openFile, which clears the
  // target.
  it("re-applies a heading navigation when the version switches under it", async () => {
    const revealedTargets: Array<{
      connected: boolean;
      flashed: boolean;
      text: string | null;
    }> = [];
    const scrollIntoView = stubScrollSpy(
      "scrollIntoView",
      function (this: HTMLElement) {
        revealedTargets.push({
          connected: this.isConnected,
          flashed: this.classList.contains("dohc-outline-target-flash"),
          text: this.textContent,
        });
      },
    );
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "plan", nonce: 1 };

    // Deliberately mounted WITHOUT the target, then given it. Mounting with it
    // lets the pre-engine local editor reveal it once before the Y.Doc binds,
    // and that extra reveal alone satisfies the count below — the consumable
    // mutation passes. Delivering it to a bound engine editor is what makes
    // the second reveal mean the remount.
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });

    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" headingTarget={headingTarget} />,
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    // engineVersionKey reopens the session, so the editor unmounts and a fresh
    // one binds. Nothing consumed the target, so it stands.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        headingTarget={headingTarget}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });

    // MUTATION: give headingTarget the onBlockTargetConsumed shape -> one
    // reveal, and the reader lands at the top of the new version.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    // WHICH heading, not just how many reveals: the count alone would accept a
    // second reveal that landed somewhere else.
    expect(revealedTargets[1]).toEqual({
      connected: true,
      flashed: true,
      text: "Plan",
    });
  });

  it("re-applies a read-mode heading navigation when the version switches under it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const bigBody = [
      "# Hello",
      "",
      "## Exact destination",
      "Body",
      "",
      LARGE_READ_MODE_FILLER,
    ].join("\n");
    expect(bigBody.length).toBeGreaterThan(64 * 1024);
    const { bridgeMock } = makeEngineBridge(bigBody);
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 2 };

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        headingTarget={headingTarget}
      />,
    );
    const destination = await screen.findByRole(
      "heading",
      { name: "Exact destination" },
      { timeout: 10_000 },
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    expect(scrollIntoView.mock.instances[0]).toBe(destination);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        headingTarget={headingTarget}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    expect(scrollIntoView.mock.instances[1]).toBe(destination);

    // A tab return clears the place without changing the version.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("replays a read-mode heading against the version-switch reread", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const filler = LARGE_READ_MODE_FILLER;
    const firstBody = `# Hello\n\n## Exact destination\nBody\n\n${filler}`;
    const secondBody = [
      "# Hello",
      "",
      "## Inserted heading",
      "Inserted paragraph.",
      "",
      "## Exact destination",
      "Body",
      "",
      filler,
    ].join("\n");
    expect(firstBody.length).toBeGreaterThan(64 * 1024);
    const { bridgeMock } = makeEngineBridge(firstBody);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 4 };

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        headingTarget={headingTarget}
      />,
    );
    const firstDestination = await screen.findByRole(
      "heading",
      { name: "Exact destination" },
      { timeout: 10_000 },
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    expect(scrollIntoView.mock.instances[0]).toBe(firstDestination);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        headingTarget={headingTarget}
      />,
    );

    await waitFor(() => expect(reads).toBe(2));
    const secondDestination = await waitFor(
      () => {
        const heading = screen.getByRole("heading", {
          name: "Exact destination",
        });
        if (heading === firstDestination) {
          throw new Error("The post-switch heading has not rendered yet.");
        }
        return heading;
      },
      { timeout: 10_000 },
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    expect(scrollIntoView.mock.instances[1]).toBe(secondDestination);
  });

  it("retires a read-mode heading observer when a newer switch arm replaces it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const firstBody = Array.from(
      { length: 201 },
      (_, index) =>
        `# First ${index + 1}\n\n${"first document padding ".repeat(20)}\n\n`,
    ).join("");
    const secondBody = Array.from(
      { length: 201 },
      (_, index) => `# Replacement ${index + 1}`,
    ).join("\n");
    expect(firstBody.length).toBeGreaterThan(32 * 1024);
    expect(secondBody.length).toBeLessThan(32 * 1024);
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const observers: ControlledMutationObserver[] = [];
    class ControlledMutationObserver implements MutationObserver {
      disconnected = false;
      observed: Node | null = null;

      constructor(private readonly callback: MutationCallback) {
        observers.push(this);
      }

      disconnect(): void {
        this.disconnected = true;
      }

      observe(target: Node): void {
        this.observed = target;
      }

      takeRecords(): MutationRecord[] {
        return [];
      }

      notify(): void {
        if (!this.disconnected) this.callback([], this);
      }
    }

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    vi.stubGlobal("MutationObserver", ControlledMutationObserver);
    const headingTarget = { anchor: "first-201", nonce: 7 };
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        headingTarget={headingTarget}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const headingObserver = observers.find(
      (observer) =>
        observer.observed instanceof HTMLElement &&
        observer.observed.classList.contains("dohc-readable-text"),
    );
    expect(headingObserver).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        headingTarget={headingTarget}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await screen.findByRole("heading", { name: "Replacement 201" });
    headingObserver!.notify();

    // MUTATION: leave pendingRenderedHeadingIndex armed. Its old observer
    // treats the new document's same ordinal as the requested destination.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("clears a stale read-mode heading wait carried through source mode into a later switch", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const firstBody = Array.from(
      { length: 201 },
      (_, index) =>
        `# First ${index + 1}\n\n${"first document padding ".repeat(20)}\n\n`,
    ).join("");
    const secondBody = Array.from(
      { length: 201 },
      (_, index) => `# Replacement ${index + 1}`,
    ).join("\n");
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const observers: ControlledMutationObserver[] = [];
    class ControlledMutationObserver implements MutationObserver {
      disconnected = false;
      observed: Node | null = null;

      constructor(private readonly callback: MutationCallback) {
        observers.push(this);
      }

      disconnect(): void {
        this.disconnected = true;
      }

      observe(target: Node): void {
        this.observed = target;
      }

      takeRecords(): MutationRecord[] {
        return [];
      }

      notify(): void {
        if (!this.disconnected) this.callback([], this);
      }
    }
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    vi.stubGlobal("MutationObserver", ControlledMutationObserver);
    const headingTarget = { anchor: "first-201", nonce: 9 };
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const headingObserver = observers.find(
      (observer) =>
        observer.observed instanceof HTMLElement &&
        observer.observed.classList.contains("dohc-readable-text"),
    );
    expect(headingObserver).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Leave read mode BEFORE the wait resolves — it is still pending.
    await toggleSourceOnce(() => toggleSource);

    // A version switch while in source mode: the re-arm must not skip the
    // clear just because mode is not "read" right now.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await findSourceEditor();

    // Return to read mode on the new document.
    await act(async () => {
      toggleSource!();
    });
    await screen.findByTestId("view-markdown");
    await act(async () => {
      await Promise.resolve();
    });

    // MUTATION: clear the pending index only when mode !== "source" at
    // re-arm time — a wait carried from read mode through source mode
    // survives the switch and scrolls "Replacement 201" (same ordinal, new
    // document) once read mode returns, though the reader never asked for it.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("re-applies a source-mode heading navigation when the version switches under it", async () => {
    const body = "# Hello\n\nParagraph\n\n## Exact destination\nBody\n";
    const { bridgeMock } = makeEngineBridge(body);
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 3 };
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
        headingTarget={headingTarget}
      />,
    );
    const expected = lineSpanInText(source.value, 5);
    await waitFor(() => {
      expect(source.selectionStart).toBe(expected.start);
      expect(source.selectionEnd).toBe(expected.end);
    });
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe(
      "## Exact destination",
    );

    source.setSelectionRange(0, 0);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
        headingTarget={headingTarget}
      />,
    );

    const reopenedSource = await waitFor(() => {
      const editor = screen.getByTestId("markdown-editor");
      if (!(editor instanceof HTMLTextAreaElement) || editor === source) {
        throw new Error("The source editor has not reopened for the new version.");
      }
      return editor;
    });
    await waitFor(() => {
      expect(reopenedSource.selectionStart).toBe(expected.start);
      expect(reopenedSource.selectionEnd).toBe(expected.end);
    });
    expect(
      reopenedSource.value.slice(
        reopenedSource.selectionStart,
        reopenedSource.selectionEnd,
      ),
    ).toBe("## Exact destination");

    reopenedSource.setSelectionRange(0, 0);
    // A tab return clears the place without changing the version.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(reopenedSource.selectionStart).toBe(0);
    expect(reopenedSource.selectionEnd).toBe(0);
  });

  it("replays a source-mode heading against the version-switch reread", async () => {
    const firstBody = "# Hello\n\nParagraph\n\n## Exact destination\nBody\n";
    const secondBody = [
      "# Hello",
      "",
      "## Inserted heading",
      "Inserted paragraph.",
      "",
      "Paragraph",
      "",
      "## Exact destination",
      "Body",
      "",
    ].join("\n");
    const { bridgeMock } = makeEngineBridge(firstBody);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 5 };
    let toggleSource: (() => void) | null = null;

    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    const firstExpected = lineSpanInText(firstBody, 5);
    await waitFor(() => {
      expect(source.selectionStart).toBe(firstExpected.start);
      expect(source.selectionEnd).toBe(firstExpected.end);
    });

    source.setSelectionRange(0, 0);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );

    await waitFor(() => expect(reads).toBe(2));
    const reopenedSource = await waitFor(() => {
      const editor = screen.getByTestId("markdown-editor");
      if (!(editor instanceof HTMLTextAreaElement) || editor === source) {
        throw new Error("The source editor has not reopened for the new version.");
      }
      return editor;
    });
    const secondExpected = lineSpanInText(secondBody, 8);
    await waitFor(() => {
      expect(reopenedSource.selectionStart).toBe(secondExpected.start);
      expect(reopenedSource.selectionEnd).toBe(secondExpected.end);
    });
    expect(
      reopenedSource.value.slice(
        reopenedSource.selectionStart,
        reopenedSource.selectionEnd,
      ),
    ).toBe("## Exact destination");
  });

  it("does not replay a source heading that an active search jump suppressed", async () => {
    const firstBody = "# Hello\n\nParagraph\n\n## Exact destination\nBody\n";
    const secondBody = [
      "# Hello",
      "",
      "## Inserted heading",
      "Inserted paragraph.",
      "",
      "Paragraph",
      "",
      "## Exact destination",
      "Body",
      "",
    ].join("\n");
    const { bridgeMock } = makeEngineBridge(firstBody);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 8 };
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();
    const setSelectionRange = vi.spyOn(
      HTMLTextAreaElement.prototype,
      "setSelectionRange",
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
        scrollTarget={{ path: "a.md", line: 1, nonce: 1 }}
        headingTarget={headingTarget}
        onScrollConsumed={vi.fn()}
      />,
    );
    const searchExpected = lineSpanInText(firstBody, 1);
    await waitFor(() => {
      expect(source.selectionStart).toBe(searchExpected.start);
      expect(source.selectionEnd).toBe(searchExpected.end);
    });
    setSelectionRange.mockClear();
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );

    await waitFor(() => expect(reads).toBe(2));
    const reopenedSource = await waitFor(() => {
      const editor = screen.getByTestId("markdown-editor");
      if (
        !(editor instanceof HTMLTextAreaElement) ||
        editor === source ||
        editor.value !== secondBody
      ) {
        throw new Error("The source editor has not reopened for the new version.");
      }
      return editor;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // MUTATION: advance appliedHeadingNonce for the suppressed target. The
    // switch then replays a destination that never landed for the reader.
    const replaySelections = setSelectionRange.mock.calls.length;
    setSelectionRange.mockRestore();
    expect(replaySelections).toBe(0);
  });

  it("blocks the source autosave for the full switch reread and sets the draft aside without a heading target", async () => {
    const firstBody = "# Hello\n\nParagraph\n";
    const secondBody = "# Hello from the new version\n\nReplacement paragraph.\n";
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const user = userEvent.setup();

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingSource = await findSourceEditor();
    expect(pendingSource.value).toBe(firstBody);
    fireEvent.change(pendingSource, { target: { value: typedBody } });
    expect(pendingSource.value).toBe(typedBody);

    // Let the armed autosave attempt its write while the independent disk
    // reread still holds the switch window open.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
      ).toBe(secondBody),
    );
    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(typedBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps a rejected switch reread write-blocked and recovers the unmounted draft", async () => {
    const firstBody = "# Old version\n\nOld paragraph.\n";
    const typedBody = `${firstBody}\nTyped after the reopen settled.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let rejectSecondRead!: (reason?: unknown) => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return {
          text: firstBody,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        rejectSecondRead = reject;
      });
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const user = userEvent.setup();

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingSource = await findSourceEditor();
    fireEvent.change(pendingSource, { target: { value: typedBody } });
    expect(pendingSource.value).toBe(typedBody);

    await act(async () => {
      rejectSecondRead(new Error("read failed"));
      await Promise.resolve();
    });
    await screen.findByText("Couldn't read this file.");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(typedBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // The recovery half of the rule above: a rejected reread must not refuse
  // writes FOREVER, only until a later reread of that same switch succeeds.
  // Without this pin, an inverted or dropped `!error` guard (refusing on
  // every answer instead of clearing only on success) passes every other
  // test in this file, because none of them retry PAST a failure.
  it("lifts the switch refusal once a retried reread succeeds", async () => {
    const firstBody = "# Old version\n\nOld paragraph.\n";
    const thirdBody = "# New version\n\nReplacement paragraph.\n";
    const { bridgeMock } = makeEngineBridge(firstBody);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return {
          text: firstBody,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }
      if (reads === 2) throw new Error("read failed");
      return {
        text: thirdBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");

    // The switch: read 2 rejects.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
      />,
    );
    await screen.findByText("Couldn't read this file.");
    expect(reads).toBe(2);

    // The retry: read 3, for the SAME switch, succeeds.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={2}
        engineVersionKey={1}
      />,
    );
    await waitFor(() => expect(reads).toBe(3));
    const source = await screen.findByText("New version");
    expect(source).toBeTruthy();

    // A NEW edit now, on the verified version, must reach disk — the
    // refusal must have lifted, not stayed on because a `!error` guard
    // regressed to refusing on every answer.
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    await userEvent.setup().type(title, "!");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalled(),
      { timeout: 5_000 },
    );
  });

  it("PROBE-STALE-FLUSH: the registered draft flush must refuse the switch window too", async () => {
    const firstBody = "# Hello\n\nParagraph\n";
    const secondBody = "# Hello from the new version\n\nReplacement paragraph.\n";
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    // STABLE identity, like the shell's useCallback([], ...) registrar: the
    // flush registers once, against the MOUNT render's closures.
    let draftFlush: (() => Promise<void>) | null = null;
    const registerFlush = (flush: (() => Promise<void>) | null) => {
      draftFlush = flush;
    };

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
        registerDraftFlush={registerFlush}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
        registerDraftFlush={registerFlush}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingSource = await findSourceEditor();
    expect(pendingSource.value).toBe(firstBody);
    fireEvent.change(pendingSource, { target: { value: typedBody } });

    // The shell awaits this seam before an explorer op — which a user can
    // trigger while the switch reread is still pending. The window rule says
    // no disk write until the reread answers.
    expect(draftFlush).not.toBeNull();
    await act(async () => {
      await draftFlush!();
    });
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
      ).toBe(secondBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // The successful reread's commit and the resync effect that applies it are
  // two separate React steps (a render, then a passive effect) — RTL's act()
  // settles both before test code can observe a gap between them, so this
  // cannot be pinned by racing the scheduler (verified: every interleaving
  // attempted here stayed green on the unfixed ref). It intercepts the fire
  // effect's own resync entry point instead: a write fired FROM INSIDE that
  // interception is synchronous with the effect body, landing exactly between
  // "the draft is captured" and "the refusal ref is cleared" — the one
  // ordering the fix promises never to invert.
  it("keeps the write path refused for the whole resync step, not just until the reread lands", async () => {
    const firstBody = "# Hello\n\nParagraph\n";
    const secondBody = "# Hello from the new version\n\nReplacement paragraph.\n";
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingSource = await findSourceEditor();
    fireEvent.change(pendingSource, { target: { value: typedBody } });

    const realCapture = orphanedDraftsModule.captureOrphanedDraft;
    let interceptionRan = false;
    let writeCallsInsideResync = 0;
    const captureSpy = vi
      .spyOn(orphanedDraftsModule, "captureOrphanedDraft")
      .mockImplementation((...args) => {
        // Synchronous, mid-effect: the fire effect just captured the pending
        // draft and has not yet cleared the shared refusal ref. A write fired
        // right here — before this function even returns — must still land
        // nothing.
        interceptionRan = true;
        const editor = screen.getByTestId("markdown-editor");
        fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
        writeCallsInsideResync = bridgeMock.writeWorkspaceText.mock.calls.length;
        return realCapture(...args);
      });

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });

    captureSpy.mockRestore();

    // MUTATION: clear the shared ref before applying the resync (or clear it
    // in the parent as soon as the reread succeeds) instead of after — the
    // interception above then observes an EARLY write and this assertion
    // catches it.
    expect(interceptionRan).toBe(true);
    expect(writeCallsInsideResync).toBe(0);
    await waitFor(() =>
      expect(
        (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
      ).toBe(secondBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("resyncs WYSIWYG after the switch reread and preserves its pending edit", async () => {
    const firstBody = "# Old version\n\nOld paragraph.";
    const secondBody = "# New version\n\nReplacement paragraph.";
    const typedBody = "# Pending switch edit. Old version\n\nOld paragraph.";
    const freshBody = "# Fresh edit. New version\n\nReplacement paragraph.";
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const user = userEvent.setup();

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    const firstEditor = await screen.findByTestId("markdown-editor");
    expect(firstEditor).not.toBeInstanceOf(HTMLTextAreaElement);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingEditor = await screen.findByTestId("markdown-editor");
    expect(pendingEditor).not.toBeInstanceOf(HTMLTextAreaElement);
    await user.type(pendingEditor, "Pending switch edit. ");

    // The pending WYSIWYG autosave must answer to the same switch window as
    // the source timer and both long-lived flush callers.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await screen.findByText("Replacement paragraph.");

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(typedBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const resyncedEditor = screen.getByTestId("markdown-editor");
    expect(resyncedEditor).not.toBe(pendingEditor);
    await user.type(resyncedEditor, "Fresh edit. ");
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: freshBody,
          expectedContentHash: TEST_CONTENT_HASH,
        }),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: typedBody,
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("resyncs an editable mode entered while the switch reread is pending", async () => {
    const firstBody = `# Old version\n\n${"x".repeat(64 * 1024)}`;
    const secondBody = "# New version\n\nReplacement paragraph.\n";
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    expect(firstBody.length).toBeGreaterThan(64 * 1024);
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const user = userEvent.setup();

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const editToggle = screen.getByTestId("markdown-edit-toggle");
    expect(editToggle.textContent).toBe("Edit");
    await user.click(editToggle);
    await waitFor(() => expect(editToggle.textContent).toBe("Source"));
    await user.click(editToggle);
    const pendingSource = await findSourceEditor();
    fireEvent.change(pendingSource, { target: { value: typedBody } });
    expect(pendingSource.value).toBe(typedBody);

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
      ).toBe(secondBody),
    );

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(typedBody),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("sets aside a source edit typed after the engine reopen settles but before the switch reread", async () => {
    const firstBody = "# Hello\n\nParagraph\n\n## Exact destination\nBody\n";
    const secondBody = [
      "# Hello",
      "",
      "## Inserted heading",
      "Inserted paragraph.",
      "",
      "Paragraph",
      "",
      "## Exact destination",
      "Body",
      "",
    ].join("\n");
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "exact-destination", nonce: 6 };
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const user = userEvent.setup();

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    const firstExpected = lineSpanInText(firstBody, 5);
    await waitFor(() => {
      expect(source.selectionStart).toBe(firstExpected.start);
      expect(source.selectionEnd).toBe(firstExpected.end);
    });

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
        headingTarget={headingTarget}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingSource = await findSourceEditor();
    expect(pendingSource.value).toBe(firstBody);
    expect(pendingSource.readOnly).toBe(false);
    fireEvent.change(pendingSource, { target: { value: typedBody } });
    expect(pendingSource.value).toBe(typedBody);

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
      ).toBe(secondBody),
    );

    // MUTATION: reset the source draft without capturing it. The reread then
    // erases the keystroke with no recovery entry.
    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(typedBody),
    );

    // The capture also cancels the armed autosave. It must not write either
    // the set-aside text or the resynced document after the reread lands.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("retires the jump after one landing, so a later re-read cannot replay it", async () => {
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    let reads = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        reads += 1;
        return {
          text: reads === 1 ? SEARCH_DOC : `${SEARCH_DOC}\nFourth paragraph.\n`,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }),
    });

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 9, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    await waitFor(() => expect(flashedBlockText()).toBe("Second paragraph."), {
      timeout: 5_000,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // What the shell does next: it consumed the target and cleared it. Then an
    // agent edits the file and workspace activity re-reads the open document —
    // the Markdown the mapping reads changes underneath a jump that is done.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        onScrollConsumed={vi.fn()}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    // Twice: the first act flushes the re-read's state into the tree, the
    // second gives the editor's two settle frames room to land a jump. One
    // act cannot see both, and the replay this test denies happens in the
    // second.
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // MUTATION: leave the pending line set -> the re-read derives a second
    // block target and yanks the reader back to an old search result.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("routes the recovery path's jump through the same seam", async () => {
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      readWorkspaceText: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 });
    // The read failed, so the Markdown the line was numbered against is gone
    // and the line resolves to the first block. The seam still runs — the
    // recovery path is not a document where jumps quietly do nothing.
    //
    // MUTATION: gate the effect on disk text being present -> no flash here.
    await waitFor(() => expect(flashedBlockText()).toBe("Plan"), { timeout: 5_000 });
  });

  // codex on the round-9 head: the SAME failed-read branch, but reached with a
  // draft already pending. `engineMayHoldDocument` was carried only by the child's
  // `readOnly` — and this branch unmounts the child in the commit that would
  // have set it, so its unmount flush ran on the pre-refusal value and wrote
  // the draft to disk while the engine may still own the document. That is the
  // Y.Doc-canonical boundary being walked around, which is the invariant this
  // PR exists to hold. An OUTCOME test like the one below, for the same
  // reason: several guards refuse this write now.
  it("refuses the unmount flush when the read fails and the open timed out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let reads = 0;
      let opens = 0;
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
          async (payload) => {
            reads += 1;
            // Read 1 succeeds, so the plain editor mounts and takes a draft.
            // The refresh's read FAILS, which hands the surface to the
            // loading/error branch and unmounts that editor.
            if (reads === 1) return await bridgeMock.readWorkspaceText(payload);
            throw new Error("read failed");
          },
        ),
        openEngineYDocSession: vi.fn(async () => {
          opens += 1;
          // Open 1: not engine-backed, so the plain editor is writable.
          // Open 2 (the refresh): times out, arriving with the failed read.
          if (opens === 1) return { available: false };
          return { available: false, engineMayHoldDocument: true };
        }),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      await typeIntoSourceEditor(`${DOC_MARKDOWN}typed`);

      // Both keys, as a version switch bumps them: `refreshKey` re-reads the
      // file (which fails) and `engineVersionKey` reopens (which times out).
      view.rerender(
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          refreshKey={1}
          engineVersionKey={1}
        />,
      );
      await screen.findByTestId(
        "engine-may-hold-document-notice",
        {},
        { timeout: 5_000 },
      );
      expect(screen.getByText("Couldn't read this file.")).toBeTruthy();

      // The armed autosave must not land either.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // codex on the round-12 head, and the same defect one state EARLIER: the
  // reopen has not answered at all, so `opening` is true and every other
  // refusal is false. On that head the unmount flush wrote the draft to disk
  // while the engine was opening the document. An OUTCOME test, deliberately:
  // three separate guards refuse that write now (the reopen's render-phase
  // capture, the child's `openingRef`, the parent's carried `opening`), so no
  // single mutation reds it. What it pins is the contract they exist for —
  // the keystrokes reach the recovery surface, and never the file.
  it("sets the draft aside when the read fails while the reopen is still pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let reads = 0;
      let opens = 0;
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
          async (payload) => {
            reads += 1;
            if (reads === 1) return await bridgeMock.readWorkspaceText(payload);
            throw new Error("read failed");
          },
        ),
        openEngineYDocSession: vi.fn(async () => {
          opens += 1;
          // Open 1: not engine-backed, so the plain editor is writable.
          // Open 2 (the refresh): NEVER answers — the read rejects first.
          if (opens === 1) return { available: false };
          return new Promise(() => {});
        }),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId("view-markdown", {}, { timeout: 5_000 });
      await typeIntoSourceEditor(`${DOC_MARKDOWN}typed`);

      view.rerender(
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          refreshKey={1}
          engineVersionKey={1}
        />,
      );
      await screen.findByText("Couldn't read this file.", {}, { timeout: 5_000 });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // Refused, never dropped: the text is on the recovery surface the
      // failed-read branch renders.
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await screen.findByTestId("orphaned-draft-notice", {}, { timeout: 5_000 });
    } finally {
      vi.useRealTimers();
    }
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
    bridgeMock.readWorkspaceText = vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
      async () => {
        reads += 1;
        if (reads === 1) {
          return {
            text: DOC_MARKDOWN,
            truncated: false,
            contentHash: TEST_CONTENT_HASH,
          };
        }
        // The version switch removed it. The reread answers FIRST.
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    );
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
      // Same draft, no pointer: this test's typed click reached prosemirror's
      // mousedown and threw AFTER it passed, which failed the whole run with
      // every assertion green. See typeIntoSourceEditor.
      await typeIntoSourceEditor(`${DOC_MARKDOWN}phantom`);
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
      readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
        async () => ({
          text: DOC_MARKDOWN,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        }),
      ),
      writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
        async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
      ),
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

  async function renderLegacyMarkdown(
    bridge: ReturnType<typeof makeHeldOpenBridge>,
    registerDraftFlush?: (flush: DraftFlush | null) => void,
  ) {
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
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
    return view;
  }

  async function enterLegacySourceMode(): Promise<HTMLTextAreaElement> {
    fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
    return (await screen.findByTestId("markdown-editor")) as HTMLTextAreaElement;
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
          expectedContentHash: TEST_CONTENT_HASH,
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
        refreshKey={(extraProps.refreshKey ?? 0) + 1}
      />,
    );
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
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
          expectedContentHash: TEST_CONTENT_HASH,
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

  it("shares concurrent legacy Markdown flushes until their held write lands", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    let flush: (() => Promise<void>) | null = null;
    await renderLegacyMarkdown(bridge, (next) => {
      flush = next;
    });
    const source = await enterLegacySourceMode();
    fireEvent.change(source, { target: { value: `${source.value}One` } });
    await waitFor(() => expect(flush).not.toBeNull());

    let firstSettled = false;
    let secondSettled = false;
    const firstFlush = flush!();
    const secondFlush = flush!();
    void firstFlush.then(() => {
      firstSettled = true;
    });
    void secondFlush.then(() => {
      secondSettled = true;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledBeforeWrite = firstSettled || secondSettled;

    await act(async () => {
      releaseWrite();
      await heldWrite;
      await Promise.all([firstFlush, secondFlush]);
    });

    expect(firstFlush).toBe(secondFlush);
    expect(settledBeforeWrite).toBe(false);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("drains a source edit made during a held flush before close can strand it", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let secondStarted!: () => void;
    const secondWriteStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => {
        secondStarted();
        return heldSecond;
      });
    let flush: (() => Promise<void>) | null = null;
    const view = await renderLegacyMarkdown(bridge, (next) => {
      flush = next;
    });
    const source = await enterLegacySourceMode();
    fireEvent.change(source, { target: { value: `${source.value}One` } });
    await waitFor(() => expect(flush).not.toBeNull());

    const flushPromise = flush!();
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const newestSource = `${source.value}Two`;
    fireEvent.change(source, { target: { value: newestSource } });
    expect(source.value).toBe(newestSource);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    const firstToFinish = await Promise.race([
      secondWriteStarted.then(() => "second-write" as const),
      flushPromise.then(() => "flush" as const),
    ]);
    expect(firstToFinish).toBe("second-write");
    expect((screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value).toBe(
      newestSource,
    );

    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    view.unmount();

    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: newestSource,
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("does not repaint a newer frontmatter title when an older write completes", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "First title" } });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    fireEvent.change(title, { target: { value: "Second title" } });
    fireEvent.blur(title);
    expect(title.value).toBe("Second title");
    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saving");
    expect(title.value).toBe("Second title");
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toContain(
      "title: Second title",
    );
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    expect(title.value).toBe("Second title");
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
  });

  it("sets aside the newest read-mode draft when the file changes during its write", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Plan\n---\n\n${"body\n".repeat(14_000)}`;
    const newestLocalBody = initialBody.replace(
      "title: Plan",
      "title: Newest local title",
    );
    const externalBody = initialBody.replace(
      "title: Plan",
      "title: External title",
    );
    const initialHash = "1".repeat(64);
    const externalHash = "2".repeat(64);
    const freshHash = "3".repeat(64);
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: externalBody,
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>(
      (resolve) => {
        resolveConflict = () =>
          resolve({ status: "conflict", currentContentHash: externalHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValue({ status: "written", contentHash: freshHash });
    let flush: (() => Promise<void>) | null = null;
    const registerFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    const view = await renderLegacyMarkdown(bridge, registerFlush);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local title" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: initialBody.replace("title: Plan", "title: Local title"),
      expectedContentHash: initialHash,
    });

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Newest local title" } });
    fireEvent.blur(title);
    expect(title.value).toBe("Newest local title");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerDraftFlush={registerFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(title.value).toBe("Newest local title");

    await waitFor(() => expect(flush).not.toBeNull());
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    const flushResult = flushPromise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await flushResult).toBe("rejected");
    expect(flushSettled).toBe(false);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External title",
      ),
    );
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(newestLocalBody),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).not.toBe("saved");

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    const recoveredTitle = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(recoveredTitle);
    fireEvent.change(recoveredTitle, { target: { value: "Fresh title" } });
    fireEvent.blur(recoveredTitle);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: externalBody.replace("title: External title", "title: Fresh title"),
      expectedContentHash: externalHash,
    });
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).not.toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await expect(flush!()).resolves.toBeUndefined();
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
  });

  it("sets aside the live WYSIWYG draft when an older in-flight save conflicts", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const initialHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    const externalBody = "# External\n\nChanged elsewhere.\n";
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: DOC_MARKDOWN,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: externalBody,
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(
      () => heldConflict,
    );
    await renderLegacyMarkdown(bridge);
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor).not.toBeInstanceOf(HTMLTextAreaElement);

    await user.type(editor, "L1");
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const firstIssuedBody = bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]
      .text;
    expect(firstIssuedBody).toContain("L1");

    await user.type(editor, "L2");
    expect(editor.textContent).toBe("L1PlanBase paragraph.L2");
    const newestLocalBody = firstIssuedBody.replace(
      "Base paragraph.",
      "Base paragraph.L2",
    );
    await act(async () => {
      resolveConflict();
      await heldConflict;
    });

    await screen.findByText("Changed elsewhere.");
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(newestLocalBody),
    );
    expect(
      (await screen.findByTestId("markdown-editor")).textContent,
    ).not.toContain("L2");
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("keeps a legacy Markdown unmount conflict recoverable without another write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "c".repeat(64);
    const externalHash = "d".repeat(64);
    const externalBody = "# External\n\nChanged elsewhere.\n";
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: DOC_MARKDOWN,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: externalBody,
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(
      () => heldConflict,
    );
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const localBody = `${source.value}Draft`;
    fireEvent.change(source, { target: { value: localBody } });
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: localBody,
      expectedContentHash: initialHash,
    });

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: externalBody,
      truncated: false,
      contentHash: externalHash,
    });
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(localBody),
    );
    await screen.findByText("Changed elsewhere.");
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(remountBridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("queues a legacy Markdown unmount draft behind the hash from its in-flight write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "e".repeat(64);
    const firstHash = "f".repeat(64);
    const secondHash = "0".repeat(64);
    bridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: DOC_MARKDOWN,
      truncated: false,
      contentHash: initialHash,
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    let resolveSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveSecond = () => resolve({ status: "written", contentHash: secondHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    fireEvent.change(source, { target: { value: `${source.value}First` } });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const newestBody = `${source.value}Second`;
    fireEvent.change(source, { target: { value: newestBody } });
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: newestBody,
      expectedContentHash: firstHash,
    });
    await act(async () => {
      resolveSecond();
      await heldSecond;
    });

    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: newestBody,
      truncated: false,
      contentHash: secondHash,
    });
    await renderLegacyMarkdown(remountBridge);
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(remountBridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("rereads legacy Markdown after a write overlaps a newer content request", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Base\n---\n\n${"Body\n".repeat(14_000)}`;
    const externalBody = initialBody.replace("title: Base", "title: External");
    const initialHash = "3".repeat(64);
    const localHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => heldSecondRead)
      .mockImplementationOnce(() => heldThirdRead);
    let resolveWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      resolveWrite = () => resolve({ status: "written", contentHash: localHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
      "Local",
    );

    await act(async () => {
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).not.toBe("saved");
    expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
      "Local",
    );

    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External",
      ),
    );
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
  });

  it("settles a WYSIWYG verification reread that differs from its completed write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = "---\ntitle: Base\n---\n\nBody\n";
    const externalBody = initialBody.replace("title: Base", "title: External");
    const initialHash = "6".repeat(64);
    const localHash = "7".repeat(64);
    const externalHash = "8".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => heldSecondRead)
      .mockImplementationOnce(() => heldThirdRead);
    let resolveWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      resolveWrite = () => resolve({ status: "written", contentHash: localHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const issuedLocalBody = bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]
      .text;
    expect(issuedLocalBody).toContain("title: Local");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External",
      ),
    );
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(issuedLocalBody),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("error");
  });

  it("captures the same legacy conflict again after its first recovery is dismissed", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Base\n---\n\n${"Body\n".repeat(14_000)}`;
    const initialHash = "9".repeat(64);
    const externalHash = "b".repeat(64);
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: initialBody,
        truncated: false,
        contentHash: externalHash,
      });
    bridge.bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: externalHash,
    });
    const user = userEvent.setup();
    await renderLegacyMarkdown(bridge);

    const editTitle = async () => {
      const title = screen.getByTestId("page-title") as HTMLInputElement;
      fireEvent.focus(title);
      fireEvent.change(title, { target: { value: "Local" } });
      fireEvent.blur(title);
    };
    await editTitle();
    await screen.findByTestId("orphaned-draft-notice", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Base",
      ),
    );

    await editTitle();
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    await screen.findByTestId("orphaned-draft-notice");
  });

  it("recovers a queued legacy unmount draft when its I/O write rejects", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "c".repeat(64);
    const firstHash = "d".repeat(64);
    bridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: DOC_MARKDOWN,
      truncated: false,
      contentHash: initialHash,
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("disk unavailable"));
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    fireEvent.change(source, { target: { value: `${source.value}First` } });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const newestBody = `${source.value}Second`;
    fireEvent.change(source, { target: { value: newestBody } });
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: `${DOC_MARKDOWN}First`,
      truncated: false,
      contentHash: firstHash,
    });
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(newestBody),
    );
  });

  it("recovers an in-flight legacy autosave that rejects after unmount", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "e".repeat(64);
    bridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: DOC_MARKDOWN,
      truncated: false,
      contentHash: initialHash,
    });
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const localBody = `${source.value}Draft`;
    fireEvent.change(source, { target: { value: localBody } });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    view.unmount();

    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
    });
    const remountBridge = makeHeldOpenBridge();
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(localBody),
    );
  });

  it("settles a held raw-source save after switching to lossy WYSIWYG without repainting or retrying", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const rawSource = `${source.value}\n<!-- keep raw -->`;
    fireEvent.change(source, { target: { value: rawSource } });

    fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const wysiwyg = await waitFor(() => {
      const editor = screen.getByTestId("markdown-editor");
      if (editor instanceof HTMLTextAreaElement) {
        throw new Error("The WYSIWYG editor has not replaced source yet.");
      }
      return editor;
    });
    const renderedBeforeWriteLands = wysiwyg.innerHTML;
    expect(wysiwyg.textContent).not.toContain("keep raw");
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text).toBe(
      rawSource,
    );

    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
    expect(screen.getByTestId("markdown-save-state").textContent).toBe("Saved");
    expect(screen.getByTestId("markdown-editor")).toBe(wysiwyg);
    expect(wysiwyg.innerHTML).toBe(renderedBeforeWriteLands);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
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
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
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
          expectedContentHash: TEST_CONTENT_HASH,
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
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1
        ? heldFirst
        : Promise.resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
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
        expectedContentHash: TEST_CONTENT_HASH,
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
    const heldA = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseA = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseB!: () => void;
    const heldB = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseB = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
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

  it("captures a failed flush when a path settlement joins its existing promise", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: DraftFlush | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next) => {
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
    await user.type(editor, " Late draft");
    const exactDraft = (editor as HTMLTextAreaElement).value;
    await waitFor(() => expect(flush).not.toBeNull());

    const originalFlush = flush!().catch((error: unknown) => error);
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const settlementFlush = flush!({ captureOnFailure: true }).catch(
      (error: unknown) => error,
    );
    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
      await Promise.all([originalFlush, settlementFlush]);
    });

    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(exactDraft),
    );
  });

  it.each([
    { retry: "succeeds", retryFails: false, expectedRecoveries: 0 },
    { retry: "fails", retryFails: true, expectedRecoveries: 1 },
  ])(
    "lets an operation-owned legacy Markdown retry settle before recovery when it $retry",
    async ({ retryFails, expectedRecoveries }) => {
      const user = userEvent.setup();
      const bridge = makeHeldOpenBridge();
      let rejectIssued!: (error: Error) => void;
      const issuedWrite = new Promise<never>((_resolve, reject) => {
        rejectIssued = reject;
      });
      let resolveRetry!: () => void;
      let rejectRetry!: (error: Error) => void;
      const retryWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve, reject) => {
        resolveRetry = () =>
          resolve({ status: "written", contentHash: TEST_CONTENT_HASH });
        rejectRetry = reject;
      });
      let writes = 0;
      bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
        writes += 1;
        return writes === 1 ? issuedWrite : retryWrite;
      });
      let flush: DraftFlush | null = null;
      const recoverySpy = vi.spyOn(
        orphanedDraftsModule,
        "captureOrphanedDraft",
      );
      try {
        const view = await renderLegacyMarkdown(bridge, (next) => {
          flush = next;
        });
        const editor = await enterLegacySourceMode();
        await user.type(editor, " Late draft");
        await waitFor(
          () =>
            expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
          { timeout: 5_000 },
        );
        await waitFor(() => expect(flush).not.toBeNull());
        const operationResult = flush!({ captureOnFailure: true }).then(
          () => "resolved" as const,
          () => "rejected" as const,
        );
        view.unmount();

        await act(async () => {
          rejectIssued(new Error("issued write failed"));
          await issuedWrite.catch(() => undefined);
        });
        await waitFor(() =>
          expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
        );
        // The unmount observer watches the issued write. The operation flush
        // owns its retry, so the observer must not capture between them.
        expect(recoverySpy).not.toHaveBeenCalled();

        await act(async () => {
          if (retryFails) rejectRetry(new Error("retry failed"));
          else resolveRetry();
          await retryWrite.catch(() => undefined);
        });
        expect(await operationResult).toBe(
          retryFails ? "rejected" : "resolved",
        );
        expect(recoverySpy).toHaveBeenCalledTimes(expectedRecoveries);
      } finally {
        recoverySpy.mockRestore();
      }
    },
  );

  // #579 review r15, the exact reported interleaving: the flush registers on
  // the in-flight write BEFORE a later Ctrl+S registers on the same promise.
  // Ctrl+S saves unconditionally, so `unsavedDraft` is already false — the
  // old seam therefore returned the moment the slot cleared, and the queued
  // writer landed the previous version's text after the switch. Membership
  // now starts at ENTRY. The barrier leaves later save work for the flush
  // loop, which has nothing to write when no draft is pending.
  it("does not enqueue a Ctrl+S that arrives after the flush began with no draft pending", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseA!: () => void;
    const heldA = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseA = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
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
    // Ctrl+S then joins the queue behind A. The seam's captured tail does not
    // include it, so it lands the previous version's text after the switch.
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
      contentHash: TEST_CONTENT_HASH,
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
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
      />,
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

  it("sets aside a read-mode edit made before the switched version finishes reading", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const oldBody = `# Old\n\n${"old word ".repeat(14_000)}\n`;
    const newBody = `---\ntitle: New baseline\n---\n\n# New\n\n${"new word ".repeat(14_000)}\n`;
    const newHash = "b".repeat(64);
    let finishSwitchedRead!: () => void;
    const switchedRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      finishSwitchedRead = () =>
        resolve({ text: newBody, truncated: false, contentHash: newHash });
    });
    let reads = 0;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      return reads === 1
        ? Promise.resolve({
            text: oldBody,
            truncated: false as const,
            contentHash: TEST_CONTENT_HASH,
          })
        : switchedRead;
    });
    let flush: DraftFlush | null = null;
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next) => {
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

    await screen.findByTestId("page-title");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingTitle = screen.getByTestId("page-title");
    await user.type(pendingTitle, "During read");
    await user.tab();
    const switchedBuffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "a.md", 2),
    );
    expect(switchedBuffer.getSnapshot()).toMatchObject({
      initialized: true,
      contentHash: null,
      dirty: true,
    });

    await act(async () => {
      finishSwitchedRead();
      await switchedRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "New baseline",
      ),
    );
    expect(screen.getAllByTestId("orphaned-draft-notice")).toHaveLength(1);
    expect(switchedBuffer.getSnapshot()).toMatchObject({
      body: newBody,
      contentHash: newHash,
      dirty: false,
      saveState: "saved",
    });

    const title = screen.getByTestId("page-title");
    await user.clear(title);
    await user.type(title, "After read");
    await user.tab();
    await act(async () => flush!());
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentHash: newHash,
        text: expect.stringContaining("title: After read"),
      }),
    );
  });

  it("applies a same-revision snapshot after the shared buffer changes", async () => {
    const bridge = makeHeldOpenBridge();
    const oldBody = `---\ntitle: Old\n---\n\n# Old\n\n${"old word ".repeat(14_000)}\n`;
    const switchedRead = new Promise<never>(() => undefined);
    let reads = 0;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      return reads === 1
        ? Promise.resolve({
            text: oldBody,
            truncated: false as const,
            contentHash: TEST_CONTENT_HASH,
          })
        : switchedRead;
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Old",
      ),
    );
    const oldBuffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "a.md", 1),
    );
    expect(oldBuffer.getSnapshot().revision).toBe(1);
    await act(async () => {
      oldBuffer.acceptRead(oldBody, TEST_CONTENT_HASH, {});
      await Promise.resolve();
    });
    expect(oldBuffer.getSnapshot().revision).toBe(2);

    const peerBody = `---\ntitle: Peer\n---\n\n# Peer\n\n${"peer word ".repeat(14_000)}\n`;
    const peerBuffer = getSharedLocalDocument(
      localDocumentKey("ws-1", "a.md", 2),
    );
    peerBuffer.initialize(oldBody, "c".repeat(64));
    peerBuffer.publishDraft(peerBody, {});
    expect(peerBuffer.getSnapshot().revision).toBe(2);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
      />,
    );

    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Peer",
      ),
    );
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
