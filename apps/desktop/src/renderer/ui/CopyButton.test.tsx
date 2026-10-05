// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { ShellErrorReporter, type ReportShellError } from "../shell/useShellError";
import { COPY_FAILURE, COPY_FEEDBACK_MS, CopyButton, CopyField, createCopy } from "./CopyButton";

beforeEach(() => {
  vi.useFakeTimers();
  // user-event's setup puts a clipboard stub on navigator for the spies.
  userEvent.setup();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function withReporter(report: ReportShellError, children: ReactNode) {
  return <ShellErrorReporter.Provider value={report}>{children}</ShellErrorReporter.Provider>;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

// The live region beside the button, after the task that sets it.
async function announced(): Promise<string> {
  await act(() => vi.advanceTimersByTimeAsync(0));
  return screen.getByRole("status").textContent ?? "";
}

describe("CopyButton feedback", () => {
  it.each(["Copied", "Couldn't copy"] as const)(
    "keeps the original reset deadline when unavailable text follows %s",
    async (feedback) => {
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      if (feedback === "Couldn't copy") writeText.mockRejectedValueOnce(new Error("unavailable"));
      const getText = vi.fn<() => string | null>().mockReturnValueOnce("first").mockReturnValue(null);
      render(<CopyButton getText={getText} testId="copy" />);
      const button = screen.getByTestId("copy");

      await click(button);
      expect(button.textContent).toBe(feedback);
      await act(() => vi.advanceTimersByTimeAsync(400));
      await click(button);
      expect(getText).toHaveBeenCalledTimes(2);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("first");
      expect(button.textContent).toBe(feedback);

      await act(() => vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS - 401));
      expect(button.textContent).toBe(feedback);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(button.textContent).toBe("Copy");
    },
  );

  it("expires old feedback while a new copy waits and gives completed feedback its whole time", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const nextText = deferred<string>();
    const nextWrite = deferred();
    const getText = vi.fn<() => string | Promise<string>>()
      .mockReturnValueOnce("first")
      .mockReturnValue(nextText.promise);
    render(<CopyButton getText={getText} testId="copy" />);
    const button = screen.getByTestId("copy");

    await click(button);
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(400));
    writeText.mockReturnValueOnce(nextWrite.promise);
    await click(button);
    await act(async () => nextText.resolve("second"));
    expect(writeText).toHaveBeenNthCalledWith(2, "second");

    await act(() => vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS - 401));
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button.textContent).toBe("Copy");
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(async () => nextWrite.resolve());
    expect(button.textContent).toBe("Copied");

    await act(() => vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS - 1));
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button.textContent).toBe("Copy");
  });

  it("answers only the latest of overlapping clicks", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const first = deferred();
    const second = deferred();
    writeText.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const report = vi.fn<ReportShellError>();
    const texts = ["old", "new"];
    render(withReporter(report, <CopyButton getText={() => texts.shift() ?? null} testId="copy" />));
    const button = screen.getByTestId("copy");

    await click(button);
    await click(button);
    expect(writeText.mock.calls).toEqual([["old"], ["new"]]);
    await act(async () => second.resolve());
    expect(button.textContent).toBe("Copied");
    // The older write fails after the newer one answered: the newer one
    // speaks for the click the person made last.
    await act(async () => first.reject(new Error("late")));
    expect(button.textContent).toBe("Copied");
    expect(report).not.toHaveBeenCalled();
  });

  it("announces each answer to a screen reader, again on a second copy", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CopyButton iconOnly label="Copy details" getText={() => "facts"} testId="copy" />);
    const button = screen.getByTestId("copy");

    await click(button);
    expect(await announced()).toBe("Copied");
    await click(button);
    // Cleared first, so the region's text changes and is read again.
    expect(screen.getByRole("status").textContent).toBe("");
    expect(await announced()).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps a pinned name and says the answer in its tooltip and words", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(
      <>
        <CopyButton iconOnly pinName label="Copy details" getText={() => "facts"} testId="icon" />
        <CopyButton pinName label="Copy details" getText={() => "facts"} testId="words" />
        <CopyButton iconOnly getText={() => "facts"} testId="unnamed" />
      </>,
    );
    const icon = screen.getByTestId("icon");
    const words = screen.getByTestId("words");
    const unnamed = screen.getByTestId("unnamed");
    expect(screen.getAllByRole("button", { name: "Copy details" })).toEqual([icon, words]);
    expect(unnamed.getAttribute("aria-label")).toBe("Copy");

    await click(icon);
    await click(words);
    await click(unnamed);
    expect(screen.getAllByRole("button", { name: "Copy details" })).toEqual([icon, words]);
    expect(icon.getAttribute("title")).toBe("Copied");
    expect(words.textContent).toBe("Copied");
    // Without a pinned name, the name is the answer.
    expect(unnamed.getAttribute("aria-label")).toBe("Copied");
  });

  it("names itself by what it says, in its own words for copied", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(
      <>
        <CopyButton label="Copy code" getText={() => "code"} testId="code" />
        <CopyButton
          label="Copy browser invitation"
          copiedLabel="Browser invitation copied"
          getText={() => "https://share.example.test"}
          testId="invitation"
        />
      </>,
    );
    expect(screen.getByRole("button", { name: "Copy code" })).toBe(screen.getByTestId("code"));
    expect(screen.getByRole("button", { name: "Copy browser invitation" })).toBe(screen.getByTestId("invitation"));

    await click(screen.getByTestId("code"));
    await click(screen.getByTestId("invitation"));
    expect(screen.getByRole("button", { name: "Copied" })).toBe(screen.getByTestId("code"));
    expect(screen.getByRole("button", { name: "Browser invitation copied" })).toBe(screen.getByTestId("invitation"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getAllByRole("status").map((region) => region.textContent)).toEqual(["Copied", "Browser invitation copied"]);
  });

  it("writes in the same task as the click when the text is at hand", () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const copy = createCopy({ getText: () => "now", report: () => null, show: () => undefined });
    void copy.copy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("now");
    copy.dispose();
  });
});

describe("CopyButton failure", () => {
  it("says a refused copy in place and reports it with a Try again that reads the text afresh", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Document is not focused."));
    const report = vi.fn<ReportShellError>();
    let text = "first";
    render(withReporter(report, <CopyButton getText={() => text} testId="copy" />));
    const button = screen.getByTestId("copy");

    await click(button);
    expect(button.textContent).toBe("Couldn't copy");
    expect(await announced()).toBe("Couldn't copy");
    expect(report).toHaveBeenCalledOnce();
    const [message, error, retry] = report.mock.calls[0]!;
    expect(message).toBe(COPY_FAILURE);
    expect(error).toEqual(new Error("Document is not focused."));
    expect(retry).toBeTypeOf("function");

    text = "second";
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retry!());
    expect(writeText).toHaveBeenLastCalledWith("second");
    expect(button.textContent).toBe("Copied");
  });

  it("reports text that could not be read, and writes nothing", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellError>();
    const projection = new Error("projection failed");
    render(withReporter(report, <CopyButton getText={() => Promise.reject(projection)} testId="copy" />));

    await click(screen.getByTestId("copy"));
    expect(screen.getByTestId("copy").textContent).toBe("Couldn't copy");
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(COPY_FAILURE, projection, expect.any(Function));
  });

  it("says a failure in place when nothing above it owns notices", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    render(<CopyButton iconOnly label="Copy" getText={() => "text"} testId="copy" />);

    await click(screen.getByTestId("copy"));
    expect(screen.getByTestId("copy").getAttribute("title")).toBe("Couldn't copy");
  });
});

describe("CopyButton after it is gone", () => {
  it("writes nothing when the text arrives after the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellError>();
    const text = deferred<string>();
    const view = render(withReporter(report, <CopyButton getText={() => text.promise} testId="copy" />));

    await click(screen.getByTestId("copy"));
    view.unmount();
    await act(async () => text.resolve("a link the surface retired"));
    expect(writeText).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("reports a write that fails after the button closed, and Try again copies the text that failed", async () => {
    const write = deferred();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(write.promise);
    const report = vi.fn<ReportShellError>();
    const view = render(withReporter(report, <CopyButton getText={() => "details"} testId="copy" />));

    await click(screen.getByTestId("copy"));
    view.unmount();
    const refusal = new Error("denied");
    await act(async () => write.reject(refusal));
    expect(report).toHaveBeenCalledExactlyOnceWith(COPY_FAILURE, refusal, expect.any(Function));
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => report.mock.calls[0]![2]!());
    expect(writeText).toHaveBeenLastCalledWith("details");
  });

  // The failure's own toast can replace the toast the button sat in, so the
  // button is gone by the time the person presses Try again.
  it("copies the text that failed when Try again comes after the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    const report = vi.fn<ReportShellError>();
    const view = render(withReporter(report, <CopyButton getText={() => "error details"} testId="copy" />));

    await click(screen.getByTestId("copy"));
    const retry = report.mock.calls[0]![2]!;
    view.unmount();
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retry());
    expect(writeText).toHaveBeenLastCalledWith("error details");
    expect(report).toHaveBeenCalledTimes(1);

    // A second refusal files again, with the same text behind its Try again.
    const again = new Error("still denied");
    writeText.mockRejectedValueOnce(again);
    await act(async () => retry());
    expect(report).toHaveBeenLastCalledWith(COPY_FAILURE, again, expect.any(Function));
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => report.mock.calls[1]![2]!());
    expect(writeText).toHaveBeenLastCalledWith("error details");
  });

  it("files the failure again without Try again when no text was read before the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellError>();
    const unreadable = new Error("projection failed");
    const view = render(withReporter(report, <CopyButton getText={() => Promise.reject(unreadable)} testId="copy" />));

    await click(screen.getByTestId("copy"));
    const retry = report.mock.calls[0]![2]!;
    view.unmount();
    await act(async () => retry());
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(COPY_FAILURE, unreadable, null);
  });

  it("succeeds silently after the button closed", async () => {
    const write = deferred();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(write.promise);
    const report = vi.fn<ReportShellError>();
    const view = render(withReporter(report, <CopyButton getText={() => "details"} testId="copy" />));

    await click(screen.getByTestId("copy"));
    view.unmount();
    await act(async () => write.resolve());
    expect(report).not.toHaveBeenCalled();
  });
});

describe("CopyField", () => {
  it("frames the caller's text with its copy beside it", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(
      <CopyField copyTestId="copy" getText={() => "dohc-sync:ws-1"}>
        <code data-testid="code">dohc-sync:ws-1</code>
      </CopyField>,
    );
    const code = screen.getByTestId("code");
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.dataset.testid).toBe("copy");
    expect(code.parentElement?.nextElementSibling).toBe(copy);

    await click(copy);
    expect(writeText).toHaveBeenCalledWith("dohc-sync:ws-1");
    expect(screen.getByRole("button", { name: "Copied" })).toBe(copy);
  });
});
