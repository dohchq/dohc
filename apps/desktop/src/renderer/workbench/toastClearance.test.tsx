// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { onComposerRoomChange, useToastsAbove } from "./toastClearance";

function Box(props: { top: number; height: number; enabled?: boolean }) {
  const ref = useRef<HTMLFormElement | null>(null);
  useToastsAbove(ref, props.enabled);
  return (
    <form
      ref={(node) => {
        ref.current = node;
        if (node) vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, props.top, 100, props.height));
      }}
    />
  );
}

const room = () => document.documentElement.style.getPropertyValue("--dohc-composer-room");

afterEach(cleanup);

it("raises the toasts above the highest shown message box, and drops the room when none is left", () => {
  const bottom = window.innerHeight;
  const { rerender, unmount } = render(<><Box top={bottom - 60} height={60} /><Box top={bottom - 90} height={0} /></>);
  // The second box is hidden: it has no height.
  expect(room()).toBe("60px");
  rerender(<><Box top={bottom - 60} height={60} /><Box top={bottom - 90} height={0} /><Box top={bottom - 80} height={80} /></>);
  expect(room()).toBe("80px");
  unmount();
  expect(room()).toBe("");
});

it("leaves the toasts in the corner for a box that doesn't count", () => {
  render(<Box top={window.innerHeight - 60} height={60} enabled={false} />);
  expect(room()).toBe("");
});

it("tells the toast stack when the room changes, and only then", () => {
  const changed = vi.fn();
  const stop = onComposerRoomChange(changed);
  const bottom = window.innerHeight;
  const { rerender, unmount } = render(<><Box top={bottom - 60} height={60} /></>);
  expect(changed).toHaveBeenCalledTimes(1);
  rerender(<><Box top={bottom - 60} height={60} /><Box top={bottom - 50} height={50} /></>);
  expect(changed).toHaveBeenCalledTimes(1);
  unmount();
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
});
