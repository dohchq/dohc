import { describe, expect, it } from "vitest";
import {
  appBuildOutputDir,
  appReadiness,
  appWriteAllowed,
  discoverApps,
  isAppCachePath,
  parseAppManifest,
  requiresTrust,
} from "./apps";

const LEDGER_FILES = [
  "finance/.apps/ledger/app.json",
  "finance/.apps/ledger/src/App.tsx",
  "finance/.apps/ledger/src/style.css",
  "finance/notes.md",
  "notes/today.md",
];

describe("discoverApps", () => {
  it("discovers a .apps/<name> folder with an app.json as a local app package", () => {
    const apps = discoverApps(LEDGER_FILES);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      name: "ledger",
      root: "finance/.apps/ledger",
      manifestPath: "finance/.apps/ledger/app.json",
    });
    expect(apps[0].sourceFiles).toEqual([
      "finance/.apps/ledger/app.json",
      "finance/.apps/ledger/src/App.tsx",
      "finance/.apps/ledger/src/style.css",
    ]);
  });

  it("ignores a .apps/<name> folder that has no app.json", () => {
    expect(discoverApps(["x/.apps/draft/src/App.tsx"])).toEqual([]);
  });

  it("does not treat build cache as app source", () => {
    const apps = discoverApps([
      "finance/.apps/ledger/app.json",
      ".dohc/cache/apps/ledger/bundle.js",
    ]);
    expect(apps[0].sourceFiles).toEqual(["finance/.apps/ledger/app.json"]);
  });
});

describe("app build output", () => {
  it("routes build output to .dohc/cache/apps/<name> (hidden, not source)", () => {
    expect(appBuildOutputDir("ledger")).toBe(".dohc/cache/apps/ledger");
    expect(isAppCachePath(".dohc/cache/apps/ledger/bundle.js")).toBe(true);
    expect(isAppCachePath("finance/.apps/ledger/src/App.tsx")).toBe(false);
  });
});

describe("manifest write globs are the maximum write surface", () => {
  it("parses read/write globs with defaults (entry, read=., offline)", () => {
    const manifest = parseAppManifest(JSON.stringify({ title: "Ledger" }));
    expect(manifest.entry).toBe("src/App.tsx");
    expect(manifest.read).toEqual(["."]);
    expect(manifest.write).toEqual([]);
    expect(manifest.network).toBe(false);
  });

  it("normalizes string globs to arrays", () => {
    const manifest = parseAppManifest(
      JSON.stringify({ title: "Ledger", read: "transactions/**", write: "transactions/**" }),
    );
    expect(manifest.read).toEqual(["transactions/**"]);
    expect(manifest.write).toEqual(["transactions/**"]);
  });

  it("requires trust only when the app can write or act as an agent", () => {
    expect(requiresTrust(parseAppManifest(JSON.stringify({ title: "A" })))).toBe(false);
    expect(
      requiresTrust(parseAppManifest(JSON.stringify({ title: "A", write: ["x/**"] }))),
    ).toBe(true);
    expect(
      requiresTrust(parseAppManifest(JSON.stringify({ title: "A", agent: "run" }))),
    ).toBe(true);
  });
});

describe("app trust gates broad workspace writes", () => {
  const manifest = parseAppManifest(
    JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
  );
  const appRoot = "finance/.apps/ledger";

  it("always allows the app to write inside its own folder", () => {
    expect(
      appWriteAllowed(manifest, { trusted: false }, appRoot, "finance/.apps/ledger/src/App.tsx"),
    ).toBe(true);
  });

  it("blocks a broad write within the declared surface until trusted", () => {
    expect(
      appWriteAllowed(manifest, { trusted: false }, appRoot, "finance/transactions/jan.md"),
    ).toBe(false);
    expect(
      appWriteAllowed(manifest, { trusted: true }, appRoot, "finance/transactions/jan.md"),
    ).toBe(true);
  });

  it("blocks even a trusted write outside the declared write globs", () => {
    // categories.md is not under the declared write surface transactions/**.
    expect(
      appWriteAllowed(manifest, { trusted: true }, appRoot, "finance/categories.md"),
    ).toBe(false);
  });

  it("blocks a write outside the app's own scope entirely", () => {
    expect(
      appWriteAllowed(manifest, { trusted: true }, appRoot, "other/secret.md"),
    ).toBe(false);
  });
});

describe("app readiness gate (AppTester must pass before ready)", () => {
  it("is not ready until the app tester has passed", () => {
    expect(appReadiness({ tested: false, passed: false })).toBe("needs-testing");
    expect(appReadiness({ tested: true, passed: false })).toBe("failed");
    expect(appReadiness({ tested: true, passed: true })).toBe("ready");
  });
});
