import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createCrashReportPreview } from "./crashReportPreview";

let path = "";
beforeEach(async () => {
  path = join(await createTestScratch("crash-report-preview"), "crash-report-to-send.txt");
});

describe("crash report preview", () => {
  it("writes the exact text new, opens it, and removes it", async () => {
    const opened: string[] = [];
    // A file left by an earlier dohc, with looser permissions.
    writeFileSync(path, "old text", { mode: 0o644 });
    const preview = createCrashReportPreview({ path, openPath: async (target) => (opened.push(target), "") });
    await preview.show("dohc crash report\n\nProcess: main");
    expect(opened).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("dohc crash report\n\nProcess: main");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await preview.remove();
    expect(existsSync(path)).toBe(false);
    // Removing again, as startup does, is quiet.
    await preview.remove();
  });

  it("says why when the editor cannot open it", async () => {
    const preview = createCrashReportPreview({ path, openPath: async () => "no application is associated" });
    await expect(preview.show("dohc crash report")).rejects.toThrow("dohc could not open the report: no application is associated");
  });
});
