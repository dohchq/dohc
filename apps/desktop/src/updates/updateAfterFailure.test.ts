import { describe, expect, it, vi } from "vitest";
import { createUpdateAfterFailure, type UpdateFailure } from "./updateAfterFailure";
import { deferred } from "../testing/deferred";

const bounds = { verdictMs: 1_000, downloadMs: 2_000 };

function fixture(options: {
  version?: string | null;
  confirm?: boolean;
  install?: { accepted: boolean; cancelled?: boolean };
  controller?: "missing";
} = {}) {
  const awaitUpdate = vi.fn(async (_bounds: typeof bounds, _onDownloading?: (version: string) => void): Promise<string | null> =>
    options.version === undefined ? "2.0.0" : options.version);
  const controller = vi.fn(async () => options.controller === "missing" ? null : { awaitUpdate });
  const confirmRestart = vi.fn(async (_failure: UpdateFailure, _version: string) => options.confirm ?? true);
  const install = vi.fn(async () => options.install ?? { accepted: true });
  // The notice stays until its signal aborts or the test closes it.
  const notices: Array<{ version: string; signal: AbortSignal; close(): void }> = [];
  const showDownloading = vi.fn((_failure: UpdateFailure, version: string, signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve());
    notices.push({ version, signal, close: resolve });
  }));
  const updateAfterFailure = createUpdateAfterFailure({ controller, showDownloading, confirmRestart, install, bounds });
  return { updateAfterFailure, awaitUpdate, controller, showDownloading, notices, confirmRestart, install };
}

describe("update after a failure", () => {
  it("restarts into a downloaded update the person accepts", async () => {
    const f = fixture();
    await expect(f.updateAfterFailure("startup")).resolves.toBe(true);
    expect(f.awaitUpdate).toHaveBeenCalledWith(bounds, expect.any(Function));
    expect(f.confirmRestart).toHaveBeenCalledWith("startup", "2.0.0");
    expect(f.install).toHaveBeenCalledOnce();
  });

  it("leaves the exit to the caller when there is no update, no updater, or the person declines", async () => {
    for (const f of [fixture({ version: null }), fixture({ controller: "missing" })]) {
      await expect(f.updateAfterFailure("startup")).resolves.toBe(false);
      expect(f.confirmRestart).not.toHaveBeenCalled();
      expect(f.install).not.toHaveBeenCalled();
    }
    const declined = fixture({ confirm: false });
    await expect(declined.updateAfterFailure("window-crash")).resolves.toBe(false);
    expect(declined.install).not.toHaveBeenCalled();
  });

  it("keeps the app open when a window with unsaved work stops the restart", async () => {
    await expect(fixture({ install: { accepted: false, cancelled: true } }).updateAfterFailure("startup")).resolves.toBe(true);
    await expect(fixture({ install: { accepted: false } }).updateAfterFailure("startup")).resolves.toBe(false);
  });

  it("shows a notice while the update downloads and closes it once the download ends", async () => {
    const f = fixture();
    const downloaded = deferred<string | null>();
    f.awaitUpdate.mockImplementationOnce((_bounds, onDownloading) => {
      onDownloading?.("2.0.0");
      return downloaded.promise;
    });
    const result = f.updateAfterFailure("startup");
    await vi.waitFor(() => expect(f.notices).toHaveLength(1));
    expect(f.showDownloading).toHaveBeenCalledWith("startup", "2.0.0", f.notices[0]!.signal);
    expect(f.notices[0]!.signal.aborted).toBe(false);
    downloaded.resolve("2.0.0");
    await expect(result).resolves.toBe(true);
    expect(f.notices[0]!.signal.aborted).toBe(true);
    expect(f.confirmRestart).toHaveBeenCalledWith("startup", "2.0.0");
  });

  it("stops waiting when the person closes the download notice", async () => {
    const f = fixture();
    f.awaitUpdate.mockImplementationOnce((_bounds, onDownloading) => {
      onDownloading?.("2.0.0");
      return new Promise<string | null>(() => undefined);
    });
    const result = f.updateAfterFailure("startup");
    await vi.waitFor(() => expect(f.notices).toHaveLength(1));
    f.notices[0]!.close();
    await expect(result).resolves.toBe(false);
    expect(f.confirmRestart).not.toHaveBeenCalled();
  });

  it("falls back to the caller's exit when the check throws", async () => {
    const f = fixture();
    f.awaitUpdate.mockRejectedValueOnce(new Error("updater broke"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(f.updateAfterFailure("startup")).resolves.toBe(false);
      expect(logged).toHaveBeenCalledOnce();
    } finally { logged.mockRestore(); }
  });

  it("shares one check between failures that arrive together, then checks again", async () => {
    const f = fixture();
    const held = deferred<string | null>();
    f.awaitUpdate.mockImplementationOnce(() => held.promise);
    const first = f.updateAfterFailure("window-crash");
    const second = f.updateAfterFailure("window-crash");
    expect(second).toBe(first);
    held.resolve("2.0.0");
    await expect(first).resolves.toBe(true);
    expect(f.confirmRestart).toHaveBeenCalledOnce();
    await f.updateAfterFailure("window-crash");
    expect(f.awaitUpdate).toHaveBeenCalledTimes(2);
  });
});
