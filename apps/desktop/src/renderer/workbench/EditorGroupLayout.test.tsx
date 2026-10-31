// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFocusSurface } from "../ui/focusReturn";
import { EditorGroupLayout } from "./EditorGroupLayout";
import { EditorTabs } from "./EditorTabs";

afterEach(cleanup);

const noop = () => {};

// Groups with real tab strips, closed the way the shell closes them: a group
// in a split that loses its last tab collapses, and its right neighbour, or
// else its left one, becomes active.
function Workbench(props: { groups: { id: string; tabs: string[] }[]; active: string }) {
  const [groups, setGroups] = useState(props.groups);
  const [active, setActive] = useState(props.active);
  const root = useRef<HTMLDivElement>(null);
  useFocusSurface(root, () => null);
  const close = (groupId: string, path: string) => {
    const index = groups.findIndex((group) => group.id === groupId);
    const next = groups.map((group) =>
      group.id === groupId ? { ...group, tabs: group.tabs.filter((tab) => tab !== path) } : group);
    if (next[index].tabs.length > 0 || next.length === 1) return setGroups(next);
    const remaining = next.filter((group) => group.id !== groupId);
    setGroups(remaining);
    if (active === groupId) setActive((remaining[index] ?? remaining[index - 1]).id);
  };
  return (
    <div ref={root} data-focus-surface="workspace" tabIndex={-1}>
      <EditorGroupLayout
        groups={groups.map((group, index) => ({
          id: group.id,
          size: 1,
          content: (
            <EditorTabs groupId={group.id} groupNumber={index + 1} tabs={group.tabs.map((path) => ({ path }))}
              activeTab={group.tabs[0] ?? null} activeTabDirty={false} recoveryPaths={new Set<string>()}
              onActivate={noop} onClose={close} onContextMenu={noop} onMove={noop} onMoveToGroup={noop}
              onCreateGroupRight={noop} />
          ),
        }))}
        activeGroupId={active}
        onFocusGroup={setActive}
        onResizeGroups={noop}
      />
    </div>
  );
}

function renderLayout(onResizeGroups = vi.fn()) {
  const onFocusGroup = vi.fn();
  render(
    <EditorGroupLayout
      groups={[
        { id: "left", size: 1, content: <button type="button">Left editor</button> },
        { id: "right", size: 1, content: <button type="button">Right editor</button> },
      ]}
      activeGroupId="left"
      onFocusGroup={onFocusGroup}
      onResizeGroups={onResizeGroups}
    />,
  );
  return { onFocusGroup, onResizeGroups };
}

describe("EditorGroupLayout", () => {
  it("labels each group and focuses it from pointer, focus, and context-menu entry", () => {
    const { onFocusGroup } = renderLayout();
    const right = screen.getByRole("region", { name: "Editor group 2" });

    fireEvent.pointerDown(right);
    fireEvent.focus(screen.getByRole("button", { name: "Right editor" }));
    fireEvent.contextMenu(right);

    expect(onFocusGroup).toHaveBeenNthCalledWith(1, "right");
    expect(onFocusGroup).toHaveBeenNthCalledWith(2, "right");
    expect(onFocusGroup).toHaveBeenNthCalledWith(3, "right");
  });

  it("exposes each stable group ID for tab drag hit-testing", () => {
    renderLayout();

    expect(
      screen.getByRole("region", { name: "Editor group 1" }).dataset.editorGroupId,
    ).toBe("left");
    expect(
      screen.getByRole("region", { name: "Editor group 2" }).dataset.editorGroupId,
    ).toBe("right");
  });

  // EditorTabs reads the data attributes to mark the active group's strip,
  // and aria-current says the same to a screen reader.
  it("marks a split and its active group, and leaves a single group unmarked", () => {
    renderLayout();
    expect(screen.getByTestId("editor-group-layout").dataset.split).toBe("true");
    const [first, second] = [
      screen.getByRole("region", { name: "Editor group 1" }),
      screen.getByRole("region", { name: "Editor group 2" }),
    ];
    expect(first.dataset.active).toBe("true");
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(second.dataset.active).toBeUndefined();
    expect(second.getAttribute("aria-current")).toBeNull();
    cleanup();

    render(
      <EditorGroupLayout
        groups={[{ id: "only", size: 1, content: <button type="button">Editor</button> }]}
        activeGroupId="only"
        onFocusGroup={vi.fn()}
        onResizeGroups={vi.fn()}
      />,
    );
    expect(screen.getByTestId("editor-group-layout").dataset.split).toBeUndefined();
    const only = screen.getByRole("region", { name: "Editor group 1" });
    expect(only.getAttribute("aria-current")).toBeNull();
    // No frame around the group: the strip carries the mark in a split.
    expect(only.className).not.toContain("ring");
  });

  // The window edge and the neighbours cut off a halo painted outside the
  // group, and the tab strip covers one painted inset on the group itself.
  it("draws keyboard focus on a layer inside the group, in place of the global halo", () => {
    renderLayout();
    const classes = screen.getByRole("region", { name: "Editor group 1" }).className.split(" ");
    expect(classes).toEqual(expect.arrayContaining([
      "relative",
      "focus-visible:outline-none",
      "keyboard:focus-visible:after:absolute",
      "keyboard:focus-visible:after:inset-0",
      "keyboard:focus-visible:after:-outline-offset-1",
      "keyboard:focus-visible:after:outline-accent",
      "forced-colors:keyboard:focus-visible:after:outline-[Highlight]",
    ]));
  });

  it("focuses an emptied single group after a keyboard close of its last tab", async () => {
    render(<Workbench groups={[{ id: "only", tabs: ["a.md"] }]} active="only" />);
    screen.getByTestId("tab-a.md").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    const group = screen.getByRole("region", { name: "Editor group 1" });
    await waitFor(() => expect(document.activeElement).toBe(group));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(group.dataset.active).toBe("true");
  });

  it("hands focus and the active mark to the empty group a keyboard close leaves in a split", async () => {
    render(
      <Workbench
        groups={[{ id: "left", tabs: ["a.md"] }, { id: "middle", tabs: [] }, { id: "right", tabs: ["b.md"] }]}
        active="right"
      />,
    );
    screen.getByTestId("tab-b.md").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const middle = screen.getByRole("region", { name: "Editor group 2" });
    await waitFor(() => expect(document.activeElement).toBe(middle));
    expect(screen.queryByRole("region", { name: "Editor group 3" })).toBeNull();
    expect(screen.getByTestId("editor-group-layout").dataset.split).toBe("true");
    expect(middle.getAttribute("aria-current")).toBe("true");
    expect(left.getAttribute("aria-current")).toBeNull();
    // The empty group keeps its strip, which carries the active mark.
    expect(middle.querySelector('[data-testid="editor-tabs-active-group"]')).not.toBeNull();
  });

  it("moves the active mark between empty and populated groups without moving focus", () => {
    const onFocusGroup = vi.fn();
    const groups = [
      { id: "left", size: 1, content: <button type="button">Left editor</button> },
      { id: "right", size: 1, content: null },
    ];
    const { rerender } = render(
      <EditorGroupLayout groups={groups} activeGroupId="left" onFocusGroup={onFocusGroup} onResizeGroups={vi.fn()} />,
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    rerender(<EditorGroupLayout groups={groups} activeGroupId="right" onFocusGroup={onFocusGroup} onResizeGroups={vi.fn()} />);
    const [left, right] = [
      screen.getByRole("region", { name: "Editor group 1" }),
      screen.getByRole("region", { name: "Editor group 2" }),
    ];
    expect(right.dataset.active).toBe("true");
    expect(right.getAttribute("aria-current")).toBe("true");
    expect(left.dataset.active).toBeUndefined();
    expect(left.getAttribute("aria-current")).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(onFocusGroup).not.toHaveBeenCalled();
    outside.remove();
  });

  it("previews pointer moves locally and commits adjacent groups once on release", () => {
    const { onResizeGroups } = renderLayout();
    const layout = screen.getByTestId("editor-group-layout");
    Object.defineProperty(layout, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000 }),
    });
    const separator = screen.getByRole("separator", { name: "Resize editor groups" });
    Object.defineProperty(separator, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 4, clientX: 500 });
    fireEvent.pointerMove(separator, {
      pointerId: 4,
      buttons: 1,
      clientX: 600,
    });
    expect(screen.getByTestId("editor-group-left").style.flexGrow).toBe("1.2");
    expect(screen.getByTestId("editor-group-right").style.flexGrow).toBe("0.8");
    fireEvent.pointerMove(separator, {
      pointerId: 4,
      buttons: 1,
      clientX: 700,
    });
    expect(screen.getByTestId("editor-group-left").style.flexGrow).toBe("1.4");
    expect(onResizeGroups).not.toHaveBeenCalled();

    fireEvent.pointerUp(separator, { pointerId: 4 });
    expect(onResizeGroups).toHaveBeenCalledOnce();
    expect(onResizeGroups).toHaveBeenCalledWith("left", "right", 1.4);
  });

  it("commits the final buttons-up move when pointerup was missed", () => {
    const { onResizeGroups } = renderLayout();
    const layout = screen.getByTestId("editor-group-layout");
    Object.defineProperty(layout, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000 }),
    });
    const separator = screen.getByRole("separator", { name: "Resize editor groups" });
    Object.defineProperty(separator, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 5, clientX: 500 });
    fireEvent.pointerMove(separator, {
      pointerId: 5,
      buttons: 0,
      clientX: 650,
    });
    expect(onResizeGroups).toHaveBeenCalledOnce();
    expect(onResizeGroups).toHaveBeenCalledWith("left", "right", 1.3);
    fireEvent.pointerMove(separator, {
      pointerId: 5,
      buttons: 1,
      clientX: 700,
    });
    expect(onResizeGroups).toHaveBeenCalledTimes(1);
  });

  it("tracks pointer movement against the full layout with three groups", () => {
    const onResizeGroups = vi.fn();
    render(
      <EditorGroupLayout
        groups={[
          { id: "left", size: 1 / 3, content: "Left" },
          { id: "middle", size: 1 / 3, content: "Middle" },
          { id: "right", size: 1 / 3, content: "Right" },
        ]}
        activeGroupId="left"
        onFocusGroup={vi.fn()}
        onResizeGroups={onResizeGroups}
      />,
    );
    const layout = screen.getByTestId("editor-group-layout");
    Object.defineProperty(layout, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 900 }),
    });
    const separator = screen.getAllByRole("separator", {
      name: "Resize editor groups",
    })[0];
    Object.defineProperty(separator, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 300 });
    fireEvent.pointerMove(separator, {
      pointerId: 7,
      buttons: 1,
      clientX: 450,
    });
    expect(screen.getByTestId("editor-group-left").style.flexGrow).toBe("0.5");
    expect(onResizeGroups).not.toHaveBeenCalled();

    fireEvent.pointerCancel(separator, { pointerId: 7 });

    expect(onResizeGroups).toHaveBeenCalledOnce();
    expect(onResizeGroups).toHaveBeenCalledWith("left", "middle", 0.5);
  });

  it("commits the final preview on window blur", () => {
    const { onResizeGroups } = renderLayout();
    const layout = screen.getByTestId("editor-group-layout");
    Object.defineProperty(layout, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000 }),
    });
    const separator = screen.getByRole("separator", { name: "Resize editor groups" });
    Object.defineProperty(separator, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(separator, { button: 0, pointerId: 8, clientX: 500 });
    fireEvent.pointerMove(separator, {
      pointerId: 8,
      buttons: 1,
      clientX: 750,
    });

    fireEvent(window, new Event("blur"));

    expect(onResizeGroups).toHaveBeenCalledOnce();
    expect(onResizeGroups).toHaveBeenCalledWith("left", "right", 1.5);
  });

  it("supports keyboard resizing", () => {
    const { onResizeGroups } = renderLayout();
    const separator = screen.getByRole("separator", { name: "Resize editor groups" });

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResizeGroups).toHaveBeenCalledWith("left", "right", 1.1);

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onResizeGroups).toHaveBeenCalledTimes(1);
  });
});
