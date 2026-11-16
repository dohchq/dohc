// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useAccessSavedNotice, type AccessSavedReport } from "./accessSavedNotice";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubReveal(reveal: (payload: unknown) => Promise<void>) {
  vi.stubGlobal("dohcDesktop", { revealWorkspaceFolder: reveal });
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
    report.mock.calls[0]![0].action.run();
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

  it("reports a folder it could not open, with Try again", async () => {
    stubReveal(async () => {
      throw new Error("dohc could not find the folder.");
    });
    const report = vi.fn<AccessSavedReport>();
    renderHook(() => useAccessSavedNotice("w", { folder, count: 1 }, report));
    report.mock.calls[0]![0].action.run();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.calls[1]![0]).toMatchObject({
      message: "dohc could not open the recovery folder.",
      retry: expect.any(Function),
    });
  });
});
