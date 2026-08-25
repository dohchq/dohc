import { describe, expect, it, vi } from "vitest";
import { launchMarks, logLaunchMarksOnce } from "./launchMarks";

describe("launch marks log", () => {
  // The daemon handshake and the renderer's first paint race, and BOTH
  // callers log after marking — the line must still print exactly once, and
  // only once every mark has landed.
  it("logs the snapshot exactly once even when the triggering events double-fire", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      launchMarks.appReady();
      launchMarks.firstWindow();
      // daemonReady and firstPaint are still missing: no line yet.
      logLaunchMarksOnce();
      expect(info).not.toHaveBeenCalled();

      launchMarks.daemonReady();
      launchMarks.firstPaint();
      logLaunchMarksOnce();
      // A renderer reload re-fires firstPaint and a caller can log again.
      launchMarks.daemonReady();
      launchMarks.firstPaint();
      logLaunchMarksOnce();

      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]?.[0])).toContain("launch marks");
    } finally {
      info.mockRestore();
    }
  });
});
