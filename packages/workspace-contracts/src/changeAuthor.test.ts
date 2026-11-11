import { describe, expect, it } from "vitest";
import { storableChangeAuthor } from "./changeAuthor";

describe("storableChangeAuthor", () => {
  const agent = { kind: "agent", agentId: "agent-1", onBehalfOf: "person-1", depth: 1 } as const;

  it("keeps a name the engine stores", () => {
    expect(storableChangeAuthor({ ...agent, agentName: "x".repeat(64) })).toEqual({ ...agent, agentName: "x".repeat(64) });
    expect(storableChangeAuthor({ kind: "person", personId: "person-1" })).toEqual({ kind: "person", personId: "person-1" });
  });

  it.each([["empty", ""], ["too long", "x".repeat(65)], ["a lone surrogate", "Planner \ud800"]])("leaves out a name that is %s", (_case, agentName) => {
    expect(storableChangeAuthor({ ...agent, agentName })).toEqual(agent);
  });
});
