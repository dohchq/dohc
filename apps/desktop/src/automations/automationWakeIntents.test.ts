import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import {
  automationWakeMessage, createAutomationWakeConsumer, createAutomationWakeIntents, type AutomationWakeIntent,
} from "./automationWakeIntents";
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

type Deps = Parameters<typeof createAutomationWakeConsumer>[0];

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
  it("calls nothing once stopped, and every stop and resume returns the same drain", async () => {
    const w = await world();
    const saved: AutomationWakeIntent[] = [{ ...pending, claimed: false }, { ...second, claimed: true }];
    for (const intent of saved) await w.intents.save(intent);
    const list = vi.fn(w.intents.list);
    const read = vi.fn(w.deps.pending);
    const consumer = createAutomationWakeConsumer({ ...w.deps, intents: { ...w.intents, list }, pending: read });
    const drain = consumer.stop();
    expect(consumer.stop()).toBe(drain);
    expect(consumer.resume()).toBe(drain);
    expect(consumer.resume()).toBe(drain);
    await drain;
    for (const dependency of [list, read, w.deps.ready, w.deps.enabled, w.deps.enabledIfOpen, w.deps.dismiss, w.deps.wake, w.deps.onError]) {
      expect(dependency).not.toHaveBeenCalled();
    }
    expect(await createAutomationWakeIntents(w.file).list()).toEqual(saved);
  });

  it.each(["list", "pending"] as const)("admits no intent when stopped during the %s read, and a restart replays both saved rows", async (stage) => {
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

  it.each<[string, (deps: Deps, hold: () => Promise<void>) => Partial<Deps>, AutomationWakeIntent[]]>([
    ["readiness", (d, hold) => ({ ready: async (intent, runner) => { await hold(); return await d.ready(intent, runner); } }), []],
    ["the open-workspace check", (d, hold) => ({
      ready: async (intent, runner) => !runner || intent.noticeId !== pending.noticeId,
      enabledIfOpen: async (intent) => { await hold(); return await d.enabledIfOpen(intent); },
    }), [{ ...pending, claimed: false }]],
    ["dismissal", (d, hold) => ({ dismiss: async (intent) => { await hold(); return await d.dismiss(intent); } }), []],
    ["the winning save", (d, hold) => ({
      intents: { ...d.intents, save: async (intent) => { if (intent.claimed) await hold(); await d.intents.save(intent); } },
    }), []],
    ["the automation check", (d, hold) => ({ enabled: async (intent) => { await hold(); return await d.enabled(intent); } }), []],
    ["the wake and its activity release", (d, hold) => ({
      wake: async (intent, message) => { try { await d.wake(intent, message); } finally { await hold(); } },
    }), []],
  ])("lets the admitted intent finish %s after stop and leaves the next one for restart", async (_stage, override, kept) => {
    const w = await world();
    await w.intents.save({ ...pending, claimed: false });
    const g = gate();
    const consumer = createAutomationWakeConsumer({ ...w.deps, pending: async () => [second], ...override(w.deps, g.hold) });
    const running = consumer.resume();
    await g.started;
    // A Notice change while the first intent is held asks for another pass.
    expect(consumer.resume()).toBe(running);
    const drain = consumer.stop();
    expect(drain).toBe(running);
    expect(consumer.resume()).toBe(drain);
    let settled = false;
    void drain.then(() => { settled = true; });
    expect(await w.intents.list()).toContainEqual(expect.objectContaining({ noticeId: pending.noticeId }));
    expect(settled).toBe(false);
    g.release();
    await drain;
    expect(w.deps.onError).not.toHaveBeenCalled();
    expect(await createAutomationWakeIntents(w.file).list()).toEqual(kept);
    expect(w.deps.dismiss).not.toHaveBeenCalledWith(expect.objectContaining({ noticeId: second.noticeId }));
    expect(w.deps.wake).not.toHaveBeenCalledWith(expect.objectContaining({ noticeId: second.noticeId }), expect.anything());

    await createAutomationWakeConsumer({ ...w.deps, intents: createAutomationWakeIntents(w.file), pending: async () => [second] }).resume();
    expect(w.deps.wake).toHaveBeenCalledWith({ ...second, claimed: true }, automationWakeMessage(second));
    expect(w.deps.wake).toHaveBeenCalledTimes(2);
    expect(await w.intents.list()).toEqual([]);
  });

  it.each([
    { outcome: "unanswered", kept: [{ ...pending, claimed: false }], errors: 0 },
    { outcome: "not-first", kept: [], errors: 0 },
    { outcome: "a failed dismissal", kept: [{ ...pending, claimed: false }], errors: 1 },
    { outcome: "a failed wake", kept: [{ ...pending, claimed: true }], errors: 1 },
  ])("keeps the journal an admitted intent leaves after stop with $outcome", async ({ outcome, kept, errors }) => {
    const w = await world();
    const g = gate();
    const consumer = createAutomationWakeConsumer({
      ...w.deps,
      pending: async () => [pending, second],
      dismiss: async () => {
        await g.hold();
        if (outcome === "unanswered") return "unanswered";
        if (outcome === "not-first") return "not-first";
        if (outcome === "a failed dismissal") throw new Error("relay down");
        return "first";
      },
      wake: async () => { throw new Error("dohc is quitting"); },
    });
    void consumer.resume();
    await g.started;
    const drain = consumer.stop();
    g.release();
    await drain;
    expect(w.deps.onError).toHaveBeenCalledTimes(errors);
    expect(w.deps.ready).not.toHaveBeenCalledWith(expect.objectContaining({ noticeId: second.noticeId }), expect.anything());
    expect(await createAutomationWakeIntents(w.file).list()).toEqual(kept);
  });
});

function pendingWithClaim() { return { ...pending, claimed: true }; }
