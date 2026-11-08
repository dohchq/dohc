import { describe, expect, it } from "vitest";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import { agentChatIdentity, orderAgentChats, withListedAgent, type SettingsAgent } from "./agentChat";
import { goneAgentPresentation } from "./actorPresentation";

const AGENTS: SettingsAgent[] = [
  { id: "default", name: "Nova", hue: "olive" },
  { id: "scout", name: "Scout", hue: "teal" },
];
const chat = (agentId: string, name: string) => ({ id: `${agentId}-chat`, kind: "agent" as const, agentId, name });

describe("agentChatIdentity", () => {
  it("names a Settings agent's chat after it, in its hue", () => {
    expect(agentChatIdentity(chat("scout", "Scout"), AGENTS)).toEqual({
      label: "Scout",
      presentation: { group: "", hue: "teal", self: false },
    });
    expect(agentChatIdentity(chat("default", "My agent"), AGENTS)).toEqual({
      label: "Nova",
      presentation: { group: "", hue: null, self: false },
    });
  });

  it("shows a renamed agent's current name, not the one its chat stored", () => {
    expect(agentChatIdentity(chat("scout", "Scout"), [{ id: "scout", name: "Ranger", hue: "plum" }])).toEqual({
      label: "Ranger",
      presentation: { group: "", hue: "plum", self: false },
    });
  });

  it("keeps a removed agent's stored name, with a mark that has no hue", () => {
    expect(agentChatIdentity(chat("helper", "Helper"), AGENTS)).toEqual({
      label: "Helper",
      presentation: goneAgentPresentation,
    });
  });

  it("calls the removed default agent's chat Your agent", () => {
    expect(agentChatIdentity(chat("default", "My agent"), [])).toEqual({
      label: "Your agent",
      presentation: goneAgentPresentation,
    });
  });

  // Dispatch wakes no agent for a chat without an agent id, so it isn't the default agent's.
  it("keeps the stored name of a chat that names no agent", () => {
    expect(agentChatIdentity({ name: "Scout" }, AGENTS)).toEqual({
      label: "Scout",
      presentation: goneAgentPresentation,
    });
  });
});

describe("orderAgentChats", () => {
  it("lists chats in Settings order, then removed agents' chats as listed", () => {
    const channels = [
      chat("gone", "Gone"),
      { id: "general", kind: "channel" as const, name: "general" },
      chat("scout", "Scout"),
      chat("default", "My agent"),
      chat("older", "Older"),
    ];
    expect(orderAgentChats(channels, AGENTS).map((channel) => channel.id)).toEqual([
      "default-chat",
      "scout-chat",
      "gone-chat",
      "older-chat",
    ]);
  });
});

describe("withListedAgent", () => {
  const listed = (id: string, kind: ChatChannelRecord["kind"], agentId?: string): ChatChannelRecord => ({
    id, name: id, slug: id, kind, createdAtMs: 0, updatedAtMs: 0, threadCount: 0, unreadCount: 0, ...(agentId ? { agentId } : {}),
  });
  const channels = [listed("nova-chat", "agent", "default"), listed("general", "channel")];

  it("gives an agent's chat opened without its agent the listed chat", () => {
    expect(withListedAgent({ id: "nova-chat", kind: "agent" as const, name: "My agent" }, channels)).toBe(channels[0]);
  });

  it("keeps a chat that names its agent, a group, and a chat that isn't listed", () => {
    const named = { id: "nova-chat", kind: "agent" as const, agentId: "scout" };
    const group = { id: "general", kind: "channel" as const };
    const unlisted = { id: "elsewhere", kind: "agent" as const };
    expect(withListedAgent(named, channels)).toBe(named);
    expect(withListedAgent(group, channels)).toBe(group);
    expect(withListedAgent(unlisted, channels)).toBe(unlisted);
  });
});
