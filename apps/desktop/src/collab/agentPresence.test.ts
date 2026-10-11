import { describe, expect, it } from "vitest";
import { resolveAgentPresenceActivity } from "./agentPresence";

const hint = (activity: unknown = "working") => ({
  sessionToken: "relay-session",
  state: { agent: true, activity },
});

describe("agent presence activity", () => {
  it.each(["working", "idle"] as const)("accepts a %s hint", (activity) => {
    expect(resolveAgentPresenceActivity([hint(activity)])).toBe(activity);
  });

  it("shows no hint for malformed state", () => {
    for (const state of [null, [], "working", { agent: true, activity: "busy" }, { activity: "idle" }]) {
      expect(resolveAgentPresenceActivity([{ ...hint(), state }])).toBeNull();
    }
  });

  it("ignores ordinary peers before the relay-admitted agent hint", () => {
    expect(resolveAgentPresenceActivity([{ sessionToken: "ordinary", state: {} }, hint()])).toBe("working");
  });
});
