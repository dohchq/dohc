import { describe, expect, it } from "vitest";
import desktopConfig, {
  mainBundledWorkspaceDeps,
  preloadBundledRuntimeDeps,
  effectFree,
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

  it("rejects Effect from sandboxed and browser bundles", () => {
    expect(desktopConfig.main?.plugins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "effect-free-preload" })]),
    );
    expect(desktopConfig.preload?.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "effect-free-preload" })]),
    );

    for (const surface of ["preload", "renderer"] as const) {
      const resolveId = effectFree(surface).resolveId as (source: string) => unknown;
      expect(() => resolveId("effect/Schema")).toThrow(
        `${surface} cannot import effect/Schema`,
      );
      expect(() => resolveId("effect")).toThrow(`${surface} cannot import effect`);
      expect(resolveId("zod")).toBeUndefined();
    }
  });
});
