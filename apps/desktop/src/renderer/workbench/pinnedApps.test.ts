// @vitest-environment jsdom
import { cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { pinnedAppInitial, usePinnedApps } from "./pinnedApps";
import {
  appViewId,
  defaultWorkbenchState,
  keepActiveViewAfterRailChange,
  keepActiveViewShown,
  pluginViewId,
  toggleSidebarOnRail,
  parseAppViewId,
  parseUiState,
  serializeUiState,
  setView,
  sidebarViews,
} from "./workbenchState";

// These wait on async bridge answers and userEvent settles. On a loaded
// machine they can take longer than Testing Library's 1000 ms default, and a
// wait that gives up first fails a test that was about to pass. Every wait
// here runs until the condition holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

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

  it("moves the selection to the first view on the rail when its view is hidden or its app unpinned", () => {
    const onSearch = setView(defaultWorkbenchState(), "search");
    const plugin = pluginViewId("dohc-sites", "sites");
    expect(keepActiveViewShown(onSearch, ["sites", "explorer"])).toMatchObject({
      activeView: "sites",
      sidebarVisible: true,
    });
    expect(keepActiveViewShown(onSearch, ["search"])).toBe(onSearch);

    const onApp = setView(defaultWorkbenchState(), appViewId("apps/trip"));
    expect(keepActiveViewShown(onApp, ["history", appViewId("apps/trip")])).toBe(onApp);
    // Explorer is hidden too, so the first view on the rail takes over.
    expect(keepActiveViewShown(onApp, ["history"]).activeView).toBe("history");
    // With every view of dohc's hidden, a plugin's view comes first, then a
    // pinned app.
    expect(keepActiveViewShown(onSearch, [plugin, appViewId("report")]).activeView).toBe(plugin);
    expect(keepActiveViewShown(onSearch, [appViewId("report")]).activeView).toBe(appViewId("report"));
    // A plugin's view is its plugin list's to judge, even before that loads.
    const onPlugin = setView(defaultWorkbenchState(), plugin);
    expect(keepActiveViewShown(onPlugin, [])).toBe(onPlugin);
  });

  it("moves the selection only when the rail change removed the selected entry", () => {
    const rail = ["explorer", "search", appViewId("apps/trip")] as const;
    const onSearch = setView(defaultWorkbenchState(), "search");
    // Hiding the selected view moves it.
    expect(keepActiveViewAfterRailChange(onSearch, rail, ["explorer", appViewId("apps/trip")]).activeView)
      .toBe("explorer");
    // Hiding another view, reordering, or pinning does not.
    expect(keepActiveViewAfterRailChange(onSearch, rail, ["search", appViewId("apps/trip")])).toBe(onSearch);
    expect(keepActiveViewAfterRailChange(onSearch, rail, [appViewId("apps/trip"), "search", "explorer"]))
      .toBe(onSearch);
    expect(keepActiveViewAfterRailChange(onSearch, rail, [...rail, appViewId("report")])).toBe(onSearch);
    // A view the rail never showed, opened by a link, stays open through any
    // rail change.
    const onHistory = setView(defaultWorkbenchState(), "history");
    expect(keepActiveViewAfterRailChange(onHistory, rail, ["search"])).toBe(onHistory);
    // Unpinning the selected app moves it.
    const onApp = setView(defaultWorkbenchState(), appViewId("apps/trip"));
    expect(keepActiveViewAfterRailChange(onApp, rail, ["explorer", "search"]).activeView).toBe("explorer");
  });

  it("opens the side panel on a view the rail shows, and nothing when the rail is empty", () => {
    const onSearch = setView(defaultWorkbenchState(), "search");
    const closed = keepActiveViewShown(onSearch, []);
    expect(closed).toMatchObject({ activeView: "search", sidebarVisible: false });
    expect(keepActiveViewShown(closed, [])).toBe(closed);
    expect(toggleSidebarOnRail(closed, [])).toBe(closed);
    // A hidden view the person opened earlier does not come back with the
    // toggle; the first view on the rail does.
    expect(toggleSidebarOnRail(closed, ["sites", "explorer"])).toMatchObject({
      activeView: "sites",
      sidebarVisible: true,
    });
    expect(toggleSidebarOnRail({ ...closed, activeView: "explorer" }, ["sites", "explorer"]))
      .toMatchObject({ activeView: "explorer", sidebarVisible: true });
    expect(toggleSidebarOnRail(onSearch, ["sites"]).sidebarVisible).toBe(false);
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

  it("answers the same list while the pins and titles stay the same", async () => {
    vi.stubGlobal("dohcDesktop", { getSitePackage: vi.fn(async () => site("apps/trip", "Trip planner")) });
    const { result, rerender } = renderHook(({ roots }) => usePinnedApps("ws-a", roots), {
      initialProps: { roots: ["apps/trip"] },
    });
    await waitFor(() => expect(result.current[0]!.label).toBe("Trip planner"));
    const first = result.current;
    // A new array with the same pins, as every settings change hands over.
    rerender({ roots: ["apps/trip"] });
    expect(result.current).toBe(first);
    rerender({ roots: ["apps/trip", "report"] });
    expect(result.current).not.toBe(first);
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
