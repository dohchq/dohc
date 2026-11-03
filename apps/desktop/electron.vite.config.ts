import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

// Electron 43.3.0 ships Chromium 150 and Node 24.18. electron-vite 5.0.0
// maps Electron targets only through major 39, so keep these explicit until
// upstream support lands. Update both with the `electron` pin in package.json.
const electronMainTarget = "node24.18";
const electronRendererTarget = "chrome150";

export const mainBundledWorkspaceDeps = [
  "@dohc/app-backend-runtime",
  "@dohc/app-browser",
  "@dohc/automation-executor",
  "@dohc/cli",
  "@dohc/excalidraw-scene",
  "@dohc/live-session-contract",
  "@dohc/security-contract",
  "@dohc/service-http",
  "@dohc/sync-relay",
  "@dohc/workspace-core",
  "@dohc/workspace-contracts",
  "@dohc/workspace-engine-client",
  "@dohc/workspace-fs",
  "@dohc/ydoc-projection",
  "@dohc/sqlite-worker",
];

export const preloadBundledRuntimeDeps = [
  // Sandboxed preloads cannot resolve app/workspace packages at runtime.
  "@dohc/cli",
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

// Electron starts dist/main/main.js, the small entry module that counts the
// launch and then imports the app's main module, dist/main/app.js.
export const mainBuildEntries = {
  main: "src/entry.ts",
  app: "src/main.ts",
  "workspace-database-worker":
    "src/workspaces/workspaceDatabaseThread.ts",
  "document-projection-worker":
    "src/workspaces/documentProjectionThread.ts",
  "workspace-files-worker": "src/workspaces/workspaceFilesThread.ts",
  "collection-history-worker": "src/workspaces/localDatasetHistoryThread.ts",
};

// micromark's browser build decodes character references through a DOM
// element, and the chat Markdown worker has no DOM. Every renderer context
// uses the package's entity table instead.
export const rendererAlias = {
  "decode-named-character-reference": createRequire(import.meta.url).resolve("decode-named-character-reference"),
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

// The PostHog project a release build reports to, compiled into main.
// Empty values name none; see src/telemetry/reportingConfig.ts.
export function reportingBuild(env: NodeJS.ProcessEnv = process.env) {
  return {
    posthogKey: env.DOHC_POSTHOG_KEY?.trim() ?? "",
    posthogHost: env.DOHC_POSTHOG_HOST?.trim() ?? "",
    dist: env.DOHC_DESKTOP_DIST?.trim() ?? "",
  };
}

export default defineConfig(({ mode }) => {
  // Minify production builds only. electron-vite also builds main and
  // preload during dev, and minifying those mangles dev stack traces.
  const minify = mode === "production" ? ("esbuild" as const) : false;
  // A production build writes source maps beside its files with no link to
  // them, so error reports can be read against them. electron-builder.yml
  // leaves them out of the installer.
  const sourcemap = mode === "production" ? ("hidden" as const) : false;
  return {
    main: {
      define: { __DOHC_REPORTING__: JSON.stringify(reportingBuild()) },
      // Workspace packages ship raw TS — they must be bundled, not
      // externalized, or Node ESM fails on their extensionless imports.
      // Bundle Effect's schema runtime to remove unused code and separate
      // module loads at startup. Bundle the updater's dynamic import for the
      // same reason, while preserving when update initialization runs.
      plugins: [
        externalizeDepsPlugin({
          exclude: [...mainBundledWorkspaceDeps, "effect", "electron-updater"],
        }),
      ],
      build: {
        target: electronMainTarget,
        minify,
        sourcemap,
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
        sourcemap,
        outDir: "dist/preload",
        // Sandboxed preloads must be CommonJS.
        lib: { entry: "src/preload.ts", formats: ["cjs"] },
      },
    },
    renderer: {
      root: "src/renderer",
      plugins: [effectFree("renderer"), react(), tailwindcss()],
      resolve: { alias: rendererAlias },
      build: {
        target: electronRendererTarget,
        minify,
        sourcemap,
        outDir: "dist/renderer",
      },
    },
  };
});
