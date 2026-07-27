import { describe, expect, it } from "vitest";
import {
  mainBundledWorkspaceDeps,
  preloadBundledRuntimeDeps,
} from "../electron.vite.config";

describe("main bundle config", () => {
  it("bundles the raw TypeScript engine client used by desktop dispatch", () => {
    expect(mainBundledWorkspaceDeps).toContain(
      "@dohc/workspace-engine-client",
    );
  });
});

describe("preload bundle config", () => {
  it("bundles runtime validators used by the sandboxed preload", () => {
    expect(preloadBundledRuntimeDeps).toEqual(
      expect.arrayContaining([
        "@dohc/workspace-contracts",
        "@dohc/workspace-core",
        "zod",
      ]),
    );
  });
});
