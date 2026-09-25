// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUserSettingsResult, WorkspaceSettingsResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../workspaces/workspaceSettings";
import { settingsFileNotice, useSettingsFileNotices } from "./useSettingsFileNotices";
import { useShellError } from "./useShellError";

// These wait on async bridge answers. On a loaded machine they can take
// longer than Testing Library's 1000 ms default, and a wait that gives up
// first fails a test that was about to pass. Every wait here runs until the
// condition holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user = (ignored?: DesktopUserSettingsResult["ignored"]): DesktopUserSettingsResult => ({
  settings: DEFAULT_USER_SETTINGS,
  source: "stored",
  ...(ignored ? { ignored } : {}),
});

describe("settingsFileNotice", () => {
  it("names each ignored key and why, and says the rest applies", () => {
    expect(settingsFileNotice("dohc-settings.json", user([{ key: "editor.fontSize", reason: "invalid" }])))
      .toBe("dohc ignored editor.fontSize in dohc-settings.json because its value is not valid. The other settings apply.");
    expect(settingsFileNotice("dohc-settings.json", user([{ key: "accent", reason: "unknown" }])))
      .toBe("dohc ignored accent in dohc-settings.json because it is not a setting dohc knows. The other settings apply.");
    expect(settingsFileNotice("dohc-settings.json", user([
      { key: "editor.fontSize", reason: "invalid" },
      { key: "accent", reason: "unknown" },
    ]))).toBe(
      "dohc ignored 2 settings in dohc-settings.json: editor.fontSize (value not valid), accent (unknown setting). The other settings apply.",
    );
    expect(settingsFileNotice("dohc-settings.json", user())).toBeNull();
  });

  it("reports a file dohc could not use, and leaves a reset's own message to Settings", () => {
    expect(settingsFileNotice("dohc-settings.json", {
      ...user(), source: "recovered", warning: "dohc could not use /s/dohc-settings.json: it is not valid JSON.",
    })).toBe("dohc could not use /s/dohc-settings.json: it is not valid JSON.");
    const reset: WorkspaceSettingsResult = {
      settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored", warning: "dohc replaced workspace settings.",
    };
    expect(settingsFileNotice(".dohc/settings.local.json", reset)).toBeNull();
  });
});

describe("useSettingsFileNotices", () => {
  it("keeps one row per file, leaves a dismissed row alone, and clears it when the file reads cleanly", async () => {
    const workspaceRead: WorkspaceSettingsResult = {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
      ignored: [{ key: "theme", reason: "unknown" }],
    };
    const getWorkspaceSettings = vi.fn(async () => workspaceRead);
    vi.stubGlobal("dohcDesktop", { getWorkspaceSettings });
    const { result, rerender } = renderHook(
      ({ userSettings, ready }) => {
        const errors = useShellError("ws-a");
        const onWorkspaceRead = useSettingsFileNotices({
          workspaceId: "ws-a",
          workspaceIsReady: ready,
          userSettings,
          show: errors.showSettingsFileNotice,
          reportError: (message) => errors.reportShellFailure({ message }),
        });
        return { ...errors, onWorkspaceRead };
      },
      { initialProps: { userSettings: user([{ key: "accent", reason: "unknown" }]), ready: false } },
    );
    expect(result.current.shellErrors.map((row) => row.message)).toEqual([
      "dohc ignored accent in dohc-settings.json because it is not a setting dohc knows. The other settings apply.",
    ]);
    expect(getWorkspaceSettings).not.toHaveBeenCalled();

    // The workspace file is read once the workspace is open.
    rerender({ userSettings: user([{ key: "accent", reason: "unknown" }]), ready: true });
    await waitFor(() => expect(result.current.shellErrors).toHaveLength(2));
    expect(getWorkspaceSettings).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });

    // The same settings arriving again do not bring back a dismissed row.
    const userRow = result.current.shellErrors[0]!;
    act(() => result.current.dismissShellError(userRow.id));
    rerender({ userSettings: user([{ key: "accent", reason: "unknown" }]), ready: true });
    expect(result.current.shellErrors.map((row) => row.kind)).toEqual(["workspace-settings-file"]);

    // A save from Settings that fixed the file clears its row.
    act(() => result.current.onWorkspaceRead({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" }));
    expect(result.current.shellErrors).toEqual([]);
    rerender({ userSettings: user([{ key: "editor.fontSize", reason: "invalid" }]), ready: true });
    expect(result.current.shellErrors.map((row) => row.kind)).toEqual(["user-settings-file"]);
    rerender({ userSettings: user(), ready: true });
    expect(result.current.shellErrors).toEqual([]);
  });

  it("opens each file from its row, and Try again reads it again", async () => {
    const broken: WorkspaceSettingsResult = {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
      warning: "Workspace settings could not be read. dohc is using default settings. Fix /w/.dohc/settings.local.json. Or select Reset workspace in Advanced to replace it.",
    };
    const bridge = {
      getWorkspaceSettings: vi.fn(async (): Promise<WorkspaceSettingsResult> => broken),
      openWorkspaceSettingsFile: vi.fn(async () => undefined),
      openUserSettingsFile: vi.fn(async (): Promise<void> => {
        throw new Error(
          "Error invoking remote method 'desktop:open-user-settings-file': Error: dohc could not open /s/dohc-settings.json. No app. Open the file in a text editor.",
        );
      }),
      reloadUserSettings: vi.fn(async () => user([{ key: "accent", reason: "unknown" }])),
    };
    vi.stubGlobal("dohcDesktop", bridge);
    const { result } = renderHook(() => {
      const errors = useShellError("ws-a");
      useSettingsFileNotices({
        workspaceId: "ws-a",
        workspaceIsReady: true,
        userSettings: user([{ key: "accent", reason: "unknown" }]),
        show: errors.showSettingsFileNotice,
        reportError: (message) => errors.reportShellFailure({ message }),
      });
      return errors;
    });
    await waitFor(() => expect(result.current.shellErrors).toHaveLength(2));
    const row = (kind: string) => result.current.shellErrors.find((error) => error.kind === kind)!;
    for (const kind of ["user-settings-file", "workspace-settings-file"]) {
      expect(row(kind).action?.label).toBe("Open settings file");
      expect(row(kind).retry).not.toBeNull();
    }

    act(() => result.current.runShellErrorAction(row("workspace-settings-file").id));
    expect(bridge.openWorkspaceSettingsFile).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
    // Opening keeps the row: the file is still wrong until it is saved.
    expect(row("workspace-settings-file")).toBeDefined();

    // A failure to open says why and what to do instead.
    act(() => result.current.runShellErrorAction(row("user-settings-file").id));
    await waitFor(() =>
      expect(result.current.shellErrors.map((error) => error.message)).toContain(
        "dohc could not open /s/dohc-settings.json. No app. Open the file in a text editor.",
      ));

    // Try again on a file that still says the same thing brings its row back.
    act(() => result.current.retryShellError(row("user-settings-file").id));
    await waitFor(() => expect(bridge.reloadUserSettings).toHaveBeenCalledOnce());
    await waitFor(() => expect(row("user-settings-file")).toBeDefined());

    // The person repairs the workspace file; Try again clears its row.
    bridge.getWorkspaceSettings.mockResolvedValue({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" });
    act(() => result.current.retryShellError(row("workspace-settings-file").id));
    await waitFor(() => expect(bridge.getWorkspaceSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.shellErrors.some((error) => error.kind === "workspace-settings-file")).toBe(false));
  });
});
