import { afterEach, expect, it } from "vitest";
import { identityHues, palette } from "../tokens";
import { ownPresentation, neutralPresentation, presentationColor, presentationClasses, relayPresentation } from "./actorPresentation";
import { setChosenColors } from "./chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
afterEach(() => setChosenColors(DEFAULT_USER_SETTINGS.appearance));
it("maps frozen relay slots and neutral, own and chosen hues in both themes", () => {
  const hues = ["rust", "amber", "teal", "blue", "indigo", "plum", "rose"] as const;
  for (const theme of ["light", "dark"] as const) {
    hues.forEach((hue, slot) => expect(presentationColor(relayPresentation(slot), "human", theme).stroke).toBe(identityHues[theme][hue]));
    expect(presentationColor(relayPresentation(999), "human", theme).stroke).toBe(palette[theme].muted);
    expect(presentationColor(neutralPresentation, "agent", theme).stroke).toBe(palette[theme].agent);
  }
  setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "blue", yourAgentColor: "olive" });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-blue");
  expect(presentationClasses(ownPresentation, "agent")).toContain("text-hue-olive");
  expect(presentationColor(relayPresentation(0)).stroke).toBe(identityHues.light.rust);
});
