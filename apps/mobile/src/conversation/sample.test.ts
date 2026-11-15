import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../server/testServer";
import { createSampleWakes, sampleMessages, sampleMessagesFor, type SampleWakes } from "./sample";

describe("sampleMessagesFor", () => {
  it("shows only you and the agent in an agent's direct chat", () => {
    for (const [chatId, agent] of [
      ["a-nova", "nova"],
      ["a-scout", "scout"],
    ] as const) {
      const authors = new Set(sampleMessagesFor(chatId).map((message) => message.author.id));
      expect([...authors].sort()).toEqual(["me", agent].sort());
    }
  });

  it("keeps the connected agent's plug and colour on its messages", () => {
    const scout = sampleMessagesFor("a-scout").find(
      (message) => message.author.id === "scout",
    )?.author;
    expect(scout).toMatchObject({ kind: "agent", connected: true, agentHue: "amber" });
  });

  it("shows #planning in every other chat", () => {
    expect(sampleMessagesFor("g-planning")).toBe(sampleMessages);
    expect(sampleMessagesFor("c-packing")).toBe(sampleMessages);
  });
});

// `talk-wakes`'s Try again: the same lifetime as a server conversation's, with no server.
describe("createSampleWakes", () => {
  afterEach(() => vi.useRealTimers());

  /** The sample's one wake under `messageId`: k6 didn't start, k7 isn't confirmed. */
  const only = (wakes: SampleWakes, messageId: string): PhoneChatWake => {
    const found = wakes.byMessage()?.get(messageId)?.[0];
    if (!found) throw new Error(`no sample wake under ${messageId}`);
    return found;
  };

  it("sends nothing for an alert answered after stop", async () => {
    const wakes = createSampleWakes("talk-wakes");
    const wake = only(wakes, "k7");
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    wakes.retry(wake, { allowed: () => true, confirm });
    expect(confirm).toHaveBeenCalledWith(wake);
    wakes.stop();
    answer.resolve(true);
    // The sample's own answer to the alert ran first.
    await answer.promise;
    expect(wakes.retries().size).toBe(0);
  });

  it("shows the agent waiting at the next generation once it answers", () => {
    vi.useFakeTimers();
    const wakes = createSampleWakes("talk-wakes");
    const wake = only(wakes, "k6");
    wakes.retry(wake, { allowed: () => true, confirm: async () => true });
    expect(wakes.retries().get(wake.wakeId)?.phase).toBe("sending");
    vi.runAllTimers();
    expect(only(wakes, "k6")).toMatchObject({ generation: 2, state: "waiting" });
    expect(wakes.retries().size).toBe(0);
  });

  it("drops its answer when the gate closed before it came", () => {
    vi.useFakeTimers();
    const wakes = createSampleWakes("talk-wakes");
    const wake = only(wakes, "k6");
    let allowed = true;
    wakes.retry(wake, { allowed: () => allowed, confirm: async () => true });
    allowed = false;
    vi.runAllTimers();
    expect(only(wakes, "k6")).toBe(wake);
    expect(wakes.retries().size).toBe(0);
  });
});
