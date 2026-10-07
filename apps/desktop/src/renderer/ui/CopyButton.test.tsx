// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { deferred } from "../../testing/deferred";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";
import { COPY_FEEDBACK_MS, CopyButton, CopyField, createCopy, type CopySecret } from "./CopyButton";

const REFUSED = "Document is not focused.";
const refusal = () => new Error(REFUSED);
const LINK: CopySecret = { what: "the share link", again: "Reset the link in Share to get a new one." };
const CODE: CopySecret = { what: "the share code", again: "Copy it again from Shared by me while the share is active." };

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

// Whether a weakly held object is gone after full collections, each in a
// fresh task: a WeakRef keeps its target until the task that read it ends.
async function collected(ref: WeakRef<object>): Promise<boolean> {
  vi.useRealTimers();
  for (let pass = 0; pass < 10; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

// The Try again of a filed failure, the last one unless told otherwise.
function retryOf(report: Mock<ReportShellFailure>, call = -1): () => void {
  const retry = report.mock.calls.at(call)?.[0].retry;
  if (!retry) throw new Error("the failure has no Try again");
  return retry;
}

// A share link's copy that fails and then closes. Only a weak reference to
// its source leaves this function.
async function failThenClose(report: Mock<ReportShellFailure>): Promise<WeakRef<object>> {
  const source = { link: "https://share.example.test/s/secret" };
  const view = render(withReporter(report, <CopyButton getText={() => source.link} sensitive={LINK} testId="copy" />));
  await click(screen.getByTestId("copy"));
  view.unmount();
  cleanup();
  return new WeakRef(source);
}

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

function withReporter(report: ReportShellFailure, children: ReactNode) {
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
    const report = vi.fn<ReportShellFailure>();
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
  it("says a refused copy in place and reports it, reason second, with a Try again that reads the text afresh", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    const report = vi.fn<ReportShellFailure>();
    let text = "first";
    render(withReporter(report, <CopyButton getText={() => text} testId="copy" />));
    const button = screen.getByTestId("copy");

    await click(button);
    expect(button.textContent).toBe("Couldn't copy");
    expect(await announced()).toBe("Couldn't copy");
    expect(report).toHaveBeenCalledExactlyOnceWith({
      message: `dohc could not copy to the clipboard. ${REFUSED}`,
      cause: refusal(),
      retry: expect.any(Function),
    });

    text = "second";
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retryOf(report)());
    expect(writeText).toHaveBeenLastCalledWith("second");
    expect(button.textContent).toBe("Copied");
  });

  it("reports text that could not be read, and writes nothing", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellFailure>();
    const projection = new Error("The draft could not be read.");
    render(withReporter(report, <CopyButton getText={() => Promise.reject(projection)} testId="copy" />));

    await click(screen.getByTestId("copy"));
    expect(screen.getByTestId("copy").textContent).toBe("Couldn't copy");
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      message: "dohc could not copy to the clipboard. The draft could not be read.",
      cause: projection,
      retry: expect.any(Function),
    });
  });

  it("says a failure in place when nothing above it owns notices", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    render(<CopyButton iconOnly label="Copy" getText={() => "text"} testId="copy" />);

    await click(screen.getByTestId("copy"));
    expect(screen.getByTestId("copy").getAttribute("title")).toBe("Couldn't copy");
  });

  // A secret's failure names it. While its button is on screen, Try again is
  // the only next step, so the words stop at the reason.
  it("names a secret in its failure and offers Try again while its button is on screen", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    const report = vi.fn<ReportShellFailure>();
    render(withReporter(report, <CopyButton getText={() => "https://share.example.test/s/a"} sensitive={LINK} testId="copy" />));

    await click(screen.getByTestId("copy"));
    expect(report).toHaveBeenCalledExactlyOnceWith({
      message: `dohc could not copy the share link. ${REFUSED}`,
      cause: refusal(),
      retry: expect.any(Function),
    });
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retryOf(report)());
    expect(writeText).toHaveBeenLastCalledWith("https://share.example.test/s/a");
  });
});

describe("CopyButton after it is gone", () => {
  it("writes nothing when the text arrives after the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellFailure>();
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
    const report = vi.fn<ReportShellFailure>();
    const view = render(withReporter(report, <CopyButton getText={() => "details"} testId="copy" />));

    await click(screen.getByTestId("copy"));
    view.unmount();
    await act(async () => write.reject(refusal()));
    expect(report).toHaveBeenCalledExactlyOnceWith({
      message: `dohc could not copy to the clipboard. ${REFUSED}`,
      cause: refusal(),
      retry: expect.any(Function),
    });
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retryOf(report)());
    expect(writeText).toHaveBeenLastCalledWith("details");
  });

  // The failure's own toast can replace the toast the button sat in, so the
  // button is gone by the time the person presses Try again.
  it("copies the text that failed when Try again comes after the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    const report = vi.fn<ReportShellFailure>();
    const view = render(withReporter(report, <CopyButton getText={() => "error details"} testId="copy" />));

    await click(screen.getByTestId("copy"));
    const retry = retryOf(report);
    view.unmount();
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retry());
    expect(writeText).toHaveBeenLastCalledWith("error details");
    expect(report).toHaveBeenCalledTimes(1);

    // A second refusal files again, with the same text behind its Try again.
    const again = new Error("The clipboard is in use.");
    writeText.mockRejectedValueOnce(again);
    await act(async () => retry());
    expect(report).toHaveBeenLastCalledWith({
      message: "dohc could not copy to the clipboard. The clipboard is in use.",
      cause: again,
      retry: expect.any(Function),
    });
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => retryOf(report)());
    expect(writeText).toHaveBeenLastCalledWith("error details");
  });

  // A secret, such as a share link, is never kept: once its button is gone,
  // Try again cannot copy it, and the notice says where to get it again.
  it("files the failure again without Try again when the button closed before the retry", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    const report = vi.fn<ReportShellFailure>();
    const getText = vi.fn(() => "secret link");
    const view = render(withReporter(report, <CopyButton getText={getText} sensitive={LINK} testId="copy" />));

    await click(screen.getByTestId("copy"));
    const retry = retryOf(report);
    view.unmount();
    getText.mockClear();
    await act(async () => retry());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(getText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      message: `dohc could not copy the share link. ${REFUSED} Reset the link in Share to get a new one.`,
      cause: refusal(),
      retry: null,
    });
  });

  it("reports a secret's failure after its button closed with where to get it again, and no Try again", async () => {
    const write = deferred();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(write.promise);
    const report = vi.fn<ReportShellFailure>();
    const view = render(
      withReporter(report, <CopyButton getText={() => "dohc-share:a:relay"} sensitive={CODE} testId="copy" />),
    );

    await click(screen.getByTestId("copy"));
    view.unmount();
    await act(async () => write.reject(refusal()));
    expect(report).toHaveBeenCalledExactlyOnceWith({
      message: `dohc could not copy the share code. ${REFUSED} Copy it again from Shared by me while the share is active.`,
      cause: refusal(),
      retry: null,
    });
  });

  // A field is keyed by its text: a reset link is a new control, so Try
  // again from the old one never copies the link it replaced.
  it("copies a secret on Try again only while its field still shows the same value", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal());
    const report = vi.fn<ReportShellFailure>();
    const field = (link: string) =>
      withReporter(report, (
        <CopyField copyTestId="copy" getText={() => link} sensitive={LINK}>
          <code>{link}</code>
        </CopyField>
      ));
    const view = render(field("https://share.example.test/s/old"));

    await click(screen.getByTestId("copy"));
    writeText.mockResolvedValue(undefined);
    await act(async () => retryOf(report)());
    expect(writeText).toHaveBeenLastCalledWith("https://share.example.test/s/old");

    writeText.mockRejectedValueOnce(refusal());
    await click(screen.getByTestId("copy"));
    const staleRetry = retryOf(report);
    view.rerender(field("https://share.example.test/s/reset"));
    writeText.mockClear();
    await act(async () => staleRetry());
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      message: `dohc could not copy the share link. ${REFUSED} Reset the link in Share to get a new one.`,
      cause: refusal(),
      retry: null,
    });
  });

  // The notice outlives the button. What it keeps must not reach the
  // secret's source, or the credential lives on in memory behind the row.
  it("leaves a secret's source unreachable once its button is gone, while its notice remains", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(refusal());
    const report = vi.fn<ReportShellFailure>();
    const source = await failThenClose(report);
    expect(report).toHaveBeenCalledOnce();
    expect(retryOf(report)).toBeTypeOf("function");
    expect(await collected(source)).toBe(true);
  });

  it("files the failure again without Try again when no text was read before the button closed", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const report = vi.fn<ReportShellFailure>();
    const unreadable = new Error("The draft could not be read.");
    const view = render(withReporter(report, <CopyButton getText={() => Promise.reject(unreadable)} testId="copy" />));

    await click(screen.getByTestId("copy"));
    const retry = retryOf(report);
    view.unmount();
    await act(async () => retry());
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      message: "dohc could not copy to the clipboard. The draft could not be read.",
      cause: unreadable,
      retry: null,
    });
  });

  it("succeeds silently after the button closed", async () => {
    const write = deferred();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(write.promise);
    const report = vi.fn<ReportShellFailure>();
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
