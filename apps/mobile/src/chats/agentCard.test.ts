import { describe, expect, it } from "vitest";
import { agentCard, agentCardLabel, reportedClaim } from "./agentCard";

describe("reportedClaim", () => {
  it("joins the product, its version and the model as the desktop does", () => {
    expect(reportedClaim({ product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" })).toBe("Claude Code 2.1 · Claude Opus 5.5");
    expect(reportedClaim({ product: "Claude Code", version: "2.1" })).toBe("Claude Code 2.1");
    expect(reportedClaim({ product: "Claude Code" })).toBe("Claude Code");
    expect(reportedClaim({ model: "Claude Opus 5.5" })).toBe("Claude Opus 5.5");
    expect(reportedClaim({ version: "2.1" })).toBeUndefined();
    expect(reportedClaim(undefined)).toBeUndefined();
  });
});

describe("agentCard", () => {
  const reported = { product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" };

  it("marks a connected agent's reported line, and not its name", () => {
    const card = agentCard({ name: "Scout", named: true, kind: "connected", reported });
    expect(card).toEqual({ name: "Scout", nameAsReported: false, kindLine: "Connected agent", reported: "Claude Code 2.1 · Claude Opus 5.5", markLabel: "connected agent" });
    expect(agentCardLabel(card)).toBe("Scout, Connected agent, Claude Code 2.1 · Claude Opus 5.5 (as reported)");
  });

  it("marks a connected agent's name when it reported nothing else", () => {
    const card = agentCard({ name: "Scout", named: true, kind: "connected" });
    expect(card.nameAsReported).toBe(true);
    expect(card.reported).toBeUndefined();
    expect(agentCardLabel(card)).toBe("Scout (as reported), Connected agent");
  });

  it("calls an agent that gave no name Agent, with no mark", () => {
    const card = agentCard({ name: "", named: false, kind: "connected" });
    expect(card.name).toBe("Agent");
    expect(card.nameAsReported).toBe(false);
  });

  it("claims no kind for an agent of unknown kind, and reads it as agent", () => {
    const card = agentCard({ name: "Helper", named: true, kind: "unknown" });
    expect(card.kindLine).toBeUndefined();
    expect(card.markLabel).toBe("agent");
    expect(card.nameAsReported).toBe(true);
  });

  it("names your own agent's owner, or says the name is unavailable, and never marks it", () => {
    expect(agentCard({ name: "Nova", named: true, kind: "own", owner: "Ice" })).toMatchObject({ kindLine: "Owned by Ice", nameAsReported: false, markLabel: "agent" });
    expect(agentCard({ name: "Nova", named: true, kind: "own" }).kindLine).toBe("Owner name unavailable");
  });
});
