import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAppImageBoot, resolveDohcMcpCommand } from "./dohcMcpCommand";

describe("resolveDohcMcpCommand", () => {
  it("recognizes only a non-empty APPIMAGE path", () => {
    expect(isAppImageBoot({ APPIMAGE: "" })).toBe(false);
    expect(isAppImageBoot({ APPIMAGE: "/path/to/x.AppImage" })).toBe(true);
    expect(isAppImageBoot({})).toBe(false);
  });

  it("resolves a packaged install to its shipped cli-bin launcher by absolute path", () => {
    // A bare `dohc-mcp` exists on no user's PATH; a packaged chat session
    // config must name the file the app actually ships.
    const windowsResourcesPath = resolve("apps", "dohc", "resources");
    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath: windowsResourcesPath,
        platform: "win32",
        env: {},
      }),
    ).toBe(join(windowsResourcesPath, "cli-bin", "dohc-mcp.cmd"));
    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath: "/opt/dohc/resources",
        platform: "linux",
        env: {},
      }),
    ).toBe(join(resolve("/opt/dohc/resources"), "cli-bin", "dohc-mcp"));
  });

  it("treats an empty APPIMAGE as a packaged non-AppImage install", () => {
    const resourcesPath = "/opt/dohc/resources";
    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath,
        platform: "linux",
        env: { APPIMAGE: "" },
      }),
    ).toBe(join(resolve(resourcesPath), "cli-bin", "dohc-mcp"));
  });

  it("uses the persistent cli-bin only for a packaged Linux AppImage", () => {
    const resourcesPath = "/tmp/.mount_dohcAbC123/resources";
    const linuxStableCliBinDir = "/home/user/.config/dohc/cli-bin";
    const appImageCommand = resolveDohcMcpCommand({
      isPackaged: true,
      resourcesPath,
      platform: "linux",
      env: { APPIMAGE: "/home/user/Downloads/dohc-1.2.3-linux-x86_64.AppImage" },
      linuxStableCliBinDir,
    });
    expect(appImageCommand).toBe(join(linuxStableCliBinDir, "dohc-mcp"));
    expect(appImageCommand).not.toContain("/tmp/.mount_dohcAbC123");

    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath,
        platform: "linux",
        env: {},
        linuxStableCliBinDir,
      }),
    ).toBe(join(resolve(resourcesPath), "cli-bin", "dohc-mcp"));
  });

  it("returns unavailable instead of exposing a packaged AppImage mount path", () => {
    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath: "/tmp/.mount_dohcAbC123/resources",
        platform: "linux",
        env: { APPIMAGE: "/home/user/Downloads/dohc-1.2.3-linux-x86_64.AppImage" },
      }),
    ).toBeNull();
  });

  it("keeps the workspace bin in dev and the DOHC_MCP_COMMAND override everywhere", () => {
    expect(resolveDohcMcpCommand({ isPackaged: false, env: {} })).toBe("dohc-mcp");
    expect(
      resolveDohcMcpCommand({
        isPackaged: true,
        resourcesPath: "/opt/dohc/resources",
        platform: "linux",
        env: { DOHC_MCP_COMMAND: " /custom/dohc-mcp " },
      }),
    ).toBe("/custom/dohc-mcp");
  });
});
