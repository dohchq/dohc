// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorErrorBoundary } from "./EditorErrorBoundary";

function BrokenEditor(): never {
  throw new Error("broken editor");
}

function Harness() {
  const [broken, setBroken] = useState(true);
  return (
    <EditorErrorBoundary resetKey="notes/test.md">
      {broken ? <BrokenEditor /> : <button onClick={() => undefined}>Editor ready</button>}
      <button onClick={() => setBroken(false)}>repair</button>
    </EditorErrorBoundary>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("EditorErrorBoundary", () => {
  it("contains an editor failure and can retry without blanking the workspace", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Harness />);

    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry editor" }));
    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();
  });
});
