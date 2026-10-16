// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "@testing-library/dom";
import { describe, expect, it, vi } from "vitest";
import { leakingHelpers, needsOwnWorker } from "../vitest.projects.ts";

const desktopRoot = resolve(import.meta.dirname, "..");
const sourcePaths = (pattern: string) => globSync(pattern, { cwd: desktopRoot }).map((path) => path.replaceAll("\\", "/"));
const readSource = (path: string) => readFileSync(resolve(desktopRoot, path), "utf8");

interface ResolvedProject { name: string; maxWorkers: number; isolate: boolean; files: string[] }

let resolved: ResolvedProject[] | undefined;
function resolvedProjects(): ResolvedProject[] {
  resolved ??= JSON.parse(execFileSync(process.execPath, [resolve(import.meta.dirname, "vitestProjects.fixture.mjs")], {
    cwd: desktopRoot,
    encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VITEST_MAX_WORKERS: "" },
  }).trim().split(/\r?\n/u).at(-1)!) as ResolvedProject[];
  return resolved;
}

// Guards that `vitest.setup.ts` is registered, not what it does.
//
// The setup file gives jsdom the document.elementFromPoint that
// prosemirror-view's posAtCoords calls. Without it that call throws inside a
// mousedown listener rather than inside a test, so vitest fails the run on an
// unhandled error and reports 0 failed tests. A run that exits 1 while naming
// nothing costs a review round to attribute.
//
// So the protection needs a name of its own. Drop `./vitest.setup.ts` from
// `setupFiles` and these two tests fail, deterministically, in one worker,
// pointing at the config line to restore.
//
// Setup files run per test file, so the method being present here is the same
// registration that puts it in every other file.
describe("apps/desktop vitest setup", () => {
  it("is registered, so jsdom has the document.elementFromPoint ProseMirror calls", () => {
    expect(typeof document.elementFromPoint).toBe("function");
  });

  it("answers a hit test rather than throwing the TypeError that failed whole runs", () => {
    expect(() => document.elementFromPoint(0, 0)).not.toThrow();
  });

  it("gives Testing Library waits the loaded-machine window, not its own 1 s default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(10_000);
  });

  it("gives vi.waitFor and expect.poll the same window, not vitest's 1 s default", async () => {
    const start = performance.now();
    const elapsed = () => performance.now() - start;
    await Promise.all([
      vi.waitFor(() => expect(elapsed()).toBeGreaterThan(1_100)),
      expect.poll(elapsed).toBeGreaterThan(1_100),
    ]);
  });

  it("keeps vitest's default for vi.waitFor under fake timers, where each check advances the clock", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      await expect(vi.waitFor(() => expect(false).toBe(true))).rejects.toThrow();
      expect(Date.now() - start).toBeLessThanOrEqual(1_100);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The desktop tests run in an isolated project and in shared projects, one per
// environment. vitest.projects.ts decides which files may share a worker.
describe("apps/desktop vitest projects", () => {
  it("honors an explicit CLI worker limit in every resolved project", () => {
    const projects = resolvedProjects();
    expect(projects.length).toBeGreaterThan(1);
    expect(projects.filter((project) => project.maxWorkers !== 1)).toEqual([]);
  });

  it("runs every desktop test file in exactly one project", () => {
    const runs = resolvedProjects().flatMap((project) => project.files).sort();
    expect(runs).toEqual(sourcePaths("src/**/*.test.{ts,tsx}").sort());
  });

  it("shares a worker only among files of one environment that the rule lets share", () => {
    const helpers = leakingHelpers(new Map(sourcePaths("src/**/*.{ts,tsx}")
      .filter((path) => !/\.test\.tsx?$/u.test(path))
      .map((path) => [path, readSource(path)])));
    const shared = resolvedProjects().filter((project) => !project.isolate);
    expect(shared.length).toBeGreaterThan(0);
    for (const project of shared) {
      const sources = project.files.map(readSource);
      expect(new Set(sources.map((source) => source.includes("@vitest-environment jsdom"))).size, project.name).toBe(1);
      expect(project.files.filter((_, index) => needsOwnWorker(sources[index], helpers)), project.name).toEqual([]);
    }
  });
});

describe("the rule that gives a desktop test file a worker of its own", () => {
  const helpers = leakingHelpers(new Map([
    ["src/a.testHarness.tsx", 'import { afterEach } from "vitest";\nafterEach(() => {});\n'],
    ["src/b.testSupport.tsx", 'import { vi } from "vitest";\nimport "./a.testHarness";\n'],
    ["src/c.ts", 'export * from "./b.testSupport.tsx";\n'],
    ["src/d.testSupport.ts", 'import { afterEach, vi } from "vitest";\nexport function track() {\n  afterEach(() => {});\n  return vi.fn();\n}\n'],
    ["src/legendList.ts", 'import { vi } from "vitest";\nvi.mock("@legendapp/list");\n'],
    ["src/e.editor-fixture.ts", 'import { vi } from "vitest";\nexport function shim() {\n  Object.defineProperty(Range.prototype, "getClientRects", { value: vi.fn() });\n}\n'],
    ["src/polyfill.ts", 'Object.defineProperty(window, "requestIdleCallback", { value: () => 0 });\n'],
  ]));

  it("finds the test helpers that register hooks or mocks or define shared properties, through any import", () => {
    expect([...helpers].sort()).toEqual(["a.testHarness", "b.testSupport", "c", "e.editor-fixture", "legendList"]);
  });

  it.each([
    ['vi.mock("./store");', true],
    ['vi.doMock("./store");', true],
    ["vi.resetModules();", true],
    ['import "./a.testHarness";', true],
    ['import { render } from "../c";', true],
    ['const { mount } = await import("./b.testSupport");', true],
    ['import { track } from "./d.testSupport";', false],
    ['vi.stubGlobal("dohcDesktop", bridge);', true],
    ['vi.stubGlobal("dohcDesktop", bridge);\nafterEach(() => vi.unstubAllGlobals());', false],
    ['vi.spyOn(console, "error");', false],
    ['Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });', true],
    ['Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });', true],
    ['Object.defineProperty(navigator, "clipboard", { value: clipboard });', true],
    ['Object.defineProperty(list, "clientHeight", { configurable: true, value: 500 });', false],
    ['import { shim } from "./e.editor-fixture";', true],
    ['import "./polyfill";', false],
  ])("decides whether %j needs its own worker: %s", (source, own) => {
    expect(needsOwnWorker(source, helpers)).toBe(own);
  });
});
