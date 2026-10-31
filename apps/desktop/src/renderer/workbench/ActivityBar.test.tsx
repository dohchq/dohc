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

describe("ActivityBar Sharing and Settings", () => {
  it("renders Settings as an inert icon when the host omits its action", () => {
    render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(screen.getByTestId("activity-settings").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("opens Sharing as a view, marks it current, and carries the conflict badge", () => {
    const onSelectView = vi.fn();
    const onOpenSettings = vi.fn();
    const { rerender } = render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="explorer"
        sidebarVisible
        hasConflict
        onSelectView={onSelectView}
        onOpenSettings={onOpenSettings}
      />,
    );

    const sharing = screen.getByRole("button", { name: "Sharing" });
    expect(sharing.getAttribute("data-testid")).toBe("activity-sharing");
    expect(screen.queryByRole("button", { name: "Sync and sharing" })).toBeNull();
    expect(sharing.querySelector(".bg-danger")).not.toBeNull();
    fireEvent.click(sharing);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onSelectView).toHaveBeenCalledWith("sharing");
    expect(onOpenSettings).toHaveBeenCalledOnce();

    rerender(
      <ActivityBar
        views={VIEW_IDS}
        activeView="sharing"
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );
    expect(screen.getByRole("button", { name: "Sharing" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Sharing" }).querySelector(".bg-danger")).toBeNull();
  });

  // Sharing is about people, so it draws people, not the cloud of sync or storage.
  it("draws Sharing as people", () => {
    render(
      <ActivityBar
        views={VIEW_IDS}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    const sharing = screen.getByRole("button", { name: "Sharing" });
    expect(sharing.getAttribute("title")).toBe("Sharing");
    expect(sharing.querySelector("svg.lucide-users")).not.toBeNull();
    expect(sharing.querySelector("svg.lucide-cloud")).toBeNull();
  });
});

describe("ActivityBar order and pinned apps", () => {
  it("shows only the views it is given, in their order", () => {
    render(
      <ActivityBar
        views={["graph", "explorer"]}
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
        .filter((id) => id !== "activity-bar" && id !== "activity-sharing" && id !== "activity-settings"),
    ).toEqual(["activity-graph", "activity-explorer"]);
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
