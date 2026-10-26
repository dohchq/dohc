// @vitest-environment jsdom
import { desktopPins, settingsSectionPin } from "../../testPins";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsResult,
} from "../../workspaces/workspaceSettings";
import { pushOverlay, removeOverlay } from "../overlayStack";
import { Overlay } from "../Overlay";
import type { ScheduleHostResult } from "../../ipc/bridgeContract";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { SettingsDialog } from "./SettingsDialog";
import { applyLookSettings } from "../theme";
import { CUSTOMIZE_TARGETS } from "./customize";
import { settingsWithAgent, testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";

const config = {
  command: "dohc-mcp",
  args: ["--workspace", "/home/sam/dohc/personal", "--home", "/state/home"],
  workspacePath: "/home/sam/dohc/personal",
  home: "/state/home",
};

let runActive = false;
let updateReady = false;
const idleUpdateState = {
  status: "idle" as const,
  message: "Updates have not been checked yet.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: true,
  canInstall: false,
};
const readyUpdateState = {
  status: "ready" as const,
  message: "Update 1.2.4 is ready. Restart dohc to apply it.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
};
type SettingsUpdateState = typeof idleUpdateState | typeof readyUpdateState;
const getDefaultMcpConfig = async (_payload: { workspaceId: string }) => config;

// The fake settings file. main merges each patch onto what is ON DISK, so the
// double keeps that state: merging onto the defaults every time would model
// less than the real save, and a second edit landing on a stale base would
// look correct here.
let workspaceSettingsOnDisk = DEFAULT_WORKSPACE_SETTINGS;

async function readWorkspaceSettings(): Promise<WorkspaceSettingsResult> {
  return {
    settings: workspaceSettingsOnDisk,
    source: workspaceSettingsOnDisk === DEFAULT_WORKSPACE_SETTINGS ? "default" : "stored",
  };
}

async function writeWorkspaceSettings(payload: {
  patch: WorkspaceSettingsPatch;
}): Promise<WorkspaceSettingsResult> {
  workspaceSettingsOnDisk = mergeWorkspaceSettings(workspaceSettingsOnDisk, payload.patch);
  return { settings: workspaceSettingsOnDisk, source: "stored" };
}

async function resetWorkspaceSettings(): Promise<WorkspaceSettingsResult> {
  workspaceSettingsOnDisk = DEFAULT_WORKSPACE_SETTINGS;
  return { settings: workspaceSettingsOnDisk, source: "stored" };
}

// The Sharing view's lists, as Settings search reads them.
function sharingAnswer(lane: "granted" | "received"): AccessAnswer {
  const row: AccessShareRow = lane === "granted"
    ? { kind: "share", shareId: "share-plan", grantId: "grant-1", via: "named", granterUserId: "me", granterEmail: null,
        recipientUserId: "sam", recipientEmail: "sam@example.com", subjectName: null, sharerName: null,
        selector: { paths: ["notes/product-plan.md"], versionId: null }, access: "edit", status: "active", generation: 1 }
    : { kind: "share", shareId: "share-funnel", grantId: "grant-2", via: "received", granterUserId: "sam", granterEmail: "sam@example.com",
        recipientUserId: "me", recipientEmail: null, subjectName: "funnel.csv", sharerName: "Sam",
        selector: { paths: ["data/funnel.csv"], versionId: null }, access: "view", status: "active", generation: 1 };
  return {
    ref: null, rows: [row], visibility: "visible",
    unknownReason: null, coverage: { kind: lane === "granted" ? "granted" : "received-account", complete: true, observation: "interval" },
    checkedAtMs: 1, freshness: "fresh", nextCursor: null,
  };
}

const bridge = {
  onWorkspaceActivity: vi.fn(() => () => {}),
  readDiagnostics: vi.fn(async () => ({ text: "dohc diagnostics", available: { usage: false, errors: false } })),
  readUsageRecord: vi.fn(async () => ({ status: "readable", enabled: true, file: "/state/dohc-usage.json", since: null, incompleteDays: 0, rows: [] })),
  requestAccessRefresh: vi.fn(async () => undefined),
  listSharingAccess: vi.fn(async ({ lane }: { workspaceId: string; lane: "granted" | "received" }) => sharingAnswer(lane)),
  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
  detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
  getMcpConfig: vi.fn(getDefaultMcpConfig),
  getAgentRunStatus: vi.fn(async () => ({
    activeRun: runActive ?{ id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const } : null,
    lastRun: null,
  })),
  startAgentRun: vi.fn(async () => {
    runActive = true;
    return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
  }),
  endAgentRun: vi.fn(async () => {
    runActive = false;
  }),
  runnerSelfTest: vi.fn(async () => ({ ok: true, detail: "self-test ok" })),
  readChatDispatchPaused: vi.fn(async () => ({ paused: false })),
  setChatDispatchPaused: vi.fn(async () => undefined),
  onChatDispatchPaused: vi.fn(() => () => undefined),
  getUpdateState: vi.fn(async () => (updateReady ? readyUpdateState : idleUpdateState)),
  checkForUpdates: vi.fn(async (): Promise<{
    checked: boolean;
    state: SettingsUpdateState;
  }> => {
    updateReady = true;
    return { checked: true, state: readyUpdateState };
  }),
  installUpdate: vi.fn(async (): Promise<{
    accepted: boolean;
    reason?: string;
    state: SettingsUpdateState | (typeof readyUpdateState & { installCommand: string });
  }> => ({
    accepted: updateReady,
    state: updateReady ? readyUpdateState : idleUpdateState,
  })),
  onUpdateState: vi.fn(() => () => {}),
  getUserSettings: vi.fn(async (): Promise<DesktopUserSettingsResult> => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "default",
  })),
  setUserSettings: vi.fn(async (payload: { settings: typeof DEFAULT_USER_SETTINGS }) => ({
    settings: payload.settings,
    source: "stored" as const,
  })),
  resetUserSettings: vi.fn(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "stored" as const,
  })),
  getUserSettingsFilePath: vi.fn(async () => "/state/dohc-settings.json"),
  readScheduleHost: vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "this-computer" })),
  onScheduleHostChanged: vi.fn(() => () => undefined),
  onCloudSessionChanged: vi.fn(() => () => undefined),
  chooseScheduleHost: vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "this-computer" })),
  takeOverScheduleHost: vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "this-computer" })),
  openUserSettingsFile: vi.fn(async () => undefined),
  getWorkspaceSettings: vi.fn(readWorkspaceSettings),
  setWorkspaceSettings: vi.fn(writeWorkspaceSettings),
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: workspaceTrusted })),
  requestWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: workspaceTrusted })),
  restrictWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    workspaceTrusted = false;
    return { workspaceId, trusted: false };
  }),
  onWorkspaceTrustChanged: vi.fn(() => () => undefined),
  resetWorkspaceSettings: vi.fn(resetWorkspaceSettings),
  setTitlebarTheme: vi.fn(async () => undefined),
  onUserSettingsChanged: vi.fn(
    (_listener: (result: DesktopUserSettingsResult) => void) => () => undefined,
  ),
  stepWindowZoom: vi.fn(async (payload: { step: "in" | "out" | "reset" }) => ({
    settings: {
      ...DEFAULT_USER_SETTINGS,
      appearance: {
        ...DEFAULT_USER_SETTINGS.appearance,
        zoomLevel: payload.step === "in" ? 1 : payload.step === "out" ? -1 : 0,
      },
    },
    source: "stored" as const,
  })),
};
const savedSettings = () => bridge.setUserSettings.mock.lastCall?.[0].settings;

const writeText = vi.fn(async (_text: string) => {});

const copyMcpConfig = () => screen.getByRole<HTMLButtonElement>("button", { name: "Copy MCP config" });
// The config has loaded once its copy is on.
const mcpConfigLoaded = () => waitFor(() => expect(copyMcpConfig().disabled).toBe(false));

function stubClipboard() {
  // navigator.clipboard is a getter-only property in jsdom; define it. Call
  // after userEvent.setup() so our spy isn't shadowed by userEvent's own stub.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

let workspaceTrusted = false;

beforeEach(() => {
  workspaceTrusted = false;
  runActive = false;
  updateReady = false;
  // vi.clearAllMocks() clears calls, not implementations: restore the fake
  // file and the default reads so one test cannot leak into the next.
  workspaceSettingsOnDisk = DEFAULT_WORKSPACE_SETTINGS;
  bridge.getWorkspaceSettings.mockImplementation(readWorkspaceSettings);
  bridge.setWorkspaceSettings.mockImplementation(writeWorkspaceSettings);
  bridge.resetWorkspaceSettings.mockImplementation(resetWorkspaceSettings);
  document.documentElement.dataset.theme = "";
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SettingsDialog", () => {
  it("shows this workspace's trust in Privacy, asks main to trust it, and restricts it again", async () => {
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="privacy" onClose={() => {}} />);
    const control = await screen.findByTestId("workspace-trust-control");
    const restricted = within(control).getByRole("radio", { name: "Restricted Mode" });
    await waitFor(() => expect(restricted.getAttribute("aria-checked")).toBe("true"));

    // The person chose Stay in Restricted Mode in main's dialog.
    await userEvent.click(within(control).getByRole("radio", { name: "Trusted" }));
    expect(bridge.requestWorkspaceTrust).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    await waitFor(() => expect(restricted.getAttribute("aria-checked")).toBe("true"));

    // The person chose Trust workspace.
    workspaceTrusted = true;
    await userEvent.click(within(control).getByRole("radio", { name: "Trusted" }));
    await waitFor(() => expect(within(control).getByRole("radio", { name: "Trusted" }).getAttribute("aria-checked")).toBe("true"));

    await userEvent.click(restricted);
    expect(bridge.restrictWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    await waitFor(() => expect(restricted.getAttribute("aria-checked")).toBe("true"));
  });

  it("has no trust row in a shared view", async () => {
    render(<SettingsDialog workspaceIsReady sharedView workspaceId="ws-1" workspacePath="/x" initialSection="privacy" onClose={() => {}} />);
    await screen.findByTestId(settingsSectionPin("privacy"));
    expect(screen.queryByTestId("settings-row-workspace-trust")).toBeNull();
    expect(bridge.readWorkspaceTrust).not.toHaveBeenCalled();
  });

  it("shows a failed-open state instead of loading workspace settings", async () => {
    const props = { workspaceId: "ws-1", workspacePath: "/x", initialSection: "agents" as const,
      workspaceIsReady: false, workspaceOpenFailed: true, onClose: vi.fn() };
    render(<SettingsDialog {...props} />);
    expect(screen.getByText("Couldn’t open this workspace. Close Settings to try again.")).toBeTruthy();
    expect(screen.queryByText("Loading settings...")).toBeNull();
    await waitFor(() => expect(bridge.getUserSettings).toHaveBeenCalled());
    expect(bridge.getWorkspaceSettings).not.toHaveBeenCalled();
    expect(bridge.getMcpConfig).not.toHaveBeenCalled();
    expect(bridge.getAgentRunStatus).not.toHaveBeenCalled();
  });

  it.each(["agents", "files", "workbench", "privacy", "cloud", "advanced"] as const)("holds the %s section and workspace search until admission", async initialSection => {
    const onError = vi.fn();
    const props = { workspaceId: "ws-1", workspacePath: "/x", initialSection, onClose: vi.fn(), onError, onOpenSharing: vi.fn() };
    const view = render(<SettingsDialog {...props} workspaceIsReady={false} />);
    await waitFor(() => expect(bridge.getUserSettings).toHaveBeenCalled());
    expect(bridge.getWorkspaceSettings).not.toHaveBeenCalled();
    expect(bridge.getMcpConfig).not.toHaveBeenCalled();
    expect(bridge.getAgentRunStatus).not.toHaveBeenCalled();
    expect(bridge.readScheduleHost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: initialSection } });
    expect(bridge.requestAccessRefresh).not.toHaveBeenCalled();
    expect(bridge.listSharingAccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByText("Loading settings...")).toBeTruthy();
    view.rerender(<SettingsDialog {...props} workspaceIsReady />);
    await waitFor(() => expect(bridge.getWorkspaceSettings).toHaveBeenCalledOnce());
    if (initialSection === "agents") await waitFor(() => expect(bridge.getMcpConfig).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
  });

  it("renders the settings shell, searches sections, and shows an empty search state", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    expect(screen.getByTestId("settings-section-general")).toBeTruthy();
    await user.type(screen.getByTestId("settings-search"), "theme");
    expect(screen.getByTestId(settingsSectionPin("appearance"))).toBeTruthy();
    await user.clear(screen.getByTestId("settings-search"));
    await user.type(screen.getByTestId("settings-search"), "launch");
    expect(screen.getByTestId("settings-empty-search")).toBeTruthy();
    await user.clear(screen.getByTestId("settings-search"));
    await user.type(screen.getByTestId("settings-search"), "nothing-here");
    expect(screen.getByTestId("settings-empty-search")).toBeTruthy();
  });

  it("groups the nav by where settings apply, under the workspace's folder", async () => {
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath={"C:\\Users\\sam\\dohc\\trip"} onClose={() => {}} />);

    const nav = (await screen.findByTestId("settings-sidebar")).querySelector("nav")!;
    const order = [...nav.children].map((child) =>
      child.getAttribute("data-testid") ?? (child.getAttribute("aria-hidden") ? "hairline" : child.tagName));
    expect(order).toEqual([
      "settings-nav-general",
      "settings-nav-appearance",
      "settings-nav-keyboard",
      "settings-nav-agents",
      "settings-row-current-workspace",
      "settings-nav-files",
      "settings-nav-workbench",
      "settings-nav-privacy",
      "settings-nav-cloud",
      "hairline",
      "settings-nav-advanced",
    ]);
    const folder = screen.getByTestId("settings-row-current-workspace");
    expect(folder.textContent).toBe("trip");
    expect(folder.getAttribute("title")).toBe("C:\\Users\\sam\\dohc\\trip");
    // Position says where a section applies; no item carries a scope tag.
    expect(nav.textContent).not.toMatch(/User|Workspace|Mixed/);
    expect(screen.getByTestId("settings-nav-general").getAttribute("aria-current")).toBe("page");
  });

  it("names the section Agents and still finds it by MCP", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    expect((await screen.findByTestId("settings-nav-agents")).textContent).toBe("Agents");
    await user.type(screen.getByTestId("settings-search"), "MCP");
    expect(screen.getByTestId("settings-nav-agents").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId(settingsSectionPin("agents"))).toBeTruthy();
    expect(screen.queryByTestId("settings-row-current-workspace")).toBeNull();
  });

  it("closes from Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={onClose} />
      </Overlay>,
    );

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves Tab and Escape to a higher overlay", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="higher-overlay-action">
          Go back
        </button>
        <Overlay onClose={onClose}>
          <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={onClose} />
        </Overlay>
      </>,
    );

    await screen.findByTestId(desktopPins.settingsDialog);
    const higherOverlayAction = screen.getByTestId("higher-overlay-action");
    higherOverlayAction.focus();
    const higherOverlay = Symbol("higher-overlay-test");
    pushOverlay(higherOverlay);
    try {
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(higherOverlayAction);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      removeOverlay(higherOverlay);
    }
  });

  it("persists appearance changes and applies them immediately", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(bridge.setUserSettings).toHaveBeenCalledWith({
      base: DEFAULT_USER_SETTINGS,
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: "dark" }),
      }),
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(bridge.setTitlebarTheme).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("saves your colors, the accent, and the editor type", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "default" });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );
    const saved = () => bridge.setUserSettings.mock.lastCall?.[0].settings;

    const yours = await screen.findByTestId("settings-row-your-color");
    await user.click(within(yours).getByRole("radio", { name: "Teal" }));
    expect(saved()?.appearance.yourColor).toBe("teal");
    expect(within(yours).getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe("true");

    // A person's swatches are round with no olive; an agent's are squares, olive first.
    const personHues = within(yours).getAllByRole("radio");
    expect(personHues.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Rust", "Amber", "Teal", "Blue", "Indigo", "Plum", "Rose"]);
    for (const radio of personHues) expect(radio.className).toContain("rounded-full");
    const agent = screen.getByTestId("settings-row-your-agent-color");
    const agentHues = within(agent).getAllByRole("radio");
    expect(agentHues.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Olive", "Rust", "Amber", "Teal", "Blue", "Indigo", "Plum", "Rose"]);
    for (const radio of agentHues) expect(radio.className).toContain("rounded-md");
    expect(within(agent).getByRole("radio", { name: "Olive" }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(agent).getByRole("radio", { name: "Plum" }));
    expect(saved()?.agents.default?.hue).toBe("plum");
    await user.click(within(agent).getByRole("radio", { name: "Olive" }));
    expect(saved()?.agents.default?.hue).toBe("olive");
    // Here the arrows choose as they move.
    await user.keyboard("{ArrowRight}");
    expect(saved()?.agents.default?.hue).toBe("rust");
    expect(document.activeElement).toBe(within(agent).getByRole("radio", { name: "Rust" }));

    // The picker saves once, when it closes, not on each step of a drag.
    const picker = within(screen.getByTestId("settings-row-accent")).getByLabelText("Accent color");
    const calls = bridge.setUserSettings.mock.calls.length;
    fireEvent.input(picker, { target: { value: "#224488" } });
    expect(bridge.setUserSettings.mock.calls.length).toBe(calls);
    fireEvent.change(picker, { target: { value: "#224488" } });
    await waitFor(() => expect(bridge.setUserSettings.mock.calls.length).toBe(calls + 1));
    expect(saved()?.appearance.accentColor).toBe("#224488");
    expect(document.documentElement.style.getPropertyValue("--dohc-accent")).not.toBe("");
    await user.click(within(screen.getByTestId("settings-row-accent")).getByRole("button", { name: "Reset" }));
    expect(saved()?.appearance.accentColor).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--dohc-accent")).toBe("");

    await user.click(within(screen.getByTestId("settings-row-editor-font")).getByRole("radio", { name: "Serif" }));
    expect(saved()?.editor.fontFamily).toBe("serif");
    await user.click(screen.getByRole("button", { name: "Larger editor text" }));
    expect(saved()?.editor.fontSize).toBe(DEFAULT_USER_SETTINGS.editor.fontSize + 1);
    expect(document.documentElement.style.getPropertyValue("--dohc-editor-font-size"))
      .toBe(`${DEFAULT_USER_SETTINGS.editor.fontSize + 1}px`);

    // The settings file opens from Advanced only.
    expect(screen.queryByRole("button", { name: "Open settings file" })).toBeNull();
  });

  it("shows a modified setting as a dot and resets it from an icon", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-theme");
    expect(within(row).queryByTitle("Modified")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Reset" })).toBeNull();

    await user.click(within(row).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(within(row).getByTitle("Modified")).toBeTruthy());
    const reset = within(row).getByRole("button", { name: "Reset" });
    // An icon, not a word: the name is for assistive technology and the tooltip.
    expect(reset.textContent).toBe("");
    expect(reset.querySelector("svg")).toBeTruthy();
    await user.click(reset);
    expect(bridge.setUserSettings).toHaveBeenLastCalledWith({
      base: expect.any(Object),
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: DEFAULT_USER_SETTINGS.appearance.themeMode }),
      }),
    });
    await waitFor(() => expect(within(row).queryByTitle("Modified")).toBeNull());
  });

  it("draws the theme as a radiogroup of three windows", async () => {
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const group = await screen.findByRole("radiogroup", { name: "Theme" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["System", "Light", "Dark"]);
    // Only the chosen window is a tab stop, and it carries the ring.
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]!.querySelector(".outline-accent")).toBeTruthy();
    expect(radios[2]!.querySelector(".outline-accent")).toBeNull();
  });

  it("resets the window zoom from its value, and names its keys", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 1 },
      },
      source: "default" as const,
    });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-zoom");
    // The value names the setting, the action, and where it stands.
    const value = await within(row).findByRole("button", { name: "Reset zoom to 100%, now 120%" });
    await user.hover(within(row).getByRole("button", { name: "Zoom in" }));
    const tip = within(row).getByRole("tooltip");
    expect(tip.textContent).toBe("Zoom inCtrl=");
    expect([...tip.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["Ctrl", "="]);

    await user.click(value);
    expect(bridge.stepWindowZoom).toHaveBeenCalledWith({ step: "reset" });
    await waitFor(() => expect(row.textContent).toContain("100%"));
    expect(within(row).getByRole("button", { name: "Reset zoom to 100%, now 100%" })).toBeTruthy();
    const size = screen.getByTestId("settings-row-editor-size");
    expect(within(size).getByRole("button", {
      name: `Reset editor text size to ${DEFAULT_USER_SETTINGS.editor.fontSize}px, now ${DEFAULT_USER_SETTINGS.editor.fontSize}px`,
    })).toBeTruthy();
  });

  it("keeps a stepper under the pointer when its row becomes changed", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="appearance" onClose={() => {}} />);

    const row = await screen.findByTestId("settings-row-editor-size");
    const larger = within(row).getByRole("button", { name: "Larger editor text" });
    const controls = larger.closest("div.rounded-md")!.parentElement!;
    const slots = () => [...controls.children].map((child) => `${child.tagName}${child.getAttribute("aria-hidden") === "true" ? ":hidden" : ""}.${child.className.includes("size-6") ? "24" : "control"}`);
    // Unchanged, the reset's place is held by an empty box nobody can reach.
    expect(slots()).toEqual(["DIV.control", "SPAN:hidden.24"]);
    expect(within(row).queryByRole("button", { name: "Reset" })).toBeNull();

    await user.click(larger);
    await waitFor(() => expect(within(row).getByRole("button", { name: "Reset" })).toBeTruthy());
    expect(slots()).toEqual(["DIV.control", "BUTTON.24"]);
    // The dot hangs outside the title's line, so the title does not move either.
    expect(within(row).getByTitle("Modified").className).toContain("absolute");
    // A second quick click still lands on +.
    await user.click(larger);
    expect(bridge.setUserSettings.mock.lastCall?.[0].settings.editor.fontSize)
      .toBe(DEFAULT_USER_SETTINGS.editor.fontSize + 2);
  });

  it("shows a stepper's tooltip on hover and on keyboard focus, each on its own", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="appearance" onClose={() => {}} />);

    const row = await screen.findByTestId("settings-row-zoom");
    const zoomIn = within(row).getByRole("button", { name: "Zoom in" });
    const zoomOut = within(row).getByRole("button", { name: "Zoom out" });
    // A click focuses the button but opens no tooltip once the pointer leaves.
    await user.click(zoomIn);
    await user.unhover(zoomIn);
    expect(within(row).queryByRole("tooltip")).toBeNull();

    // From the keyboard, the focused part keeps its tooltip while the pointer
    // passes over another part and leaves.
    zoomIn.blur();
    await user.keyboard("{Tab}");
    zoomIn.focus();
    await waitFor(() => expect(within(row).getByRole("tooltip").textContent).toContain("Zoom in"));
    await user.hover(zoomOut);
    expect(within(row).getByRole("tooltip").textContent).toContain("Zoom out");
    await user.unhover(zoomOut);
    const tip = within(row).getByRole("tooltip");
    expect(tip.textContent).toContain("Zoom in");
    expect(zoomIn.getAttribute("aria-describedby")).toBe(tip.id);

    // A click on the part the keyboard focused leaves no tooltip once the pointer leaves.
    await user.click(zoomIn);
    await user.unhover(zoomIn);
    expect(within(row).queryByRole("tooltip")).toBeNull();
    expect(zoomIn.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps the reset's place on a row that cannot reset, so controls share a right edge", async () => {
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    const updates = await screen.findByTestId("settings-row-desktop-updates");
    const last = within(updates).getByTestId("install-update-button").parentElement!.lastElementChild!;
    expect(last.tagName).toBe("SPAN");
    expect(last.getAttribute("aria-hidden")).toBe("true");
    expect(last.className).toContain("size-6");
  });

  it("closes a stepper's tooltip with the first Escape and Settings with the next", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="appearance" onClose={onClose} />
      </Overlay>,
    );

    const row = await screen.findByTestId("settings-row-zoom");
    const zoomIn = within(row).getByRole("button", { name: "Zoom in" });
    await user.keyboard("{Tab}");
    zoomIn.focus();
    await waitFor(() => expect(within(row).getByRole("tooltip")).toBeTruthy());

    await user.keyboard("{Escape}");
    expect(within(row).queryByRole("tooltip")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("drops the History rail and Current workspace rows", async () => {
    const view = render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="workbench" onClose={() => {}} />,
    );
    const workbench = await screen.findByTestId(settingsSectionPin("workbench"));
    expect(workbench.textContent).not.toContain("History rail");
    view.unmount();

    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    const general = await screen.findByTestId(settingsSectionPin("general"));
    expect(general.textContent).not.toContain("Current workspace");
  });

  it("finds the Keyboard page by a shortcut's name", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    const search = await screen.findByTestId(desktopPins.settingsSearch);
    await user.type(search, "bold");
    const nav = screen.getByTestId("settings-sidebar").querySelector("nav")!;
    expect([...nav.querySelectorAll("button")].map((item) => item.dataset.testid)).toEqual(["settings-nav-keyboard"]);
    // The page shows the shortcut the search named, under its heading.
    const page = () => screen.getByTestId(settingsSectionPin("keyboard"));
    expect(within(page()).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Document"]);
    expect(page().textContent).toBe("DocumentBoldCtrlB");

    // A name another section also answers to lists both.
    await user.clear(search);
    await user.type(search, "sidebar");
    expect([...nav.querySelectorAll("button")].map((item) => item.dataset.testid))
      .toEqual(["settings-nav-appearance", "settings-nav-keyboard", "settings-nav-workbench"]);

    // A search that found the page by its own words shows every shortcut.
    await user.clear(search);
    await user.type(search, "keys");
    expect(within(page()).getAllByRole("heading").map((heading) => heading.textContent))
      .toEqual(["Workbench", "Document", "Find field", "Command palette and Go to"]);
  });

  it("finds no Keyboard page for a shortcut this computer does not list", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    // The test renderer loaded with no macOS platform and no dev tools.
    const search = await screen.findByTestId(desktopPins.settingsSearch);
    for (const query of ["paragraph", "dev tools"]) {
      await user.clear(search);
      await user.type(search, query);
      expect(screen.getByTestId(desktopPins.settingsEmptySearch).textContent).toBe(`No settings match "${query}".`);
    }
  });

  it("shows the window zoom as a percentage and steps it through settings", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-zoom");
    expect(row.textContent).toContain("100%");

    await user.click(within(row).getByRole("button", { name: "Zoom in" }));
    // The stepper goes through main's one zoom mutation — never a full-file
    // save — and paints the level main answered with.
    expect(bridge.stepWindowZoom).toHaveBeenCalledWith({ step: "in" });
    expect(bridge.setUserSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(row.textContent).toContain("120%"));
  });

  it("repaints the window zoom when main reports changed user settings", async () => {
    let pushUserSettings: ((result: DesktopUserSettingsResult) => void) | undefined;
    bridge.onUserSettingsChanged.mockImplementationOnce((listener) => {
      pushUserSettings = listener;
      return () => undefined;
    });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-zoom");
    expect(row.textContent).toContain("100%");
    if (!pushUserSettings) {
      throw new Error("User settings subscription was not registered.");
    }
    pushUserSettings({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 },
      },
      source: "stored",
    });

    await waitFor(() => expect(row.textContent).toContain("144%"));
  });

  it("a broadcast during the initial load is not painted over by it", async () => {
    // The initial Promise.all retains a user-settings snapshot; a change pushed
    // while it is in flight is newer and must survive the load resolving,
    // in the controls and in the window's look.
    const onWorkspaceSettingsRead = vi.fn();
    let pushUserSettings: ((result: DesktopUserSettingsResult) => void) | undefined;
    bridge.onUserSettingsChanged.mockImplementationOnce((listener) => {
      pushUserSettings = listener;
      return () => undefined;
    });
    const load = deferred<Awaited<ReturnType<typeof bridge.getUserSettings>>>();
    bridge.getUserSettings.mockImplementationOnce(() => load.promise);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
        onWorkspaceSettingsRead={onWorkspaceSettingsRead}
      />,
    );

    await waitFor(() => {
      if (!pushUserSettings) {
        throw new Error("User settings subscription was not registered.");
      }
    });
    const pushed = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2, accentColor: "#224488" },
    };
    // DesktopRoot applies the pushed look to the window.
    applyLookSettings(pushed);
    const accent = document.documentElement.style.getPropertyValue("--dohc-accent");
    pushUserSettings?.({ settings: pushed, source: "stored" });
    load.resolve({ settings: DEFAULT_USER_SETTINGS, source: "default" });

    const row = await screen.findByTestId("settings-row-zoom");
    await waitFor(() => expect(row.textContent).toContain("144%"));
    // The load's callback reports the workspace settings after its user
    // settings, so the stale read has had its chance once this fires.
    await waitFor(() => expect(onWorkspaceSettingsRead).toHaveBeenCalled());
    expect(row.textContent).toContain("144%");
    expect(document.documentElement.style.getPropertyValue("--dohc-accent")).toBe(accent);
    applyLookSettings(DEFAULT_USER_SETTINGS);
  });

  it("an in-flight save's response cannot overwrite a newer zoom broadcast", async () => {
    const user = userEvent.setup();
    let pushUserSettings: ((result: DesktopUserSettingsResult) => void) | undefined;
    bridge.onUserSettingsChanged.mockImplementationOnce((listener) => {
      pushUserSettings = listener;
      return () => undefined;
    });
    const save = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
    bridge.setUserSettings.mockImplementationOnce(() => save.promise);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    // A full save is now awaiting main's response…
    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    // …when a zoom broadcast lands with a newer result.
    pushUserSettings?.({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 },
      },
      source: "stored",
    });
    const row = await screen.findByTestId("settings-row-zoom");
    await waitFor(() => expect(row.textContent).toContain("144%"));

    // The older response arrives; awaiting its own promise (not a timer)
    // guarantees the component's continuation ran before the assertion.
    await act(async () => {
      save.resolve({
        settings: {
          ...DEFAULT_USER_SETTINGS,
          appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
        },
        source: "stored",
      });
      await save.promise;
    });
    expect(row.textContent).toContain("144%");
  });

  it("saves a preferred name and previews agent attribution", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="general"
        onClose={() => {}}
      />,
    );

    const input = await screen.findByTestId("general-preferred-name-input");
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("Enter your name");
    expect(screen.getByTestId("general-preferred-name-preview").textContent).toContain(
      "You",
    );
    expect(screen.queryByText("Launch behavior")).toBeNull();
    await user.type(input, "Sam");
    expect(screen.getByTestId("general-preferred-name-preview").textContent).toContain(
      "Sam",
    );
    await user.tab();

    await waitFor(() =>
      expect(bridge.setUserSettings).toHaveBeenCalledWith({
        base: expect.any(Object),
        settings: expect.objectContaining({ profile: { preferredName: "Sam" } }),
      }),
    );
  });

  it("cancels a preferred-name edit without saving or closing settings", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="general"
        onClose={onClose}
      />,
    );

    const input = await screen.findByTestId("general-preferred-name-input");
    bridge.setUserSettings.mockClear();
    await user.type(input, "Unsaved name");
    await user.keyboard("{Escape}");

    expect((input as HTMLInputElement).value).toBe("");
    expect(bridge.setUserSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
  });

  it("reports a failed save with the error it came from, so Copy keeps the path", async () => {
    const user = userEvent.setup();
    const denied = new Error(
      "Error invoking remote method 'desktop:set-user-settings': Error [EACCES]: EACCES: permission denied, open 'C:\\dohc\\settings.json'",
    );
    bridge.setUserSettings.mockRejectedValueOnce(denied);
    const onError = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
        onError={onError}
      />,
    );

    await screen.findByRole("radio", { name: "System" });
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      "dohc could not save your settings. dohc does not have permission to use this file or folder.",
      denied,
    );
  });

  it("rolls back optimistic appearance changes when save fails", async () => {
    const user = userEvent.setup();
    bridge.setUserSettings.mockRejectedValueOnce(new Error("Disk full"));
    // DesktopRoot has already applied the settings the dialog opens with.
    applyLookSettings(DEFAULT_USER_SETTINGS);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await screen.findByRole("radio", { name: "System" });
    const initialTheme = document.documentElement.dataset.theme;
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() =>
      expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe(
        "error",
      ),
    );
    // The chip must not borrow the document's "your edits are still here",
    // and it owes a next step.
    expect(screen.getByTestId("settings-save-state").getAttribute("title")).toBe(
      "dohc could not save this setting. Try changing it again.",
    );
    expect(document.documentElement.dataset.theme).toBe(initialTheme);
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("goes back to the saved settings when a save behind a failed one also fails", async () => {
    const user = userEvent.setup();
    let failFirst: (cause: Error) => void = () => {};
    bridge.setUserSettings
      .mockImplementationOnce(() => new Promise<never>((_, reject) => { failFirst = reject; }))
      .mockRejectedValueOnce(new Error("Disk full"));
    applyLookSettings(DEFAULT_USER_SETTINGS);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await screen.findByRole("radio", { name: "System" });
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    // This save starts from Dark, which the first save never wrote.
    await user.click(screen.getByRole("radio", { name: "Light" }));
    failFirst(new Error("Disk full"));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error");
  });

  it("supports arrow-key navigation inside segmented appearance controls", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    const system = await screen.findByRole("radio", { name: "System" });
    system.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(bridge.setUserSettings).toHaveBeenCalledWith({
      base: expect.any(Object),
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: "light" }),
      }),
    });
  });

  it("copies this workspace's MCP config from the title line", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/home/sam/dohc/personal"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    await mcpConfigLoaded();
    await user.click(copyMcpConfig());
    // The copy is the literal config the person pastes into their AI tool.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"')));
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("dohc-mcp");
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("/home/sam/dohc/personal");
  });

  it("does not call an active agent run a connected agent", async () => {
    runActive = true;
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("mcp-enable-toggle").textContent).toBe("Stop run"),
    );
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    // Connecting needs only the config; the run control lives in its own row,
    // and the one copy sits on the title line.
    expect(screen.getAllByRole("button", { name: /^(Start|Stop) (agent )?run$/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(1);
    await mcpConfigLoaded();
    expect(screen.queryByText(/Needs setup|Ready|Connected/)).toBeNull();
  });

  it("lists an agent that is on without a personal name", async () => {
    bridge.getUserSettings.mockResolvedValueOnce({
      settings: settingsWithAgent({ name: "Nova" }),
      source: "default",
    });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    expect((await screen.findByRole("switch", { name: "Turn on Nova" })).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps an agent entry dohc could not use in its row while a save runs", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({
      settings: settingsWithAgent({ name: "Nova" }),
      source: "stored",
      agentProblems: [{ id: "codex", name: "Codex", position: 1, problem: "`hue` must be one of: olive." }],
    });
    const saved = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
    bridge.setUserSettings.mockImplementationOnce(() => saved.promise);
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    const problem = await screen.findByTestId("agent-problem");
    expect(problem.textContent).toBe("hue must be one of: olive.");
    await user.click(screen.getByRole("switch", { name: "Turn on Nova" }));
    expect(screen.getByTestId("agent-problem")).toBe(problem);
    await act(async () => saved.resolve({ settings: settingsWithAgent({ name: "Nova", enabled: false }), source: "stored" }));
  });

  it("does not move focus to Copy when the run row starts the run", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    await mcpConfigLoaded();
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    expect(document.activeElement).not.toBe(copyMcpConfig());
  });

  it("changes an agent's color, when it stops and its command from its details", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "stored" });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Nova actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Details" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Color of Nova" })).getByRole("radio", { name: "Blue" }));
    await waitFor(() => expect(savedSettings()?.agents.default?.hue).toBe("blue"));
    await user.click(screen.getByRole("button", { name: "Change when Nova stops" }));
    const minutes = screen.getByRole("spinbutton", { name: "Minutes before Nova stops" });
    await user.clear(minutes);
    await user.type(minutes, "45{Enter}");
    await waitFor(() => expect(savedSettings()?.agents.default?.timeoutMinutes).toBe(45));
    await user.click(screen.getByRole("button", { name: "Change the command that starts Nova" }));
    const command = screen.getByRole("textbox", { name: "Command that starts Nova" });
    await user.clear(command);
    await user.type(command, "  codex exec  {Enter}");
    await waitFor(() => expect(savedSettings()?.agents.default).toEqual({
      name: "Nova", hue: "blue", launch: { command: "codex exec" }, changesFiles: true, enabled: true, timeoutMinutes: 45,
    }));
  });

  it("gives an agent you run a command of its own, and leaves it off", async () => {
    const user = userEvent.setup();
    const { launch: _launch, ...mcpOnly } = testAgent({ name: "Nova", enabled: false });
    bridge.getUserSettings.mockResolvedValueOnce({ settings: { ...DEFAULT_USER_SETTINGS, agents: { default: mcpOnly } }, source: "stored" });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Nova actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Details" }));
    // Without a way to start it, there is nothing to stop.
    expect(screen.queryByText("Stops after")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use your own command" }));
    await user.type(screen.getByRole("textbox", { name: "Command that starts Nova" }), "node agent.mjs{Enter}");
    await waitFor(() => expect(savedSettings()?.agents.default).toMatchObject({ launch: { command: "node agent.mjs" }, enabled: false }));
  });

  it("keeps an agent's command when the field is left empty", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "stored" });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Nova actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: "Change the command that starts Nova" }));
    await user.clear(screen.getByRole("textbox", { name: "Command that starts Nova" }));
    await user.keyboard("{Enter}");
    expect(bridge.setUserSettings).not.toHaveBeenCalled();
    expect(screen.getByText("node agent.mjs")).toBeTruthy();
  });

  it("checks the agent in its row", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "stored" });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Check" }));
    expect(bridge.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "default" });
    expect(await screen.findByText(/^Replied in \d+ s$/)).toBeTruthy();
  });

  // #687 on this surface. A session without a recorder holds `runnerSelfTest`
  // behind a restart: main builds the recorder once per workspace per app
  // session, so a Check here would run into a refusal. The note says so and
  // Check is off.
  it("tells the user to restart when this session has no recorder", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "stored" });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sessionRecorderOn={false}
        onClose={() => {}}
      />,
    );

    const note = await screen.findByTestId("agents-check-note");
    expect(note.textContent).toBe("The workspace engine starts when dohc starts. Restart dohc to check an agent.");
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Check" });
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  // A shared view materializes no settings file, so the engine reads as
  // on by default, while main installs no recorder. The no-recorder branch
  // must not prescribe a restart that cannot make the check work.
  it("shows the shared-view note without a restart instruction", async () => {
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sharedView
        sessionRecorderOn={false}
        onClose={() => {}}
      />,
    );

    const note = await screen.findByTestId("agents-check-note");
    expect(note.textContent).toBe(
      "This workspace is a shared view. dohc records nothing here, so there is no chat to test.",
    );
    expect(note.textContent).not.toContain("restart");
  });

  // sharedView is a synchronous prop, but sessionRecorderOn only resolves
  // once main's openWorkspace status arrives. In that window a shared view
  // already knows it has no chat to test, so Check must not wait on it.
  it("turns Check off in a shared view before the recorder status resolves", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova" }), source: "stored" });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sharedView
        onClose={() => {}}
      />,
    );

    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check" });
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  it("says an agent didn't reply without turning it on or off", async () => {
    const onError = vi.fn();
    bridge.runnerSelfTest.mockResolvedValueOnce({
      ok: false,
      detail: "Runner did not report within 120 seconds.",
    });
    bridge.getUserSettings.mockResolvedValueOnce({ settings: settingsWithAgent({ name: "Nova", enabled: false }), source: "stored" });
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("Didn't reply.")).toBeTruthy();
    expect(onError).toHaveBeenCalledWith("Runner did not report within 120 seconds.");
    expect(screen.getByRole("switch", { name: "Turn on Nova" }).getAttribute("aria-checked")).toBe("false");
    expect(bridge.setUserSettings).not.toHaveBeenCalled();
  });

  // Live documents belong to the workspace that owns them. A shared view
  // runs no owner live delivery, so it gets no list to manage.
  it("opens live documents from sync and sharing for an owned workspace", async () => {
    const onOpenLiveDocuments = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="cloud"
        onOpenLiveDocuments={onOpenLiveDocuments}
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-live-documents");
    expect(row.textContent).toContain("Live documents");
    expect(row.textContent).toContain("Stopping one keeps the file and its history.");
    await user.click(within(row).getByRole("button", { name: "Open live documents" }));
    expect(onOpenLiveDocuments).toHaveBeenCalledOnce();
  });

  // Settings holds values. The share lists live in the Sharing view.
  it("keeps share lists out of sync and sharing", async () => {
    const onConnect = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="cloud"
        cloud={{ status: { connected: false }, unreadable: false, onChanged: vi.fn(), onConnect, onError: vi.fn(), onAccountError: vi.fn(), onDeleteAccount: vi.fn() }}
        onOpenSharing={() => {}}
        onClose={() => {}}
      />,
    );

    const section = await screen.findByTestId("settings-section-cloud");
    await userEvent.setup().click(within(section).getByRole("button", { name: "Connect server" }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(section.textContent).not.toContain("Shared by me");
    expect(section.textContent).not.toContain("Shared with me");
    expect(within(section).queryByRole("list")).toBeNull();
    // Nothing reads the lists until a search asks.
    expect(bridge.listSharingAccess).not.toHaveBeenCalled();
  });

  it("finds a share by name, and a list by its old section name, and opens Sharing on it", async () => {
    const onOpenSharing = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        onOpenSharing={onOpenSharing}
        onClose={() => {}}
      />,
    );

    const search = await screen.findByTestId(desktopPins.settingsSearch);
    await user.type(search, "product-plan");
    const share = await screen.findByRole("button", { name: /product-plan\.md/ });
    // No section matches, so the result stands alone.
    expect(screen.queryByTestId(desktopPins.settingsEmptySearch)).toBeNull();
    expect(bridge.listSharingAccess).toHaveBeenCalledWith({ workspaceId: "ws-1", lane: "granted" });
    expect(bridge.listSharingAccess).toHaveBeenCalledWith({ workspaceId: "ws-1", lane: "received" });
    await user.click(share);
    expect(onOpenSharing).toHaveBeenLastCalledWith({ lane: "granted", shareId: "share-plan" });

    await user.clear(search);
    await user.type(search, "shared with me");
    const results = await screen.findByTestId("settings-sharing-results");
    const lane = within(results).getAllByTestId("settings-sharing-result");
    expect(lane.map((result) => result.textContent)).toEqual(["Shared with me"]);
    await user.click(lane[0]!);
    expect(onOpenSharing).toHaveBeenLastCalledWith({ lane: "received", shareId: null });
    // The lists were read once for the dialog.
    expect(bridge.listSharingAccess).toHaveBeenCalledTimes(2);
  });

  it("offers no Shared by me result in a shared view", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        sharedView
        onOpenSharing={() => {}}
        onClose={() => {}}
      />,
    );

    await user.type(await screen.findByTestId(desktopPins.settingsSearch), "shared");
    const results = await screen.findByTestId("settings-sharing-results");
    expect(within(results).getAllByTestId("settings-sharing-result").map((result) => result.dataset.lane)).toEqual(["received"]);
    expect(bridge.listSharingAccess).not.toHaveBeenCalledWith(expect.objectContaining({ lane: "granted" }));
  });

  it("hides live documents in a shared view", async () => {
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="cloud"
        sharedView
        onOpenLiveDocuments={() => {}}
        onClose={() => {}}
      />,
    );

    await screen.findByTestId("settings-section-cloud");
    expect(screen.queryByTestId("settings-row-live-documents")).toBeNull();
  });

  it("copies the config snippet to the clipboard", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    await mcpConfigLoaded();
    await user.click(copyMcpConfig());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"')));
  });

  it("reports a copy failure to the shell without claiming success", async () => {
    const user = userEvent.setup();
    stubClipboard();
    const denied = new Error("Clipboard denied");
    writeText.mockRejectedValueOnce(denied);
    const report = vi.fn<ReportShellFailure>();
    render(
      <ShellErrorReporter.Provider value={report}>
        <SettingsDialog workspaceIsReady
          workspaceId="ws-1"
          workspacePath="/x"
          initialSection="agents"
          onClose={() => {}}
        />
      </ShellErrorReporter.Provider>,
    );
    await mcpConfigLoaded();
    await user.click(copyMcpConfig());
    expect(await screen.findByRole("button", { name: "Couldn't copy" })).toBeTruthy();
    expect(report).toHaveBeenCalledWith({
      message: "dohc could not copy to the clipboard. Clipboard denied",
      cause: denied,
      retry: expect.any(Function),
    });
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("reports MCP load failures and retries without leaving stale UI", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );

    expect((await screen.findByTestId("mcp-load-error")).textContent).toBe("Retry");
    expect(onError).toHaveBeenCalledWith("MCP unavailable", expect.any(Error), expect.any(Function));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("mcp-load-error")).toBeNull());
    await mcpConfigLoaded();
  });

  it("retries a refused stop's original run from its notice after Settings closes", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw cause;
    });
    const view = render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={onError} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"));
    const retry = onError.mock.calls[0]?.[2];
    expect(retry).toBeTypeOf("function");
    view.unmount();
    await act(async () => { await retry(); });
    expect(bridge.endAgentRun).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1", runId: "run-1" });
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
  });

  it("retries the terminal history write instead of starting a replacement run", async () => {
    runActive = true;
    const user = userEvent.setup();
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw new Error("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={vi.fn()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(bridge.endAgentRun).toHaveBeenCalledTimes(2));
    expect(bridge.endAgentRun).toHaveBeenLastCalledWith({ workspaceId: "ws-1", runId: "run-1" });
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
  });

  it("queues a notice retry behind a refused stop's pending status read", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={onError} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    const recovery = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw new Error("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    });
    bridge.getAgentRunStatus
      .mockResolvedValueOnce({ activeRun: { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" }, lastRun: null })
      .mockImplementationOnce(() => recovery.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const retried = onError.mock.calls[0]?.[2]();
    expect(bridge.endAgentRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      recovery.resolve({ activeRun: null, lastRun: null });
      await retried;
    });
    expect(bridge.endAgentRun).toHaveBeenCalledTimes(2);
    expect(bridge.endAgentRun).toHaveBeenLastCalledWith({ workspaceId: "ws-1", runId: "run-1" });
  });

  it("keeps a stopped run's retry bound to its ID when another run starts", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw new Error("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    });
    const view = render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={onError} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"));
    bridge.getAgentRunStatus.mockResolvedValueOnce({
      activeRun: { id: "run-new", startedAt: 2, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" }, lastRun: null,
    });
    await act(async () => { await onError.mock.calls[0]?.[2](); });
    expect(bridge.endAgentRun).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1", runId: "run-1" });
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    view.unmount();
  });

  it("retries only the read after a successful start", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={onError} onClose={() => {}} />);
    await mcpConfigLoaded();
    bridge.startAgentRun.mockImplementationOnce(async () => {
      runActive = true;
      bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
      return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
    });
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await act(async () => { await onError.mock.calls[0]?.[2](); });
    expect(bridge.startAgentRun).toHaveBeenCalledTimes(1);
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
  });

  it("reports an agent history mutation refusal through the notice hook", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    bridge.startAgentRun.mockRejectedValueOnce(cause);
    render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="agents" onError={onError} onClose={() => {}} />,
    );
    await mcpConfigLoaded();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toBe("Start run");
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(cause.message, cause, expect.any(Function)));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
  });

  it.each([
    ["stopped", false],
    ["running", true],
  ] as const)("reports a failed read before a %s toggle as a load failure and changes nothing", async (state, active) => {
    runActive = active;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("");
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe(state),
    );
    bridge.getAgentRunStatus.mockRejectedValueOnce(cause);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith("dohc could not load agent settings.", cause, expect.any(Function));
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe(state);
  });

  it("shows a stop that history refused to record once a fresh status reports it", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw cause;
    });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function));
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
  });

  it("keeps a run active when its stop refuses the attribution clear and status still says running", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("capture refused the clear");
    bridge.endAgentRun.mockRejectedValueOnce(cause);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toBe("Stop run");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
  });

  it("keeps Retry from racing a refused stop's pending recovery read", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    const recovery = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.endAgentRun.mockRejectedValueOnce(cause);
    bridge.getAgentRunStatus
      .mockImplementationOnce(async () => ({
        activeRun: { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const },
        lastRun: null,
      }))
      .mockImplementationOnce(() => recovery.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function)));
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    // A newer read lands while the recovery is still pending.
    runActive = false;
    await user.click(retry);
    await act(async () => {});
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
    await act(async () => {
      recovery.resolve({
        activeRun: { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" },
        lastRun: null,
      });
      await recovery.promise;
    });
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
    // Once the recovery settles, Retry reads the newer status.
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps a toggle from racing a pending Retry read", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const loadFailure = new Error("MCP unavailable");
    bridge.getMcpConfig.mockRejectedValueOnce(loadFailure);
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await screen.findByTestId("mcp-load-error");
    const retryRead = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.getAgentRunStatus.mockImplementationOnce(() => retryRead.promise);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(true);
    // A click while Retry is pending must not start a run whose newer status
    // Retry's older answer could then repaint.
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await act(async () => {});
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    await act(async () => {
      retryRead.resolve({ activeRun: null, lastRun: null });
      await retryRead.promise;
    });
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(loadFailure.message, loadFailure, expect.any(Function));
  });

  it("does not let an old workspace's late Retry re-enable a new workspace's pending toggle", async () => {
    const user = userEvent.setup();
    const props = { workspacePath: "/x", initialSection: "agents" as const, onClose: () => {} };
    bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
    const view = render(<SettingsDialog workspaceIsReady workspaceId="ws-1" {...props} />);
    await screen.findByTestId("mcp-load-error");
    const oldRetryRead = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.getAgentRunStatus.mockImplementationOnce(() => oldRetryRead.promise);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    view.rerender(<SettingsDialog workspaceIsReady workspaceId="ws-2" {...props} />);
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    const starting = deferred<Awaited<ReturnType<typeof bridge.startAgentRun>>>();
    bridge.startAgentRun.mockImplementationOnce(() => starting.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-2" }));
    await act(async () => {
      oldRetryRead.resolve({ activeRun: null, lastRun: null });
      await oldRetryRead.promise;
    });
    expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(true);
    await act(async () => {
      runActive = true;
      starting.resolve({ id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" });
      await starting.promise;
    });
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
  });

  it("does not call a started run a failed update when only the final MCP read fails", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const configFailure = new Error("MCP config unavailable");
    try {
      bridge.startAgentRun.mockImplementationOnce(async () => {
        runActive = true;
        bridge.getMcpConfig.mockRejectedValue(configFailure);
        return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
      });
      render(
        <SettingsDialog workspaceIsReady
          workspaceId="ws-1"
          workspacePath="/x"
          initialSection="agents"
          onError={onError}
          onClose={() => {}}
        />,
      );
      await mcpConfigLoaded();
      await user.click(screen.getByTestId("mcp-enable-toggle"));
      await waitFor(() =>
        expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
      );
      expect(onError).toHaveBeenCalledExactlyOnceWith(configFailure.message, configFailure, expect.any(Function));
      expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
    } finally {
      bridge.getMcpConfig.mockImplementation(getDefaultMcpConfig);
    }
  });

  it("reports a started run once when both panel status reads fail", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const statusFailure = new Error("status unavailable");
    bridge.startAgentRun.mockImplementationOnce(async () => {
      runActive = true;
      bridge.getAgentRunStatus
        .mockRejectedValueOnce(statusFailure)
        .mockRejectedValueOnce(new Error("recovery unavailable"));
      return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
    });
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await mcpConfigLoaded();
    const statusReads = bridge.getAgentRunStatus.mock.calls.length;
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(statusReads + 3));
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(onError).toHaveBeenCalledExactlyOnceWith(statusFailure.message, statusFailure, expect.any(Function));
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
  });

  it("shows a refused stop's live status even when the MCP config becomes unavailable", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    try {
      bridge.endAgentRun.mockImplementationOnce(async () => {
        runActive = false;
        bridge.getMcpConfig.mockRejectedValue(new Error("MCP config unavailable"));
        throw cause;
      });
      render(
        <SettingsDialog workspaceIsReady
          workspaceId="ws-1"
          workspacePath="/x"
          initialSection="agents"
          onError={onError}
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
      );
      await user.click(screen.getByTestId("mcp-enable-toggle"));
      await waitFor(() =>
        expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
      );
      expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function));
      // The config it read before stays copyable.
      expect(copyMcpConfig().disabled).toBe(false);
    } finally {
      bridge.getMcpConfig.mockImplementation(getDefaultMcpConfig);
    }
  });

  it("keeps a refused stop's notice and running state when the recovery read fails", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error("dohc could not read this workspace's agent run history. Check .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    const statusReads = bridge.getAgentRunStatus.mock.calls.length;
    bridge.endAgentRun.mockRejectedValueOnce(cause);
    bridge.getAgentRunStatus
      .mockImplementationOnce(async () => ({
        activeRun: { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const },
        lastRun: null,
      }))
      .mockRejectedValueOnce(new Error("status unavailable"));
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(statusReads + 2));
    await waitFor(() => expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false));
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function));
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
  });

  it("ignores a refused stop's late recovery read after switching workspaces", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const props = { workspacePath: "/x", initialSection: "agents" as const, onError, onClose: () => {} };
    const view = render(<SettingsDialog workspaceIsReady workspaceId="ws-1" {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    const recovery = deferred<{ activeRun: null; lastRun: null }>();
    const cause = new Error("This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    bridge.endAgentRun.mockRejectedValueOnce(cause);
    bridge.getAgentRunStatus
      .mockImplementationOnce(async () => ({
        activeRun: { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const },
        lastRun: null,
      }))
      .mockImplementationOnce(() => recovery.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function)));
    view.rerender(<SettingsDialog workspaceIsReady workspaceId="ws-2" {...props} />);
    await waitFor(() =>
      expect(bridge.getAgentRunStatus).toHaveBeenLastCalledWith({ workspaceId: "ws-2" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await act(async () => {
      recovery.resolve({ activeRun: null, lastRun: null });
      await recovery.promise;
    });
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
  });

  it("ignores in-flight MCP config responses after switching workspaces", async () => {
    // Delay ws-old and resolve it only after rerendering ws-new; if cancellation
    // fails, the old config overwrites the one Copy MCP config copies.
    const user = userEvent.setup();
    stubClipboard();
    let resolveOldConfig = () => {};
    try {
      bridge.getMcpConfig.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "ws-old") {
          return new Promise<typeof config>((resolve) => {
            resolveOldConfig = () =>
              resolve({
                ...config,
                args: ["--workspace", "/old"],
                workspacePath: "/old",
              });
          });
        }
        return Promise.resolve({
          ...config,
          args: ["--workspace", "/new"],
          workspacePath: "/new",
        });
      });
      const view = render(
        <SettingsDialog workspaceIsReady
          workspaceId="ws-old"
          workspacePath="/old"
          initialSection="agents"
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(bridge.getMcpConfig).toHaveBeenCalledWith({ workspaceId: "ws-old" }),
      );

      view.rerender(
        <SettingsDialog workspaceIsReady
          workspaceId="ws-new"
          workspacePath="/new"
          initialSection="agents"
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(bridge.getMcpConfig).toHaveBeenCalledWith({ workspaceId: "ws-new" }),
      );
      await mcpConfigLoaded();
      await act(async () => resolveOldConfig());
      await user.click(copyMcpConfig());
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(writeText.mock.calls.at(-1)?.[0]).toContain("/new");
      expect(writeText.mock.calls.at(-1)?.[0]).not.toContain("/old");
    } finally {
      bridge.getMcpConfig.mockImplementation(getDefaultMcpConfig);
    }
  });

  it("starts an agent run, then reflects running status", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("stops the active agent run", async () => {
    runActive = true;
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(toggle);
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
  });

  it("refreshes stale stopped UI before toggling so it cannot stop a run behind a Start label", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");
    runActive = true;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toBe("Stop run");
  });

  it("refreshes stale running UI before toggling so it cannot start a run behind a Stop label", async () => {
    runActive = true;
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    runActive = false;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toBe("Start run");
  });

  it("shows current desktop update version and channel", async () => {
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "idle",
      ),
    );
    expect(screen.getByTestId("desktop-updates-version").textContent).toBe("1.2.3");
    expect(screen.getByTestId("desktop-updates-channel").textContent).toBe("latest");
  });

  it("checks for updates and enables restart when an update is ready", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(screen.getByTestId("install-update-button").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows update check failures and re-enables checking", async () => {
    bridge.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "Could not check for updates.",
      ),
    );
    expect(screen.getByTestId("check-updates-button").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows rejected update checks returned by the main process", async () => {
    bridge.checkForUpdates.mockResolvedValueOnce({
      checked: false,
      state: idleUpdateState,
    });
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "No update check was started.",
      ),
    );
  });

  it("disables update actions while an update check is pending", async () => {
    const pending = deferred<{ checked: boolean; state: typeof readyUpdateState }>();
    bridge.checkForUpdates.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("check-updates-button").hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(screen.getByTestId("install-update-button").hasAttribute("disabled")).toBe(
      true,
    );

    pending.resolve({ checked: true, state: readyUpdateState });
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("updates desktop update status from the live update subscription", async () => {
    let pushUpdate: ((state: typeof readyUpdateState) => void) | undefined;
    const onUpdateStateMock = bridge.onUpdateState as unknown as {
      mockImplementationOnce(
        implementation: (
          listener: (state: typeof readyUpdateState) => void,
        ) => () => void,
      ): void;
    };
    onUpdateStateMock.mockImplementationOnce((listener) => {
      pushUpdate = listener;
      return () => undefined;
    });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "idle",
      ),
    );

    if (!pushUpdate) throw new Error("Update subscription was not registered.");
    pushUpdate(readyUpdateState);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("keeps subscription state when the initial update fetch resolves later", async () => {
    let pushUpdate: ((state: typeof readyUpdateState) => void) | undefined;
    const pending = deferred<typeof idleUpdateState>();
    bridge.getUpdateState.mockImplementationOnce(() => pending.promise);
    const onUpdateStateMock = bridge.onUpdateState as unknown as {
      mockImplementationOnce(
        implementation: (
          listener: (state: typeof readyUpdateState) => void,
        ) => () => void,
      ): void;
    };
    onUpdateStateMock.mockImplementationOnce((listener) => {
      pushUpdate = listener;
      return () => undefined;
    });
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    if (!pushUpdate) throw new Error("Update subscription was not registered.");
    pushUpdate(readyUpdateState);
    pending.resolve(idleUpdateState);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("restarts into a ready update from settings", async () => {
    updateReady = true;
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );

    await user.click(screen.getByTestId("install-update-button"));

    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });

  it("shows rejected restart requests returned by the main process", async () => {
    updateReady = true;
    bridge.installUpdate.mockResolvedValueOnce({
      accepted: false,
      state: readyUpdateState,
    });
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );

    await user.click(screen.getByTestId("install-update-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "Could not restart into the update.",
      ),
    );
  });

  it("shows why a Linux .deb did not install, and the command that installs it beside its copy", async () => {
    updateReady = true;
    const reason = "dohc did not get permission to install the update. Run this command in a terminal to install it.";
    const installCommand = "sudo apt install '/home/sam/.cache/dohc-updater/pending/dohc-1.2.4-linux-amd64.deb'";
    bridge.installUpdate.mockResolvedValueOnce({
      accepted: false,
      reason,
      state: { ...readyUpdateState, message: reason, installCommand },
    });
    const user = userEvent.setup();
    render(<SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe("ready"),
    );
    expect(screen.queryByTestId("desktop-updates-install-command")).toBeNull();

    await user.click(screen.getByTestId("install-update-button"));

    await waitFor(() => expect(screen.getByTestId("desktop-updates-status").textContent).toBe(reason));
    expect(screen.getByTestId("desktop-updates-install-command").textContent).toBe(installCommand);
    expect(screen.getByTestId("desktop-updates-install-command-copy").getAttribute("aria-label")).toBe("Copy install command");
  });

  it("persists the attachment location and hides the folder name for same-folder", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    // Folder name is visible for the default (per-document) location.
    expect(await screen.findByTestId("attachment-folder-input")).toBeTruthy();

    await user.selectOptions(
      screen.getByTestId("attachment-location-select"),
      "global-folder",
    );
    // The save carries the changed control only — main merges it onto the
    // file, so the dialog's copy of the other fields never rides along.
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      patch: { files: { attachmentLocation: "global-folder" } },
    });

    // Switching to same-folder removes the (now meaningless) folder-name row.
    await user.selectOptions(
      screen.getByTestId("attachment-location-select"),
      "same-folder",
    );
    await waitFor(() =>
      expect(screen.queryByTestId("attachment-folder-input")).toBeNull(),
    );
  });

  it("saves and resets the default site preview mode", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="workbench"
        onClose={() => {}}
      />,
    );

    const select = await screen.findByTestId("site-preview-mode-select");
    expect(
      Array.from((select as HTMLSelectElement).options).map((option) => option.value),
    ).toEqual(["auto", "static", "dev", "build"]);

    await user.selectOptions(select, "build");
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      patch: { sites: { defaultPreviewMode: "build" } },
    });

    const row = screen.getByTestId("settings-row-site-preview-mode");
    await waitFor(() => expect(row.textContent).toContain("Modified"));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(bridge.setWorkspaceSettings).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      patch: { sites: { defaultPreviewMode: "auto" } },
    });
  });

  // Over a settings file dohc cannot read, the dialog's resolved copy is the
  // defaults, so saving one unrelated control would write them over the
  // file. main refuses; the dialog must say so and must not claim a save
  // happened.
  it("shows the refusal when the settings file cannot be read, and never says Saved", async () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /x/.dohc/local/settings.local.json. Then restart dohc.";
    const refusal =
      "dohc did not save workspace settings. dohc cannot read /x/.dohc/local/settings.local.json. Fix that file. Or select Reset workspace in Advanced to replace it.";
    const onDisk = {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered" as const,
      warning,
    };
    bridge.getWorkspaceSettings.mockResolvedValue(onDisk);
    bridge.setWorkspaceSettings.mockResolvedValue({ ...onDisk, refusal });

    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    await user.selectOptions(
      await screen.findByTestId("attachment-location-select"),
      "global-folder",
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("settings-warning").map((node) => node.textContent),
      ).toContain(refusal),
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe(
      "error",
    );
    expect(screen.getByTestId("settings-save-state").textContent).not.toContain(
      "Saved",
    );
    // The control snaps back to what is really on disk instead of showing an
    // edit that never landed.
    await waitFor(() =>
      expect(
        (screen.getByTestId("attachment-location-select") as HTMLSelectElement).value,
      ).toBe("per-document"),
    );
  });

  // Each control saves on its own, and main merges each patch onto the file.
  // An earlier edit must therefore survive the next one — the assertion that
  // keeps the fake settings file above honest about what the real save does.
  it("keeps an earlier edit when the next control is saved", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    await user.selectOptions(
      await screen.findByTestId("attachment-location-select"),
      "global-folder",
    );
    const input = await screen.findByTestId("attachment-folder-input");
    await user.clear(input);
    await user.type(input, "media");

    await waitFor(() =>
      expect((input as HTMLInputElement).value).toBe("media"),
    );
    expect(
      (screen.getByTestId("attachment-location-select") as HTMLSelectElement).value,
    ).toBe("global-folder");
  });

  it("shows one scoped reset action for each settings scope", async () => {
    bridge.getUserSettings.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
      },
      source: "default",
    });
    workspaceSettingsOnDisk = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      privacy: { confirmExternalLinks: false },
    };

    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
      />,
    );

    const userRow = await screen.findByTestId("settings-row-reset-user");
    const workspaceRow = screen.getByTestId("settings-row-reset-workspace");
    expect(within(userRow).getAllByRole("button")).toHaveLength(1);
    expect(within(userRow).getByRole("button").textContent).toBe("Reset user");
    expect(within(workspaceRow).getAllByRole("button")).toHaveLength(1);
    expect(within(workspaceRow).getByRole("button").textContent).toBe(
      "Reset workspace",
    );
  });

  it("opens the settings file shown beside its path, and reports a failure through the shell", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
        onError={onError}
      />,
    );

    const row = await screen.findByTestId("settings-row-settings-file");
    await within(row).findByText("/state/dohc-settings.json");
    await user.click(within(row).getByRole("button", { name: "Open settings file" }));
    expect(bridge.openUserSettingsFile).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();

    bridge.openUserSettingsFile.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:open-user-settings-file': Error: dohc could not open /state/dohc-settings.json. No application is associated with this file.",
    ));
    await user.click(within(row).getByRole("button", { name: "Open settings file" }));
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      "dohc could not open /state/dohc-settings.json. No application is associated with this file.",
    ));
  });

  it("marks and focuses the part a Customize… command opened Settings for", async () => {
    const user = userEvent.setup();
    const ask = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection={CUSTOMIZE_TARGETS.sidebar.section}
        focus={CUSTOMIZE_TARGETS.sidebar}
        askAgent={{ ready: true, ask, setUp: vi.fn() }}
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-sidebar");
    expect(row.dataset.highlighted).toBe("true");
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("group", { name: "Sidebar" })).toBe(row);
    expect(screen.getByTestId("settings-row-theme").dataset.highlighted).toBeUndefined();
    await user.click(within(row).getByRole("button", { name: "Ask my agent" }));
    expect(ask).toHaveBeenCalledExactlyOnceWith({ kind: "settings", target: CUSTOMIZE_TARGETS.sidebar });
  });

  it("marks the editor's row, and not the settings file's, for the editor", async () => {
    const user = userEvent.setup();
    const ask = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection={CUSTOMIZE_TARGETS.editor.section}
        focus={CUSTOMIZE_TARGETS.editor}
        askAgent={{ ready: true, ask, setUp: vi.fn() }}
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-editor-font");
    expect(row.dataset.highlighted).toBe("true");
    expect(document.activeElement).toBe(row);
    expect(screen.getByTestId("settings-dialog").dataset.activeSection).toBe("appearance");
    await user.click(within(row).getByRole("button", { name: "Ask my agent" }));
    expect(ask).toHaveBeenCalledExactlyOnceWith({ kind: "settings", target: CUSTOMIZE_TARGETS.editor });
  });

  it("offers the settings file to the agent, or the way to set one up", async () => {
    const user = userEvent.setup();
    const setUp = vi.fn();
    const { rerender } = render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" initialSection="advanced" onClose={() => {}} />,
    );
    const row = await screen.findByTestId("settings-row-settings-file");
    expect(row.dataset.highlighted).toBeUndefined();
    expect(within(row).queryByTestId("ask-agent")).toBeNull();

    rerender(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        askAgent={{ ready: false, ask: vi.fn(), setUp }}
        onClose={() => {}}
      />,
    );
    expect(within(row).getByText("You have no agent set up.")).toBeTruthy();
    // A search that hides the Agents section must not hold the dialog back.
    await user.type(screen.getByTestId("settings-search"), "json");
    await user.click(within(row).getByRole("button", { name: "Set up an agent" }));
    expect(screen.getByTestId("settings-dialog").dataset.activeSection).toBe("agents");
    expect((screen.getByTestId("settings-search") as HTMLInputElement).value).toBe("");
    expect(setUp).not.toHaveBeenCalled();
  });

  // Main refuses a save or reset until this workspace's engine open has
  // prepared .dohc/local. The person reads why, the control shows what is on
  // disk, and Try again sends the same change.
  it("says why a workspace settings save was refused, and Try again sends it again", async () => {
    const words =
      "dohc did not save this workspace's settings because it can't keep this computer's settings out of iCloud Drive. Restart dohc to try again.";
    const refused = new Error(
      `Error invoking remote method 'desktop:set-workspace-settings': LocalStateUnavailableError: ${words}`,
    );
    bridge.setWorkspaceSettings.mockRejectedValueOnce(refused);
    const onError = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
        onError={onError}
      />,
    );

    const select = await screen.findByTestId("attachment-location-select");
    await user.selectOptions(select, "global-folder");
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(words, refused, expect.any(Function));
    expect(screen.getAllByTestId("settings-warning").map((node) => node.textContent)).toContain(
      `Settings error: ${words}`,
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("per-document"));

    await act(async () => {
      await onError.mock.calls[0]![2]();
    });
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledTimes(2);
    expect(bridge.setWorkspaceSettings).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      patch: { files: { attachmentLocation: "global-folder" } },
    });
  });

  it("says why a workspace settings reset was refused, and Try again resets", async () => {
    const words =
      "dohc did not reset this workspace's settings because the workspace has not finished opening. Try again when it opens.";
    const refused = new Error(
      `Error invoking remote method 'desktop:reset-workspace-settings': LocalStateUnavailableError: ${words}`,
    );
    bridge.resetWorkspaceSettings.mockRejectedValueOnce(refused);
    const onError = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
        onError={onError}
      />,
    );

    await userEvent.setup().click(await screen.findByRole("button", { name: "Reset workspace" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(words, refused, expect.any(Function));
    await act(async () => {
      await onError.mock.calls[0]![2]();
    });
    expect(bridge.resetWorkspaceSettings).toHaveBeenCalledTimes(2);
  });

  it("hands every workspace settings answer to the shell", async () => {
    const onWorkspaceSettingsRead = vi.fn();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
        onWorkspaceSettingsRead={onWorkspaceSettingsRead}
      />,
    );
    await waitFor(() => expect(onWorkspaceSettingsRead).toHaveBeenCalledOnce());
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reset workspace" }));
    await waitFor(() => expect(onWorkspaceSettingsRead).toHaveBeenCalledTimes(2));
  });

  it("persists an edited attachment folder name", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    const input = await screen.findByTestId("attachment-folder-input");
    await user.clear(input);
    await user.type(input, "media");
    await waitFor(() =>
      expect(bridge.setWorkspaceSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        patch: { files: { attachmentFolderName: "media" } },
      }),
    );
  });
});
