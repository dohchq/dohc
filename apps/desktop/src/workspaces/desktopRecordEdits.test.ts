import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { desktopRecordEditContext, type DesktopRecordEditHost } from "./desktopRecordEdits";
import { AuthoredTextChangedError } from "./workspaceEngineCapture";

const automation = {
  kind: "automation", automationId: "collection:tasks#stamp", onBehalfOf: "local", depth: 1,
  run: { claimId: "atc_stamp", automationName: "Stamp" },
} as const;
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
    personAuthor: () => ({ kind: "human", humanId: "local:installation" }),
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

it("hand creation uses the person main captured instead of a caller's claim", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-record-edits-person-"));
  roots.push(workspaceRoot);
  const writes: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
  const context = desktopRecordEditContext({
    capture: {
      openYDocSession: () => Promise.reject(new Error("not used")),
      writeAuthoredFile: async (...args) => {
        writes.push(args);
        return { resolvedAbsolutePath: args[0], materializeOutcome: "applied" };
      },
    },
    workspaceRoot,
    personAuthor: () => ({ kind: "human", humanId: "local:installation", authorContext: "host-context" }),
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    signal: new AbortController().signal,
  });
  await context.createFile("tasks/hand.md", "hand made", createLocalChangeAuthor("Hand edit"));
  expect(writes[0]?.[2]).toEqual({ kind: "human", humanId: "local:installation", authorContext: "host-context" });
  expect(writes[0]?.[3]?.createOnly).toBe(true);
});
