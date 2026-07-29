import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireE2eEngine } from "../../scripts/require-e2e-engine.mjs";

// The guard that keeps a fresh checkout from running the whole e2e suite
// against an app that cannot launch (every spec failing inside
// electron.launch, with the real cause buried in Playwright's log).

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dohc-e2e-engine-guard-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("requireE2eEngine", () => {
  it("refuses with the build command when no daemon exists anywhere", () => {
    const root = tempRoot();
    expect(() =>
      requireE2eEngine({
        desktopTargetDir: join(root, "desktop"),
        cargoTargetDir: join(root, "cargo"),
        platform: "win32",
      }),
    ).toThrow(/cargo build --bin dohc-workspace-engine/);
  });

  it("stages a cargo-built daemon into the path the app actually resolves", () => {
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    mkdirSync(cargoTargetDir, { recursive: true });
    writeFileSync(join(cargoTargetDir, "dohc-workspace-engine.exe"), "binary");

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "win32",
    });

    expect(result.copied).toBe(true);
    expect(result.binary).toBe(join(desktopTargetDir, "dohc-workspace-engine.exe"));
  });

  it("leaves an already-staged daemon alone", () => {
    const root = tempRoot();
    const desktopTargetDir = join(root, "desktop");
    mkdirSync(desktopTargetDir, { recursive: true });
    writeFileSync(join(desktopTargetDir, "dohc-workspace-engine"), "binary");

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir: join(root, "cargo"),
      platform: "linux",
    });

    expect(result.copied).toBe(false);
  });
});
