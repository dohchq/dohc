import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratchSync } from "./workspaces/testTemp";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  });
});
