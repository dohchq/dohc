import { describe, expect, it } from "vitest";
import { resolveAgentPresenceActivity } from "./agentPresence";

const owner = { workspaceId: "owner-workspace", userId: "owner" };
const hint = (userId: string, activity: unknown = "working") => ({
  userId,
  clientId: "agent:owner-workspace",
  state: { agent: true, activity, userId: "owner" },
});

describe("agent presence authority", () => {
  it("ignores recipient hints even when their state claims the owner", () => {
    expect(resolveAgentPresenceActivity([hint("recipient")], owner.workspaceId, owner.userId)).toBeNull();
  });

  it("does not let foreign peers mask the real owner's hint", () => {
    expect(resolveAgentPresenceActivity([hint("recipient", "idle"), hint("owner")], owner.workspaceId, owner.userId))
      .toBe("working");
  });

  it.each(["working", "idle"] as const)("accepts the owner's %s hint", (activity) => {
    expect(resolveAgentPresenceActivity([hint("owner", activity)], owner.workspaceId, owner.userId)).toBe(activity);
  });

  it("stays dark without owner authority or with malformed hints", () => {
    expect(resolveAgentPresenceActivity([hint("owner")], owner.workspaceId, null)).toBeNull();
    for (const state of [null, [], "working", { agent: true, activity: "busy" }, { activity: "idle" }]) {
      expect(resolveAgentPresenceActivity([{ ...hint("owner"), state }], owner.workspaceId, owner.userId)).toBeNull();
    }
    expect(resolveAgentPresenceActivity([{ ...hint("owner"), userId: "" }], owner.workspaceId, owner.userId)).toBeNull();
    expect(resolveAgentPresenceActivity([{ ...hint("owner"), clientId: "agent:other" }], owner.workspaceId, owner.userId)).toBeNull();
  });
});
