import { expect, it, vi } from "vitest";
import { systemPrivacySettingsOperations } from "./bridgeContract";
import { registerSystemPrivacySettingsIpc } from "./systemPrivacySettingsIpc";

function register(platform: NodeJS.Platform) {
  let handle!: (trusted: boolean, payload: unknown) => Promise<unknown>;
  const openExternal = vi.fn(async () => undefined);
  registerSystemPrivacySettingsIpc<boolean, never>({
    handle(channel, handler) {
      expect(channel).toBe(systemPrivacySettingsOperations.openSystemPrivacySettings.channel);
      handle = handler;
    },
    assertTrustedSender(trusted) { if (!trusted) throw new Error("Untrusted sender"); },
    withActiveWorkspace: vi.fn(() => { throw new Error("Device operation must not enter a workspace"); }),
  }, platform, openExternal);
  return { handle: (trusted: boolean, payload: unknown) => handle(trusted, payload), openExternal };
}

it("opens only the fixed Files & Folders pane, for a trusted window on macOS", async () => {
  const mac = register("darwin");
  await expect(mac.handle(false, {})).rejects.toThrow("Untrusted sender");
  await expect(mac.handle(true, null)).rejects.toThrow();
  expect(mac.openExternal).not.toHaveBeenCalled();
  await mac.handle(true, { url: "https://example.com" });
  expect(mac.openExternal).toHaveBeenCalledExactlyOnceWith(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  );
  const windows = register("win32");
  await expect(windows.handle(true, {})).rejects.toThrow("Only macOS");
  expect(windows.openExternal).not.toHaveBeenCalled();
});
