// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

    expect(await screen.findByTestId("error-boundary-markdown-read-view")).toBeTruthy();
    expect(screen.getByTestId("workspace")).toBeTruthy();

    await userEvent.click(screen.getByTestId("error-boundary-markdown-read-view-retry"));

    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await loader.mock.results[1]!.value;
    });
    expect(await screen.findByRole("heading", { name: "Recovered document" })).toBeTruthy();
    await waitFor(() => expect(onRendered).toHaveBeenCalledOnce());
  });

  it("renders a later document in its first commit once the chunk has loaded", async () => {
    const first = render(
      <LazyMarkdownReadView body="# First document" resetKey="workspace-1:first.md" />,
    );
    expect(await screen.findByRole("heading", { name: "First document" })).toBeTruthy();
    first.unmount();

    render(<LazyMarkdownReadView body="# Second document" resetKey="workspace-1:second.md" />);
    expect(
      screen.queryByRole("heading", { name: "Second document" }),
      "a fresh lazy per mount suspends again and shows the loading lines for a module already loaded",
    ).toBeTruthy();
    expect(screen.queryByTestId("markdown-read-loading")).toBeNull();
  });

  it("marks completion only after the loaded child parses and commits", async () => {
    let resolve!: (module: typeof import("./IncrementalMarkdownDocument")) => void;
    const pending = new Promise<typeof import("./IncrementalMarkdownDocument")>((done) => {
      resolve = done;
    });
    const loader = vi.fn(() => pending);
    const onRendered = vi.fn(() => {
      expect(screen.getByRole("heading", { name: "Measured document" })).toBeTruthy();
    });

    render(
      <LazyMarkdownReadView
        body="# Measured document"
        resetKey="workspace-1:measured.md"
        loader={loader}
        onRendered={onRendered}
      />,
    );

    expect(screen.getByTestId("markdown-read-loading").textContent).toBe("Loading document…");
    expect(onRendered).not.toHaveBeenCalled();

    const recoveredModule = await import("./IncrementalMarkdownDocument");
    await act(async () => {
      resolve(recoveredModule);
      await pending;
    });

    expect(await screen.findByRole("heading", { name: "Measured document" })).toBeTruthy();
    await waitFor(() => expect(onRendered).toHaveBeenCalledOnce());
  });

  it("resolves workspace-relative images and blocks escaping paths when imageContext is set", async () => {
    render(
      <LazyMarkdownReadView
        body={[
          "![Diagram](Assets/diagram.png)",
          "![Spaced](Assets/my%20pic.png)",
          "![Unicode](Assets/café.png)",
          "![Escape](../../outside.png)",
          "![EncodedEscape](..%2F..%2Foutside.png)",
          "![EncodedAbsolute](%2Fetc%2Fpasswd)",
          "![EncodedScheme](file%3A%2F%2F%2Fetc%2Fpasswd)",
        ].join("\n\n")}
        resetKey="workspace-1:notes/readme.md"
        imageContext={{ workspaceId: "ws-1", docPath: "notes/readme.md" }}
      />,
    );
    const diagram = await screen.findByAltText("Diagram");
    expect(diagram.getAttribute("src")).toBe("dohc-file://ws-1/notes/Assets/diagram.png");
    expect(screen.getByAltText("Spaced").getAttribute("src")).toBe(
      "dohc-file://ws-1/notes/Assets/my%20pic.png",
    );
    expect(screen.getByAltText("Unicode").getAttribute("src")).toBe(
      "dohc-file://ws-1/notes/Assets/caf%C3%A9.png",
    );
    expect(screen.getByAltText("Escape").getAttribute("src")).toBeNull();
    expect(screen.getByAltText("EncodedEscape").getAttribute("src")).toBeNull();
    expect(screen.getByAltText("EncodedAbsolute").getAttribute("src")).toBeNull();
    expect(screen.getByAltText("EncodedScheme").getAttribute("src")).toBeNull();
  });
});
