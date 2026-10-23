// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./renderer/settings/SettingsDialog";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./renderer/settings/settingsRegistry";
import { desktopPins, settingsNavPin, settingsSectionPin } from "./testPins";

vi.mock("./testPins", async (importOriginal) => {
  const pins = await importOriginal<typeof import("./testPins")>();
  return {
    ...pins,
    desktopPins: Object.fromEntries(Object.entries(pins.desktopPins).map(([key, value]) => [key, "reader-" + value])),
    settingsNavPin: (section: string) => "reader-settings-nav-" + section,
    settingsSectionPin: (section: string) => "reader-settings-section-" + section,
  };
});
vi.mock("./renderer/bridge", async () => {
  const { DEFAULT_USER_SETTINGS } = await import("./settings/userSettings");
  const { DEFAULT_WORKSPACE_SETTINGS } = await import("./workspaces/workspaceSettings");
  return { bridge: () => ({
    onUserSettingsChanged: () => () => {},
    getUserSettings: async () => ({ settings: DEFAULT_USER_SETTINGS, source: "default", warning: "fixture warning" }),
    readDiagnostics: async () => ({ text: "dohc diagnostics", available: { usage: false, errors: false } }),
    readUsageRecord: async () => ({ status: "readable", enabled: true, file: "/state/dohc-usage.json", since: null, incompleteDays: 0, rows: [] }),
    getWorkspaceSettings: async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" }),
    getUserSettingsFilePath: async () => "/fixture/settings.json",
    readWorkspaceTrust: async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: false }),
    onWorkspaceTrustChanged: () => () => {},
    onUpdateState: () => () => {},
    getUpdateState: async () => ({ status: "idle", message: "fixture", currentVersion: "1.2.3", channel: "latest", canCheck: false, canInstall: false }),
  }) };
});
vi.mock("./renderer/settings/AgentsMcpSettings", () => ({ AgentsMcpSettings: () => null }));
vi.mock("./renderer/settings/ScheduleHostRow", () => ({ ScheduleHostRow: () => null }));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
function renderSettings(initialSection?: SettingsSectionId) {
  render(<SettingsDialog workspaceIsReady workspaceId="fixture" workspacePath="/fixture" onClose={() => {}} initialSection={initialSection} />);
}
it.each(["settingsDialog", "settingsSearch", "settingsWarning", "settingsEmptySearch"] as const)(
  "couples the %s literal to its producer", async (key) => {
    renderSettings();
    if (key === "settingsEmptySearch") {
      fireEvent.change(screen.getByTestId(desktopPins.settingsSearch), { target: { value: "unmatched-fixture-query" } });
    }
    expect(await screen.findByTestId(desktopPins[key])).toBeTruthy();
  },
);
it.each(SETTINGS_SECTIONS.map(section => section.id))("couples Settings nav %s to its producer", async (section) => {
  renderSettings();
  expect(await screen.findByTestId(settingsNavPin(section))).toBeTruthy();
});
it.each(SETTINGS_SECTIONS.map(section => section.id))("couples Settings section %s to its producer", async (section) => {
  renderSettings(section);
  expect(await screen.findByTestId(settingsSectionPin(section))).toBeTruthy();
});
