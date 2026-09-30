import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
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
  it("saves before dismissal and saves the winning receipt before waking", async () => {
    const w = await world();
    w.deps.dismiss.mockImplementation(async () => {
      expect(await w.intents.list()).toEqual([{ ...pending, claimed: false }]);
      return "first";
    });
    w.deps.wake.mockImplementation(async () => {
      expect(await w.intents.list()).toEqual([{ ...pending, claimed: true }]);
    });
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.wake).toHaveBeenCalledExactlyOnceWith(pendingWithClaim(), automationWakeMessage(pending));
    expect(w.deps.enabledIfOpen).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([]);
  });

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

  it("holds a winner across an account change and resumes only in its account", async () => {
    const w = await world();
    w.deps.ready.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([pendingWithClaim()]);
    await createAutomationWakeConsumer({ ...w.deps, pending: async () => [] }).resume();
    expect(w.deps.wake).toHaveBeenCalledTimes(1);
    expect(w.deps.dismiss).toHaveBeenCalledTimes(1);
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

  it.each([false, true])("dismisses a disabled or deleted automation without waking (claimed: %s)", async (claimed) => {
    const w = await world();
    await w.intents.save({ ...pending, claimed });
    w.deps.enabled.mockResolvedValue(false);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([]);
    expect(w.deps.dismiss).toHaveBeenCalledTimes(claimed ? 0 : 1);
  });

  it.each([false, true])("dismisses disabled or deleted wakes without a runner (claimed: %s)", async (claimed) => {
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

  it.each([false, true])("does not open workspace activity on resume without a runner when closed (claimed: %s)", async (claimed) => {
    const w = await world();
    await w.intents.save({ ...pending, claimed });
    const acquireDispatchRunActivity = vi.fn(async () => undefined);
    w.deps.enabled.mockImplementation(async () => {
      await acquireDispatchRunActivity();
      return true;
    });
    w.deps.enabledIfOpen.mockResolvedValue(undefined);
    w.deps.ready.mockImplementation(async (_intent?: PendingAutomationWake, needsRunner = true) => !needsRunner);
    const consumer = createAutomationWakeConsumer(w.deps);
    await consumer.resume();
    await consumer.resume();
    expect(acquireDispatchRunActivity).not.toHaveBeenCalled();
    expect(w.deps.dismiss).not.toHaveBeenCalled();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(w.deps.onError).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([{ ...pending, claimed }]);
  });

  it("keeps enabled wakes parked without a runner", async () => {
    const w = await world();
    w.deps.ready.mockImplementation(async (_intent?: PendingAutomationWake, needsRunner = true) => !needsRunner);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.dismiss).not.toHaveBeenCalled();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(w.deps.onError).not.toHaveBeenCalled();
    expect(w.deps.enabled).not.toHaveBeenCalled();
  });

  it("parks the winner without opening activity if the runner disappears during dismissal", async () => {
    const w = await world();
    w.deps.dismiss.mockImplementation(async () => {
      w.deps.ready.mockImplementation(async (_intent?: PendingAutomationWake, needsRunner = true) => !needsRunner);
      return "first";
    });
    w.deps.enabledIfOpen.mockResolvedValue(undefined);
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.enabled).not.toHaveBeenCalled();
    expect(w.deps.wake).not.toHaveBeenCalled();
    expect(w.deps.onError).not.toHaveBeenCalled();
    expect(await w.intents.list()).toEqual([pendingWithClaim()]);
  });

  it("fails closed on corrupt intents instead of replacing them with an empty list", async () => {
    const w = await world();
    await writeFile(w.file, "{broken");
    await createAutomationWakeConsumer(w.deps).resume();
    expect(w.deps.onError).toHaveBeenCalledTimes(1);
    expect(w.deps.dismiss).not.toHaveBeenCalled();
  });
});

function pendingWithClaim() { return { ...pending, claimed: true }; }
