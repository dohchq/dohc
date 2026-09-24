import { describe, expect, it } from "vitest";
import { pinnedAppsFor, withAppPinned } from "./pinnedApps";
import { DEFAULT_USER_SETTINGS, MAX_PINNED_APPS } from "./userSettings";

const known = ["ws-a", "ws-b"];

describe("pinned apps in the settings file", () => {
  it("pins and unpins per workspace, and drops a workspace with no pins", () => {
    const pinned = withAppPinned(DEFAULT_USER_SETTINGS, { workspaceId: "ws-a", appRoot: "apps/trip", pinned: true }, known);
    expect(pinnedAppsFor(pinned, "ws-a")).toEqual(["apps/trip"]);
    expect(pinnedAppsFor(pinned, "ws-b")).toEqual([]);
    expect(withAppPinned(pinned, { workspaceId: "ws-a", appRoot: "apps/trip", pinned: true }, known)).toEqual(pinned);

    const two = withAppPinned(
      withAppPinned(pinned, { workspaceId: "ws-a", appRoot: "budget", pinned: true }, known),
      { workspaceId: "ws-b", appRoot: "report", pinned: true },
      known,
    );
    expect(two.sidebar.pinnedApps).toEqual({ "ws-a": ["apps/trip", "budget"], "ws-b": ["report"] });
    expect(withAppPinned(two, { workspaceId: "ws-b", appRoot: "report", pinned: false }, known).sidebar.pinnedApps)
      .toEqual({ "ws-a": ["apps/trip", "budget"] });
  });

  it("drops pins for workspaces dohc no longer knows", () => {
    const stale = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, pinnedApps: { "ws-gone": ["old"], "ws-a": ["apps/trip"] } },
    };
    expect(withAppPinned(stale, { workspaceId: "ws-b", appRoot: "report", pinned: true }, known).sidebar.pinnedApps)
      .toEqual({ "ws-a": ["apps/trip"], "ws-b": ["report"] });
  });

  it("refuses a pin past the limit with the way out", () => {
    let settings = DEFAULT_USER_SETTINGS;
    for (let index = 0; index < MAX_PINNED_APPS; index += 1) {
      settings = withAppPinned(settings, { workspaceId: "ws-a", appRoot: `app-${index}`, pinned: true }, known);
    }
    expect(() => withAppPinned(settings, { workspaceId: "ws-a", appRoot: "one-more", pinned: true }, known)).toThrow(
      `The sidebar holds ${MAX_PINNED_APPS} pinned apps. Unpin one first.`,
    );
  });
});
