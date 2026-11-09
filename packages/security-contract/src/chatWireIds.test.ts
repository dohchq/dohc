import { describe, expect, it } from "vitest";
import { AGENT_CHANNEL_WIRE_ID, GENERAL_CHANNEL_WIRE_ID, agentIdForChannelWireId } from "./chatWireIds";

describe("agentIdForChannelWireId", () => {
  it("reads the agent from an agent chat's wire id", () => {
    expect(agentIdForChannelWireId(AGENT_CHANNEL_WIRE_ID)).toBe("default");
    expect(agentIdForChannelWireId(`${AGENT_CHANNEL_WIRE_ID}_terminal`)).toBe("terminal");
    expect(agentIdForChannelWireId(`${AGENT_CHANNEL_WIRE_ID}_claude-2`)).toBe("claude-2");
  });

  it.each([
    GENERAL_CHANNEL_WIRE_ID,
    "channel-project",
    `${AGENT_CHANNEL_WIRE_ID}_`,
    `${AGENT_CHANNEL_WIRE_ID}_default`,
    `${AGENT_CHANNEL_WIRE_ID}_Terminal`,
    `${AGENT_CHANNEL_WIRE_ID}_a--b`,
    `${AGENT_CHANNEL_WIRE_ID}_trailing-`,
    `${AGENT_CHANNEL_WIRE_ID}x`,
    `${AGENT_CHANNEL_WIRE_ID}_${"a".repeat(65)}`,
  ])("names no agent for %s", (wireId) => {
    expect(agentIdForChannelWireId(wireId)).toBeNull();
  });
});
