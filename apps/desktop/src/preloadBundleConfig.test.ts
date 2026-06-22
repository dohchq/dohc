import { describe, expect, it } from "vitest";
import { preloadBundledRuntimeDeps } from "../electron.vite.config";

describe("preload bundle config", () => {
  it("bundles runtime validators used by the sandboxed preload", () => {
    expect(preloadBundledRuntimeDeps).toEqual(
      expect.arrayContaining(["@dohc/workspace-core", "zod"]),
    );
  });
});
