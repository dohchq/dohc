import { describe, expect, it } from "vitest";
import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import { whoChangedLast, whoSwitchedOff, type AutomationHistoryMoment, type AutomationsFileHistory } from "./automationHistory";

const input = { path: "Tasks/automations.yaml", id: "hourly", ownerUserId: "owner" };
const file = (name: string, enabled = true) =>
  `version: 1\nautomations:\n  - id: hourly\n    name: ${name}\n    enabled: ${enabled}\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n`;
const named = (userId: string): MomentAuthor => ({ kind: "named", userId, grantId: "grant", grantGeneration: 1 });
const automation: MomentAuthor = { kind: "automation", automationId: "collection:Tasks#hourly", depth: 1 };
const agent: MomentAuthor = { kind: "agent", agentId: "helper", onBehalfOf: "owner" };
const human: MomentAuthor = { kind: "human", humanId: "local-human" };

function change(before: string, after: string, authors?: MomentAuthor[]): AutomationHistoryMoment {
  return { operation: "write", payload: { before: { text: before }, after: { text: after } }, ...(authors ? { authors } : {}) };
}

function history(...moments: AutomationHistoryMoment[]): AutomationsFileHistory {
  return {
    flush: async () => {},
    fileObjectIdForPath: async () => "object",
    listMoments: async () => ({ moments: moments.map((_, index) => ({ id: String(index), protected: false })), nextBeforeMomentOrder: null }),
    readMoment: async (id) => ({ protected: false, moment: moments[Number(id)]! }),
  };
}

describe("the last person who changed an automation entry", () => {
  it.each([
    { authors: undefined, expected: "owner" },
    { authors: [], expected: "owner" },
    { authors: [human], expected: "owner" },
    { authors: [agent], expected: "owner" },
    { authors: [human, agent], expected: "owner" },
    { authors: [named("editor"), named("editor")], expected: "editor" },
    { authors: [human, automation], expected: null },
    { authors: [named("editor"), named("other")], expected: null },
  ])("names $expected for $authors", async ({ authors, expected }) => {
    await expect(whoChangedLast(history(change(file("Old"), file("New"), authors)), input)).resolves.toBe(expected);
  });

  it("skips automation edits and changes to other entries", async () => {
    const withOther = (name: string) => `${file("New")}  - id: other\n    name: ${name}\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n`;
    await expect(whoChangedLast(history(
      change(withOther("Old"), withOther("New"), [named("other-editor")]),
      change(file("New"), file("New", false), [automation]),
      change(file("Old"), file("New"), [named("editor")]),
    ), input)).resolves.toBe("editor");
  });

  it("keeps conflicting people's newest edit unknown instead of naming an earlier editor", async () => {
    await expect(whoChangedLast(history(
      change(file("New"), file("Newest"), [named("editor"), named("other")]),
      change(file("Old"), file("New"), [named("earlier")]),
    ), input)).resolves.toBeNull();
  });

  it("names the switcher and the prior entry editor from author lists", async () => {
    await expect(whoSwitchedOff(history(
      change(file("New"), file("New", false), [named("switcher")]),
      change(file("Old"), file("New"), [named("editor")]),
    ), input)).resolves.toMatchObject({ switchedOffBy: { kind: "person", userId: "switcher" }, lastChangedBy: "editor" });
  });

  it.each([
    { authors: [automation] },
    { authors: [human, automation] },
  ])("does not name a switcher for $authors", async ({ authors }) => {
    await expect(whoSwitchedOff(history(
      change(file("New"), file("New", false), authors),
      change(file("Old"), file("New"), [named("editor")]),
    ), input)).resolves.toBeNull();
  });
});
