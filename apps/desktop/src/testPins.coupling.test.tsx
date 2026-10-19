// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Titlebar } from "./renderer/Titlebar";
import { ActivityBar } from "./renderer/workbench/ActivityBar";
import { AboutRail } from "./renderer/workbench/AboutRail";
import { SidePanel } from "./renderer/workbench/SidePanel";
import { EditorTabs } from "./renderer/workbench/EditorTabs";
import { VIEW_IDS } from "./renderer/workbench/workbenchState";
import { desktopPins, activityPin, editorTabTestId } from "./testPins";

// Changing the reader's pin must reach the producer without another selector edit.
vi.mock("./testPins", async (importOriginal) => {
  const pins = await importOriginal<typeof import("./testPins")>();
  return {
    ...pins,
    desktopPins: Object.fromEntries(Object.entries(pins.desktopPins).map(([key, value]) => [key, "reader-" + value])),
    activityPin: (view: string) => "reader-activity-" + view,
    editorTabTestId: (path: string) => "reader-" + pins.editorTabTestId(path),
  };
});

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
const noop = () => {};

function renderFrame() {
  render(<>
    <Titlebar aboutSidebar={{ visible: true, onToggle: noop }} />
    <ActivityBar views={VIEW_IDS} activeView="explorer" sidebarVisible hasConflict={false} onSelectView={noop} onOpenSettings={noop} />
    <AboutRail width={320} onWidthChange={noop}>About</AboutRail>
    <SidePanel title="Explorer" width={320} onWidthChange={noop}>Files</SidePanel>
  </>);
}

it.each(["titlebar", "titlebarAboutSidebar", "activityBar", "aboutRail", "sidePanel"] as const)(
  "couples the %s literal to its producer", (key) => {
    renderFrame();
    expect(screen.getByTestId(desktopPins[key])).toBeTruthy();
  },
);
it.each([...VIEW_IDS, "sharing", "settings"])(
  "couples activity %s to its producer", (view) => {
    renderFrame();
    expect(screen.getByTestId(activityPin(view))).toBeTruthy();
  },
);
it.each(["fixture/旅.md", "tab://chats/channel/team%2Fone", "tab://data-collection/data%2Fdataset.json/12345678-1234-4123-8123-123456789abc"])(
  "couples editor tab %s to its producer", (path) => {
    render(<EditorTabs groupId="left" groupNumber={1} tabs={[{ path }]} activeTab={path}
      activeTabDirty={false} recoveryPaths={new Set<string>()}
      onActivate={noop} onClose={noop} onContextMenu={noop} onMove={noop}
      onMoveToGroup={noop} onCreateGroupRight={noop} />);
    expect(screen.getByTestId(editorTabTestId(path))).toBeTruthy();
  },
);
