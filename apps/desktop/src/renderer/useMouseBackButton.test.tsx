// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMouseBackButton } from "./useMouseBackButton";

function Route(props: { onBack: (() => void) | undefined }) {
  useMouseBackButton(props.onBack);
  return null;
}

afterEach(cleanup);

describe("useMouseBackButton", () => {
  it("calls back on the mouse's back button and ignores the others", () => {
    const onBack = vi.fn();
    render(<Route onBack={onBack} />);

    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseUp(window, { button: 4 });
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does nothing while back is unavailable, and stops after unmount", () => {
    const onBack = vi.fn();
    const view = render(<Route onBack={undefined} />);
    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).not.toHaveBeenCalled();

    view.rerender(<Route onBack={onBack} />);
    view.unmount();
    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).not.toHaveBeenCalled();
  });
});
