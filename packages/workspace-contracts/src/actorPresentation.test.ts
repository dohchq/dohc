import { expect, it } from "vitest";
import { ACTOR_HUES, actorHueSlot, shownAgentName } from "./actorPresentation";
it.each([["", 2], ["alice", 6], ["A😀", 4], ["é", 0]] as const)("pins frozen code-point hue slot %s", (input, slot) => {
  expect(actorHueSlot(input)).toBe(slot);
});
it("excludes olive from the human hash slots", () => { expect(ACTOR_HUES).toEqual(["rust", "amber", "teal", "blue", "indigo", "plum", "rose"]); });
it("shows an agent's name only when no character in it can hide or reorder text", () => {
  for (const name of ["Nova", "Café 2", "Agent_1.v-2"]) expect(shownAgentName(name)).toBe(name);
  for (const name of ["‮avon", "No​va", "Nova⁦", "ㅤ", "Nova­", "Nova﻿", "No‍va", "Nova", "No va"]) {
    expect(shownAgentName(name), JSON.stringify(name)).toBeUndefined();
  }
  expect(shownAgentName(undefined)).toBeUndefined();
});
