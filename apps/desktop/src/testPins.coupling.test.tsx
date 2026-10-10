// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Titlebar } from "./renderer/Titlebar";
import { ActivityBar } from "./renderer/workbench/ActivityBar";
import { ChatsPanel } from "./renderer/workbench/ChatsPanel";
import { SidePanel } from "./renderer/workbench/SidePanel";
import { EditorTabs } from "./renderer/workbench/EditorTabs";
import { desktopPins, activityPin, chatsPanelTabPin, editorTabTestId } from "./testPins";

// Changing the reader's pin must reach the producer without another selector edit.
vi.mock("./testPins", async (importOriginal) => {
  const pins = await importOriginal<typeof import("./testPins")>();
  return {
    ...pins,
    desktopPins: Object.fromEntries(Object.entries(pins.desktopPins).map(([key, value]) => [key, "reader-" + value])),
    activityPin: (view: string) => "reader-activity-" + view,
    chatsPanelTabPin: (tab: string) => "reader-chats-tab-" + tab,
    editorTabTestId: (path: string) => "reader-" + pins.editorTabTestId(path),
  };
});

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
const noop = () => {};

function renderFrame() {
  render(<>
    <Titlebar chatsSidebar={{ visible: true, onToggle: noop }} />
    <ActivityBar views={["explorer", "search", "graph", "sites", "history"]} activeView="explorer" sidebarVisible hasConflict={false} onSelectView={noop} onOpenSettings={noop} onOpenCloud={noop} />
    <ChatsPanel width={320} onWidthChange={noop} onCollapse={noop} tabs={["all", "about"]} tab="all" onTabChange={noop}>Chats</ChatsPanel>
    <SidePanel title="Explorer" width={320} onWidthChange={noop}>Files</SidePanel>
  </>);
}

it.each(["titlebar", "titlebarChatsSidebar", "activityBar", "chatsPanel", "chatsPanelCollapse", "sidePanel"] as const)(
  "couples the %s literal to its producer", (key) => {
    renderFrame();
    expect(screen.getByTestId(desktopPins[key])).toBeTruthy();
  },
);
it.each(["explorer", "search", "graph", "sites", "history", "cloud", "settings"])(
  "couples activity %s to its producer", (view) => {
    renderFrame();
    expect(screen.getByTestId(activityPin(view))).toBeTruthy();
  },
);
it.each(["all", "about"])("couples Chats tab %s to its producer", (tab) => {
  renderFrame();
  expect(screen.getByTestId(chatsPanelTabPin(tab))).toBeTruthy();
});
it.each(["fixture/旅.md", "tab://chats/channel/team%2Fone", "tab://data-collection/data%2Fdataset.json/12345678-1234-4123-8123-123456789abc"])(
  "couples editor tab %s to its producer", (path) => {
    render(<EditorTabs groupId="left" groupNumber={1} tabs={[{ path }]} activeTab={path}
      activeTabDirty={false} recoveryPaths={new Set<string>()}
      onActivate={noop} onClose={noop} onContextMenu={noop} onMove={noop}
      onMoveToGroup={noop} onCreateGroupRight={noop} />);
    expect(screen.getByTestId(editorTabTestId(path))).toBeTruthy();
  },
);
