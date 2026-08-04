import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratchSync } from "./workspaces/testTemp";

// These assertions belong to the desktop app, not to the daemon client package.
// The lifecycle suite they came from moved into @dohc/workspace-engine-client,
// and a package test cannot reach back out to assert on this app's packaging
// config and a repo workflow.
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "../..");

const scratchPaths: string[] = [];

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Rust engine packaging gate", () => {
  it("fails the packaging gate when the staged engine binary is missing", () => {
    const emptyResourceDir = createTestScratchSync("dohc-missing-engine-resource-");
    scratchPaths.push(emptyResourceDir);

    const gate = spawnSync(
      process.execPath,
      [
        join(desktopDir, "scripts", "require-workspace-engine.mjs"),
        emptyResourceDir,
      ],
      { encoding: "utf8" },
    );

    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toContain(
      "Refusing to package without the Rust workspace engine binary",
    );
    expect(
      readFileSync(join(desktopDir, "electron-builder.yml"), "utf8"),
    ).toMatch(/^beforePack: scripts\/require-workspace-engine\.mjs$/m);
    expect(
      readFileSync(
        join(repoRoot, ".github/workflows/desktop-release.yml"),
        "utf8",
      ),
    ).toContain("pnpm --filter @dohc/desktop run build:engine -- --target");
  });
});
