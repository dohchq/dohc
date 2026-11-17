// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAccessSavedNotice, type AccessSavedReport } from "./accessSavedNotice";
import { useShellError } from "./useShellError";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubReveal(
  reveal: (payload: unknown) => Promise<void>,
  dismiss: (payload: unknown) => Promise<void> = async () => undefined,
) {
  vi.stubGlobal("dohcDesktop", {
    revealWorkspaceFolder: reveal,
    dismissAccessSavedNotice: dismiss,
  });
}

describe("the notice for items an access change saved", () => {
  const folder = ".dohc/local/recovery/2026-11-16 10-00 UTC";

  it("says how many items moved and opens their folder", async () => {
    const reveal = vi.fn(async () => undefined);
    stubReveal(reveal);
    const report = vi.fn<AccessSavedReport>();
    renderHook(() => useAccessSavedNotice("w", { folder, count: 3 }, report));
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Your access changed. dohc moved 3 items into a recovery folder.",
        identity: "access-saved:w",
        action: expect.objectContaining({ label: "Open folder" }),
      }),
    );
    report.mock.calls[0]![0].action!.run();
    await vi.waitFor(() =>
      expect(reveal).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", accessSaved: true }),
    );
  });

  it("names the undone changes when nothing moved", () => {
    stubReveal(async () => undefined);
    const report = vi.fn<AccessSavedReport>();
    renderHook(() => useAccessSavedNotice("w", { folder, count: 0 }, report));
    expect(report.mock.calls[0]![0].message).toBe(
      "Your access changed. dohc undid changes that weren't sent. The recovery folder lists them.",
    );
  });

  it("files nothing without a saved folder, and once per folder", () => {
    const report = vi.fn<AccessSavedReport>();
    const { rerender } = renderHook(({ saved }) => useAccessSavedNotice("w", saved, report), {
      initialProps: { saved: undefined as { folder: string; count: number } | undefined },
    });
    expect(report).not.toHaveBeenCalled();
    rerender({ saved: { folder, count: 1 } });
    rerender({ saved: { folder, count: 1 } });
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0].message).toBe(
      "Your access changed. dohc moved 1 item into a recovery folder.",
    );
  });

  it("forgets the folder when the row is dismissed, and says when it could not", async () => {
    const dismiss = vi.fn(async (_payload: unknown): Promise<void> => {
      throw new Error("The workspace closed.");
    });
    stubReveal(async () => undefined, dismiss);
    const report = vi.fn<AccessSavedReport>();
    renderHook(() => useAccessSavedNotice("w", { folder, count: 1 }, report));
    report.mock.calls[0]![0].onDismiss!();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", folder });
    expect(report.mock.calls[1]![0]).toMatchObject({
      message: "dohc could not dismiss this Notice.",
      retry: expect.any(Function),
    });
    dismiss.mockResolvedValueOnce(undefined);
    report.mock.calls[1]![0].retry!();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports a folder it could not open, with Try again", async () => {
    stubReveal(async () => {
      throw new Error("dohc could not find the folder.");
    });
    const report = vi.fn<AccessSavedReport>();
    renderHook(() => useAccessSavedNotice("w", { folder, count: 1 }, report));
    report.mock.calls[0]![0].action!.run();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.calls[1]![0]).toMatchObject({
      message: "dohc could not open the recovery folder.",
      retry: expect.any(Function),
    });
  });

  // Through the shell's own report, as the shell files it.
  function filed(
    reveal: (payload: unknown) => Promise<void>,
    dismiss: (payload: unknown) => Promise<void>,
  ) {
    stubReveal(reveal, dismiss);
    return renderHook(() => {
      const shell = useShellError("w");
      useAccessSavedNotice("w", { folder, count: 1 }, shell.reportShellFailure);
      return shell;
    });
  }

  it("is a notice, not a failure: nothing failed", () => {
    const { result } = filed(
      async () => undefined,
      async () => undefined,
    );
    expect(result.current.shellErrors).toEqual([
      expect.objectContaining({
        message: "Your access changed. dohc moved 1 item into a recovery folder.",
        tone: "warning",
      }),
    ]);
  });

  it("still forgets the folder when the row is dismissed after it could not open", async () => {
    const dismiss = vi.fn(async (_payload: unknown) => undefined);
    const { result } = filed(async () => {
      throw new Error("dohc could not find the folder.");
    }, dismiss);
    act(() => result.current.shellErrors[0]!.action!.run());
    await vi.waitFor(() =>
      expect(result.current.shellErrors[0]?.message).toBe(
        "dohc could not open the recovery folder.",
      ),
    );
    act(() => result.current.dismissShellError(result.current.shellErrors[0]!.id));
    await vi.waitFor(() =>
      expect(dismiss).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", folder }),
    );
    expect(result.current.shellErrors).toEqual([]);
  });
});
