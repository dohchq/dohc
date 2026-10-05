// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Titlebar } from "./renderer/Titlebar";
import { ActivityBar } from "./renderer/workbench/ActivityBar";
import { ChatsPanel } from "./renderer/workbench/ChatsPanel";
import { EditorTabs } from "./renderer/workbench/EditorTabs";
import { desktopPins, activityPin, chatsPanelTabPin, editorTabTestId } from "./testPins";

// A reader-side change must reach each producer without a second selector edit.
vi.mock("./testPins", async (importOriginal) => {
  const pins = await importOriginal<typeof import("./testPins")>();
  return {
    ...pins,
    desktopPins: { ...pins.desktopPins, titlebarChatsSidebar: "reader-chats-toggle" },
    activityPin: (view: string) => "reader-activity-" + view,
    chatsPanelTabPin: (tab: string) => "reader-chats-tab-" + tab,
    editorTabTestId: (path: string) => "reader-" + pins.editorTabTestId(path),
  };
});

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
const noop = () => {};

it("connects frame producers to the same pins imported by e2e", () => {
  render(<>
    <Titlebar chatsSidebar={{ visible: true, onToggle: noop }} />
    <ActivityBar
      views={["explorer"]} activeView="explorer" sidebarVisible
      hasConflict={false} onSelectView={noop}
    />
    <ChatsPanel
      width={320} onWidthChange={noop} onCollapse={noop}
      tabs={["all", "file"]} tab="all" onTabChange={noop}
    >Chats</ChatsPanel>
  </>);
  expect(screen.getByTestId(desktopPins.titlebarChatsSidebar)).toBeTruthy();
  expect(screen.getByTestId(activityPin("explorer"))).toBeTruthy();
  expect(screen.getByTestId(chatsPanelTabPin("file"))).toBeTruthy();
});

it.each(["fixture/旅.md", "tab://chats/channel/team%2Fone"])(
  "connects editor tab producer and e2e reader for %s", (path) => {
    render(<EditorTabs
      groupId="left" groupNumber={1} tabs={[{ path }]} activeTab={path}
      activeTabDirty={false} recoveryPaths={new Set<string>()}
      onActivate={noop} onClose={noop} onContextMenu={noop} onMove={noop}
      onMoveToGroup={noop} onCreateGroupRight={noop}
    />);
    expect(screen.getByTestId(editorTabTestId(path))).toBeTruthy();
  },
);
