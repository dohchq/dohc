// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function ResetHarness({ broken, resetKey }: { broken: boolean; resetKey: string }) {
  return (
    <EditorErrorBoundary resetKey={resetKey}>
      {broken ? <BrokenEditor /> : <button>Editor ready</button>}
    </EditorErrorBoundary>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EditorErrorBoundary", () => {
  it("contains an editor failure and can retry without blanking the workspace", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Harness />);

    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Render again" }));
    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();
  });

  it("recovers automatically when a different document reset key is rendered", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<ResetHarness broken resetKey="notes/broken.md" />);
    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();

    view.rerender(<ResetHarness broken={false} resetKey="notes/healthy.md" />);

    expect(screen.getByRole("button", { name: "Editor ready" })).toBeTruthy();
  });
});
