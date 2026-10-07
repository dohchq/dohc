import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_MAX_CHARS } from "../ipc/bridgeContract";
import type { CrashFacts } from "../crashReports/crashReport";
import { diagnosticsText, saveDiagnostics } from "./diagnostics";

const FACTS: CrashFacts = {
  atMs: Date.UTC(2026, 9, 7, 9, 0, 0),
  version: "1.2.3",
  channel: "latest",
  packaged: true,
  system: "Windows_NT 10.0.22631",
  arch: "x64",
  electron: "43.3.0",
  uptimeSeconds: 42,
};
const BOTH = { usage: true, errors: true };

describe("diagnostics", () => {
  it("names the build, the system, the switches, and the crash report", () => {
    expect(diagnosticsText({
      facts: FACTS,
      available: BOTH,
      privacy: { usageReports: true, errorReports: false },
      crashReport: "dohc crash report\n\nTime: 2026-10-07T08:00:00.000Z",
    })).toBe([
      "dohc diagnostics",
      "Created: 2026-10-07T09:00:00.000Z",
      "Version: 1.2.3 (latest)",
      "System: Windows_NT 10.0.22631 x64",
      "Electron: 43.3.0",
      "Running for: 42 s",
      "Usage reports: on",
      "Error reports: off",
      "",
      "dohc crash report",
      "",
      "Time: 2026-10-07T08:00:00.000Z",
    ].join("\n"));
  });

  it("says which reports this launch cannot send, and when nothing went wrong", () => {
    const text = (available: { usage: boolean; errors: boolean }) => diagnosticsText({
      facts: { ...FACTS, packaged: false },
      available,
      privacy: { usageReports: true, errorReports: true },
      crashReport: null,
    });
    const switches = (value: string) => value.split("\n").filter((line) => line.includes(" reports: "));
    expect(text({ usage: false, errors: false })).toContain("Version: 1.2.3 (latest, development build)");
    expect(text({ usage: false, errors: false })).toContain("Recent problems: none");
    expect(switches(text({ usage: false, errors: false })))
      .toEqual(["Usage reports: unavailable for this launch", "Error reports: unavailable for this launch"]);
    expect(switches(text({ usage: true, errors: false })))
      .toEqual(["Usage reports: on", "Error reports: unavailable for this launch"]);
    expect(switches(text({ usage: false, errors: true })))
      .toEqual(["Usage reports: unavailable for this launch", "Error reports: on"]);
  });

  it("stays within its bound", () => {
    const text = diagnosticsText({ facts: FACTS, available: BOTH, privacy: { usageReports: true, errorReports: true }, crashReport: "x".repeat(DIAGNOSTICS_MAX_CHARS) });
    expect(text.length).toBe(DIAGNOSTICS_MAX_CHARS);
  });

  it("saves the text where the person chose, and nothing when they cancel", async () => {
    const writeFile = vi.fn(async () => undefined);
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/chosen/diagnostics.txt" }));
    expect(await saveDiagnostics({ showSaveDialog, writeFile, defaultPath: "/docs/dohc-diagnostics.txt" }, "text")).toBe(true);
    expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "/docs/dohc-diagnostics.txt" }));
    expect(writeFile).toHaveBeenCalledWith("/chosen/diagnostics.txt", "text");

    writeFile.mockClear();
    expect(await saveDiagnostics({
      showSaveDialog: async () => ({ canceled: true }),
      writeFile,
      defaultPath: "/docs/dohc-diagnostics.txt",
    }, "text")).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
