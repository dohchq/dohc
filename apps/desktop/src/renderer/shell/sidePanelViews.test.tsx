// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_SETTINGS } from "../../settings/userSettings";
import { SidebarViewsControl } from "../settings/SidebarViewsControl";
import { ActivityBar } from "../workbench/ActivityBar";
import { VIEW_IDENTITY } from "../workbench/viewIdentity";
import { VIEW_IDS } from "../workbench/workbenchState";
import type { ShellSidePanelProps } from "./ShellSidePanel";
import { SIDE_PANEL_VIEWS } from "./sidePanelViews";

afterEach(cleanup);
const noop = () => {};

describe("the side-panel view registry", () => {
  it("holds one record per view, with Chats beside Files", () => {
    expect(Object.keys(SIDE_PANEL_VIEWS).sort()).toEqual([...VIEW_IDS].sort());
    expect(VIEW_IDS.slice(0, 2)).toEqual(["explorer", "chats"]);
    const labels = VIEW_IDS.map((view) => SIDE_PANEL_VIEWS[view].label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(SIDE_PANEL_VIEWS.chats).toMatchObject({ label: "Chats", customize: "chats" });
    for (const view of VIEW_IDS) {
      expect(typeof SIDE_PANEL_VIEWS[view].render).toBe("function");
      // The rail and Settings read the same label and icon without loading
      // the views.
      expect(SIDE_PANEL_VIEWS[view]).toMatchObject(VIEW_IDENTITY[view]);
    }
  });

  it("names every rail button and every sidebar setting from its record", () => {
    render(<>
      <ActivityBar views={VIEW_IDS} activeView="chats" sidebarVisible hasConflict={false} onSelectView={noop} />
      <SidebarViewsControl sidebar={DEFAULT_SIDEBAR_SETTINGS} onChange={noop} />
    </>);
    const rail = screen.getByTestId("activity-bar");
    for (const view of VIEW_IDS) {
      expect(within(rail).getByRole("button", { name: SIDE_PANEL_VIEWS[view].label }).dataset.testid).toBe(`activity-${view}`);
    }
    expect(within(rail).getByRole("button", { name: "Chats" }).getAttribute("aria-current")).toBe("page");
    const settings = within(screen.getByTestId("sidebar-views")).getAllByTestId("sidebar-view");
    expect(settings.map((row) => row.dataset.view)).toEqual([...VIEW_IDS]);
    expect(settings[1]!.textContent).toContain("Chats");
  });
});

it("routes panel graph failures and retry to the shell notice hook", () => {
  const reportShellError = vi.fn();
  const element = SIDE_PANEL_VIEWS.graph.render({ workspaceId: "ws", reportShellError } as unknown as ShellSidePanelProps) as React.ReactElement<{children: React.ReactElement<{onError: typeof reportShellError}>}>;
  const retry = vi.fn(), error = new Error("offline");
  element.props.children.props.onError("dohc could not load the graph.", error, retry);
  expect(reportShellError).toHaveBeenCalledWith("dohc could not load the graph.", error, retry);
});
