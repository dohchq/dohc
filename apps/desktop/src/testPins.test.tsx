// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Titlebar } from "./renderer/Titlebar";
import { ActivityBar } from "./renderer/workbench/ActivityBar";
import { AboutRail } from "./renderer/workbench/AboutRail";
import { SidePanel } from "./renderer/workbench/SidePanel";
import { VIEW_IDS } from "./renderer/workbench/workbenchState";
import { desktopPins, activityPin, settingsNavPin, settingsSectionPin, editorTabTestId, editorTabPrefixPattern } from "./testPins";

afterEach(cleanup);
const noop = () => {};

describe("shared desktop pins", () => {
  it("lets e2e readers find literal and generated frame producers", () => {
    render(<>
      <Titlebar aboutSidebar={{ visible: true, onToggle: noop }} primarySidebar={{ visible: true, onToggle: noop }} onQuickOpen={noop} />
      <ActivityBar views={VIEW_IDS} activeView="search" sidebarVisible hasConflict={false} searchResultCount={3} onSelectView={noop} onOpenSettings={noop} />
      <AboutRail width={320} onWidthChange={noop}>About</AboutRail>
      <SidePanel title="Explorer" width={320} onWidthChange={noop}>Files</SidePanel>
    </>);
    for (const id of [desktopPins.titlebar, desktopPins.titlebarAboutSidebar, desktopPins.activityBar, desktopPins.aboutRail, desktopPins.sidePanel]) {
      expect(screen.getByTestId(id).getAttribute("data-testid")).toBe(id);
    }
    for (const view of ["explorer", "chats", "search", "graph", "history", "sharing", "settings"]) {
      expect(screen.getByTestId(activityPin(view)).getAttribute("data-testid")).toBe("activity-" + view);
    }
  });

  it("preserves selector values for runtime and fixture-only inputs", () => {
    expect(desktopPins.settingsDialog).toBe("settings-dialog");
    expect(desktopPins.aboutRail).toBe("about-rail");
    expect(desktopPins.titlebarAboutSidebar).toBe("titlebar-about-sidebar");
    expect(activityPin("chats")).toBe("activity-chats");
    expect(settingsNavPin("appearance")).toBe("settings-nav-appearance");
    expect(settingsSectionPin("agents")).toBe("settings-section-agents");
    expect(editorTabTestId("fixture/旅 [one].md")).toBe("tab-fixture/旅 [one].md");
    expect(editorTabTestId("tab://chats/channel/team%2Fone")).toBe("tab-dohc://chats/channel/team%2Fone");
    expect(editorTabPrefixPattern("fixture/a+b[1].").test("tab-fixture/a+b[1].md")).toBe(true);
    expect(editorTabPrefixPattern("fixture/a+b[1].").test("tab-fixture/ab1xmd")).toBe(false);
    expect(editorTabPrefixPattern("tab://chats/channel/", true).test("tab-dohc://chats/channel/fixture-id")).toBe(true);
    expect(editorTabPrefixPattern("tab://chats/channel/", true).test("tab-dohc://chats/dm/fixture-id")).toBe(false);
  });
});
