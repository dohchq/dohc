import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import desktopConfig, {
  mainBundledWorkspaceDeps,
  preloadBundledRuntimeDeps,
} from "../electron.vite.config";

function configuredEffectGuard(surface: "preload" | "renderer"): Plugin {
  const plugins = desktopConfig[surface]?.plugins;
  const guard = plugins?.find(
    (plugin): plugin is Plugin =>
      typeof plugin === "object" &&
      plugin !== null &&
      !Array.isArray(plugin) &&
      "name" in plugin &&
      plugin.name === `effect-free-${surface}`,
  );
  expect(guard).toBeDefined();
  return guard!;
}

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
        "effect",
        "zod",
      ]),
    );
  });

  it("rejects Effect from sandboxed and browser bundles", () => {
    expect(desktopConfig.preload?.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "effect-free-preload" })]),
    );

    for (const surface of ["preload", "renderer"] as const) {
      const resolveId = configuredEffectGuard(surface).resolveId as (
        source: string,
      ) => unknown;
      expect(() => resolveId("effect/Schema")).toThrow(
        `${surface} cannot import effect/Schema`,
      );
      expect(() => resolveId("effect")).toThrow(`${surface} cannot import effect`);
      expect(() => resolveId("effect?raw")).toThrow(
        `${surface} cannot import effect?raw`,
      );
      expect(() => resolveId("effect#schema")).toThrow(
        `${surface} cannot import effect#schema`,
      );
      expect(() => resolveId("effect/Schema?raw")).toThrow(
        `${surface} cannot import effect/Schema?raw`,
      );
      expect(resolveId("zod")).toBeUndefined();
    }
  });
});
