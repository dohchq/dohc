// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";
import { appViewId, VIEW_IDS } from "./workbenchState";

afterEach(cleanup);

describe("ActivityBar views", () => {
  it("offers each view as a rail item that selects it and marks it current", () => {
    const onSelectView = vi.fn();
    render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="history"
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );

    const history = screen.getByRole("button", { name: "History" });
    expect(history.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Explorer" }));
    expect(onSelectView).toHaveBeenCalledWith("explorer");
  });
});

describe("ActivityBar optional utility actions", () => {
  it("renders Cloud and Settings as inert icons when the host omits actions", () => {
    render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(screen.getByTestId("activity-cloud").tagName).toBe("SPAN");
    expect(screen.getByTestId("activity-settings").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Sync and sharing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("keeps the desktop Cloud and Settings actions clickable when supplied", () => {
    const onOpenCloud = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
        onOpenCloud={onOpenCloud}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync and sharing" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenCloud).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("ActivityBar order and pinned apps", () => {
  it("shows only the views it is given, in their order", () => {
    render(
      <ActivityBar
        views={["sites", "explorer"]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );
    const rail = screen.getByTestId("activity-bar");
    expect(
      [...rail.querySelectorAll("[data-testid^='activity-']")]
        .map((button) => button.getAttribute("data-testid"))
        .filter((id) => id !== "activity-bar" && id !== "activity-cloud" && id !== "activity-settings"),
    ).toEqual(["activity-sites", "activity-explorer"]);
    expect(screen.queryByTestId("activity-search")).toBeNull();
  });

  it("opens a pinned app as its own view and offers its menu", () => {
    const onSelectView = vi.fn();
    const onPinnedAppMenu = vi.fn();
    render(
      <ActivityBar
        views={VIEW_IDS}
        pinnedApps={[{ root: "apps/trip", label: "Trip planner", missing: false }]}
        onPinnedAppMenu={onPinnedAppMenu}
        activeView={appViewId("apps/trip")}
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );
    const pinned = screen.getByRole("button", { name: "Trip planner" });
    expect(pinned.getAttribute("title")).toBe("Trip planner");
    // Its initial tells it apart from other pinned apps.
    expect(pinned.textContent).toBe("T");
    expect(pinned.getAttribute("aria-current")).toBe("page");
    fireEvent.click(pinned);
    expect(onSelectView).toHaveBeenCalledWith(appViewId("apps/trip"));
    fireEvent.contextMenu(pinned);
    expect(onPinnedAppMenu).toHaveBeenCalledWith("apps/trip");
  });
});
