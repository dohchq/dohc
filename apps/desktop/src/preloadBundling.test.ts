import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import desktopConfig, { preloadBundledRuntimeDeps } from "../electron.vite.config";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageRootOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

it("bundles every package reached by the preload's local runtime import graph", async () => {
  const config = await desktopConfig({ command: "build", mode: "production" });
  const library = config.preload?.build?.lib;
  if (!library) throw new Error("The preload must have a configured build entry");

  // Follow local imports through the bundler, which erases type-only imports.
  // Leaving packages external exposes the runtime package boundary in its output.
  const { metafile } = await build({
    absWorkingDir: desktopRoot,
    entryPoints: typeof library.entry === "string" ? [library.entry] : library.entry,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    outdir: "preload-graph",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const allowed = new Set(["electron", ...preloadBundledRuntimeDeps]);
  const missing = [...new Set(
    Object.values(metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((dependency) => dependency.external)
      .map((dependency) => packageRootOf(dependency.path))
      .filter((packageName) => !allowed.has(packageName)),
  )].sort();

  expect(
    missing,
    "Sandboxed preloads cannot resolve these packages; add them to preloadBundledRuntimeDeps",
  ).toEqual([]);
});
