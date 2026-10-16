import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The desktop tests run in three vitest projects. A file runs in a worker of
// its own when it would leave something behind for the next file in a shared
// worker. Every other file shares a worker with files of its environment, so
// the worker never restarts to switch between jsdom and node.
//
// A worker that runs several files keeps two things vitest resets between
// isolated files: its module mocks and its evaluated modules. So a file runs
// on its own when it:
//
// - calls vi.mock, vi.doMock, or vi.resetModules;
// - imports a helper that registers hooks or mocks when it is first imported,
//   because that helper runs once per worker, not once per file;
// - stubs a global with vi.stubGlobal and never calls vi.unstubAllGlobals;
// - defines a property on a window object, a DOM constructor, or its
//   prototype with Object.defineProperty. The property outlives the file, and
//   it is read-only unless the definition says otherwise.

const MODULE_MOCKS = /\bvi\.(?:mock|doMock|resetModules)\(/u;
const TOP_LEVEL_HOOK = /^(?:beforeAll|beforeEach|afterEach|afterAll)\(/mu;
const SHARED_DEFINITION = /\bObject\.definePropert(?:y|ies)\(\s*(?:globalThis|window|document|navigator|crypto|[A-Z]\w*(?:\.prototype)?)\b/u;
const IMPORTED = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/gu;
const JSDOM = "@vitest-environment jsdom";

export interface DesktopTestFiles {
  /** Each file runs in a worker of its own. */
  isolated: string[];
  /** jsdom files that share workers. */
  sharedDom: string[];
  /** node files that share workers. */
  sharedNode: string[];
}

/** The module name an import specifier or a file path names, without its extension. */
function moduleName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.[cm]?[jt]sx?$/u, "");
}

function importedNames(source: string): string[] {
  return [...source.matchAll(IMPORTED)].map((match) => moduleName(match[1]));
}

/**
 * The names of test helpers that register hooks or mocks when imported or that
 * define properties on shared window objects, and of modules that import such a
 * helper. A test helper is a module that mentions vitest. A product module that
 * patches a global does so once per worker, whether or not files share it.
 */
export function leakingHelpers(helpers: ReadonlyMap<string, string>): Set<string> {
  const leaking = new Set([...helpers]
    .filter(([, source]) => source.includes("vitest")
      && (MODULE_MOCKS.test(source) || TOP_LEVEL_HOOK.test(source) || SHARED_DEFINITION.test(source)))
    .map(([path]) => moduleName(path)));
  const imports = [...helpers].map(([path, source]) => ({ name: moduleName(path), imported: importedNames(source) }));
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, imported } of imports) {
      if (!leaking.has(name) && imported.some((other) => leaking.has(other))) {
        leaking.add(name);
        grew = true;
      }
    }
  }
  return leaking;
}

/** Whether a test file would leave module mocks, helper hooks, or changed globals in a shared worker. */
export function needsOwnWorker(source: string, helpers: ReadonlySet<string>): boolean {
  return MODULE_MOCKS.test(source)
    || SHARED_DEFINITION.test(source)
    || importedNames(source).some((name) => helpers.has(name))
    || (source.includes("vi.stubGlobal(") && !source.includes("vi.unstubAllGlobals("));
}

/** Sorts the test files under `root/src` into the three desktop projects. */
export function desktopTestFiles(
  root: string,
  { exclude, isolated }: { exclude: readonly string[]; isolated: readonly string[] },
): DesktopTestFiles {
  const sources = new Map(globSync("src/**/*.{ts,tsx}", { cwd: root })
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !exclude.includes(path))
    .map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const isTest = (path: string) => /\.test\.tsx?$/u.test(path);
  const missing = isolated.filter((path) => !isTest(path) || !sources.has(path));
  if (missing.length) throw new Error(`These isolated test files do not exist: ${missing.join(", ")}`);
  const helpers = leakingHelpers(new Map([...sources].filter(([path]) => !isTest(path))));
  const files: DesktopTestFiles = { isolated: [], sharedDom: [], sharedNode: [] };
  for (const [path, source] of [...sources].filter(([path]) => isTest(path)).sort(([a], [b]) => a.localeCompare(b))) {
    if (isolated.includes(path) || needsOwnWorker(source, helpers)) files.isolated.push(path);
    else if (source.includes(JSDOM)) files.sharedDom.push(path);
    else files.sharedNode.push(path);
  }
  return files;
}
