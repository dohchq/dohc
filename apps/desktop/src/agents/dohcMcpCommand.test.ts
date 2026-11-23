import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAppImageBoot, isTemporaryMacAppPath, resolveDohcMcpLaunch } from "./dohcMcpCommand";

describe("resolveDohcMcpLaunch", () => {
  it("recognizes only a non-empty APPIMAGE path", () => {
    expect(isAppImageBoot({ APPIMAGE: "" })).toBe(false);
    expect(isAppImageBoot({ APPIMAGE: "/path/to/x.AppImage" })).toBe(true);
    expect(isAppImageBoot({})).toBe(false);
  });

  it("resolves a packaged Windows install to node.exe plus dohc-mcp.mjs so shell-free MCP clients avoid EINVAL", () => {
    const windowsResourcesPath = resolve("apps", "dohc", "resources");
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath: windowsResourcesPath,
        platform: "win32",
        env: {},
      }),
    ).toEqual({
      command: join(windowsResourcesPath, "app-compiler", "node.exe"),
      args: [join(windowsResourcesPath, "cli-bin", "dohc-mcp.mjs")],
    });
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath: "/opt/dohc/resources",
        platform: "linux",
        env: {},
      }),
    ).toEqual({
      command: join(resolve("/opt/dohc/resources"), "cli-bin", "dohc-mcp"),
      args: [],
    });
  });

  it("treats an empty APPIMAGE as a packaged non-AppImage install", () => {
    const resourcesPath = "/opt/dohc/resources";
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath,
        platform: "linux",
        env: { APPIMAGE: "" },
      }),
    ).toEqual({
      command: join(resolve(resourcesPath), "cli-bin", "dohc-mcp"),
      args: [],
    });
  });

  it("uses the persistent cli-bin only for a packaged Linux AppImage", () => {
    const resourcesPath = "/tmp/.mount_dohcAbC123/resources";
    const linuxStableCliBinDir = "/home/user/.config/dohc/cli-bin";
    const appImageLaunch = resolveDohcMcpLaunch({
      isPackaged: true,
      resourcesPath,
      platform: "linux",
      env: { APPIMAGE: "/home/user/Downloads/dohc-1.2.3-linux-x86_64.AppImage" },
      linuxStableCliBinDir,
    });
    expect(appImageLaunch).toEqual({
      command: join(linuxStableCliBinDir, "dohc-mcp"),
      args: [],
    });
    expect(appImageLaunch?.command).not.toContain("/tmp/.mount_dohcAbC123");

    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath,
        platform: "linux",
        env: {},
        linuxStableCliBinDir,
      }),
    ).toEqual({
      command: join(resolve(resourcesPath), "cli-bin", "dohc-mcp"),
      args: [],
    });
  });

  it("returns unavailable instead of exposing a packaged AppImage mount path", () => {
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath: "/tmp/.mount_dohcAbC123/resources",
        platform: "linux",
        env: { APPIMAGE: "/home/user/Downloads/dohc-1.2.3-linux-x86_64.AppImage" },
      }),
    ).toBeNull();
  });

  it("returns unavailable for a macOS app on a disk image or a translocated copy", () => {
    const temporary = [
      "/Volumes/dohc 1.2.3/dohc.app/Contents/Resources",
      "/private/var/folders/x1/abc/T/AppTranslocation/0F2C9A1E-1111-4222-8333-944455556666/d/dohc.app/Contents/Resources",
    ];
    for (const resourcesPath of temporary) {
      expect(isTemporaryMacAppPath(resourcesPath)).toBe(true);
      expect(
        resolveDohcMcpLaunch({ isPackaged: true, resourcesPath, platform: "darwin", env: {} }),
      ).toBeNull();
    }
    const installed = "/Applications/dohc.app/Contents/Resources";
    expect(isTemporaryMacAppPath(installed)).toBe(false);
    expect(
      isTemporaryMacAppPath("/Volumes/External/Applications/dohc.app/Contents/Resources"),
    ).toBe(false);
    expect(
      isTemporaryMacAppPath("/Volumes/dohc 1.2.3/Stuff/Applications/dohc.app/Contents/Resources"),
    ).toBe(true);
    expect(isTemporaryMacAppPath("/Users/sam/Applications/dohc.app/Contents/Resources")).toBe(
      false,
    );
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath: installed,
        platform: "darwin",
        env: {},
      }),
    ).toEqual({
      command: join(resolve(installed), "cli-bin", "dohc-mcp"),
      args: [],
    });
  });

  it("resolves staged dev resources when present and falls back to dohc-mcp or DOHC_MCP_COMMAND", () => {
    const devResources = resolve("apps", "desktop", "resources");
    expect(
      resolveDohcMcpLaunch({
        isPackaged: false,
        devResourcesPath: devResources,
        platform: "win32",
        env: {},
        fileExists: () => true,
      }),
    ).toEqual({
      command: join(devResources, "app-compiler", "node.exe"),
      args: [join(devResources, "cli-bin", "dohc-mcp.mjs")],
    });
    expect(
      resolveDohcMcpLaunch({
        isPackaged: false,
        devResourcesPath: devResources,
        platform: "win32",
        env: {},
        fileExists: () => false,
      }),
    ).toEqual({ command: "dohc-mcp", args: [] });
    expect(
      resolveDohcMcpLaunch({
        isPackaged: false,
        devResourcesPath: devResources,
        platform: "darwin",
        env: {},
        fileExists: () => true,
      }),
    ).toEqual({ command: "dohc-mcp", args: [] });
    expect(
      resolveDohcMcpLaunch({
        isPackaged: true,
        resourcesPath: "/opt/dohc/resources",
        platform: "linux",
        env: { DOHC_MCP_COMMAND: " /custom/dohc-mcp " },
      }),
    ).toEqual({ command: "/custom/dohc-mcp", args: [] });
  });
});
