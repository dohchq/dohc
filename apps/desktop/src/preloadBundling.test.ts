import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { preloadBundledRuntimeDeps } from "../electron.vite.config";

// #783 — the preload's import graph must be BUNDLED, not required at runtime.
//
// A sandboxed preload has no module resolver. Anything left external becomes a
// bare `require(...)` in `dist/preload/preload.cjs`, Electron refuses the whole
// script, and the window comes up with no `window.dohcDesktop` at all. Nothing
// about that failure names the missing package to the user: the renderer just
// says "dohc desktop bridge is unavailable", and every Playwright spec times
// out waiting for a screen that will never render.
//
// That is exactly what happened. `bridgeContract.ts` gained a VALUE import of
// `@dohc/security-contract/share-selector` (#780) while
// `preloadBundledRuntimeDeps` did not gain the package, and the desktop app
// stopped booting under the harness — silently, because no gate runs the e2e.
//
// The boot smoke in `e2e/desktop-boot.spec.ts` proves the app comes up. This
// test is the one that runs on every `pnpm test`, and it fails on the SOURCE
// change rather than waiting for someone to run an ungated suite.

const here = dirname(fileURLToPath(import.meta.url));

// Electron injects its own module into a preload, so it is the one specifier
// that is legitimately external.
const HOST_PROVIDED = new Set(["electron"]);

// The preload's own graph. `preload.ts` imports nothing else local, and
// `channels.ts` imports nothing at all, so this list is the whole of it — and
// the assertion below fails loudly if `preload.ts` grows a local import this
// list does not name.
const PRELOAD_GRAPH = ["preload.ts", "ipc/bridgeContract.ts", "ipc/channels.ts"];

function sourceOf(relativePath: string): string {
  return readFileSync(join(here, relativePath), "utf8");
}

// Bare-package specifiers this module imports for their VALUES. A
// `import type` never reaches the bundle, so it is not a runtime dependency
// and is deliberately excluded.
function valueImportedPackages(source: string): string[] {
  const packages: string[] = [];
  const importPattern = /^import\s+(?!type\s)([\s\S]*?)from\s+"([^"]+)";/gmu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2]!;
    if (specifier.startsWith(".")) continue;
    packages.push(packageRootOf(specifier));
  }
  return packages;
}

// `@dohc/workspace-contracts/engine` is bundled by naming the PACKAGE, which
// is what the vite `external` list matches on.
function packageRootOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("the sandboxed preload's runtime dependencies", () => {
  it("names every package its graph imports for values", () => {
    const bundled = new Set(preloadBundledRuntimeDeps);
    const missing = new Map<string, string[]>();
    for (const module of PRELOAD_GRAPH) {
      for (const packageName of valueImportedPackages(sourceOf(module))) {
        if (HOST_PROVIDED.has(packageName) || bundled.has(packageName)) continue;
        missing.set(packageName, [...(missing.get(packageName) ?? []), module]);
      }
    }
    expect(
      Object.fromEntries(missing),
      "MUTATION: a value import the preload does not bundle becomes a bare require(), " +
        "Electron refuses the whole preload, and the app boots with no bridge (#783)",
    ).toEqual({});
  });

  it("reads a graph that is still the whole graph", () => {
    // The check above is only as good as the file list it walks. If
    // `preload.ts` gains a local import, this fails and names it.
    const localImports = [
      ...sourceOf("preload.ts").matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+"(\.[^"]+)";/gmu),
    ].map((match) => `${match[1]!.replace(/^\.\//u, "")}.ts`);
    expect(
      [...new Set(localImports)].sort(),
      "MUTATION: a new local import in preload.ts must join PRELOAD_GRAPH, or its " +
        "packages go unchecked",
    ).toEqual(PRELOAD_GRAPH.filter((module) => module !== "preload.ts").sort());
  });

  it("proves the check can fail, so it is not vacuous", () => {
    const bundled = new Set(preloadBundledRuntimeDeps);
    expect(
      valueImportedPackages(sourceOf("ipc/bridgeContract.ts")).filter(
        (packageName) => !HOST_PROVIDED.has(packageName),
      ).length,
      "the bridge contract must actually import packages, or the check proves nothing",
    ).toBeGreaterThan(0);
    expect(bundled.has("@dohc/security-contract")).toBe(true);
  });
});
