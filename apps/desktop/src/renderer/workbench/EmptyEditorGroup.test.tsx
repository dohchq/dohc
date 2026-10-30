// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_KIND_RECORDS } from "@dohc/workspace-contracts/kinds";
import { SHORTCUTS } from "../../shortcuts/shortcutRegistry";
import { fileName } from "./EditorTabs";
import { EmptyEditorGroup } from "./EmptyEditorGroup";

afterEach(cleanup);

// File tiles carry the kind registry's names.
const DOCUMENT = FILE_KIND_RECORDS.markdown.name;
const LABELS = { markdown: DOCUMENT, collection: "Collection", drawing: FILE_KIND_RECORDS.drawing.name };

const FILES = [
  { path: "a.md", kind: "file" as const },
  { path: "Lisbon trip/Trip plan.md", kind: "file" as const },
  { path: "sketch.excalidraw", kind: "file" as const },
];

function renderStart(overrides: Partial<Parameters<typeof EmptyEditorGroup>[0]> = {}) {
  const props = {
    platform: "win32",
    create: { markdown: vi.fn(), collection: vi.fn(), drawing: vi.fn() },
    recent: [],
    files: FILES,
    onOpen: vi.fn(),
    ...overrides,
  };
  render(<EmptyEditorGroup {...props} />);
  return props;
}

describe("start surface tiles", () => {
  it.each(["markdown", "collection", "drawing"] as const)("runs the %s action from its tile", async (kind) => {
    const { create } = renderStart();
    fireEvent.click(screen.getByRole("button", { name: LABELS[kind] }));
    expect(create[kind]).toHaveBeenCalledOnce();
    for (const other of Object.keys(create) as (keyof typeof create)[]) {
      if (other !== kind) expect(create[other]).not.toHaveBeenCalled();
    }
  });

  it("shows only the kinds the workspace can make, in order", () => {
    renderStart({ create: { drawing: vi.fn(), markdown: vi.fn() } });
    expect(screen.getAllByRole("button").map((tile) => tile.textContent)).toEqual([`${DOCUMENT}Ctrl N`, LABELS.drawing]);
  });

  it.each([
    ["win32", "Ctrl N", "Control+N"],
    ["darwin", "⌘N", "Meta+N"],
  ])("labels the document tile with the registry's new-file chord on %s", (platform, text, aria) => {
    renderStart({ platform });
    const tile = screen.getByRole("button", { name: DOCUMENT });
    expect(tile.textContent).toBe(`${DOCUMENT}${text}`);
    expect(tile.getAttribute("aria-keyshortcuts")).toBe(aria);
  });

  it("follows a changed new-file binding", () => {
    const accelerators = SHORTCUTS["new-file"].accelerators;
    const original = accelerators[0];
    Reflect.set(accelerators, "0", "CommandOrControl+Shift+M");
    try {
      renderStart();
      const tile = screen.getByRole("button", { name: DOCUMENT });
      expect(tile.textContent).toBe(`${DOCUMENT}Ctrl Shift M`);
      expect(tile.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+M");
    } finally {
      Reflect.set(accelerators, "0", original);
    }
  });

  it("reaches each tile with Tab and runs it with Enter or Space", async () => {
    const user = userEvent.setup();
    const { create } = renderStart();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: DOCUMENT }));
    await user.keyboard("{Enter}");
    expect(create.markdown).toHaveBeenCalledOnce();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collection" }));
    await user.keyboard(" ");
    expect(create.collection).toHaveBeenCalledOnce();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: LABELS.drawing }));
  });

  it("ignores presses while an action is still running", async () => {
    let finish = () => {};
    const drawing = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const markdown = vi.fn();
    renderStart({ create: { drawing, markdown } });

    fireEvent.click(screen.getByRole("button", { name: LABELS.drawing }));
    fireEvent.click(screen.getByRole("button", { name: LABELS.drawing }));
    fireEvent.click(screen.getByRole("button", { name: DOCUMENT }));
    expect(drawing).toHaveBeenCalledOnce();
    expect(markdown).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: LABELS.drawing }));
      expect(drawing).toHaveBeenCalledTimes(2);
    });
  });
});

describe("start surface recent", () => {
  it("lists listed recent files, most recent first, by their tab names, and opens one", () => {
    const { onOpen } = renderStart({ recent: ["sketch.excalidraw", "gone.md", "tab://collection/c1", "Lisbon trip/Trip plan.md"] });
    const recent = within(screen.getByRole("region", { name: "Recent" }));
    const rows = recent.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([fileName("sketch.excalidraw"), fileName("Lisbon trip/Trip plan.md")]);
    expect(rows[1]!.title).toBe("Lisbon trip/Trip plan.md");

    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("Lisbon trip/Trip plan.md");
  });

  it("shows at most five", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.md` }));
    renderStart({ files, recent: files.map((file) => file.path) });
    expect(within(screen.getByRole("region", { name: "Recent" })).getAllByRole("button")).toHaveLength(5);
  });

  it.each([
    ["no recent path", { recent: [] }],
    ["no listing yet", { recent: ["a.md"], files: null }],
  ])("is absent with %s", (_name, overrides) => {
    renderStart(overrides);
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
  });
});

describe("start surface drop zone", () => {
  const dropped = new File(["# Notes"], "notes.md");

  it("takes dropped files into an empty workspace", () => {
    const onDropFiles = vi.fn();
    renderStart({ files: [], onDropFiles });
    const zone = screen.getByTestId("start-drop");
    expect(zone.textContent).toBe("Drop files here to add them");

    const over = createEvent.dragOver(zone, { dataTransfer: { types: ["Files"], dropEffect: "none" } });
    fireEvent(zone, over);
    expect(over.defaultPrevented).toBe(true);

    fireEvent.drop(zone, { dataTransfer: { files: [dropped], types: ["Files"] } });
    expect(onDropFiles).toHaveBeenCalledExactlyOnceWith([dropped]);
  });

  it("leaves a drag without files alone", () => {
    renderStart({ files: [], onDropFiles: vi.fn() });
    const zone = screen.getByTestId("start-drop");
    const over = createEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"] } });
    fireEvent(zone, over);
    expect(over.defaultPrevented).toBe(false);
  });

  it.each([
    ["the workspace has files", { onDropFiles: vi.fn() }],
    ["the listing has not landed", { files: null, onDropFiles: vi.fn() }],
    ["the workspace takes no import", { files: [] }],
  ])("is absent when %s", (_name, overrides) => {
    renderStart(overrides);
    expect(screen.queryByTestId("start-drop")).toBeNull();
  });
});

it("says only to select a file where nothing can be made and nothing is recent", () => {
  renderStart({ create: {}, files: [] });
  expect(screen.getByTestId("start-surface").textContent).toBe("Select a file");
  expect(screen.queryByRole("button")).toBeNull();
});
