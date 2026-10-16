import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { desktopTestFiles } from "./vitest.projects.ts";

// At most 8 concurrent workers. Fifteen of these suites open their own temp
// `.dohc/engine/engine.db`, and past roughly eight the filesystem is the
// constraint rather than the CPU — so a bigger machine must not buy more
// contention. Evidence and the failure modes are on #392.
const WORKER_CAP = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 4)));
const require = createRequire(import.meta.url);
const PURE_INSPECTOR_TEST = "src/renderer/FileInspector.test.tsx";
const SHARED_WORKER_SETUP = "./src/testSharedWorkerSetup.ts";
const tests = desktopTestFiles(dirname(fileURLToPath(import.meta.url)), {
  exclude: [PURE_INSPECTOR_TEST],
  // vitest.projects.ts chooses most isolated files from their source. These
  // files need their own worker for a reason their source does not show.
  isolated: [
    // The report bound lasts as long as the window, and the module holds the
    // count. An earlier file in a shared worker would spend part of it.
    "src/renderer/rendererErrorReport.bound.test.ts",
  ],
});

const common = {
  // Source-backed examples outside this package use the same React instance as their desktop tests.
  resolve: { alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  } },
  test: {
    css: { include: [/[?&]raw(?:&|$)/] },
    // A loaded machine stretches honest work: on a 24-process load the slowest
    // share-code test took 1.73 s and site-runner tests took up to 2.3 s.
    // vitest.setup.ts gives Testing Library waits 10 s to match.
    // In a full gate beside other work, the 100-tab-limit shell tests took over
    // 15 s; each passes alone. 30 s matches the storage and service packages.
    testTimeout: 30_000,
    // expect.poll's own default is 1 s; waits get the same 10 s as vitest.setup.ts.
    expect: { poll: { timeout: 10_000 } },
    // node >= 25 ships a default-on WebStorage whose localStorage global is
    // created without a backing file in the workers ("--localstorage-file was
    // provided without a valid path") and shadows jsdom's real Storage, so
    // renderer tests using localStorage (theme.test.ts) fail. Disable node's
    // copy in the test workers; jsdom's localStorage takes over.
    execArgv: ["--no-experimental-webstorage"],
  },
};

const desktop = {
  ...common.test,
  // Renderer hit testing and waits, plus scratch-directory cleanup.
  setupFiles: ["./vitest.setup.ts", "./src/testSetup.ts"],
  globalSetup: ["./src/testGlobalSetup.ts"],
};

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  ...common,
  test: {
    ...common.test,
    // Keep the cap global so --maxWorkers also controls each inline project.
    maxWorkers: WORKER_CAP,
    projects: [
      { ...common, test: { ...desktop, name: "desktop", include: tests.isolated } },
      // Files in a shared project run one after another in the same worker.
      // Each file starts from the worker's baseline: its environment
      // variables, globals, and real timers, and in jsdom an empty document,
      // empty storage, and its DOM prototypes.
      {
        ...common,
        test: {
          ...desktop,
          name: "desktop-shared-dom",
          include: tests.sharedDom,
          isolate: false,
          setupFiles: [...desktop.setupFiles, SHARED_WORKER_SETUP, "./src/testSharedDomSetup.ts"],
        },
      },
      {
        ...common,
        test: {
          ...desktop,
          name: "desktop-shared-node",
          include: tests.sharedNode,
          isolate: false,
          setupFiles: [...desktop.setupFiles, SHARED_WORKER_SETUP],
        },
      },
      {
        ...common,
        test: {
          ...common.test,
          name: "file-inspector-helpers",
          include: [PURE_INSPECTOR_TEST],
          environment: "node",
        },
      },
    ],
  },
});
