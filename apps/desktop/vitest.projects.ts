import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The desktop tests run in three vitest projects. A file runs in a worker of
// its own when it would leave something behind for the next file in a shared
// worker. Every other file shares a worker with files of its environment, so
// the worker never restarts to switch between jsdom and node.
//
// Each shared file starts from its worker's baseline: environment variables,
// own globals, nothing stubbed, real timers, and in jsdom an empty document
// and storage, the root element's attributes, and RESTORED_PROTOTYPES
// (testSharedWorkerSetup.ts and testSharedDomSetup.ts). What that reset cannot
// undo sends a file to a worker of its own. A worker that runs several files
// keeps its module mocks and evaluated modules, so a file runs on its own when
// it:
//
// - calls vi.mock, vi.doMock, or vi.resetModules;
// - stubs a global with vi.stubGlobal and never calls vi.unstubAllGlobals;
// - defines a property on a window object, a DOM constructor, or its
//   prototype with Object.defineProperty. The property is read-only unless the
//   definition says otherwise, so a later file cannot assign it;
// - assigns to the prototype of a class outside RESTORED_PROTOTYPES;
// - listens for error or unhandledrejection on window. vitest's jsdom
//   environment reports an uncaught error only while no other listener does,
//   so every later file in the worker would pass with uncaught errors;
// - imports a test helper that does any of these, registers hooks when first
//   imported, or keeps vi.fn() mocks in a top-level declaration. The helper
//   runs once per worker, so its hooks register for one file and its mocks
//   keep every file's calls.

/** The DOM prototypes a shared jsdom file gets back as its worker started with them. */
export const RESTORED_PROTOTYPES = ["EventTarget", "Node", "Element", "HTMLElement", "HTMLInputElement", "Document", "HTMLDocument"];

const MODULE_MOCKS = /\bvi\s*\.\s*(?:mock|doMock|resetModules)\s*\(/u;
const TOP_LEVEL_HOOK = /^(?:beforeAll|beforeEach|afterEach|afterAll)\s*\(/mu;
const SHARED_DEFINITION = /\bObject\s*\.\s*definePropert(?:y|ies)\s*\(\s*(?:globalThis|window|document|navigator|crypto|[A-Z]\w*(?:\.prototype)?)\b/u;
const PROTOTYPE_ASSIGNMENT = new RegExp(`\\b(?!(?:${RESTORED_PROTOTYPES.join("|")})\\.prototype\\b)[A-Z]\\w*\\.prototype\\.[\\w$]+\\s*=(?!=)`, "u");
const ERROR_LISTENER = /\b(?:window|globalThis|self)\s*\.\s*addEventListener\s*\(\s*["'`](?:error|unhandledrejection)["'`]/u;
const STUB_GLOBAL = /\bvi\s*\.\s*stubGlobal\s*\(/u;
const UNSTUB_GLOBALS = /\bvi\s*\.\s*unstubAllGlobals\s*\(/u;
const MOCK_FUNCTION = /\bvi\s*\.\s*fn\s*\(/u;
const DECLARATION = /^(?:export\s+)?(?:const|let|var)\s/u;
const FUNCTION_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+(?:\s*:[^=]+)?\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/u;
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

/**
 * The module name an import specifier or a file path names, without its
 * extension. A directory's index module takes the directory's name, the way
 * `import "./support"` names `support/index.ts`.
 */
function moduleName(path: string): string {
  const parts = path.replace(/\.[cm]?[jt]sx?$/u, "").split("/");
  const name = parts.at(-1) ?? "";
  return name === "index" && parts.length > 1 ? parts.at(-2) ?? name : name;
}

function importedNames(source: string): string[] {
  return [...source.matchAll(IMPORTED)].map((match) => moduleName(match[1]));
}

/** Whether a top-level declaration that is not a function creates vi.fn() mocks. Top-level statements start a line. */
function hasTopLevelMocks(source: string): boolean {
  return source.split(/^(?=\S)/mu)
    .some((statement) => DECLARATION.test(statement) && !FUNCTION_DECLARATION.test(statement) && MOCK_FUNCTION.test(statement));
}

/** Whether test source changes what the next file in a shared worker sees, in a way the reset cannot undo. */
function leaves(source: string): boolean {
  return MODULE_MOCKS.test(source) || SHARED_DEFINITION.test(source) || PROTOTYPE_ASSIGNMENT.test(source) || ERROR_LISTENER.test(source);
}

/**
 * The names of test helpers that leave something behind, register hooks when
 * imported, or keep top-level vi.fn() mocks, and of modules that import such a
 * helper. A test helper is a module that mentions vitest. A product module that
 * patches a global does so once per worker, whether or not files share it.
 */
export function leakingHelpers(helpers: ReadonlyMap<string, string>): Set<string> {
  const leaking = new Set([...helpers]
    .filter(([, source]) => source.includes("vitest") && (leaves(source) || TOP_LEVEL_HOOK.test(source) || hasTopLevelMocks(source)))
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

/** Whether a test file would leave something in a shared worker that the reset cannot undo. */
export function needsOwnWorker(source: string, helpers: ReadonlySet<string>): boolean {
  return leaves(source)
    || importedNames(source).some((name) => helpers.has(name))
    || (STUB_GLOBAL.test(source) && !UNSTUB_GLOBALS.test(source));
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
