// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorTabTestId } from "../../testPins";
import { EditorTabs } from "./EditorTabs";

afterEach(cleanup);

const noop = () => {};

function strip(options: { dirty?: boolean; recovery?: string[]; onClose?: (groupId: string, path: string) => void } = {}) {
  return (
    <EditorTabs
      groupId="left"
      groupNumber={1}
      tabs={[{ path: "plan.md" }, { path: "notes.md" }]}
      activeTab="plan.md"
      activeTabDirty={options.dirty ?? false}
      recoveryPaths={new Set(options.recovery ?? [])}
      onActivate={noop}
      onClose={options.onClose ?? noop}
      onContextMenu={noop}
      onMove={noop}
      onMoveToGroup={noop}
      onCreateGroupRight={noop}
    />
  );
}

const tabOf = (path: string) => screen.getByTestId(editorTabTestId(path));
const closeOf = (path: string) => within(tabOf(path)).getByRole("button", { name: `Close ${path}` });
const classes = (el: Element) => el.className.split(/\s+/);

describe("EditorTabs unsaved dot", () => {
  // jsdom has no layout, so the width is read from the structure: an unsaved
  // tab lays out the same boxes as a saved one, with no box before its glyph,
  // and its dot sits inside the close's 16px slot, which a saved tab has too.
  it("keeps an unsaved tab as wide as a saved one", () => {
    const boxes = (tab: HTMLElement) => [...tab.children].map((child) => `${child.tagName} ${child.className}`);
    const { rerender } = render(strip());
    const saved = boxes(tabOf("plan.md"));
    rerender(strip({ dirty: true }));
    const tab = tabOf("plan.md");
    expect(boxes(tab)).toEqual(saved);
    const dot = within(tab).getByTestId("tab-dirty");
    const slot = closeOf("plan.md").parentElement;
    expect(dot.parentElement).toBe(slot);
    expect(slot).toBe(tab.lastElementChild);
    expect(classes(slot!)).toEqual(expect.arrayContaining(["size-4", "shrink-0"]));
  });

  it("swaps the dot for the close on hover and keyboard focus, in the same slot", () => {
    render(strip({ dirty: true }));
    const tab = tabOf("plan.md");
    const dot = within(tab).getByTestId("tab-dirty");
    const close = closeOf("plan.md");
    expect(classes(tab)).toContain("group/tab");
    // Both fill the slot's one cell.
    expect(classes(dot)).toContain("[grid-area:1/1]");
    expect(classes(close)).toContain("[grid-area:1/1]");
    // The close starts hidden, and each state that shows it hides the dot.
    expect(classes(close)).toContain("opacity-0");
    for (const state of ["group-hover/tab", "keyboard:group-focus-visible/tab"]) {
      expect(classes(dot)).toContain(`${state}:opacity-0`);
      expect(classes(close)).toContain(`${state}:opacity-100`);
    }
    expect(classes(close)).toContain("focus:opacity-100");
    expect(classes(dot)).toContain("group-has-[:focus]/tab:opacity-0");
    // The pointer on the close still fills it, and the swap is instant.
    expect(classes(close)).toContain("hover:bg-hover");
    expect(`${dot.className} ${close.className}`).not.toContain("transition");
    // The dot takes no press, so the close under it gets the click.
    expect(classes(dot)).toContain("pointer-events-none");

    // A saved tab is as it was: the active one shows its close, and an
    // inactive one shows it on hover or focus.
    cleanup();
    render(strip());
    expect(classes(closeOf("plan.md"))).not.toContain("opacity-0");
    expect(classes(closeOf("notes.md"))).toEqual(
      expect.arrayContaining(["opacity-0", "focus:opacity-100", "group-hover:opacity-100"]),
    );
  });

  it("shows the dot in the close's slot on an inactive tab that holds recovered changes", () => {
    render(strip({ recovery: ["notes.md"] }));
    const tab = tabOf("notes.md");
    const dot = within(tab).getByTestId("tab-dirty");
    expect(dot.parentElement).toBe(tab.lastElementChild);
    expect(dot.parentElement).toBe(closeOf("notes.md").parentElement);
    expect(within(tabOf("plan.md")).queryByTestId("tab-dirty")).toBeNull();
  });

  it("keeps the unsaved state in the tab's name and still closes the tab", () => {
    const onClose = vi.fn();
    render(strip({ dirty: true, onClose }));
    const tab = tabOf("plan.md");
    // An image, so every browser reads its label into the tab's name. ARIA
    // names no span that has no role.
    expect(within(tab).getByRole("img", { name: "Unsaved changes" })).toBe(within(tab).getByTestId("tab-dirty"));
    expect(screen.getByRole("tab", { name: /Unsaved changes/ })).toBe(tab);
    fireEvent.click(closeOf("plan.md"));
    expect(onClose).toHaveBeenLastCalledWith("left", "plan.md");
    fireEvent.keyDown(tab, { key: "Delete" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
