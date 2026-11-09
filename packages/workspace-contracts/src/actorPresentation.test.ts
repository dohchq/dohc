import { expect, it } from "vitest";
import { ACTOR_HUES, actorHueSlot, escapeHiddenText, isConnectedAgentId, shownAgentName } from "./actorPresentation";
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
it("counts an agent as connected only when no run names it", () => {
  for (const agentId of [undefined, "", "dohc-mcp"]) expect(isConnectedAgentId(agentId)).toBe(true);
  for (const agentId of ["claude", "default"]) expect(isConnectedAgentId(agentId)).toBe(false);
});
it("writes each character that can hide or reorder text in JSON as its escape", () => {
  const value = { agentName: "\u202Eavon\u200B\u3164\u{E0001}\u0085", path: "notes.md" };
  const json = JSON.stringify(value, null, 2);
  const shown = escapeHiddenText(json);
  expect(shown).toBe(json.replace(value.agentName, "\\u202eavon\\u200b\\u3164\\udb40\\udc01\\u0085"));
  expect(JSON.parse(shown)).toEqual(value);
  expect(escapeHiddenText(JSON.stringify({ name: "Café 2" }, null, 2))).toBe(JSON.stringify({ name: "Café 2" }, null, 2));
});
