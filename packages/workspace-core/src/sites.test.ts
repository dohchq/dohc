import { describe, expect, it } from "vitest";
import { frameworkConfigName, hasWebDependency, packageManagerFromFiles } from "./sites";

describe("hasWebDependency", () => {
  it("detects a mainstream web framework dependency", () => {
    expect(hasWebDependency({ dependencies: { react: "^19.0.0" } })).toBe(true);
    expect(hasWebDependency({ devDependencies: { vite: "^7.0.0" } })).toBe(true);
  });

  it("returns false when no web dependency is present", () => {
    expect(hasWebDependency({ dependencies: { lodash: "^4.0.0" } })).toBe(false);
    expect(hasWebDependency(undefined)).toBe(false);
  });
});

describe("frameworkConfigName", () => {
  it("finds a recognized framework config file name", () => {
    expect(frameworkConfigName(new Set(["next.config.mjs", "README.md"]))).toBe(
      "next.config.mjs",
    );
  });

  it("returns undefined when no config file matches", () => {
    expect(frameworkConfigName(new Set(["package.json"]))).toBeUndefined();
  });
});

describe("package helpers", () => {
  it("detects package managers from lockfiles before package metadata", () => {
    expect(
      packageManagerFromFiles(new Set(["yarn.lock"]), { packageManager: "npm@10.0.0" }),
    ).toBe("yarn");
    expect(packageManagerFromFiles(new Set(), { packageManager: "pnpm@10.0.0" })).toBe("pnpm");
  });
});
