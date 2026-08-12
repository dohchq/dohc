// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorGroupLayout } from "./EditorGroupLayout";

afterEach(cleanup);

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

  it("resizes adjacent groups with pointer movement and stops after a buttons-up move", () => {
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
    expect(onResizeGroups).toHaveBeenCalledWith("left", "right", 1.2);

    fireEvent.pointerMove(separator, {
      pointerId: 4,
      buttons: 0,
      clientX: 650,
    });
    fireEvent.pointerMove(separator, {
      pointerId: 4,
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

    expect(onResizeGroups).toHaveBeenCalledWith("left", "middle", 0.5);
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
