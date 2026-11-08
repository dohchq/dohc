import { afterEach, expect, it, vi } from "vitest";
import { identityHues, palette } from "../tokens";
import { ownPresentation, neutralPresentation, presentationColor, presentationClasses, relayPresentation, setOwnPresentation, ownAgentPresentation, bindOwnPresentation, bindAgentColorUpdates, clearAgentColorOverrides, subscribePresentation, goneAgentPresentation, agentTextClass, canChooseAgentColor } from "./actorPresentation";
import { setChosenColors } from "./chosenColors";
import { settingsWithAgent } from "../../testing/agentSettings";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
afterEach(() => { clearAgentColorOverrides(); setChosenColors(DEFAULT_USER_SETTINGS); setOwnPresentation(undefined); });
it("maps frozen relay slots and neutral, own and chosen hues in both themes", () => {
  const hues = ["rust", "amber", "teal", "blue", "indigo", "plum", "rose"] as const;
  for (const theme of ["light", "dark"] as const) {
    hues.forEach((hue, slot) => expect(presentationColor(relayPresentation(slot), "human", theme).stroke).toBe(identityHues[theme][hue]));
    expect(presentationColor(relayPresentation(999), "human", theme).stroke).toBe(palette[theme].muted);
    expect(presentationColor(neutralPresentation, "agent", theme).stroke).toBe(palette[theme].agent);
  }
  setChosenColors({ ...settingsWithAgent({ hue: "rose" }), appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "blue" } });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-blue");
  expect(presentationClasses(ownPresentation, "agent")).toContain("text-hue-rose");
  expect(presentationColor(relayPresentation(0)).stroke).toBe(identityHues.light.rust);
});

it("marks an agent no longer in Settings in subtle ink, never the default olive", () => {
  expect(presentationClasses(goneAgentPresentation, "agent")).toBe("border-subtle bg-panel text-subtle");
  expect(agentTextClass(goneAgentPresentation)).toBe("text-subtle");
  expect(presentationClasses(neutralPresentation, "agent")).toContain("text-agent");
  expect(canChooseAgentColor(goneAgentPresentation)).toBe(false);
});

it("applies the main own hue and keeps chosen human and agent colours overriding it", () => {
  setOwnPresentation({ group: "own", hue: "rose", self: true });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-rose");
  expect(presentationClasses(ownAgentPresentation, "agent")).toContain("text-agent");
  for (const theme of ["light", "dark"] as const) {
    expect(presentationColor(ownPresentation, "human", theme).stroke).toBe(identityHues[theme].rose);
  }
  setChosenColors({ ...settingsWithAgent({ hue: "rose" }), appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "teal" } });
  expect(presentationClasses(ownPresentation)).toContain("text-hue-teal");
  expect(presentationClasses(ownAgentPresentation, "agent")).toContain("text-hue-rose");
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


it("repaints from a scoped event without a bridge read and keeps overrides until close", () => {
  let changed: Parameters<import("../../ipc/bridgeContract").DohcDesktopBridge["onAgentColorChanged"]>[0] = () => undefined;
  const stopEvent = vi.fn();
  let workspace = "w";
  const stop = bindAgentColorUpdates({ onAgentColorChanged: listener => { changed = listener; return stopEvent; } }, () => workspace);
  const repaint = vi.fn();
  const unsubscribe = subscribePresentation(repaint);
  const token = { group: "agent", hue: "rose", self: true } as const;
  setChosenColors(settingsWithAgent({ hue: "teal" }));
  expect(presentationClasses(token, "agent")).toContain("text-hue-rose");
  repaint.mockClear();
  changed({ workspaceId: "other", group: "agent", hue: "blue" });
  expect(repaint).not.toHaveBeenCalled();
  changed({ workspaceId: "w", group: "agent", hue: "blue" });
  expect(repaint).toHaveBeenCalledOnce();
  expect(presentationClasses(token, "agent")).toContain("text-hue-blue");
  // A late chat read still holds the old token. The event wins.
  expect(presentationClasses({ ...token }, "agent")).toContain("text-hue-blue");
  changed({ workspaceId: "w", group: "agent", hue: null });
  expect(presentationClasses(token, "agent")).toContain("text-hue-teal");
  expect(presentationClasses({ ...token, self: false }, "agent")).toContain("text-agent");
  setChosenColors(DEFAULT_USER_SETTINGS);
  expect(presentationClasses(token, "agent")).toContain("text-agent");
  workspace = "next";
  changed({ workspaceId: "w", group: "agent", hue: "blue" });
  expect(presentationClasses(token, "agent")).toContain("text-agent");
  stop();
  expect(stopEvent).toHaveBeenCalledOnce();
  expect(presentationClasses(token, "agent")).toContain("text-hue-rose");
  unsubscribe();
});


it("keeps the new workspace's event when the previous workspace's passive cleanup runs", () => {
  let workspaceId = "before";
  let changed: Parameters<import("../../ipc/bridgeContract").DohcDesktopBridge["onAgentColorChanged"]>[0] = () => undefined;
  const stop = bindAgentColorUpdates({ onAgentColorChanged: listener => { changed = listener; return () => undefined; } }, () => workspaceId);
  changed({ workspaceId: "before", group: "old-agent", hue: "rose" });
  workspaceId = "after";
  changed({ workspaceId: "after", group: "new-agent", hue: "blue" });
  clearAgentColorOverrides("before");
  expect(presentationClasses({ group: "new-agent", hue: null, self: false }, "agent")).toContain("text-hue-blue");
  expect(presentationClasses({ group: "old-agent", hue: null, self: false }, "agent")).toContain("text-agent");
  stop();
});
