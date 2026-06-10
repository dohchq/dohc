import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // Workspace packages ship raw TS — they must be bundled, not
    // externalized, or Node ESM fails on their extensionless imports.
    // chokidar and other real npm deps stay external (loaded from node_modules).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@dohc/workspace-core",
          "@dohc/workspace-contracts",
          "@dohc/workspace-fs",
          "@dohc/workspace-sync",
          "@dohc/workspace-history",
        ],
      }),
    ],
    build: {
      outDir: "dist/main",
      lib: { entry: "src/main.ts" },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      // Sandboxed preloads must be CommonJS.
      lib: { entry: "src/preload.ts", formats: ["cjs"] },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});
