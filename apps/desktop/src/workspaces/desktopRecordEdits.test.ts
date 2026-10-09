import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import type { RecordEditSession, RecordUpdateOptions } from "@dohc/automation-executor/collection-record-edits";
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

const personNamed = (humanId: string): LocalPersonAuthor => ({ kind: "human", humanId });

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
  it("names creation with the same key across retries and Collection moves", async () => {
    const inputs: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
    const context = desktopRecordEditContext({ capture: {
      openRecordSession: async () => { throw Error("unused"); },
      writeAuthoredFile: async (...args) => { inputs.push(args); return { resolvedAbsolutePath: args[0], materializeOutcome: "applied" }; },
    }, workspaceRoot: await scratchRoot(), person: personNamed("local"), withAdapter: async () => null,
    onCaptureSettled: () => () => undefined, signal: new AbortController().signal });
    const text = "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n";
    await context.createFile("tasks/a.md", text, automation);
    await context.createFile("tasks/a.md", text, automation);
    await context.createFile("moved/a.md", text, automation);
    expect(inputs.map(input => input[3]?.requestId)).toEqual(Array(3).fill(inputs[0]?.[3]?.requestId));
    expect(inputs[0]?.[3]?.requestId).toMatch(/^automation-create:[a-f0-9]{64}$/);
  });
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

it("names main's person on a hand-made record and the run's person on an automation's or agent's", async () => {
  const writes: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
  const context = desktopRecordEditContext({
    capture: {
      openRecordSession: () => Promise.reject(new Error("not used")),
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
  // A run Bob's synced edit started, a scheduled run, and an agent working for this person.
  const forBob = { ...automation, onBehalfOf: "bob" };
  const scheduled = { kind: "automation", automationId: "collection:tasks#weekly", depth: 0,
    run: { claimId: "atc_weekly", automationName: "Weekly" } } as const;
  const agent = { kind: "agent", agentId: "cli-agent", onBehalfOf: "local:installation", depth: 0 } as const;
  await context.createFile("tasks/hand.md", "hand made", createLocalChangeAuthor("Someone else"));
  await context.createFile("tasks/bob.md", "run made", forBob);
  await context.createFile("tasks/weekly.md", "run made", scheduled);
  await context.createFile("tasks/agent.md", "agent made", agent);
  expect(writes.map(write => write[2])).toEqual([personNamed("local:installation"), forBob, scheduled, agent]);
  expect(writes.every(write => write[3]?.createOnly === true)).toBe(true);
});

it("names main's person on a person's field edit and keeps an automation's or agent's own", async () => {
  const applied: RecordUpdateOptions[] = [];
  const session: RecordEditSession = {
    applyDecidedLocalUpdate: async (_decide, _onArmed, options) => { applied.push(options); return true; },
    settleNow: async () => undefined,
    close: async () => undefined,
  };
  const context = desktopRecordEditContext({
    capture: { openRecordSession: async () => session, writeAuthoredFile: () => Promise.reject(new Error("not used")) },
    workspaceRoot: await scratchRoot(),
    person: personNamed("account-alice"),
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    signal: new AbortController().signal,
  });
  const record = await context.openRecord("tasks/one.md");
  const forBob = { actorOriginId: automation.automationId,
    attribution: { actorKind: "automation" as const, onBehalfOf: "bob", depth: 1, run: automation.run } };
  const agent = { actorOriginId: "cli-agent", attribution: { actorKind: "agent" as const, onBehalfOf: "account-alice", depth: 0 } };
  await record.applyDecidedLocalUpdate(() => null, () => undefined, { attribution: { actorKind: "human" }, idempotencyKey: "typed" });
  await record.applyDecidedLocalUpdate(() => null, () => undefined, forBob);
  await record.applyDecidedLocalUpdate(() => null, () => undefined, agent);
  expect(applied).toEqual([
    { actorOriginId: "account-alice", attribution: { actorKind: "human", onBehalfOf: "account-alice", depth: 0 }, idempotencyKey: "typed" },
    forBob,
    agent,
  ]);
});

it("a hand-made record keeps the person who asked while it waits for its workspace", async () => {
  const workspaceRoot = await scratchRoot();
  let account = "account-alice";
  const entered = deferred();
  const release = deferred();
  const writes: Array<Parameters<DesktopRecordEditHost["capture"]["writeAuthoredFile"]>> = [];
  const creating = createRecordByHand({ collectionPath: "tasks", name: "hand" }, {
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
