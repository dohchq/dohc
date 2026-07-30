import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
        override: null,
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
      override: null,
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
      override: null,
    });

    expect(result.copied).toBe(false);
  });

  it("REFRESHES a staged daemon that is older than the cargo-built one", () => {
    // Without this, `cargo build` refreshes only the workspace-root binary and
    // Electron keeps launching the stale staged copy — while the seed helper
    // picks the newest candidate. The specs then seed with one daemon version
    // and exercise another.
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    mkdirSync(cargoTargetDir, { recursive: true });
    mkdirSync(desktopTargetDir, { recursive: true });
    const staged = join(desktopTargetDir, "dohc-workspace-engine");
    const built = join(cargoTargetDir, "dohc-workspace-engine");
    writeFileSync(staged, "stale");
    writeFileSync(built, "fresh");
    utimesSync(staged, 1_700_000_000, 1_700_000_000);
    utimesSync(built, 1_800_000_000, 1_800_000_000);

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "linux",
      override: null,
    });

    expect(result.refreshed).toBe(true);
    // Content, not just the flag — the flag alone would pass a no-op copy.
    expect(readFileSync(staged, "utf8")).toBe("fresh");
  });

  it("stages the root build over an existing staged copy, regardless of mtime", () => {
    // The root build is authoritative and engineBinary.ts resolves it FIRST, so
    // leaving a different file staged would have Electron launch one daemon
    // while the seed helper used another. A previous run's override can be
    // NEWER than a fresh build, so mtime is the wrong test — the supported way
    // to pin a custom artifact is the override, asserted below.
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    mkdirSync(cargoTargetDir, { recursive: true });
    mkdirSync(desktopTargetDir, { recursive: true });
    const staged = join(desktopTargetDir, "dohc-workspace-engine");
    const built = join(cargoTargetDir, "dohc-workspace-engine");
    writeFileSync(staged, "leftover");
    writeFileSync(built, "root-build");
    // Staged deliberately NEWER, which the previous revision would have kept.
    utimesSync(staged, 1_900_000_000, 1_900_000_000);
    utimesSync(built, 1_700_000_000, 1_700_000_000);

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "linux",
      override: null,
    });

    expect(result.refreshed).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe("root-build");
  });

  it("stages an explicit override even when the cargo build is newer", () => {
    // Electron always launches the staged path, so an override honoured only by
    // the seed helper would leave Playwright seeding with the override and
    // exercising the staged file — the skew this refresh exists to remove,
    // arriving from the other direction.
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    const overrideDir = join(root, "custom");
    mkdirSync(cargoTargetDir, { recursive: true });
    mkdirSync(desktopTargetDir, { recursive: true });
    mkdirSync(overrideDir, { recursive: true });
    const staged = join(desktopTargetDir, "dohc-workspace-engine");
    const built = join(cargoTargetDir, "dohc-workspace-engine");
    const override = join(overrideDir, "dohc-workspace-engine");
    writeFileSync(staged, "stale");
    writeFileSync(built, "root-build");
    writeFileSync(override, "override-build");
    utimesSync(staged, 1_700_000_000, 1_700_000_000);
    // Deliberately the NEWEST, so a naive mtime rule would pick it over the
    // override.
    utimesSync(built, 1_900_000_000, 1_900_000_000);
    utimesSync(override, 1_800_000_000, 1_800_000_000);

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "linux",
      override,
    });

    expect(result.binary).toBe(staged);
    expect(readFileSync(staged, "utf8")).toBe("override-build");
  });

  it("refuses an override that does not exist rather than launching without one", () => {
    const root = tempRoot();
    expect(() =>
      requireE2eEngine({
        desktopTargetDir: join(root, "desktop"),
        cargoTargetDir: join(root, "cargo"),
        platform: "linux",
        override: join(root, "absent-engine"),
      }),
    ).toThrow(/does not exist/);
  });
  it("does not destroy the source when it is a symlink AT the staged path", () => {
    // The inverse alias. Unlinking the destination first would delete the very
    // file the copy is about to read, failing ENOENT and leaving no daemon.
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    mkdirSync(cargoTargetDir, { recursive: true });
    mkdirSync(desktopTargetDir, { recursive: true });
    const staged = join(desktopTargetDir, "dohc-workspace-engine");
    const built = join(cargoTargetDir, "dohc-workspace-engine");
    writeFileSync(staged, "the only copy");
    try {
      symlinkSync(staged, built);
    } catch {
      return; // symlinks unavailable on this host
    }

    const result = requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "linux",
      override: null,
    });

    // No copy happened, and it says so rather than reporting one that did not.
    expect(result.copied).toBe(false);
    expect(readFileSync(staged, "utf8")).toBe("the only copy");
  });

  it("replaces a symlinked staged path without touching its target", () => {
    const root = tempRoot();
    const cargoTargetDir = join(root, "cargo");
    const desktopTargetDir = join(root, "desktop");
    const elsewhere = join(root, "precious");
    mkdirSync(cargoTargetDir, { recursive: true });
    mkdirSync(desktopTargetDir, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const staged = join(desktopTargetDir, "dohc-workspace-engine");
    const built = join(cargoTargetDir, "dohc-workspace-engine");
    const target = join(elsewhere, "real-build");
    writeFileSync(target, "precious build");
    writeFileSync(built, "new build");
    try {
      symlinkSync(target, staged);
    } catch {
      return;
    }

    requireE2eEngine({
      desktopTargetDir,
      cargoTargetDir,
      platform: "linux",
      override: null,
    });

    // copyFileSync would have followed the link and rewritten the target.
    expect(readFileSync(target, "utf8")).toBe("precious build");
    expect(readFileSync(staged, "utf8")).toBe("new build");
  });
});
