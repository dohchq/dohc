// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownNestingRefusal } from "@dohc/ydoc-projection";
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

  it("shows the refused view for a note nested too deeply, without reporting a crash", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function DeepEditor(): never {
      throw new MarkdownNestingRefusal("lexing");
    }
    render(
      <EditorErrorBoundary resetKey="notes/deep.md" refused={limit => <p>refused by {limit}</p>}>
        <DeepEditor />
      </EditorErrorBoundary>,
    );
    expect(screen.getByText("refused by lexing")).toBeTruthy();
    expect(screen.queryByTestId("editor-crash-recovery")).toBeNull();
    expect(logged.mock.calls.some(call => String(call[0]).startsWith("[dohc] editor recovered"))).toBe(false);
  });

  it("recovers automatically when a different document reset key is rendered", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<ResetHarness broken resetKey="notes/broken.md" />);
    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();

    view.rerender(<ResetHarness broken={false} resetKey="notes/healthy.md" />);

    expect(screen.getByRole("button", { name: "Editor ready" })).toBeTruthy();
  });
});
