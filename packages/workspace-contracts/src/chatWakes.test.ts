import { describe, expect, it } from "vitest";
import { PhoneChatContext, PhoneChatWake } from "./chatWakes";

const wake = {
  wakeId: `wake-${"0".repeat(32)}`,
  messageId: "message-1",
  threadId: "thread-1",
  generation: 1,
  state: "waiting",
  winnerLabel: null,
  agentName: "Claude",
  canRetry: false,
};

describe("a phone's wake", () => {
  it("names its agent, or null when no computer declares it now", () => {
    expect(PhoneChatWake.parse(wake)).toEqual(wake);
    expect(PhoneChatWake.parse({ ...wake, agentName: null })).toEqual({
      ...wake,
      agentName: null,
    });
    expect(PhoneChatWake.parse({ ...wake, agentName: "x".repeat(256) }).agentName).toHaveLength(
      256,
    );
  });

  it("refuses a wake without its agent's name, an empty or overlong name, and any private field", () => {
    const unnamed = Object.fromEntries(Object.entries(wake).filter(([key]) => key !== "agentName"));
    for (const [label, value] of [
      ["no name", unnamed],
      ["an empty name", { ...wake, agentName: "" }],
      ["an overlong name", { ...wake, agentName: "x".repeat(257) }],
      ["a name that isn't text", { ...wake, agentName: 7 }],
      ["an install ID", { ...wake, installId: "install-9f2c" }],
      ["an agent ID", { ...wake, agentId: "default" }],
      ["candidates", { ...wake, candidates: [] }],
      ["a target", { ...wake, target: "mention:claude" }],
    ] as const) {
      expect(PhoneChatWake.safeParse(value).success, label).toBe(false);
    }
  });

  it("takes a whole context whose wakes share a name as separate wakes", () => {
    const context = {
      ok: true,
      conversation: {
        kind: "thread",
        threadId: "thread-1",
        groupKind: "group",
        nextBefore: null,
      },
      mentions: [],
      wakes: [
        { ...wake, agentName: "Helper" },
        { ...wake, wakeId: `wake-${"1".repeat(32)}`, agentName: "Helper" },
      ],
      wakeCursor: "3",
    };
    expect(PhoneChatContext.parse(context).wakes).toHaveLength(2);
    expect(
      PhoneChatContext.safeParse({ ...context, wakes: [{ ...wake, agentName: undefined }] })
        .success,
    ).toBe(false);
  });
});
