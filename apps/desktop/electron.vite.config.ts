import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

// Electron 42 ships Chromium 148 and Node 24.15. electron-vite 5.0.0
// currently only maps Electron targets through major 39, so keep these
// explicit until upstream support lands.
const electronMainTarget = "node24.15";
const electronRendererTarget = "chrome148";

export const mainBundledWorkspaceDeps = [
  "@dohc/cli",
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
  "@dohc/workspace-contracts",
  "@dohc/workspace-core",
  "zod",
];

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

export default defineConfig({
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
      outDir: "dist/main",
      lib: { entry: "src/main.ts" },
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
      outDir: "dist/renderer",
    },
  },
});
