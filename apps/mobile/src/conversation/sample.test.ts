import { describe, expect, it } from "vitest";
import { sampleMessages, sampleMessagesFor } from "./sample";

describe("sampleMessagesFor", () => {
  it("shows only you and the agent in an agent's direct chat", () => {
    for (const [chatId, agent] of [["a-nova", "nova"], ["a-scout", "scout"]] as const) {
      const authors = new Set(sampleMessagesFor(chatId).map(message => message.author.id));
      expect([...authors].sort()).toEqual(["me", agent].sort());
    }
  });

  it("keeps the connected agent's plug and colour on its messages", () => {
    const scout = sampleMessagesFor("a-scout").find(message => message.author.id === "scout")?.author;
    expect(scout).toMatchObject({ kind: "agent", connected: true, agentHue: "amber" });
  });

  it("shows #planning in every other chat", () => {
    expect(sampleMessagesFor("g-planning")).toBe(sampleMessages);
    expect(sampleMessagesFor("c-packing")).toBe(sampleMessages);
  });
});
