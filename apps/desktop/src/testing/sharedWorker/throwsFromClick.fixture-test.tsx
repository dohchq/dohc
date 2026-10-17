// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { it } from "vitest";

// A click handler that throws. vitest must report the uncaught error, which
// fails the run, even after a file that listened for errors on window.
it("clicks a button whose handler throws", () => {
  render(
    <button type="button" onClick={() => { throw new Error("thrown from a click handler"); }}>
      Throw
    </button>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Throw" }));
});
