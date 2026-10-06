import { describe, expect, it } from "vitest";
import { resolveAgentPresenceActivity } from "./agentPresence";

const workspaceId = "owner-workspace";
const hint = (activity: unknown = "working") => ({
  clientId: "agent:owner-workspace",
  state: { agent: true, activity },
});

describe("agent presence activity", () => {
  it.each(["working", "idle"] as const)("accepts a %s hint", (activity) => {
    expect(resolveAgentPresenceActivity([hint(activity)], workspaceId)).toBe(activity);
  });

  it("shows no hint for malformed state", () => {
    for (const state of [null, [], "working", { agent: true, activity: "busy" }, { activity: "idle" }]) {
      expect(resolveAgentPresenceActivity([{ ...hint(), state }], workspaceId)).toBeNull();
    }
  });

  it("shows no hint for another workspace", () => {
    expect(resolveAgentPresenceActivity([{ ...hint(), clientId: "agent:other" }], workspaceId)).toBeNull();
  });
});
