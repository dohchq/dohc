import { describe, expect, it } from "vitest";
import { DEFAULT_USER_SETTINGS, MAX_PINNED_APPS } from "../../settings/userSettings";
import { pinnedAppLabel, pinnedAppsFor, withAppPinned } from "./pinnedApps";
import {
  appViewId,
  clearUnpinnedAppView,
  defaultWorkbenchState,
  parseAppViewId,
  parseUiState,
  serializeUiState,
  setView,
  sidebarViews,
} from "./workbenchState";

describe("sidebar views", () => {
  it("shows dohc's views in the person's order, then the rest, without the hidden ones", () => {
    expect(sidebarViews({ order: ["sites", "search"], hidden: ["graph", "plugins"] }))
      .toEqual(["sites", "search", "explorer", "history"]);
    expect(sidebarViews({ order: [], hidden: [] }))
      .toEqual(["explorer", "search", "graph", "sites", "history", "plugins"]);
  });
});

describe("pinned apps", () => {
  it("pins and unpins per workspace, and drops a workspace with no pins", () => {
    const pinned = withAppPinned(DEFAULT_USER_SETTINGS, "ws-a", "apps/trip", true);
    expect(pinnedAppsFor(pinned, "ws-a")).toEqual(["apps/trip"]);
    expect(pinnedAppsFor(pinned, "ws-b")).toEqual([]);
    expect(withAppPinned(pinned, "ws-a", "apps/trip", true)).toEqual(pinned);

    const two = withAppPinned(withAppPinned(pinned, "ws-a", "budget", true), "ws-b", "report", true);
    expect(two.sidebar.pinnedApps).toEqual({ "ws-a": ["apps/trip", "budget"], "ws-b": ["report"] });
    expect(withAppPinned(two, "ws-b", "report", false).sidebar.pinnedApps)
      .toEqual({ "ws-a": ["apps/trip", "budget"] });
  });

  it("refuses a pin past the limit with the way out", () => {
    let settings = DEFAULT_USER_SETTINGS;
    for (let index = 0; index < MAX_PINNED_APPS; index += 1) {
      settings = withAppPinned(settings, "ws-a", `app-${index}`, true);
    }
    expect(() => withAppPinned(settings, "ws-a", "one-more", true)).toThrow(
      `The sidebar holds ${MAX_PINNED_APPS} pinned apps. Unpin one first.`,
    );
  });

  it("names a pinned app by its folder", () => {
    expect(pinnedAppLabel("apps/trip")).toBe("trip");
    expect(pinnedAppLabel("report")).toBe("report");
  });

  it("selects a pinned app as a view that survives a restart and leaves once unpinned", () => {
    const viewId = appViewId("apps/trip planner");
    expect(parseAppViewId(viewId)).toBe("apps/trip planner");
    expect(parseAppViewId("app-view:")).toBeNull();
    expect(parseAppViewId("app-view:%E0%A4%A")).toBeNull();

    const state = setView(defaultWorkbenchState(), viewId);
    expect(parseUiState(serializeUiState(state)).activeView).toBe(viewId);
    expect(clearUnpinnedAppView(state, ["apps/trip planner"])).toBe(state);
    expect(clearUnpinnedAppView(state, []).activeView).toBe(defaultWorkbenchState().activeView);
  });
});
