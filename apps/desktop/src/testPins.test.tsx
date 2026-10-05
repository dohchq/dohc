// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Titlebar } from "./renderer/Titlebar";
import { ActivityBar } from "./renderer/workbench/ActivityBar";
import { ChatsPanel } from "./renderer/workbench/ChatsPanel";
import { desktopPins, activityPin, chatsPanelTabPin, settingsNavPin, settingsSectionPin, editorTabTestId, editorTabPrefixPattern } from "./testPins";

afterEach(cleanup);
const noop = () => {};

describe("shared desktop pins", () => {
  it("lets e2e readers find literal and generated frame producers", () => {
    render(<>
      <Titlebar chatsSidebar={{ visible: true, onToggle: noop }} primarySidebar={{ visible: true, onToggle: noop }} onQuickOpen={noop} />
      <ActivityBar views={["explorer", "search", "graph", "sites", "history"]} activeView="search" sidebarVisible hasConflict={false} searchResultCount={3} onSelectView={noop} onOpenSettings={noop} onOpenCloud={noop} />
      <ChatsPanel width={320} onWidthChange={noop} onCollapse={noop} tabs={["all", "file"]} tab="all" onTabChange={noop}>Chats</ChatsPanel>
    </>);
    for (const id of [desktopPins.titlebar, desktopPins.titlebarChatsSidebar, desktopPins.activityBar, desktopPins.chatsPanel, desktopPins.chatsPanelCollapse]) {
      expect(screen.getByTestId(id).getAttribute("data-testid")).toBe(id);
    }
    for (const view of ["explorer", "search", "graph", "sites", "history", "cloud", "settings"]) {
      expect(screen.getByTestId(activityPin(view)).getAttribute("data-testid")).toBe("activity-" + view);
    }
    for (const tab of ["all", "file"]) {
      expect(screen.getByTestId(chatsPanelTabPin(tab)).getAttribute("data-testid")).toBe("chats-panel-tab-" + tab);
    }
  });

  it("preserves selector values for runtime and fixture-only inputs", () => {
    expect(desktopPins.settingsDialog).toBe("settings-dialog");
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
