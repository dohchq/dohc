// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { CopyButton } from "./CopyButton";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CopyButton feedback reset", () => {
  it.each(["Copied", "Couldn't copy"] as const)(
    "keeps the original reset deadline when unavailable text follows %s",
    async (feedback) => {
      userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      if (feedback === "Couldn't copy") writeText.mockRejectedValueOnce(new Error("unavailable"));
      const getText = vi.fn<() => string | null>().mockReturnValueOnce("first").mockReturnValue(null);
      render(<CopyButton getText={getText} testId="copy" />);
      const button = screen.getByTestId("copy");

      await act(async () => { fireEvent.click(button); });
      expect(button.textContent).toBe(feedback);
      await act(() => vi.advanceTimersByTimeAsync(400));
      await act(async () => { fireEvent.click(button); });
      expect(getText).toHaveBeenCalledTimes(2);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("first");
      expect(button.textContent).toBe(feedback);

      await act(() => vi.advanceTimersByTimeAsync(799));
      expect(button.textContent).toBe(feedback);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(button.textContent).toBe("Copy");
    },
  );

  it("expires old feedback while a new copy waits and gives completed feedback 1200 ms", async () => {
    userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const nextText = deferred<string>();
    const nextWrite = deferred();
    const getText = vi.fn<() => string | Promise<string>>()
      .mockReturnValueOnce("first")
      .mockReturnValue(nextText.promise);
    render(<CopyButton getText={getText} testId="copy" />);
    const button = screen.getByTestId("copy");

    await act(async () => { fireEvent.click(button); });
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(400));
    writeText.mockReturnValueOnce(nextWrite.promise);
    await act(async () => { fireEvent.click(button); });
    await act(async () => { nextText.resolve("second"); });
    expect(writeText).toHaveBeenNthCalledWith(2, "second");

    await act(() => vi.advanceTimersByTimeAsync(799));
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button.textContent).toBe("Copy");
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(async () => { nextWrite.resolve(); });
    expect(button.textContent).toBe("Copied");

    await act(() => vi.advanceTimersByTimeAsync(1199));
    expect(button.textContent).toBe("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button.textContent).toBe("Copy");
  });
});
