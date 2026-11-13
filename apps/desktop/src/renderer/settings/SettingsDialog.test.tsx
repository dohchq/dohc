// @vitest-environment jsdom
import { desktopPins, settingsSectionPin } from "../../testPins";
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import { overlaySettings } from "../../settings/settingsFile";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsResult,
} from "../../workspaces/workspaceSettings";
import { pushOverlay, removeOverlay } from "../overlayStack";
import { Overlay } from "../Overlay";
import type { ScheduleHostResult, UpdateStateEvent } from "../../ipc/bridgeContract";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { SettingsDialog } from "./SettingsDialog";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";

import { applyLookSettings } from "../theme";
import { CUSTOMIZE_TARGETS } from "./customize";
import { settingsWithAgent, testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { useInstallationNotices } from "../shell/installationNotices";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";

// The workspace shell provides the session in production.
const render = (ui: ReactElement, options?: RenderOptions) =>
  renderUi(ui, {
    wrapper: ({ children }) => (
      <WorkspaceSessionProvider workspaceId="fixture">{children}</WorkspaceSessionProvider>
    ),
    ...options,
  });

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
const availableUpdateState = {
  status: "available" as const,
  message: "dohc 1.2.4 is available.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: false,
  canInstall: false,
  version: "1.2.4",
};
const readyUpdateState = {
  status: "ready" as const,
  message: "Update 1.2.4 is ready. Restart dohc to install it.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
};
type SettingsUpdateState = UpdateStateEvent;
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
  const row: AccessShareRow =
    lane === "granted"
      ? {
          kind: "share",
          shareId: "share-plan",
          grantId: "grant-1",
          via: "named",
          granterUserId: "me",
          granterEmail: null,
          recipientUserId: "sam",
          recipientEmail: "sam@example.com",
          subjectName: null,
          sharerName: null,
          selector: { paths: ["notes/product-plan.md"], versionId: null },
          access: "edit",
          status: "active",
          generation: 1,
        }
      : {
          kind: "share",
          shareId: "share-funnel",
          grantId: "grant-2",
          via: "received",
          granterUserId: "sam",
          granterEmail: "sam@example.com",
          recipientUserId: "me",
          recipientEmail: null,
          subjectName: "funnel.csv",
          sharerName: "Sam",
          selector: { paths: ["data/funnel.csv"], versionId: null },
          access: "view",
          status: "active",
          generation: 1,
        };
  return {
    ref: null,
    rows: [row],
    visibility: "visible",
    unknownReason: null,
    coverage: {
      kind: lane === "granted" ? "granted" : "received-account",
      complete: true,
      observation: "interval",
    },
    checkedAtMs: 1,
    freshness: "fresh",
    nextCursor: null,
  };
}

const bridge = {
  onWorkspaceActivity: vi.fn(() => () => {}),
  listChatChannels: vi.fn(async () => ({ channels: [], fileThreads: [] })),
  readDiagnostics: vi.fn(async () => ({
    text: "dohc diagnostics",
    available: { usage: false, errors: false },
  })),
  readUsageRecord: vi.fn(async () => ({
    status: "readable",
    enabled: true,
    file: "/state/dohc-usage.json",
    since: null,
    incompleteDays: 0,
    rows: [],
  })),
  requestAccessRefresh: vi.fn(async () => undefined),
  listSharingAccess: vi.fn(
    async ({ lane }: { workspaceId: string; lane: "granted" | "received" }) => sharingAnswer(lane),
  ),
  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
  listSites: vi.fn(async (_payload: { workspaceId: string }) => ({ sites: [] as unknown[] })),
  detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
  getMcpConfig: vi.fn(getDefaultMcpConfig),
  getAgentRunStatus: vi.fn(async () => ({
    activeRun: runActive
      ? {
          id: "run-1",
          startedAt: 1,
          agentId: "terminal",
          onBehalfOf: "local",
          status: "running" as const,
        }
      : null,
    lastRun: null,
  })),
  startAgentRun: vi.fn(async () => {
    runActive = true;
    return {
      id: "run-1",
      startedAt: 1,
      agentId: "terminal",
      onBehalfOf: "local",
      status: "running" as const,
    };
  }),
  endAgentRun: vi.fn(async () => {
    runActive = false;
  }),
  runnerSelfTest: vi.fn(async () => ({ ok: true, detail: "self-test ok" })),
  readChatDispatchPaused: vi.fn(async () => ({ paused: false })),
  setChatDispatchPaused: vi.fn(async () => undefined),
  onChatDispatchPaused: vi.fn(() => () => undefined),
  readAgentsListening: vi.fn(async () => ({ agentIds: [] })),
  onAgentsListening: vi.fn(() => () => undefined),
  readPersonalAgents: vi.fn(async () => ({ accounts: [] })),
  onPersonalAgents: vi.fn(() => () => undefined),
  changePersonalAgent: vi.fn(async () => ({ ok: true, personalAgents: { accounts: [] } })),
  getUpdateState: vi.fn(async (): Promise<SettingsUpdateState> =>
    updateReady ? readyUpdateState : idleUpdateState,
  ),
  checkForUpdates: vi.fn(
    async (): Promise<{
      checked: boolean;
      state: SettingsUpdateState;
    }> => ({ checked: true, state: availableUpdateState }),
  ),
  downloadUpdate: vi.fn(async (): Promise<{ accepted: boolean; state: SettingsUpdateState }> => {
    updateReady = true;
    return { accepted: true, state: readyUpdateState };
  }),
  installUpdate: vi.fn(
    async (): Promise<{
      accepted: boolean;
      reason?: string;
      state: SettingsUpdateState;
    }> => ({
      accepted: updateReady,
      state: updateReady ? readyUpdateState : idleUpdateState,
    }),
  ),
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
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    trusted: workspaceTrusted,
  })),
  requestWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    trusted: workspaceTrusted,
  })),
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

const writeText = vi.fn(async (_text: string) => {});

// Copy MCP config and the run sit on the page of an agent you run, so a test of either lists one.
const listAgentYouRun = () =>
  bridge.getUserSettings.mockImplementation(async () => ({
    settings: {
      ...DEFAULT_USER_SETTINGS,
      agents: {
        terminal: {
          name: "Terminal",
          hue: "rose",
          changesFiles: true,
          enabled: false,
          timeoutMinutes: 30,
        },
      },
    },
    source: "stored",
  }));
// A row opens its agent's page, where its controls are.
const openAgent = async (name: string) =>
  fireEvent.click(await screen.findByRole("button", { name }));
const copyMcpConfig = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Copy MCP config" });
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
  bridge.getUserSettings.mockImplementation(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "default",
  }));
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
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="privacy"
        onClose={() => {}}
      />,
    );
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
    await waitFor(() =>
      expect(
        within(control).getByRole("radio", { name: "Trusted" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );

    await userEvent.click(restricted);
    expect(bridge.restrictWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    await waitFor(() => expect(restricted.getAttribute("aria-checked")).toBe("true"));
  });

  it("has no trust row in a shared view", async () => {
    render(
      <SettingsDialog
        workspaceIsReady
        sharedView
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="privacy"
        onClose={() => {}}
      />,
    );
    await screen.findByTestId(settingsSectionPin("privacy"));
    expect(screen.queryByTestId("settings-row-workspace-trust")).toBeNull();
    expect(bridge.readWorkspaceTrust).not.toHaveBeenCalled();
  });

  it("shows a failed-open state instead of loading workspace settings", async () => {
    const props = {
      workspaceId: "ws-1",
      workspacePath: "/x",
      initialSection: "agents" as const,
      workspaceIsReady: false,
      workspaceOpenFailed: true,
      onClose: vi.fn(),
    };
    render(<SettingsDialog {...props} />);
    expect(
      screen.getByText("Couldn’t open this workspace. Close Settings to try again."),
    ).toBeTruthy();
    expect(screen.queryByText("Loading settings...")).toBeNull();
    await waitFor(() => expect(bridge.getUserSettings).toHaveBeenCalled());
    expect(bridge.getWorkspaceSettings).not.toHaveBeenCalled();
    expect(bridge.getMcpConfig).not.toHaveBeenCalled();
    expect(bridge.getAgentRunStatus).not.toHaveBeenCalled();
  });

  it.each(["agents"] as const)(
    "holds the %s section and workspace search until admission",
    async (initialSection) => {
      const onError = vi.fn();
      const props = {
        workspaceId: "ws-1",
        workspacePath: "/x",
        initialSection,
        onClose: vi.fn(),
        onError,
        onOpenSharing: vi.fn(),
      };
      const view = render(<SettingsDialog {...props} workspaceIsReady={false} />);
      await waitFor(() => expect(bridge.getUserSettings).toHaveBeenCalled());
      expect(bridge.getWorkspaceSettings).not.toHaveBeenCalled();
      expect(bridge.getMcpConfig).not.toHaveBeenCalled();
      expect(bridge.getAgentRunStatus).not.toHaveBeenCalled();
      expect(bridge.readScheduleHost).not.toHaveBeenCalled();
      expect(bridge.listSites).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Search settings"), {
        target: { value: initialSection },
      });
      expect(bridge.requestAccessRefresh).not.toHaveBeenCalled();
      expect(bridge.listSharingAccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(screen.getByText("Loading settings...")).toBeTruthy();
      view.rerender(<SettingsDialog {...props} workspaceIsReady />);
      await waitFor(() => expect(bridge.getWorkspaceSettings).toHaveBeenCalledOnce());
      if (initialSection === "agents")
        await waitFor(() => expect(bridge.getMcpConfig).toHaveBeenCalledOnce());
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("renders the settings shell, searches sections, and shows an empty search state", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />,
    );

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

  describe("an edit in place", () => {
    const renderAgents = (onClose: () => void) => {
      bridge.getUserSettings.mockResolvedValueOnce({
        settings: settingsWithAgent({ name: "Nova" }),
        source: "stored",
      });
      render(
        <Overlay onClose={onClose}>
          <SettingsDialog
            workspaceIsReady
            workspaceId="ws-1"
            workspacePath="/x"
            initialSection="agents"
            onClose={onClose}
          />
        </Overlay>,
      );
    };
    const editCommand = async (user: ReturnType<typeof userEvent.setup>) => {
      await openAgent("Nova");
      await user.click(screen.getByRole("button", { name: "Change the command that starts Nova" }));
      return screen.getByRole("textbox", { name: "Command that starts Nova" });
    };

    it("takes the first Escape in an agent's command, keeping the old one, and Settings closes on the next", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderAgents(onClose);
      const command = await editCommand(user);
      await user.type(command, " --verbose");
      bridge.setUserSettings.mockClear();
      await user.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox", { name: "Command that starts Nova" })).toBeNull();
      expect(screen.getByText("node agent.mjs")).toBeTruthy();
      expect(bridge.setUserSettings).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes nothing on an Escape that ends an input method's composition", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderAgents(onClose);
      const command = await editCommand(user);
      fireEvent.keyDown(command, { key: "Escape", isComposing: true });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Command that starts Nova" })).toBe(command);
    });
  });

  describe("a press outside Settings", () => {
    const backdrop = () => document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!;
    const renderInOverlay = (onClose: () => void, initialSection: "general" | "agents") =>
      render(
        <Overlay onClose={onClose}>
          <SettingsDialog
            workspaceIsReady
            workspaceId="ws-1"
            workspacePath="/x"
            initialSection={initialSection}
            onClose={onClose}
          />
        </Overlay>,
      );

    it("stays open on a name it refuses, with the field focused", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderInOverlay(onClose, "general");
      const field = await screen.findByTestId("general-preferred-name-input");
      await user.click(field);
      await user.paste("Sam");
      bridge.setUserSettings.mockClear();
      await user.click(backdrop());
      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field);
      expect(screen.getByRole("alert").textContent).toBe(
        "Names cannot contain control characters.",
      );
      expect(bridge.setUserSettings).not.toHaveBeenCalled();
    });

    // Applies a look with this accent, and answers the accent the window shows.
    const look = (accentColor: string) => {
      applyLookSettings({
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, accentColor },
      });
      return document.documentElement.style.getPropertyValue("--dohc-accent");
    };
    // Settings that unmounts once it closes, as the shell's does, beside the
    // installation notices a write it cut off reports to.
    const renderClosable = (initialSection: "general" | "appearance" | "advanced" | "agents") => {
      const onError = vi.fn();
      const report = vi.fn<(error: ConnectionErrorReport) => void>();
      function Notices() {
        useInstallationNotices(report);
        return null;
      }
      function Closable() {
        const [open, setOpen] = useState(true);
        const close = () => setOpen(false);
        return open ? (
          <Overlay onClose={close}>
            <SettingsDialog
              workspaceIsReady
              workspaceId="ws-1"
              workspacePath="/x"
              initialSection={initialSection}
              onError={onError}
              onClose={close}
            />
          </Overlay>
        ) : null;
      }
      render(
        <>
          <Notices />
          <Closable />
        </>,
      );
      return { onError, report };
    };

    it("reports a save that fails after Settings closed, and Try again sends it again", async () => {
      const user = userEvent.setup();
      const { onError, report } = renderClosable("general");
      const save = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
      bridge.setUserSettings.mockImplementationOnce(() => save.promise);
      await user.type(await screen.findByTestId("general-preferred-name-input"), "Sam");
      await user.click(backdrop());
      expect(screen.queryByTestId("settings-dialog")).toBeNull();
      const change = bridge.setUserSettings.mock.lastCall![0];
      expect(change.settings.profile).toEqual({ preferredName: "Sam" });

      const cause = new Error("The settings file is read-only.");
      await act(async () => save.reject(cause));

      // The workspace open when the save fails shows it, even after a switch.
      await waitFor(() => expect(report).toHaveBeenCalledOnce());
      expect(onError).not.toHaveBeenCalled();
      const [{ cause: reported, retry }] = report.mock.lastCall!;
      expect(reported).toBe(cause);
      bridge.setUserSettings.mockClear();
      const resent = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
      bridge.setUserSettings.mockImplementationOnce(() => resent.promise);
      await act(async () => expect(retry?.()).toBe(true));
      expect(bridge.setUserSettings).toHaveBeenCalledExactlyOnceWith(change);
      // A look applied while Try again waits stays. Main's broadcast brings the file's.
      const newer = look("#884422");
      await act(async () => resent.resolve({ settings: DEFAULT_USER_SETTINGS, source: "stored" }));
      expect(document.documentElement.style.getPropertyValue("--dohc-accent")).toBe(newer);
      applyLookSettings(DEFAULT_USER_SETTINGS);
    });
  });

  it("leaves Tab and Escape to a higher overlay", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="higher-overlay-action">
          Go back
        </button>
        <Overlay onClose={onClose}>
          <SettingsDialog
            workspaceIsReady
            workspaceId="ws-1"
            workspacePath="/x"
            onClose={onClose}
          />
        </Overlay>
      </>,
    );

    await screen.findByTestId(desktopPins.settingsDialog);
    const higherOverlayAction = screen.getByTestId("higher-overlay-action");
    higherOverlayAction.focus();
    const higherOverlay = Symbol("higher-overlay-test");
    pushOverlay(higherOverlay, () => undefined);
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
      <SettingsDialog
        workspaceIsReady
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

  it("marks a modified setting with a bar and resets it from a labeled button", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        workspaceIsReady
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
    // The bar sits on the card's edge, outside the row's text.
    expect(within(row).getByTitle("Modified").className).toContain("absolute");
    const reset = within(row).getByRole("button", { name: "Reset" });
    expect(reset.textContent).toBe("Reset");
    await user.click(reset);
    expect(bridge.setUserSettings).toHaveBeenLastCalledWith({
      base: expect.any(Object),
      settings: expect.objectContaining({
        appearance: expect.objectContaining({
          themeMode: DEFAULT_USER_SETTINGS.appearance.themeMode,
        }),
      }),
    });
    await waitFor(() => expect(within(row).queryByTitle("Modified")).toBeNull());
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
      <SettingsDialog
        workspaceIsReady
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
      <SettingsDialog
        workspaceIsReady
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

  it("rolls back optimistic appearance changes when save fails", async () => {
    const user = userEvent.setup();
    bridge.setUserSettings.mockRejectedValueOnce(new Error("Disk full"));
    // DesktopRoot has already applied the settings the dialog opens with.
    applyLookSettings(DEFAULT_USER_SETTINGS);
    render(
      <SettingsDialog
        workspaceIsReady
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
      expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error"),
    );
    // The chip must not borrow the document's "your edits are still here",
    // and it owes a next step.
    expect(screen.getByTestId("settings-save-state").getAttribute("title")).toBe(
      "dohc could not save this setting. Try changing it again.",
    );
    expect(document.documentElement.dataset.theme).toBe(initialTheme);
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  });

  it("goes back to the saved settings when a save behind a failed one also fails", async () => {
    const user = userEvent.setup();
    let failFirst: (cause: Error) => void = () => {};
    bridge.setUserSettings
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
            failFirst = reject;
          }),
      )
      .mockRejectedValueOnce(new Error("Disk full"));
    applyLookSettings(DEFAULT_USER_SETTINGS);
    render(
      <SettingsDialog
        workspaceIsReady
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
      expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error");
  });

  it("doesn't replace an agent that came back before Undo", async () => {
    const user = userEvent.setup();
    let file: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      agents: { codex: testAgent({ name: "Codex" }), default: testAgent({ name: "Nova" }) },
    };
    const read = async (): Promise<DesktopUserSettingsResult> => ({
      settings: file,
      source: "stored",
    });
    const orderAgents = vi.fn(async (_payload: { order: string[] }) => read());
    vi.stubGlobal("dohcDesktop", {
      ...bridge,
      getUserSettings: read,
      setUserSettings: async ({
        settings,
        base,
      }: {
        settings: DesktopUserSettings;
        base: DesktopUserSettings;
      }) => {
        file = overlaySettings({ ...file }, base, settings) as DesktopUserSettings;
        return read();
      },
      orderAgents,
      detectAgentTools: async () => ({
        workingDirectory: "/workspace",
        tools: [
          {
            tool: "codex",
            executable: "/bin/codex",
            version: "0.98",
            auth: "signed-in",
            probe: "detected",
          },
        ],
      }),
    });
    const onError = vi.fn();
    const onNotice = vi.fn<(message: string, undo?: () => void) => void>();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onNotice={onNotice}
        onClose={() => {}}
      />,
    );
    await openAgent("Codex");
    await user.click(screen.getByRole("button", { name: "Remove Codex…" }));
    await user.click(
      within(screen.getByTestId("remove-agent-dialog")).getByRole("button", {
        name: "Remove agent",
      }),
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)),
    );
    await user.click(await screen.findByTestId("agent-add"));
    await user.click(screen.getByTestId("agent-runs-with-codex"));
    await user.click(screen.getByTestId("agent-add-confirm"));
    await waitFor(() =>
      expect(file.agents.codex?.launch).toEqual({ tool: "codex", executable: "/bin/codex" }),
    );
    const added = file.agents.codex;

    await act(async () => onNotice.mock.calls[0]![1]!());
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Undo didn't replace the new Codex, so the one you removed stays removed.",
      ),
    );
    expect(file.agents.codex).toEqual(added);
    expect(Object.keys(file.agents)).toEqual(["default", "codex"]);
    expect(orderAgents).not.toHaveBeenCalled();
  });

  // sharedView is a synchronous prop, but sessionRecorderOn only resolves
  // once main's openWorkspace status arrives. In that window a shared view
  // already knows it has no chat to test, so Check must not wait on it.
  it("turns Check off in a shared view before the recorder status resolves", async () => {
    const user = userEvent.setup();
    bridge.getUserSettings.mockResolvedValueOnce({
      settings: settingsWithAgent({ name: "Nova" }),
      source: "stored",
    });
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sharedView
        onClose={() => {}}
      />,
    );

    await openAgent("Nova");
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Send test" });
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  it("offers no Shared by me result in a shared view", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        sharedView
        onOpenSharing={() => {}}
        onClose={() => {}}
      />,
    );

    await user.type(await screen.findByTestId(desktopPins.settingsSearch), "shared");
    const results = await screen.findByTestId("settings-sharing-results");
    expect(
      within(results)
        .getAllByTestId("settings-sharing-result")
        .map((result) => result.dataset.lane),
    ).toEqual(["received"]);
    expect(bridge.listSharingAccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "granted" }),
    );
  });

  it("keeps a stopped run's retry bound to its ID when another run starts", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    bridge.endAgentRun.mockImplementationOnce(async () => {
      runActive = false;
      throw new Error(
        "Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.",
      );
    });
    listAgentYouRun();
    const view = render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await openAgent("Terminal");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    bridge.getAgentRunStatus.mockResolvedValueOnce({
      activeRun: {
        id: "run-new",
        startedAt: 2,
        agentId: "terminal",
        onBehalfOf: "local",
        status: "running",
      },
      lastRun: null,
    });
    await act(async () => {
      await onError.mock.calls[0]?.[2]();
    });
    expect(bridge.endAgentRun).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1", runId: "run-1" });
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    view.unmount();
  });

  it("retries only the read after a successful start", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    listAgentYouRun();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await openAgent("Terminal");
    await mcpConfigLoaded();
    bridge.startAgentRun.mockImplementationOnce(async () => {
      runActive = true;
      bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
      return {
        id: "run-1",
        startedAt: 1,
        agentId: "terminal",
        onBehalfOf: "local",
        status: "running" as const,
      };
    });
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await act(async () => {
      await onError.mock.calls[0]?.[2]();
    });
    expect(bridge.startAgentRun).toHaveBeenCalledTimes(1);
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
  });

  it("keeps Retry from racing a refused stop's pending recovery read", async () => {
    runActive = true;
    const user = userEvent.setup();
    const onError = vi.fn();
    const cause = new Error(
      "This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.",
    );
    listAgentYouRun();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onError={onError}
        onClose={() => {}}
      />,
    );
    await openAgent("Terminal");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    const recovery = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.endAgentRun.mockRejectedValueOnce(cause);
    bridge.getAgentRunStatus
      .mockImplementationOnce(async () => ({
        activeRun: {
          id: "run-1",
          startedAt: 1,
          agentId: "terminal",
          onBehalfOf: "local",
          status: "running" as const,
        },
        lastRun: null,
      }))
      .mockImplementationOnce(() => recovery.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledExactlyOnceWith(cause.message, cause, expect.any(Function)),
    );
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
        activeRun: {
          id: "run-1",
          startedAt: 1,
          agentId: "terminal",
          onBehalfOf: "local",
          status: "running",
        },
        lastRun: null,
      });
      await recovery.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("mcp-load-error").textContent).toBe("Retry");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(screen.queryByTestId("mcp-load-error")).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not let an old workspace's late Retry re-enable a new workspace's pending toggle", async () => {
    const user = userEvent.setup();
    const props = { workspacePath: "/x", initialSection: "agents" as const, onClose: () => {} };
    bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
    listAgentYouRun();
    const view = render(<SettingsDialog workspaceIsReady workspaceId="ws-1" {...props} />);
    await openAgent("Terminal");
    await screen.findByTestId("mcp-load-error");
    const oldRetryRead = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    bridge.getAgentRunStatus.mockImplementationOnce(() => oldRetryRead.promise);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    view.rerender(<SettingsDialog workspaceIsReady workspaceId="ws-2" {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false),
    );
    const starting = deferred<Awaited<ReturnType<typeof bridge.startAgentRun>>>();
    bridge.startAgentRun.mockImplementationOnce(() => starting.promise);
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() =>
      expect(bridge.startAgentRun).toHaveBeenCalledWith({
        workspaceId: "ws-2",
        agentId: "terminal",
      }),
    );
    await act(async () => {
      oldRetryRead.resolve({ activeRun: null, lastRun: null });
      await oldRetryRead.promise;
    });
    expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(true);
    await act(async () => {
      runActive = true;
      starting.resolve({
        id: "run-1",
        startedAt: 1,
        agentId: "terminal",
        onBehalfOf: "local",
        status: "running",
      });
      await starting.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("mcp-enable-toggle").hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running");
  });

  it("ignores in-flight MCP config responses after switching workspaces", async () => {
    // Delay ws-old and resolve it only after rerendering ws-new; if cancellation
    // fails, the old config overwrites the one Copy MCP config copies.
    const user = userEvent.setup();
    stubClipboard();
    listAgentYouRun();
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
        <SettingsDialog
          workspaceIsReady
          workspaceId="ws-old"
          workspacePath="/old"
          initialSection="agents"
          onClose={() => {}}
        />,
      );
      await openAgent("Terminal");
      await waitFor(() =>
        expect(bridge.getMcpConfig).toHaveBeenCalledWith({ workspaceId: "ws-old" }),
      );

      view.rerender(
        <SettingsDialog
          workspaceIsReady
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

  it("refreshes stale stopped UI before toggling so it cannot stop a run behind a Start label", async () => {
    const user = userEvent.setup();
    listAgentYouRun();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    await openAgent("Terminal");
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

  it("checks for updates, downloads only when asked, then restarts", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />,
    );
    await screen.findByTestId("desktop-updates-status");
    const step = () => screen.getByTestId("desktop-updates-step");
    expect(step().textContent).toBe("Check for updates");

    await user.click(step());
    await waitFor(() => expect(step().textContent).toBe("Update"));
    expect(screen.getByTestId("desktop-updates-status").textContent).toBe(
      "dohc 1.2.4 is available.",
    );
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();

    await user.click(step());
    await waitFor(() => expect(step().textContent).toBe("Restart to update"));
    expect(bridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(bridge.installUpdate).not.toHaveBeenCalled();

    await user.click(step());
    await waitFor(() => expect(step().textContent).toBe("Restarting…"));
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
    expect(step().hasAttribute("disabled")).toBe(true);
  });

  it("shows a failed check in the status line and offers the check again", async () => {
    bridge.checkForUpdates.mockResolvedValueOnce({
      checked: true,
      state: {
        ...idleUpdateState,
        status: "error",
        message: "feed returned 500",
        failure: { step: "check", id: 1 },
      },
    });
    const user = userEvent.setup();
    render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />,
    );
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("desktop-updates-step"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toBe(
        "dohc could not check for updates. feed returned 500",
      ),
    );
    const step = screen.getByTestId("desktop-updates-step");
    expect(step.textContent).toBe("Check for updates");
    expect(step.hasAttribute("disabled")).toBe(false);
  });

  it("keeps subscription state when the initial update fetch resolves later", async () => {
    let pushUpdate: ((state: typeof readyUpdateState) => void) | undefined;
    const pending = deferred<typeof idleUpdateState>();
    bridge.getUpdateState.mockImplementationOnce(() => pending.promise);
    const onUpdateStateMock = bridge.onUpdateState as unknown as {
      mockImplementationOnce(
        implementation: (listener: (state: typeof readyUpdateState) => void) => () => void,
      ): void;
    };
    onUpdateStateMock.mockImplementationOnce((listener) => {
      pushUpdate = listener;
      return () => undefined;
    });
    render(
      <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />,
    );

    if (!pushUpdate) throw new Error("Update subscription was not registered.");
    pushUpdate(readyUpdateState);
    pending.resolve(idleUpdateState);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe("ready"),
    );
  });

  it("shows why a Linux .deb did not install, and the command that installs it beside its copy", async () => {
    updateReady = true;
    const reason = "dohc did not get permission. Run this command in a terminal to install it.";
    const installCommand =
      "sudo apt install '/home/sam/.cache/dohc-updater/pending/dohc-1.2.4-linux-amd64.deb'";
    bridge.installUpdate.mockResolvedValueOnce({
      accepted: false,
      reason,
      state: {
        ...readyUpdateState,
        message: reason,
        installCommand,
        failure: { step: "install", id: 1 },
      },
    });
    const report = vi.fn<ReportShellFailure>();
    const user = userEvent.setup();
    render(
      <ShellErrorReporter.Provider value={report}>
        <SettingsDialog workspaceIsReady workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />
      </ShellErrorReporter.Provider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe("ready"),
    );
    expect(screen.queryByTestId("desktop-updates-install-command")).toBeNull();

    await user.click(screen.getByTestId("desktop-updates-step"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toBe(
        `dohc could not install version 1.2.4. ${reason}`,
      ),
    );
    expect(screen.getByTestId("desktop-updates-install-command").textContent).toBe(installCommand);
    expect(
      screen.getByTestId("desktop-updates-install-command-copy").getAttribute("aria-label"),
    ).toBe("Copy install command");
    expect(screen.getByTestId("desktop-updates-step").textContent).toBe("Restart to update");
    // Main reported it in the state; the shell's notices show it from there.
    expect(report).not.toHaveBeenCalled();
  });

  // The text of the path that describes one attachment location radio.
  const examplePath = (location: string) =>
    document.getElementById(
      screen.getByTestId(`attachment-location-${location}`).getAttribute("aria-describedby")!,
    )?.textContent;

  it("persists the attachment location and shows where each choice saves", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    const group = await screen.findByRole("radiogroup", { name: "Attachment location" });
    const radio = (name: string) => within(group).getByRole("radio", { name });
    expect(radio("In a folder beside the document").getAttribute("aria-checked")).toBe("true");
    // Each choice is described by the path a paste writes.
    expect(examplePath("per-document")).toBe("Trips/Lisbon/assets/photo.png");
    expect(examplePath("global-folder")).toBe("assets/photo.png");
    expect(examplePath("same-folder")).toBe("Trips/Lisbon/photo.png");

    await user.click(radio("In one folder for the whole workspace"));
    // The save carries the changed control only — main merges it onto the
    // file, so the dialog's copy of the other fields never rides along.
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      patch: { files: { attachmentLocation: "global-folder" } },
    });

    // The arrow keys move the choice. Beside the document uses no folder, so
    // the folder name stays in place but cannot be edited.
    await user.keyboard("{ArrowDown}");
    expect(bridge.setWorkspaceSettings).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      patch: { files: { attachmentLocation: "same-folder" } },
    });
    const input = screen.getByTestId("attachment-folder-input") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Not used when images go beside the document.",
    );
  });

  it("saves and resets the default app preview mode, and says what each mode does", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="apps"
        onClose={() => {}}
      />,
    );

    const control = await screen.findByTestId("site-preview-mode-control");
    expect(
      within(control)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Auto", "Dev", "Build", "Static"]);
    const row = screen.getByTestId("settings-row-site-preview-mode");
    expect(row.textContent).toContain("Dev when an app has a dev script.");

    await user.click(within(control).getByRole("radio", { name: "Static" }));
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      patch: { sites: { defaultPreviewMode: "static" } },
    });
    await waitFor(() =>
      expect(row.textContent).toContain("Shows each app's files without running commands."),
    );
    await waitFor(() => expect(row.textContent).toContain("Modified"));
    await user.click(within(row).getByRole("button", { name: "Reset" }));
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
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByTestId("attachment-location-global-folder"));

    await waitFor(() =>
      expect(screen.getAllByTestId("settings-warning").map((node) => node.textContent)).toContain(
        refusal,
      ),
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error");
    expect(screen.getByTestId("settings-save-state").textContent).not.toContain("Saved");
    // The control snaps back to what is really on disk instead of showing an
    // edit that never landed.
    await waitFor(() =>
      expect(
        screen.getByTestId("attachment-location-per-document").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  // Each control saves on its own, and main merges each patch onto the file.
  // An earlier edit must therefore survive the next one — the assertion that
  // keeps the fake settings file above honest about what the real save does.
  it("keeps an earlier edit when the next control is saved", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByTestId("attachment-location-global-folder"));
    const input = await screen.findByTestId("attachment-folder-input");
    await user.clear(input);
    await user.type(input, "media");

    await waitFor(() => expect((input as HTMLInputElement).value).toBe("media"));
    expect(
      screen.getByTestId("attachment-location-global-folder").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("marks and focuses the part a Customize… command opened Settings for", async () => {
    render(
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection={CUSTOMIZE_TARGETS.sidebar.section}
        focus={CUSTOMIZE_TARGETS.sidebar}
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-sidebar");
    expect(row.dataset.highlighted).toBe("true");
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("group", { name: "Sidebar" })).toBe(row);
    expect(screen.getByTestId("settings-row-theme").dataset.highlighted).toBeUndefined();
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
      <SettingsDialog
        workspaceIsReady
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="files"
        onClose={() => {}}
        onError={onError}
      />,
    );

    await user.click(await screen.findByTestId("attachment-location-global-folder"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(words, refused, expect.any(Function));
    expect(screen.getAllByTestId("settings-warning").map((node) => node.textContent)).toContain(
      `Settings error: ${words}`,
    );
    expect(screen.getByTestId("settings-save-state").getAttribute("data-state")).toBe("error");
    await waitFor(() =>
      expect(
        screen.getByTestId("attachment-location-per-document").getAttribute("aria-checked"),
      ).toBe("true"),
    );

    await act(async () => {
      await onError.mock.calls[0]![2]();
    });
    expect(bridge.setWorkspaceSettings).toHaveBeenCalledTimes(2);
    expect(bridge.setWorkspaceSettings).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      patch: { files: { attachmentLocation: "global-folder" } },
    });
  });
});
