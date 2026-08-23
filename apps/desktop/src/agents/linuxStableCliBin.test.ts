import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncLinuxStableCliBin } from "./linuxStableCliBin";

const scratchDirs: string[] = [];
let failLauncherCopy = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: (async (...args: Parameters<typeof actual.copyFile>) => {
      if (failLauncherCopy && basename(String(args[0])) === "dohc-mcp") {
        await actual.writeFile(args[1], "partial-launcher");
        throw new Error("launcher copy failed");
      }
      return actual.copyFile(...args);
    }) as typeof actual.copyFile,
  };
});

afterEach(() => {
  failLauncherCopy = false;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncLinuxStableCliBin", () => {
  it("copies both launchers, sets the executable mode, and overwrites stale copies", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe("launcher-v1");
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v1");
    if (process.platform !== "win32") {
      expect(statSync(join(targetDir, "dohc-mcp")).mode & 0o777).toBe(0o755);
    }

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v2");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe("launcher-v2");
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v2");
  });

  it("keeps the published launcher intact when its replacement copy fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    const targetLauncher = join(targetDir, "dohc-mcp");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const publishedMode = statSync(targetLauncher).mode & 0o777;
    if (process.platform !== "win32") expect(publishedMode).toBe(0o755);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v2");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherCopy = true;

    await expect(syncLinuxStableCliBin({ resourcesCliBinDir, targetDir })).rejects.toThrow(
      "launcher copy failed",
    );
    expect(readFileSync(targetLauncher, "utf8")).toBe("launcher-v1");
    expect(statSync(targetLauncher).mode & 0o777).toBe(publishedMode);
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v2");
    expect(readdirSync(targetDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
