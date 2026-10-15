import { expect, it } from "vitest";
import { ACTOR_HUES, actorHueSlot } from "./actorPresentation";
it.each([["", 2], ["alice", 6], ["A😀", 4], ["é", 0]] as const)("pins frozen code-point hue slot %s", (input, slot) => {
  expect(actorHueSlot(input)).toBe(slot);
});
it("excludes olive from the human hash slots", () => { expect(ACTOR_HUES).toEqual(["rust", "amber", "teal", "blue", "indigo", "plum", "rose"]); });
