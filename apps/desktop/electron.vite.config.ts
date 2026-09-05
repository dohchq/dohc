import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

// Electron 43.3.0 ships Chromium 150 and Node 24.18. electron-vite 5.0.0
// maps Electron targets only through major 39, so keep these explicit until
// upstream support lands. Update both with the `electron` pin in package.json.
const electronMainTarget = "node24.18";
const electronRendererTarget = "chrome150";

export const mainBundledWorkspaceDeps = [
  "@dohc/cli",
  "@dohc/live-session-contract",
  "@dohc/sdk",
  "@dohc/security-contract",
  "@dohc/workspace-core",
  "@dohc/workspace-contracts",
  "@dohc/workspace-engine-client",
  "@dohc/workspace-fs",
  "@dohc/ydoc-projection",
  "@dohc/sqlite-worker",
];

export const preloadBundledRuntimeDeps = [
  // Sandboxed preloads cannot resolve app/workspace packages at runtime.
  "@dohc/live-session-contract",
  "@dohc/workspace-contracts",
  "@dohc/workspace-core",
  // The bridge contract reads the share access levels from the one place both
  // sides define them, and a value import from a sandboxed preload has to be
  // bundled like any other. Left external, the built preload carried a bare
  // `require("@dohc/security-contract/share-selector")`, Electron refused the
  // whole script, and every window came up with no bridge at all — which is
  // every desktop e2e, silently, for as long as the import has existed.
  "@dohc/security-contract",
  "effect",
  "zod",
];

export const mainBuildEntries = {
  main: "src/main.ts",
  "plugin-host": "src/plugins/pluginHostProcess.ts",
  "pnpm-runner": "src/plugins/pluginPnpmRunnerProcess.ts",
  "workspace-database-worker":
    "src/workspaces/workspaceDatabaseThread.ts",
};

function effectFree(surface: "preload" | "renderer"): Plugin {
  return {
    name: `effect-free-${surface}`,
    enforce: "pre",
    resolveId(source) {
      const moduleId = source.replace(/[?#].*$/u, "");
      if (moduleId === "effect" || moduleId.startsWith("effect/")) {
        throw new Error(
          `${surface} cannot import ${source}. Move shared values to an Effect-free module.`,
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Minify production builds only. electron-vite also builds main and
  // preload during dev, and minifying those mangles dev stack traces.
  const minify = mode === "production" ? ("esbuild" as const) : false;
  return {
    main: {
      // Workspace packages ship raw TS — they must be bundled, not
      // externalized, or Node ESM fails on their extensionless imports.
      // chokidar and other real npm deps stay external (loaded from node_modules).
      plugins: [
        externalizeDepsPlugin({
          exclude: mainBundledWorkspaceDeps,
        }),
      ],
      build: {
        target: electronMainTarget,
        minify,
        outDir: "dist/main",
        lib: {
          entry: mainBuildEntries,
        },
      },
    },
    preload: {
      plugins: [
        effectFree("preload"),
        externalizeDepsPlugin({
          exclude: preloadBundledRuntimeDeps,
        }),
      ],
      build: {
        target: electronMainTarget,
        minify,
        outDir: "dist/preload",
        // Sandboxed preloads must be CommonJS.
        lib: { entry: "src/preload.ts", formats: ["cjs"] },
      },
    },
    renderer: {
      root: "src/renderer",
      plugins: [effectFree("renderer"), react(), tailwindcss()],
      build: {
        target: electronRendererTarget,
        minify,
        outDir: "dist/renderer",
      },
    },
  };
});
