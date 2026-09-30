import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopRecordEditContext, type DesktopRecordEditHost } from "./desktopRecordEdits";
import { AuthoredTextChangedError } from "./workspaceEngineCapture";

const automation = { kind: "automation", automationId: "collection:tasks#stamp", onBehalfOf: "local", depth: 1 } as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function contextFor(materializeOutcome: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-record-edits-"));
  roots.push(workspaceRoot);
  const capture: DesktopRecordEditHost["capture"] = {
    openYDocSession: () => Promise.reject(new Error("not used")),
    writeAuthoredFile: async (absolutePath) => ({ resolvedAbsolutePath: absolutePath, materializeOutcome }),
  };
  return desktopRecordEditContext({
    capture,
    workspaceRoot,
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    signal: new AbortController().signal,
  });
}

describe("desktopRecordEditContext createFile for an automation", () => {
  it("returns the path when the engine published the file", async () => {
    const context = await contextFor("applied");
    await expect(context.createFile("tasks/a.md", "text", automation)).resolves.toBe("tasks/a.md");
  });

  it.each(["conflict", "superseded"])("refuses a %s publication as a changed file", async (outcome) => {
    const context = await contextFor(outcome);
    await expect(context.createFile("tasks/a.md", "text", automation)).rejects.toBeInstanceOf(AuthoredTextChangedError);
  });

  it("refuses a skipped publication instead of reporting the record created", async () => {
    const context = await contextFor("skipped");
    await expect(context.createFile("tasks/a.md", "text", automation)).rejects.toThrow("dohc could not publish tasks/a.md");
  });
});
