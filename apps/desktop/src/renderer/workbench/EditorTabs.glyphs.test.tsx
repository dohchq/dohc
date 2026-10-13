// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { editorTabTestId } from "../../testPins";
import { EditorTabs } from "./EditorTabs";
import {
  CHATS_TAB_PATH,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  chatTabPath,
  collectionTabPath,
  momentDiffTabPath,
  siteTabPath,
  transactionalCollectionTabPath,
  versionCompareTabPath,
} from "./workbenchState";

// Counts file-glyph renders, so a test can see which tabs re-rendered.
const fileGlyphs = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../ui/KindGlyph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/KindGlyph")>();
  return {
    ...actual,
    FileGlyph: (props: ComponentProps<typeof actual.FileGlyph>) => {
      fileGlyphs.renders += 1;
      return actual.FileGlyph(props);
    },
  };
});

afterEach(cleanup);

const noop = () => {};

function strip(paths: string[], options: { active?: string; dirty?: boolean; files?: WorkspaceFileEntry[]; onActivate?: (groupId: string, path: string) => void } = {}) {
  return (
    <EditorTabs
      groupId="left"
      groupNumber={1}
      tabs={paths.map((path) => ({ path }))}
      activeTab={options.active ?? paths[0] ?? null}
      activeTabDirty={options.dirty ?? false}
      recoveryPaths={new Set<string>()}
      files={options.files ? new Map(options.files.map((file) => [file.path, file])) : undefined}
      onActivate={options.onActivate ?? noop}
      onClose={noop}
      onContextMenu={noop}
      onMove={noop}
      onMoveToGroup={noop}
      onCreateGroupRight={noop}
    />
  );
}

// The tab's own glyph: every svg but the close button's.
function glyphOf(path: string): Element | null {
  return screen.getByTestId(editorTabTestId(path)).querySelector("svg:not(.lucide-x)");
}

const KIND_GLYPHS: Array<[string, string]> = [
  ["plan.md", "file-text"],
  ["budget.csv", "file-spreadsheet"],
  ["flow.excalidraw", "pen-tool"],
  ["app.ts", "file-code"],
  [siteTabPath("apps/trip"), "app-window"],
  [collectionTabPath("people"), "table-2"],
  [transactionalCollectionTabPath("data/dataset.json", "00000000-0000-4000-8000-000000000002"), "table-2"],
  [chatTabPath({ kind: "channel", id: "trip" }), "hash"],
  [CHATS_TAB_PATH, "message-circle"],
  [chatTabPath({ kind: "new" }), "message-circle"],
  [chatTabPath({ kind: "dm", id: "person one" }), "message-circle"],
  [versionCompareTabPath("try"), "layers"],
  [momentDiffTabPath("moment"), "file-diff"],
  [GRAPH_TAB_PATH, "workflow"],
  // lucide's History, the rail's glyph.
  [HISTORY_TAB_PATH, "rotate-ccw-clock"],
];

describe("EditorTabs glyphs", () => {
  it.each(KIND_GLYPHS)("draws %s with the %s glyph, decoratively", (path, glyph) => {
    render(strip([path]));
    const mark = glyphOf(path);
    expect(mark?.classList.contains(`lucide-${glyph}`)).toBe(true);
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a database from the listing, not the extension", () => {
    render(strip(["ledger.db", "notes.db", "cache.sqlite"], {
      files: [
        { path: "ledger.db", kind: "database" },
        { path: "notes.db", kind: "file" },
      ],
    }));
    expect(glyphOf("ledger.db")?.classList.contains("lucide-database")).toBe(true);
    expect(glyphOf("notes.db")?.classList.contains("lucide-file")).toBe(true);
    expect(glyphOf("cache.sqlite")?.classList.contains("lucide-file")).toBe(true);
  });

  it("draws a page's emoji in place of its glyph, without renaming the tab", () => {
    render(strip(["plan.md"], { files: [{ path: "plan.md", kind: "file", icon: "🧭" }] }));
    const tab = screen.getByRole("tab", { name: "plan.md" });
    expect(glyphOf("plan.md")).toBeNull();
    expect(within(tab).getByText("🧭").getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps each tab's and menu row's name, role and test id", () => {
    const paths = ["plan.md", collectionTabPath("people"), GRAPH_TAB_PATH];
    render(strip(paths, { files: [{ path: "plan.md", kind: "file", icon: "🧭" }] }));
    const names = ["plan.md", "people", "Graph"];
    for (const [index, path] of paths.entries()) {
      expect(screen.getByRole("tab", { name: names[index] }).dataset.testid).toBe(editorTabTestId(path));
    }
    fireEvent.click(screen.getByRole("button", { name: "All tabs in editor group 1" }));
    for (const name of names) expect(screen.getByRole("menuitem", { name })).toBeTruthy();
  });

  it("draws each tab's glyph in the overflow menu", () => {
    render(strip(["budget.csv", siteTabPath("apps/trip"), chatTabPath({ kind: "channel", id: "trip" })]));
    fireEvent.click(screen.getByRole("button", { name: "All tabs in editor group 1" }));
    const glyphs = screen.getAllByRole("menuitem").map((row) => row.querySelector("svg")?.getAttribute("class") ?? "");
    expect(glyphs[0]).toContain("lucide-file-spreadsheet");
    expect(glyphs[1]).toContain("lucide-app-window");
    expect(glyphs[2]).toContain("lucide-hash");
    // Ink on the current row's selected fill, subtle on the rest, as
    // Explorer's open editors tone the same glyph.
    expect(glyphs[0]).toContain("text-ink");
    expect(glyphs[1]).toContain("text-subtle");
    expect(glyphs[2]).toContain("text-subtle");
  });

  it("leaves a press on the glyph or emoji to the tab, which activates it and arms its drag", () => {
    const onActivate = vi.fn();
    render(strip(["a.md", "b.md", "launch.md"], { onActivate, files: [{ path: "launch.md", kind: "file", icon: "🚀" }] }));
    const glyph = glyphOf("b.md");
    if (!glyph) throw new Error("no glyph");
    fireEvent.pointerDown(glyph, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    expect(onActivate).toHaveBeenLastCalledWith("left", "b.md");
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 20, clientY: 0 });
    expect(screen.getByTestId(editorTabTestId("b.md")).dataset.dragging).toBe("");
    fireEvent.pointerUp(window, { pointerId: 1 });
    const emoji = within(screen.getByTestId(editorTabTestId("launch.md"))).getByText("🚀");
    fireEvent.pointerDown(emoji, { button: 0, pointerId: 2 });
    expect(onActivate).toHaveBeenLastCalledWith("left", "launch.md");
    fireEvent.pointerUp(window, { pointerId: 2 });
  });

  it("re-renders only the active tab when its dirty state flips", () => {
    const paths = ["a.md", "b.md", "c.md"];
    const files: WorkspaceFileEntry[] = paths.map((path) => ({ path, kind: "file" }));
    const { rerender } = render(strip(paths, { active: "b.md", files }));
    const before = fileGlyphs.renders;
    rerender(strip(paths, { active: "b.md", dirty: true, files }));
    expect(fileGlyphs.renders - before).toBe(1);
    expect(screen.getByTestId(editorTabTestId("b.md")).querySelector('[data-testid="tab-dirty"]')).not.toBeNull();
  });
});
