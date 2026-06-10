import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
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
    build: {
      outDir: "dist/renderer",
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});
