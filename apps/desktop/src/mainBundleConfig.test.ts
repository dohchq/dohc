import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mainBundledWorkspaceDeps } from "../electron.vite.config";

// electron-vite's externalizeDepsPlugin externalizes every entry in this
// package's `dependencies` that is not listed in `mainBundledWorkspaceDeps`.
// Workspace packages ship raw TypeScript whose relative imports are
// extensionless, so an externalized one resolves fine at build time and then
// dies at RUNTIME the first time the main process imports it:
//
//   ERR_MODULE_NOT_FOUND: Cannot find module '.../workspace-core/src/workspaceMode'
//     imported from .../workspace-core/src/index.ts
//
// Nothing else catches this. vitest and tsc resolve the TypeScript sources
// directly, so typecheck and the unit suite stay green; only a dev or packaged
// launch fails. This test is that missing guard.
//
// It scans the main-process sources rather than the dependency list, because
// renderer-only packages (@dohc/brand) and separately-spawned ones (@dohc/mcp)
// are dependencies that the main bundle legitimately never imports. Type-only
// imports are counted too: those specifiers are erased at build time, so
// bundling them is harmless, and treating them as reachable keeps the guard
// from going quiet the moment a type-only import becomes a value import.
const MAIN_SOURCE_ROOT = join(__dirname);
const RENDERER_DIR = join(MAIN_SOURCE_ROOT, "renderer");

function mainProcessSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (path === RENDERER_DIR) continue;
      mainProcessSourceFiles(path, found);
      continue;
    }
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    found.push(path);
  }
  return found;
}

describe("main bundle config", () => {
  it("bundles every workspace package the main process imports", () => {
    const imported = new Set<string>();
    for (const file of mainProcessSourceFiles(MAIN_SOURCE_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(@dohc\/[a-z0-9-]+)/g)) {
        imported.add(match[1] as string);
      }
    }

    expect(imported.size).toBeGreaterThan(0);

    const externalized = [...imported]
      .filter((name) => !mainBundledWorkspaceDeps.includes(name))
      .sort();

    expect(
      externalized,
      "these workspace packages are imported by main-process sources but are " +
        "not in mainBundledWorkspaceDeps, so electron-vite will externalize " +
        "them and the main process will fail at runtime on their extensionless " +
        "raw-TypeScript imports. Add them to mainBundledWorkspaceDeps in " +
        "apps/desktop/electron.vite.config.ts.",
    ).toEqual([]);
  });
});
