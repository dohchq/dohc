// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { DesktopSettings } from "./DesktopSettings";

const config = {
  command: "dohc-mcp",
  args: ["--workspace", "/home/ice/dohc/personal", "--home", "/state/home"],
  workspacePath: "/home/ice/dohc/personal",
  home: "/state/home",
};

let mcpEnabled = false;
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
  message: "Update 1.2.4 is ready — restart dohc to apply it.",
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

const bridge = {
  getMcpConfig: vi.fn(getDefaultMcpConfig),
  getAgentRunStatus: vi.fn(async () => ({
    mcpEnabled,
    activeRun: mcpEnabled ? { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const } : null,
    lastRun: null,
  })),
  startAgentRun: vi.fn(async () => {
    mcpEnabled = true;
    return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
  }),
  endAgentRun: vi.fn(async () => {
    mcpEnabled = false;
  }),
  runnerSelfTest: vi.fn(async () => ({ ok: true, detail: "self-test ok" })),
  probeAgentDrivers: vi.fn(async () => ({
    drivers: [
      {
        id: "codex",
        displayName: "Codex",
        installed: true,
        version: "codex 1.0",
        auth: { status: "unknown" as const, label: "CLI login" },
        models: [],
      },
      {
        id: "claude-acp",
        displayName: "Claude",
        installed: false,
        auth: { status: "unknown" as const },
        models: [],
      },
    ],
    session: null,
  })),
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
    completed: boolean;
    state: SettingsUpdateState;
  }> => ({
    accepted: updateReady,
    completed: false,
    state: updateReady ? readyUpdateState : idleUpdateState,
  })),
  onUpdateState: vi.fn(() => () => {}),
  listPlugins: vi.fn(async () => ({ ok: true as const, plugins: [] })),
  installPlugin: vi.fn(),
  disablePlugin: vi.fn(),
  enablePlugin: vi.fn(),
  approvePlugin: vi.fn(),
  pluginUninstallPreflight: vi.fn(),
  uninstallPlugin: vi.fn(),
  onPluginStatusChanged: vi.fn(() => () => {}),
  getUserSettings: vi.fn(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "default" as const,
  })),
  setUserSettings: vi.fn(async (payload: { settings: typeof DEFAULT_USER_SETTINGS }) => ({
    settings: payload.settings,
    source: "stored" as const,
  })),
  resetUserSettings: vi.fn(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "stored" as const,
  })),
  getWorkspaceSettings: vi.fn(readWorkspaceSettings),
  setWorkspaceSettings: vi.fn(writeWorkspaceSettings),
  resetWorkspaceSettings: vi.fn(resetWorkspaceSettings),
  writeClipboardText: vi.fn(async (_payload: { text: string }) => undefined),
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

const writeText = vi.fn(async () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stubClipboard() {
  // navigator.clipboard is a getter-only property in jsdom; define it. Call
  // AFTER userEvent.setup() so our spy isn't shadowed by userEvent's own stub.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  mcpEnabled = false;
  updateReady = false;
  // vi.clearAllMocks() clears calls, not implementations: restore the fake
  // file and the default reads so one test cannot leak into the next.
  workspaceSettingsOnDisk = DEFAULT_WORKSPACE_SETTINGS;
  bridge.getWorkspaceSettings.mockImplementation(readWorkspaceSettings);
  bridge.setWorkspaceSettings.mockImplementation(writeWorkspaceSettings);
  bridge.resetWorkspaceSettings.mockImplementation(resetWorkspaceSettings);
  document.documentElement.dataset.theme = "";
  document.documentElement.dataset.density = "";
  document.documentElement.dataset.reduceMotion = "";
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopSettings", () => {
  it("renders the settings shell, searches sections, and shows an empty search state", async () => {
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    expect(screen.getByTestId("settings-section-general")).toBeTruthy();
    await user.type(screen.getByTestId("settings-search"), "theme");
    expect(screen.getByTestId("settings-section-appearance")).toBeTruthy();
    await user.clear(screen.getByTestId("settings-search"));
    await user.type(screen.getByTestId("settings-search"), "nothing-here");
    expect(screen.getByTestId("settings-empty-search")).toBeTruthy();
  });

  it("no longer carries plugins — they live in the activity bar", async () => {
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    await user.type(await screen.findByTestId("settings-search"), "uninstall");

    expect(screen.queryByTestId("settings-nav-plugins")).toBeNull();
    expect(screen.queryByTestId("settings-section-plugins")).toBeNull();
    expect(screen.getByTestId("settings-empty-search")).toBeTruthy();
  });

  it("closes from Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={onClose} />);

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("persists appearance changes and applies them immediately", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(bridge.setUserSettings).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: "dark" }),
      }),
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(bridge.setTitlebarTheme).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("shows the window zoom as a percentage and steps it through settings", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
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
      <DesktopSettings
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

  it("a zoom broadcast during the initial load is not painted over by it", async () => {
    // The initial Promise.all retains a user-settings snapshot; a zoom pushed
    // while it is in flight is NEWER and must survive the load resolving.
    let pushUserSettings: ((result: DesktopUserSettingsResult) => void) | undefined;
    bridge.onUserSettingsChanged.mockImplementationOnce((listener) => {
      pushUserSettings = listener;
      return () => undefined;
    });
    const load = deferred<Awaited<ReturnType<typeof bridge.getUserSettings>>>();
    bridge.getUserSettings.mockImplementationOnce(() => load.promise);
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      if (!pushUserSettings) {
        throw new Error("User settings subscription was not registered.");
      }
    });
    pushUserSettings?.({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 },
      },
      source: "stored",
    });
    load.resolve({ settings: DEFAULT_USER_SETTINGS, source: "default" });

    const row = await screen.findByTestId("settings-row-zoom");
    await waitFor(() => expect(row.textContent).toContain("144%"));
    // The load's callback proves it ran to completion through its
    // applyAppearanceSettings side effect — the titlebar mirror fires
    // unconditionally right after the guarded repaint line. Waiting on it
    // (not a timer) guarantees the stale repaint had its chance.
    await waitFor(() => expect(bridge.setTitlebarTheme).toHaveBeenCalled());
    expect(row.textContent).toContain("144%");
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
      <DesktopSettings
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
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="general"
        onClose={() => {}}
      />,
    );

    const input = await screen.findByTestId("general-preferred-name-input");
    await user.type(input, "Ice");
    expect(screen.getByTestId("general-preferred-name-preview").textContent).toContain(
      "Ice's agent",
    );
    await user.tab();

    await waitFor(() =>
      expect(bridge.setUserSettings).toHaveBeenCalledWith({
        settings: expect.objectContaining({ profile: { preferredName: "Ice" } }),
      }),
    );
  });

  it("cancels a preferred-name edit without saving or closing settings", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <DesktopSettings
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

  it("rolls back optimistic appearance changes when save fails", async () => {
    const user = userEvent.setup();
    bridge.setUserSettings.mockRejectedValueOnce(new Error("Disk full"));
    render(
      <DesktopSettings
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
    expect(document.documentElement.dataset.theme).toBe(initialTheme);
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("supports arrow-key navigation inside segmented appearance controls", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
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
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: "light" }),
      }),
    });
  });

  it("shows the workspace path, a copyable MCP config snippet, and usage examples", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/home/ice/dohc/personal"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    const snippet = await screen.findByTestId("mcp-config-snippet");
    // The snippet is the literal config the user pastes into their AI tool.
    expect(snippet.textContent).toContain('"mcpServers"');
    expect(snippet.textContent).toContain("dohc-mcp");
    expect(snippet.textContent).toContain("/home/ice/dohc/personal");
    // Usage examples are present.
    expect(screen.getByText(/Create a finance app/i)).toBeTruthy();
    expect(screen.getByTestId("agent-setup-guide")).toBeTruthy();
    const probes = await screen.findAllByTestId("agent-probe-row");
    expect(probes).toHaveLength(2);
    expect(probes[0]?.textContent).toContain("Installed · sign-in not verified");
    expect(probes[1]?.textContent).toContain("Not found");
  });

  it("does not claim an enabled MCP server is connected", async () => {
    mcpEnabled = true;
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    expect((await screen.findByTestId("agent-setup-status")).textContent).toContain(
      "Needs setup",
    );
    expect(screen.getByTestId("agent-setup-mcp-action").textContent).toContain(
      "MCP enabled · copy config below",
    );
  });

  it("shows the trusted runner controls and persists command, toggle, and timeout", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    const command = await screen.findByTestId("runner-command-input");
    expect(command.getAttribute("placeholder")).toContain("Bash(dohc chat:*)");
    expect(screen.getByText(/unsandboxed runner can read anything/i)).toBeTruthy();
    expect(screen.getByTestId("runner-multi-device-note").textContent).toContain(
      "Enable the runner on one device per workspace",
    );
    await user.type(command, "codex exec --sandbox workspace-write");
    await user.click(screen.getByRole("switch", { name: "Enable chat runner" }));

    const timeout = screen.getByTestId("runner-timeout-input");
    await user.clear(timeout);
    await user.type(timeout, "45");
    await user.tab();

    await waitFor(() =>
      expect(bridge.setUserSettings).toHaveBeenLastCalledWith({
        settings: expect.objectContaining({
          runner: {
            command: "codex exec --sandbox workspace-write",
            enabled: true,
            timeoutMinutes: 45,
          },
        }),
      }),
    );
    expect(
      screen.getByTestId("runner-configuration-status").getAttribute("data-state"),
    ).toBe("active");
  });

  it("keeps runner enable disabled until the command draft is non-empty", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    const command = await screen.findByTestId("runner-command-input");
    const enable = screen.getByRole("switch", { name: "Enable chat runner" });
    expect(enable.getAttribute("disabled")).not.toBeNull();
    await user.type(command, "   ");
    expect(enable.getAttribute("disabled")).not.toBeNull();
    expect(bridge.setUserSettings).not.toHaveBeenCalled();

    await user.type(command, "codex exec");
    expect(enable.getAttribute("disabled")).toBeNull();
    await user.click(enable);

    await waitFor(() =>
      expect(bridge.setUserSettings).toHaveBeenCalledWith({
        settings: expect.objectContaining({
          runner: {
            // Persisted commands are trimmed; the draft's leading whitespace
            // must not survive the save.
            command: "codex exec",
            enabled: true,
            timeoutMinutes: 30,
          },
        }),
      }),
    );
  });

  it("saves the runner draft before self-test and reports success", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    await user.type(
      await screen.findByTestId("runner-command-input"),
      "claude -p",
    );
    await user.click(screen.getByTestId("runner-self-test-button"));

    await waitFor(() =>
      expect(bridge.setUserSettings).toHaveBeenCalledWith({
        settings: expect.objectContaining({
          runner: expect.objectContaining({ command: "claude -p" }),
        }),
      }),
    );
    expect(bridge.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect((await screen.findByTestId("runner-self-test-result")).textContent).toBe(
      "self-test ok",
    );
    expect(
      screen.getByTestId("runner-self-test-result").getAttribute("data-state"),
    ).toBe("success");
  });

  it("blocks the runner self-test when the workspace engine is off", async () => {
    // AUDIT-OPTOUT: the self-test writes a chat thread, which an opted-out
    // workspace must never record. The main process refuses it; the button
    // must not offer it.
    bridge.getWorkspaceSettings.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: { workspaceEngineAlpha: false },
      },
      source: "default" as const,
    });
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    await user.type(await screen.findByTestId("runner-command-input"), "claude -p");
    const button = await screen.findByTestId("runner-self-test-button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("runner-self-test-engine-note").textContent).toContain(
      "The workspace engine is off",
    );
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  // #687 on this surface. The note's gate is the RENDERER's live settings
  // value, but the recovery depends on main's open-time decision, and the two
  // off states differ. Opened with the engine OFF: main built no recorder and
  // cannot until a restart, so turning the setting on hides the note and
  // enables Test runner over a click that can only fail.
  it("tells the user to restart when this session has no recorder", async () => {
    bridge.getWorkspaceSettings.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: { workspaceEngineAlpha: false },
      },
      source: "default" as const,
    });
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sessionRecorderOn={false}
        onClose={() => {}}
      />,
    );

    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toContain(
        "Turn it on in Advanced. Then restart dohc to test the runner.",
      ),
    );
  });

  // The other off state (#687, codex round 5): the workspace opened with the
  // engine ON and the user switched it off here. Main's recorder is still
  // live, so switching back on makes Test runner work at once. Prescribing a
  // restart would send the user to relaunch the app for nothing.
  it("asks for no restart when this session already has a recorder", async () => {
    bridge.getWorkspaceSettings.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: { workspaceEngineAlpha: false },
      },
      source: "default" as const,
    });
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sessionRecorderOn
        onClose={() => {}}
      />,
    );

    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toContain("Turn it on in Advanced to test the runner."),
    );
    expect(note.textContent).not.toContain("restart");
  });

  // The third state (#687, codex round 6), and the one the live-setting gate
  // got wrong: the session has NO recorder and the user has already followed
  // the instruction, so the setting reads on. Main still holds the
  // recorder-less activity — `runnerSelfTest` takes `prepareRunWorkspace`,
  // which refuses without a capture — so enabling Test runner here would show
  // a button known to fail and delete the restart instruction on the way.
  it("keeps the restart visible after the setting is turned on without a recorder", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sessionRecorderOn={false}
        onClose={() => {}}
      />,
    );

    // Configured, and the engine setting is ON (the schema default) — so the
    // live-setting gate alone would enable this button.
    await user.type(await screen.findByTestId("runner-command-input"), "claude -p");
    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toBe(
        "The workspace engine starts when dohc starts. Restart dohc to test the runner.",
      ),
    );
    const button = await screen.findByTestId("runner-self-test-button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  // #687: a shared view materializes no settings file, so the engine reads as
  // on by default, while main installs no recorder. The no-recorder branch
  // must not prescribe a restart that cannot make the self-test work.
  it("shows the shared-view note without a restart instruction", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sharedView
        sessionRecorderOn={false}
        onClose={() => {}}
      />,
    );

    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toBe(
        "This workspace is a shared view. dohc records nothing here, so there is no chat to test.",
      ),
    );
    expect(note.textContent).not.toContain("restart");
  });

  // #687 codex round 7: sharedView is a synchronous prop, but
  // sessionRecorderOn only resolves once main's openWorkspace status
  // arrives. In that window a shared view already knows it has no chat to
  // test, but sessionRecorderOn is still undefined — the disabled condition
  // must not wait on it to keep a doomed click off the button.
  it("disables the self-test in a shared view before the recorder status resolves", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        sharedView
        onClose={() => {}}
      />,
    );

    await user.type(await screen.findByTestId("runner-command-input"), "claude -p");
    await screen.findByTestId("runner-self-test-engine-note");
    const button = await screen.findByTestId("runner-self-test-button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(bridge.runnerSelfTest).not.toHaveBeenCalled();
  });

  it("surfaces a failed runner self-test without enabling dispatch", async () => {
    bridge.runnerSelfTest.mockResolvedValueOnce({
      ok: false,
      detail: "Runner did not report within 120 seconds.",
    });
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    await user.type(await screen.findByTestId("runner-command-input"), "claude -p");
    await user.click(screen.getByTestId("runner-self-test-button"));

    const result = await screen.findByRole("alert");
    expect(result.textContent).toContain("did not report within 120 seconds");
    expect(screen.getByRole("switch", { name: "Enable chat runner" }).getAttribute(
      "aria-checked",
    )).toBe("false");
  });

  it("copies the config snippet to the clipboard", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    await screen.findByTestId("mcp-config-snippet");
    await user.click(screen.getByText("Copy"));
    expect(bridge.writeClipboardText).toHaveBeenCalledWith({
      text: expect.stringContaining('"mcpServers"'),
    });
  });

  it("reports a copy failure without claiming success", async () => {
    const user = userEvent.setup();
    bridge.writeClipboardText.mockRejectedValueOnce(new Error("Clipboard denied"));
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    await screen.findByTestId("mcp-config-snippet");
    await user.click(screen.getByText("Copy"));
    expect((await screen.findByTestId("mcp-copy-error")).textContent).toBe(
      "Could not copy MCP config.",
    );
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("reports MCP load failures and retries without leaving stale UI", async () => {
    const user = userEvent.setup();
    bridge.getMcpConfig.mockRejectedValueOnce(new Error("MCP unavailable"));
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );

    expect((await screen.findByTestId("mcp-load-error")).textContent).toContain(
      "Could not load MCP settings.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("mcp-load-error")).toBeNull());
    expect(screen.getByTestId("mcp-config-snippet").textContent).toContain("dohc-mcp");
  });

  it("ignores in-flight MCP config responses after switching workspaces", async () => {
    // Delay ws-old and resolve it only after rerendering ws-new; if cancellation
    // fails, the old config overwrites the visible snippet.
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
        <DesktopSettings
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
        <DesktopSettings
          workspaceId="ws-new"
          workspacePath="/new"
          initialSection="agents"
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("mcp-config-snippet").textContent).toContain("/new"),
      );
      resolveOldConfig();
      await waitFor(() =>
        expect(screen.getByTestId("mcp-config-snippet").textContent).toContain("/new"),
      );
      expect(screen.getByTestId("mcp-config-snippet").textContent).not.toContain("/old");
    } finally {
      bridge.getMcpConfig.mockImplementation(getDefaultMcpConfig);
    }
  });

  it("toggles the MCP server on, then reflects running status", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
        onAgentActiveChange={onAgentActiveChange}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    // Started the run itself, so the shell may let this outrank a refresh
    // that was already in flight.
    expect(onAgentActiveChange).toHaveBeenLastCalledWith({
      active: true,
      mutated: true,
    });
  });

  it("disables an enabled server, ending the active run", async () => {
    mcpEnabled = true;
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
        onAgentActiveChange={onAgentActiveChange}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(toggle);
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
    await waitFor(() =>
      expect(onAgentActiveChange).toHaveBeenLastCalledWith({
        active: false,
        mutated: true,
      }),
    );
  });

  it("refreshes stale stopped UI before toggling so it cannot disable behind an Enable label", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onAgentActiveChange={onAgentActiveChange}
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");
    mcpEnabled = true;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toContain("Disable");
    // Nothing was started or ended, so this reading must not outrank anything.
    // It came from its own request, which may be older than one the shell is
    // still waiting on.
    expect(onAgentActiveChange).toHaveBeenLastCalledWith({
      active: true,
      mutated: false,
    });
  });

  it("refreshes stale running UI before toggling so it cannot enable behind a Disable label", async () => {
    mcpEnabled = true;
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onAgentActiveChange={onAgentActiveChange}
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    mcpEnabled = false;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toContain("Enable");
    expect(onAgentActiveChange).toHaveBeenLastCalledWith({
      active: false,
      mutated: false,
    });
  });

  it("shows current desktop update version and channel", async () => {
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
      completed: false,
      state: readyUpdateState,
    });
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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

  it("persists the attachment location and hides the folder name for same-folder", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
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

  // #483: over a settings file dohc cannot read, the dialog's resolved copy
  // carries the fail-closed opt-out, so saving one unrelated control would
  // land that opt-out on disk and the workspace would look opted out forever.
  // main refuses; the dialog must say so and must not claim a save happened.
  it("shows the refusal when the settings file cannot be read, and never says Saved", async () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /x/.dohc/settings.local.json. Then restart dohc.";
    const refusal =
      "dohc did not save workspace settings. dohc cannot read /x/.dohc/settings.local.json. Fix that file. Or select Reset workspace in Advanced to replace it.";
    const onDisk = {
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: { workspaceEngineAlpha: false },
      },
      source: "recovered" as const,
      warning,
    };
    bridge.getWorkspaceSettings.mockResolvedValue(onDisk);
    bridge.setWorkspaceSettings.mockResolvedValue({ ...onDisk, refusal });

    const user = userEvent.setup();
    render(
      <DesktopSettings
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
      <DesktopSettings
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

  // #687: the recovery path this row prescribes has to be the one that works.
  // Main decides the recorder once per workspace per app session —
  // `openWorkspaceActivity` retains every workspace it opens and
  // `workspaceActivity.open` no-ops for one it already watches — so reopening
  // the workspace re-reads this flag nowhere. Same instruction the History,
  // versions and chats surfaces give, for the same cause.
  it("tells the user to restart, not to reopen the workspace", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-workspace-engine-alpha");
    await waitFor(() =>
      expect(row.textContent).toContain(
        "Restart dohc after you change this setting.",
      ),
    );
    expect(row.textContent).not.toContain("next time the workspace is opened");
    // And the row may not claim the turn-off is immediate: the retained
    // capture keeps recording until that restart.
    expect(row.textContent).toContain("Until you restart, recording does not change.");
    expect(row.textContent).not.toContain("no history is recorded while it is off");
  });

  // #589: a shared view is fed by the share's pull and gets no capture, so it
  // records nothing. It also materializes no settings file, so this read
  // returns the schema default — ON. The toggle would assert both a choice
  // nobody made and a recording that never happens.
  it("states the capability for a shared view instead of the engine toggle", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        sharedView
        initialSection="advanced"
        onClose={() => {}}
      />,
    );

    const row = await screen.findByTestId("settings-row-workspace-engine-alpha");
    expect(row.textContent).toContain("This workspace is a shared view.");
    expect(row.textContent).toContain("dohc records nothing here.");
    expect(
      screen.getByTestId("settings-workspace-engine-share-view").textContent,
    ).toContain("no recording");
    expect(
      screen.queryByRole("switch", {
        name: "Use the workspace engine (default on)",
      }),
    ).toBeNull();
  });

  // #329 on this branch: a shared view replaces the engine ROW, and nothing
  // else. An unreadable settings file must still say so — that warning is the
  // one surface telling the user their file is damaged, and a share view is
  // not a reason to swallow it.
  it("still warns a shared view about an unreadable settings file", async () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /x/.dohc/settings.local.json. Then restart dohc.";
    bridge.getWorkspaceSettings.mockResolvedValue({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: { workspaceEngineAlpha: false },
      },
      source: "recovered" as const,
      warning,
    });

    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        sharedView
        initialSection="advanced"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("settings-warning").map((node) => node.textContent),
      ).toContain(warning),
    );
    // Still the capability row, not the toggle: the warning rides beside it.
    expect(screen.getByTestId("settings-workspace-engine-share-view")).toBeTruthy();
  });

  it("keeps the engine toggle for a workspace that is not a shared view", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="advanced"
        onClose={() => {}}
      />,
    );

    expect(
      await screen.findByRole("switch", {
        name: "Use the workspace engine (default on)",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("settings-workspace-engine-share-view")).toBeNull();
  });

  it("persists an edited attachment folder name", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
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
