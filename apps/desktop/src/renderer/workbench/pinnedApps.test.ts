// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { pinnedAppInitial, usePinnedApps } from "./pinnedApps";
import {
  appViewId,
  defaultWorkbenchState,
  keepActiveViewShown,
  parseAppViewId,
  parseUiState,
  serializeUiState,
  setView,
  sidebarViews,
} from "./workbenchState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sidebar views", () => {
  it("shows dohc's views in the person's order, then the rest, without the hidden ones", () => {
    expect(sidebarViews({ order: ["sites", "search"], hidden: ["graph", "plugins"] }))
      .toEqual(["sites", "search", "explorer", "history"]);
    expect(sidebarViews({ order: [], hidden: [] }))
      .toEqual(["explorer", "search", "graph", "sites", "history", "plugins"]);
  });

  it("moves the selection to the first shown view when its view is hidden or its app unpinned", () => {
    const onSearch = setView(defaultWorkbenchState(), "search");
    expect(keepActiveViewShown(onSearch, ["sites", "explorer"], [])).toMatchObject({
      activeView: "sites",
      sidebarVisible: true,
    });
    expect(keepActiveViewShown(onSearch, ["search"], [])).toBe(onSearch);

    const onApp = setView(defaultWorkbenchState(), appViewId("apps/trip"));
    expect(keepActiveViewShown(onApp, ["history"], ["apps/trip"])).toBe(onApp);
    // Explorer is hidden too, so the first shown view takes over.
    expect(keepActiveViewShown(onApp, ["history"], []).activeView).toBe("history");
    // With no view of dohc's shown, a pinned app takes over, and with nothing
    // at all the side panel closes.
    expect(keepActiveViewShown(onSearch, [], ["report"]).activeView).toBe(appViewId("report"));
    expect(keepActiveViewShown(onSearch, [], [])).toMatchObject({
      activeView: "search",
      sidebarVisible: false,
    });
  });

  it("keeps a pinned app selected across a restart", () => {
    const viewId = appViewId("apps/trip planner");
    expect(parseAppViewId(viewId)).toBe("apps/trip planner");
    expect(parseAppViewId("app-view:")).toBeNull();
    expect(parseAppViewId("app-view:%E0%A4%A")).toBeNull();
    const state = setView(defaultWorkbenchState(), viewId);
    expect(parseUiState(serializeUiState(state)).activeView).toBe(viewId);
  });
});

describe("pinned apps", () => {
  const site = (root: string, title: string) => ({ root, title }) as SitePackageInfo;

  it("names each pin by its app's title, and marks a folder that holds no app", async () => {
    const getSitePackage = vi.fn(async ({ path }: { path: string }) =>
      path === "apps/trip" ? site("apps/trip", "Trip planner")
        : path === "apps/nested/inner" ? site("apps", "Outer")
        : null);
    vi.stubGlobal("dohcDesktop", { getSitePackage });
    const roots = ["apps/trip", "apps/nested/inner", "gone"];
    const { result } = renderHook(() => usePinnedApps("ws-a", roots));
    // The folder stands in until the app is read.
    expect(result.current.map((app) => app.label)).toEqual(["trip", "inner", "gone"]);
    await waitFor(() => expect(result.current[0]!.label).toBe("Trip planner"));
    expect(result.current).toEqual([
      { root: "apps/trip", label: "Trip planner", missing: false },
      // The deepest app around a folder is not this pin's app.
      { root: "apps/nested/inner", label: "inner", missing: true },
      { root: "gone", label: "gone", missing: true },
    ]);
    expect(getSitePackage).toHaveBeenCalledTimes(3);
  });

  it("never names an app at the workspace root by a dot", () => {
    vi.stubGlobal("dohcDesktop", { getSitePackage: vi.fn(() => new Promise(() => undefined)) });
    const { result } = renderHook(() => usePinnedApps("ws-a", ["."]));
    expect(result.current[0]!.label).toBe("App");
  });

  it("marks each app with the first letter of its name", () => {
    expect(pinnedAppInitial("trip planner")).toBe("T");
    expect(pinnedAppInitial("  élan")).toBe("É");
    expect(pinnedAppInitial("")).toBe("A");
  });
});
