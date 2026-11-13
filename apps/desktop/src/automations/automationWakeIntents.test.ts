import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { automationWakeMessage, createAutomationWakeConsumer, createAutomationWakeIntents } from "./automationWakeIntents";
import type { PendingAutomationWake } from "../notices/noticeStore";

const pending: PendingAutomationWake = {
  account: "relay#owner", workspaceId: "workspace", noticeId: "automation-wake:" + "a".repeat(64),
  wake: { automationId: "collection:Tasks#ask", name: "Ask", depth: 3, body: "Check the task." },
};

async function world() {
  const file = join(await createTestScratch("wake-intents-"), "intents.json");
  const intents = createAutomationWakeIntents(file);
  const deps = {
    intents, pending: async () => [pending],
    ready: vi.fn(async () => true),
    enabled: vi.fn(async () => true),
    enabledIfOpen: vi.fn(async (): Promise<boolean | undefined> => true),
    dismiss: vi.fn(async (): Promise<"first" | "not-first" | "unanswered"> => "first"),
    wake: vi.fn(async () => undefined), onError: vi.fn(),
  };
  return { file, intents, deps };
}

describe("durable agent wakes", () => {

  it("recovers a lost dismissal response by asking with the saved intent", async () => {
    const w = await world();
    w.deps.dismiss.mockResolvedValueOnce("unanswered").mockResolvedValueOnce("first");
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([{ ...pending, claimed: false }]);
    await createAutomationWakeConsumer({ ...w.deps, intents: createAutomationWakeIntents(w.file), pending: async () => [] }).resume();
    expect(w.deps.wake).toHaveBeenCalledTimes(1);
    expect(await w.intents.list()).toEqual([]);
  });

  it("resumes a saved winner without dismissing again and reuses the message id", async () => {
    const w = await world();
    w.deps.wake.mockRejectedValueOnce(new Error("crash after message write")).mockResolvedValueOnce(undefined);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(await w.intents.list()).toEqual([pendingWithClaim()]);
    await createAutomationWakeConsumer({ ...w.deps, intents: createAutomationWakeIntents(w.file), pending: async () => [] }).resume();
    expect(w.deps.dismiss).toHaveBeenCalledTimes(1);
    expect(w.deps.wake.mock.calls[0]).toEqual(w.deps.wake.mock.calls[1]);
    expect(await w.intents.list()).toEqual([]);
  });

  it("never runs a losing computer and keeps unavailable computers from claiming", async () => {
    const w = await world();
    w.deps.ready.mockResolvedValueOnce(false);
    const consumer = createAutomationWakeConsumer(w.deps);
    await consumer.resume();
    expect(w.deps.dismiss).not.toHaveBeenCalled();
    w.deps.dismiss.mockResolvedValue("not-first");
    await consumer.resume();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([]);
  });

  it("serializes concurrent drains and keeps accounts with the same notice id separate", async () => {
    const w = await world();
    const other = { ...pending, account: "other-relay#owner", claimed: true };
    await w.intents.save(other);
    w.deps.ready.mockImplementation(async (intent?: PendingAutomationWake) => intent?.account === pending.account);
    const consumer = createAutomationWakeConsumer(w.deps);
    await Promise.all([consumer.resume(), consumer.resume()]);
    expect(w.deps.wake).toHaveBeenCalledTimes(1);
    expect(await w.intents.list()).toEqual([other]);
    expect(automationWakeMessage(other).messageId).not.toBe(automationWakeMessage(pending).messageId);
  });

  it.each([false])("dismisses disabled or deleted wakes without a runner (claimed: %s)", async (claimed) => {
    const w = await world();
    await w.intents.save({ ...pending, claimed });
    w.deps.enabled.mockResolvedValue(false);
    w.deps.enabledIfOpen.mockResolvedValue(false);
    w.deps.ready.mockImplementation(async (_intent?: PendingAutomationWake, needsRunner = true) => !needsRunner);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(await w.intents.list()).toEqual([]);
    expect(w.deps.dismiss).toHaveBeenCalledTimes(claimed ? 0 : 1);
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(w.deps.enabled).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt intents instead of replacing them with an empty list", async () => {
    const w = await world();
    await writeFile(w.file, "{broken");
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.onError).toHaveBeenCalledTimes(1);
    expect(w.deps.dismiss).not.toHaveBeenCalled();
  });
});

const second: PendingAutomationWake = { ...pending, noticeId: "automation-wake:" + "b".repeat(64) };

// Holds the first call that reaches it until released.
function gate() {
  const started = deferred();
  const released = deferred();
  let used = false;
  return {
    started: started.promise,
    release: () => released.resolve(),
    hold: async () => {
      if (used) return;
      used = true;
      started.resolve();
      await released.promise;
    },
  };
}

describe("agent wakes stopped at quit", () => {

  it.each(["pending"] as const)("admits no intent when stopped during the %s read, and a restart replays both saved rows", async (stage: "list" | "pending") => {
    const w = await world();
    await w.intents.save({ ...pending, claimed: false });
    await w.intents.save({ ...second, claimed: true });
    const g = gate();
    const read = vi.fn(async (): Promise<PendingAutomationWake[]> => []);
    const consumer = createAutomationWakeConsumer({
      ...w.deps,
      intents: { ...w.intents, list: async () => { if (stage === "list") await g.hold(); return await w.intents.list(); } },
      pending: async () => { if (stage === "pending") await g.hold(); return await read(); },
    });
    const running = consumer.resume();
    await g.started;
    expect(consumer.stop()).toBe(running);
    g.release();
    await running;
    expect(read).toHaveBeenCalledTimes(stage === "list" ? 0 : 1);
    for (const dependency of [w.deps.ready, w.deps.enabled, w.deps.enabledIfOpen, w.deps.dismiss, w.deps.wake, w.deps.onError]) {
      expect(dependency).not.toHaveBeenCalled();
    }
    expect(await createAutomationWakeIntents(w.file).list()).toEqual([{ ...pending, claimed: false }, { ...second, claimed: true }]);

    await createAutomationWakeConsumer({ ...w.deps, intents: createAutomationWakeIntents(w.file), pending: async () => [] }).resume();
    // Only the unclaimed row asks the relay; the saved winner wakes without asking.
    expect(w.deps.dismiss).toHaveBeenCalledOnce();
    expect(w.deps.wake).toHaveBeenCalledTimes(2);
    expect(await w.intents.list()).toEqual([]);
  });

});

function pendingWithClaim() { return { ...pending, claimed: true }; }
