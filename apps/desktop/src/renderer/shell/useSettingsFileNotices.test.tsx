// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUserSettingsResult, WorkspaceSettingsResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../workspaces/workspaceSettings";
import { settingsFileNotice, useSettingsFileNotices } from "./useSettingsFileNotices";
import { useShellError } from "./useShellError";

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
});
