import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { createRecordByHand, desktopRecordEditContext, type DesktopRecordEditHost, type LocalPersonAuthor } from "./desktopRecordEdits";
import { AuthoredTextChangedError } from "./workspaceEngineCapture";
import { deferred } from "../testing/deferred";

const automation = {
  kind: "automation", automationId: "collection:tasks#stamp", onBehalfOf: "local", depth: 1,
  run: { claimId: "atc_stamp", automationName: "Stamp" },
} as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const personNamed = (humanId: string): LocalPersonAuthor => ({ kind: "human", humanId, authorContext: `context:${humanId}` });

async function scratchRoot(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-record-edits-"));
  roots.push(workspaceRoot);
  return workspaceRoot;
}

async function contextFor(materializeOutcome: string) {
  const capture: DesktopRecordEditHost["capture"] = {
    openRecordSession: () => Promise.reject(new Error("not used")),
    writeAuthoredFile: async (absolutePath) => ({ resolvedAbsolutePath: absolutePath, materializeOutcome }),
  };
  return desktopRecordEditContext({
    capture,
    workspaceRoot: await scratchRoot(),
    person: personNamed("local:installation"),
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
  const writes: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
  const opened: Array<Parameters<DesktopRecordEditHost["capture"]["openRecordSession"]>> = [];
  const context = desktopRecordEditContext({
    capture: {
      openRecordSession: (...args) => {
        opened.push(args);
        return Promise.reject(new Error("not used"));
      },
      writeAuthoredFile: async (...args) => {
        writes.push(args);
        return { resolvedAbsolutePath: args[0], materializeOutcome: "applied" };
      },
    },
    workspaceRoot: await scratchRoot(),
    person: personNamed("local:installation"),
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    signal: new AbortController().signal,
  });
  await context.createFile("tasks/hand.md", "hand made", createLocalChangeAuthor("Hand edit"));
  await context.createFile("tasks/run.md", "run made", automation);
  await expect(context.openRecord("tasks/hand.md")).rejects.toThrow("not used");
  expect(writes[0]?.[2]).toEqual(personNamed("local:installation"));
  expect(writes[0]?.[3]?.createOnly).toBe(true);
  // An automation keeps its declared provenance under the same person.
  expect(writes[1]?.[2]).toEqual({ ...automation, authorContext: "context:local:installation" });
  expect(opened).toEqual([["tasks/hand.md", "context:local:installation"]]);
});

it("a hand-made record keeps the person who asked while it waits for its workspace", async () => {
  const workspaceRoot = await scratchRoot();
  let account = "account-alice";
  const entered = deferred();
  const release = deferred();
  const writes: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
  const creating = createRecordByHand({ workspaceId: "workspace", collectionPath: "tasks", name: "hand" }, {
    author: createLocalChangeAuthor("Alice"),
    localPerson: async () => personNamed(account),
    // The workspace operation and its engine capture are still opening.
    withWorkspaceOperation: async work => {
      entered.resolve();
      await release.promise;
      return await work("operation");
    },
    editContext: async (_operation, person) => desktopRecordEditContext({
      capture: {
        openRecordSession: () => Promise.reject(new Error("not used")),
        writeAuthoredFile: async (...args) => {
          writes.push(args);
          throw new Error("stop after the create");
        },
      },
      workspaceRoot, person, withAdapter: async () => null,
      onCaptureSettled: () => () => undefined, signal: new AbortController().signal,
    }),
  });
  await entered.promise;
  account = "account-bob";
  release.resolve();
  await expect(creating).rejects.toThrow("stop after the create");
  expect(writes.map(write => write[2])).toEqual([personNamed("account-alice")]);
});
