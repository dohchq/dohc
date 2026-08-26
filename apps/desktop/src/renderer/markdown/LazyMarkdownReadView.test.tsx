// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyMarkdownReadView } from "./LazyMarkdownReadView";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LazyMarkdownReadView", () => {
  it("contains a rejected import and retries with a fresh lazy component", async () => {
    let attempt = 0;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("markdown chunk unavailable");
      return import("./IncrementalMarkdownDocument");
    });
    const onRendered = vi.fn();

    render(
      <div>
        <div data-testid="workspace">Workspace remains usable</div>
        <LazyMarkdownReadView
          body="# Recovered document"
          resetKey="workspace-1:notes.md"
          loader={loader}
          onRendered={onRendered}
        />
      </div>,
    );

    expect(
      await screen.findByTestId("error-boundary-markdown-read-view"),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace")).toBeTruthy();

    await userEvent.click(
      screen.getByTestId("error-boundary-markdown-read-view-retry"),
    );

    expect(
      await screen.findByRole("heading", { name: "Recovered document" }),
    ).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(onRendered).toHaveBeenCalledOnce();
  });

  it("marks completion only after the loaded child parses and commits", async () => {
    let resolve!: (
      module: typeof import("./IncrementalMarkdownDocument"),
    ) => void;
    const pending = new Promise<
      typeof import("./IncrementalMarkdownDocument")
    >((done) => {
      resolve = done;
    });
    const loader = vi.fn(() => pending);
    const onRendered = vi.fn(() => {
      expect(
        screen.getByRole("heading", { name: "Measured document" }),
      ).toBeTruthy();
    });

    render(
      <LazyMarkdownReadView
        body="# Measured document"
        resetKey="workspace-1:measured.md"
        loader={loader}
        onRendered={onRendered}
      />,
    );

    expect(screen.getByTestId("markdown-read-loading").textContent).toBe(
      "Loading document...",
    );
    expect(onRendered).not.toHaveBeenCalled();

    const recoveredModule = await import("./IncrementalMarkdownDocument");
    await act(async () => {
      resolve(recoveredModule);
      await pending;
    });

    expect(
      await screen.findByRole("heading", { name: "Measured document" }),
    ).toBeTruthy();
    expect(onRendered).toHaveBeenCalledOnce();
  });
});
