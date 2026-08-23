import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncLinuxStableCliBin } from "./linuxStableCliBin";

const scratchDirs: string[] = [];

afterEach(() => {
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
});
