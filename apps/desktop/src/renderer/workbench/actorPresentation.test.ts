import { afterEach, expect, it, vi } from "vitest";
import { identityHues, palette } from "../tokens";
import { ownPresentation, neutralPresentation, presentationColor, presentationClasses, relayPresentation, setOwnPresentation, ownAgentPresentation, bindOwnPresentation } from "./actorPresentation";
import { setChosenColors } from "./chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
afterEach(() => { setChosenColors(DEFAULT_USER_SETTINGS.appearance); setOwnPresentation(undefined); });
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

it("applies the main own hue and keeps chosen human and agent colours overriding it", () => {
  setOwnPresentation({ group: "own", hue: "rose", self: true });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-rose");
  expect(presentationClasses(ownAgentPresentation, "agent")).toContain("text-agent");
  for (const theme of ["light", "dark"] as const) {
    expect(presentationColor(ownPresentation, "human", theme).stroke).toBe(identityHues[theme].rose);
  }
  setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "teal", yourAgentColor: "olive" });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-teal");
  expect(presentationClasses(ownAgentPresentation, "agent")).toContain("text-hue-olive");
});

it("loads the own hue before a workspace opens and retires stale account reads", async () => {
  const { deferred } = await import("../../testing/deferred");
  const stale = deferred<import("../../ipc/bridgeContract").CloudStatusResult>();
  const cloudStatus = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue({
    connected: true, ownPresentation: { group: "own", hue: "rose", self: true },
  });
  let sessionChanged: Parameters<import("../../ipc/bridgeContract").DohcDesktopBridge["onCloudSessionChanged"]>[0];
  const unsubscribe = vi.fn();
  const stop = bindOwnPresentation({ cloudStatus, onCloudSessionChanged: listener => { sessionChanged = listener; return unsubscribe; } });
  sessionChanged!({ sessionKey: null, phase: "changing" });
  expect(ownPresentation.hue).toBeNull();
  expect(cloudStatus).toHaveBeenCalledTimes(1);
  sessionChanged!({ sessionKey: "session", phase: "ready" });
  await vi.waitFor(() => expect(ownPresentation.hue).toBe("rose"));
  stale.resolve({ connected: false, ownPresentation: { group: "own", hue: "teal", self: true } });
  await stale.promise;
  expect(ownPresentation.hue).toBe("rose");
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
