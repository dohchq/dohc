import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// R16 ratchet. The legacy TypeScript engine `@dohc/workspace-engine` is being
// deleted in favour of the Rust daemon. Deleting it is blocked on work tracked
// on #391, but NOTHING should be allowed to add a new production dependency on
// it while that work is in flight — every new importer is another thing to
// unpick later.
//
// So this asserts SET EQUALITY against the list below, not "no more than".
// Adding an importer fails, and so does removing one without editing the list:
// the shrinking is the point, and it should be a deliberate, reviewed edit that
// records the win rather than a number that quietly drifts.
//
// Type-only imports are fine — they carry no runtime dependency and vanish at
// build time — so they are not listed and not counted.

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const LEGACY_PACKAGE = "@dohc/workspace-engine";

// Production files with a RUNTIME import of the legacy engine. Shrink this list
// as the migration proceeds; never grow it.
//
// Both entries are blocked on the same thing (#391): `workspaceEngineCapture`
// imports the two store factories used by the daemon-unavailable fallback, and
// `ydocEngineProviderSession` is the legacy provider session that fallback
// selects. Its Rust replacement already exists.
//
// Eleven other production files name this package but import only TYPES, so
// they are absent by design, not by omission — see the parser tests below.
const ALLOWED = [
  "apps/desktop/src/collab/ydocEngineProviderSession.ts",
  "apps/desktop/src/workspaces/workspaceEngineCapture.ts",
] as const;

const SCAN_ROOTS = ["apps", "packages", "services"];

// Shipping code, in any language that reaches a user. `.js` is included because
// two packages expose JavaScript launchers as their `bin` — packages/cli
// bin/dohc.js and packages/mcp bin/dohc-mcp.js — so a legacy dependency added to
// either would ship while a TypeScript-only scan stayed green.
const SCANNED_SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

// Not production: the legacy package itself, test files, Playwright specs, and
// build/QA tooling.
function isProductionSource(posixPath: string): boolean {
  if (posixPath.startsWith("packages/workspace-engine/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posixPath)) return false;
  if (posixPath.includes("/e2e/")) return false;
  if (posixPath.includes("/scripts/")) return false;
  if (posixPath.includes("/testing/")) return false;
  // Build and test tooling that happens to sit at a package root rather than
  // under scripts/ — electron.vite.config.ts, playwright.config.ts,
  // vitest.config.ts. These run on a developer's machine, never a user's.
  if (/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(posixPath)) return false;
  // Declaration files carry no runtime import — everything in them is erased,
  // including `import Engine = require(…)`.
  if (/\.d\.[cm]?ts$/.test(posixPath)) return false;
  return SCANNED_SOURCE.test(posixPath);
}

function scriptKindFor(posixPath: string): ts.ScriptKind {
  if (posixPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (posixPath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(posixPath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "target",
  ".git",
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else out.push(full);
  }
}

// Detection is an AST walk, not a regex. The regex version of this shipped one
// false negative already: a lazy clause pattern started matching at the FIRST
// import in a file and spanned every statement up to the target's `from`, so a
// file opening with `import type { … } from "@dohc/workspace-core"` produced a
// clause beginning with `type` and a genuine runtime import was waved through.
// Patching the pattern fixed that instance; the class remains — comments between
// `import` and its parenthesis, the specifier appearing inside a string or a
// comment, `loader.require(…)` masquerading as `require(…)`. The compiler
// already knows the difference, so ask it.
const LEGACY_SOURCE_DIR = "packages/workspace-engine/";

// The package name, OR a relative path that lands inside the package. Reaching
// into another package's source by relative path is an established pattern here
// (apps/desktop/e2e/workspace-agent-attribution.spec.ts:19 does it), so a
// name-only comparison would miss a real runtime dependency added that way.
function isLegacySpecifier(specifier: string, fromFile: string): boolean {
  if (specifier === LEGACY_PACKAGE || specifier.startsWith(`${LEGACY_PACKAGE}/`)) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return resolved.startsWith(LEGACY_SOURCE_DIR);
}

// True when the whole declaration is erased at build time: `import type { X }`,
// or named bindings that are ALL individually `type`. One value binding among
// them makes the declaration runtime.
function isErasedImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // bare `import "pkg"` — side effect
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)) {
    return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
  }
  return false;
}

function hasRuntimeLegacyImport(source: string, fileName = "probe.ts"): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(fileName),
  );
  // `createRequire` bindings are runtime loaders under another name, and this
  // repo uses them DELIBERATELY: workspaceDatabase.ts:18 explains that bundlers
  // emitting a CommonJS shim inject their own top-level `const require`, so a
  // second declaration is a SyntaxError. Production therefore names them
  // `requireFromHere` / `requireModule` — and the legacy package does it too
  // (linkedChatStore.ts:199). Matching only a callee literally named `require`
  // would leave the ratchet open along the path the codebase already prefers.
  const requireAliases = new Set<string>(["require"]);
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined && ts.isCallExpression(init)) {
        const callee = init.expression;
        const isCreateRequire =
          (ts.isIdentifier(callee) && callee.text === "createRequire") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire");
        if (isCreateRequire) requireAliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteralLike(spec) && isLegacySpecifier(spec.text, fileName) && !isErasedImport(node)) {
        found = true;
        return;
      }
    } else if (ts.isExportDeclaration(node)) {
      // `export { x } from "pkg"` re-exports a value; `export type { X }` does
      // not — and neither does `export { type X }`, whose specifiers are each
      // type-only while the declaration itself is not.
      const spec = node.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteralLike(spec) && isLegacySpecifier(spec.text, fileName)) {
        const clause = node.exportClause;
        const allSpecifiersErased =
          clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((e) => e.isTypeOnly);
        if (!node.isTypeOnly && !allSpecifiersErased) {
          found = true;
          return;
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import Engine = require("pkg")`.
      const ref = node.moduleReference;
      if (
        ts.isExternalModuleReference(ref) &&
        ts.isStringLiteralLike(ref.expression) &&
        isLegacySpecifier(ref.expression.text, fileName) &&
        !node.isTypeOnly
      ) {
        found = true;
        return;
      }
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isStringArg =
          arg !== undefined && ts.isStringLiteralLike(arg) && isLegacySpecifier(arg.text, fileName);
      if (isStringArg) {
        // `import("pkg")`, and a BARE `require("pkg")` — but not a method call
        // such as `loader.require("pkg")`, which is not Node's require.
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isBareRequire =
          ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text);
        // Node's CommonJS `module.require(...)`, which really does load — unlike
        // an arbitrary `loader.require(...)` method, which does not.
        const isModuleRequire =
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "module" &&
          node.expression.name.text === "require";
        if (isDynamicImport || isBareRequire || isModuleRequire) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("legacy engine production imports (R16 ratchet)", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  const importers = files
    .map((f) => relative(REPO_ROOT, f).split(sep).join("/"))
    .filter(isProductionSource)
    .filter((p) => hasRuntimeLegacyImport(readFileSync(join(REPO_ROOT, p), "utf8"), p))
    .sort();

  it("actually reached every scan root — a scan that matched nothing would pass vacuously", () => {
    // Without this, a broken REPO_ROOT or an over-eager skip list turns the
    // assertion below into [] === [] the moment the allowlist empties.
    //
    // One sentinel per scan root rather than a total file count. A count is a
    // proxy for "did the walk work" that also rejects legitimate deletion once
    // the repo shrinks past whatever number you picked, and there is no measured
    // healthy range to pick from. These three prove each root was walked, and
    // they fail loudly if one is ever renamed — which is the correct outcome,
    // since a renamed sentinel means this guard is no longer checking that root.
    const scanned = new Set(
      files.map((f) => relative(REPO_ROOT, f).split(sep).join("/")),
    );
    for (const sentinel of [
      "apps/desktop/src/main.ts",
      "packages/workspace-contracts/src/engine.ts",
      "services/sync-relay/src/errorCodes.ts",
    ]) {
      expect(scanned, `scan root for ${sentinel} was not walked`).toContain(
        sentinel,
      );
    }
  });

  it("matches the allowlist exactly, so the count can only shrink deliberately", () => {
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it("still detects a runtime import that hides among type-only specifiers", () => {
    // Guards the parser itself: the discrimination above is the whole test, and
    // a parser that called everything type-only would report zero importers.
    expect(
      hasRuntimeLegacyImport(`import type { A } from "${LEGACY_PACKAGE}";`),
    ).toBe(false);
    expect(
      hasRuntimeLegacyImport(
        `import { type A, type B } from "${LEGACY_PACKAGE}";`,
      ),
    ).toBe(false);
    expect(
      hasRuntimeLegacyImport(
        `import { type A, thing } from "${LEGACY_PACKAGE}";`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`import { thing } from "${LEGACY_PACKAGE}";`),
    ).toBe(true);
    expect(hasRuntimeLegacyImport(`import "${LEGACY_PACKAGE}";`)).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `import { thing } from "${LEGACY_PACKAGE}/testing";`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `import { thing } from "@dohc/workspace-engine-client";`,
      ),
    ).toBe(false);
  });

  it("is not fooled by the shapes a regex gets wrong", () => {
    // Each of these is why detection is an AST walk. A pattern match gets at
    // least one of them wrong, and the failure direction that matters is the
    // false NEGATIVE — a guard that cannot see an importer.
    const L = LEGACY_PACKAGE;

    // The specifier inside a string or a comment is not an import.
    expect(hasRuntimeLegacyImport(`const example = 'import("${L}")';`)).toBe(false);
    expect(hasRuntimeLegacyImport(`// see await import("${L}") for the old way`)).toBe(false);
    expect(hasRuntimeLegacyImport(`/* import { x } from "${L}"; */`)).toBe(false);

    // A method call named `require` is not Node's require.
    expect(hasRuntimeLegacyImport(`loader.require("${L}");`)).toBe(false);
    expect(hasRuntimeLegacyImport(`this.require("${L}");`)).toBe(false);

    // A comment between the keyword and the parenthesis does not hide it.
    expect(hasRuntimeLegacyImport(`await import(/* lazy */ "${L}");`)).toBe(true);
    expect(hasRuntimeLegacyImport(`const m = require(
  "${L}",
);`)).toBe(true);

    // Re-exports: a value re-export is runtime, a type re-export is not.
    expect(hasRuntimeLegacyImport(`export { thing } from "${L}";`)).toBe(true);
    expect(hasRuntimeLegacyImport(`export type { Thing } from "${L}";`)).toBe(false);
    expect(hasRuntimeLegacyImport(`export { type Thing } from "${L}";`)).toBe(false);

    // Default and namespace imports are runtime; their type-only forms are not.
    expect(hasRuntimeLegacyImport(`import thing from "${L}";`)).toBe(true);
    expect(hasRuntimeLegacyImport(`import * as all from "${L}";`)).toBe(true);
    expect(hasRuntimeLegacyImport(`import type thing from "${L}";`)).toBe(false);

    // A prefix collision must not match.
    expect(hasRuntimeLegacyImport(`import { x } from "${L}-client";`)).toBe(false);
    expect(hasRuntimeLegacyImport(`await import("${L}-client");`)).toBe(false);
  });

  it("detects createRequire bindings, which this repo prefers over bare require", () => {
    // workspaceDatabase.ts:18 explains why production names these something
    // other than `require`: a bundler emitting a CommonJS shim injects its own
    // top-level `const require`, so a second declaration is a SyntaxError. Real
    // examples: workspaceDatabase.ts:35 `requireFromHere`, cliServer.ts:229 and
    // mcp/tools.ts:398 `requireModule`, and the legacy package's own
    // linkedChatStore.ts:199. Matching only `require` left the ratchet open
    // along the exact path the codebase already prefers.
    const viaAlias = [
      `import { createRequire } from "node:module";`,
      `const requireFromHere = createRequire(import.meta.url);`,
      `export const engine = requireFromHere("${LEGACY_PACKAGE}");`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(viaAlias)).toBe(true);

    const otherName = [
      `const requireModule = createRequire(import.meta.url);`,
      `export const e = requireModule("${LEGACY_PACKAGE}");`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(otherName)).toBe(true);

    // A binding NOT from createRequire must not be treated as a loader.
    const notALoader = [
      `const requireFromHere = makeSomethingElse();`,
      `export const e = requireFromHere("${LEGACY_PACKAGE}");`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(notALoader)).toBe(false);
  });

  it("parses each file with the script kind its extension implies", () => {
    // A .tsx file parsed as TS chokes on JSX, and a malformed AST hides the
    // import that follows it. The scan passes the real path for this reason.
    const tsx = [
      `export function View() {`,
      `  return <div className="x">{"hi"}</div>;`,
      `}`,
      `export async function load() {`,
      `  return await import("${LEGACY_PACKAGE}");`,
      `}`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(tsx, "some/View.tsx")).toBe(true);
    expect(scriptKindFor("a/b.tsx")).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor("a/b.jsx")).toBe(ts.ScriptKind.JSX);
    expect(scriptKindFor("a/b.mjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKindFor("a/b.ts")).toBe(ts.ScriptKind.TS);
  });

  it("detects the loader spellings a name-only check misses", () => {
    const L = LEGACY_PACKAGE;
    // A no-substitution template literal is a NoSubstitutionTemplateLiteral, not
    // a StringLiteral — `isStringLiteralLike` covers both.
    expect(hasRuntimeLegacyImport("const m = await import(`" + L + "`);")).toBe(true);
    expect(hasRuntimeLegacyImport("const m = require(`" + L + "`);")).toBe(true);
    // Node's CommonJS module.require really loads; an arbitrary member call does not.
    expect(hasRuntimeLegacyImport(`module.require("${L}");`)).toBe(true);
    expect(hasRuntimeLegacyImport(`loader.require("${L}");`)).toBe(false);
    expect(hasRuntimeLegacyImport(`registry.module.require("${L}");`)).toBe(false);
  });

  it("resolves a relative path that reaches into the legacy package", () => {
    // Reaching into another package's source by relative path is an established
    // pattern here, so a name-only comparison would miss a real dependency.
    const rel = `import { createVersionedTextStore } from "../../../../packages/workspace-engine/src/index";`;
    expect(hasRuntimeLegacyImport(rel, "apps/desktop/src/workspaces/thing.ts")).toBe(true);
    // Same depth, a DIFFERENT package — must not match.
    const other = `import { x } from "../../../../packages/workspace-contracts/src/engine";`;
    expect(hasRuntimeLegacyImport(other, "apps/desktop/src/workspaces/thing.ts")).toBe(false);
    // A relative path that does not escape into the package.
    expect(hasRuntimeLegacyImport(`import { x } from "./sibling";`, "apps/desktop/src/a.ts")).toBe(
      false,
    );
    // Type-only stays erased even by relative path.
    const relType = `import type { VersionedTextStore } from "../../../../packages/workspace-engine/src/index";`;
    expect(hasRuntimeLegacyImport(relType, "apps/desktop/src/workspaces/thing.ts")).toBe(false);
  });

  it("excludes .d.mts and .d.cts, not only .d.ts", () => {
    // SCANNED_SOURCE accepts mts/cts, so excluding only `.d.ts` would let an
    // erased declaration count as a runtime importer.
    expect(isProductionSource("packages/x/src/a.d.ts")).toBe(false);
    expect(isProductionSource("packages/x/src/a.d.mts")).toBe(false);
    expect(isProductionSource("packages/x/src/a.d.cts")).toBe(false);
    expect(isProductionSource("packages/x/src/a.mts")).toBe(true);
  });

  it("scans shipping JavaScript and skips build/test config", () => {
    // packages/cli exposes bin/dohc.js and packages/mcp exposes bin/dohc-mcp.js,
    // so a legacy dependency in either would ship to users.
    expect(isProductionSource("packages/cli/bin/dohc.js")).toBe(true);
    expect(isProductionSource("packages/mcp/bin/dohc-mcp.js")).toBe(true);
    // Config at a package root is tooling, not shipping code — and it is not
    // under scripts/, so it needs its own exclusion.
    expect(isProductionSource("apps/desktop/electron.vite.config.ts")).toBe(false);
    expect(isProductionSource("apps/desktop/playwright.config.ts")).toBe(false);
    expect(isProductionSource("apps/desktop/vitest.config.ts")).toBe(false);
    // But a source file whose name merely contains "config" is production.
    expect(isProductionSource("apps/desktop/src/preloadBundleConfig.ts")).toBe(true);
  });

  it("excludes declaration files, whose imports are erased", () => {
    // `/\.tsx?$/` matches `.d.ts`, so without the explicit check a declaration
    // containing `import Engine = require(…)` would be read as a runtime import.
    expect(isProductionSource("apps/desktop/src/renderer/assets.d.ts")).toBe(false);
    expect(isProductionSource("apps/desktop/src/renderer/assets.ts")).toBe(true);
    // The detector alone WOULD flag it, which is what makes the filter load-bearing.
    expect(hasRuntimeLegacyImport(`import Engine = require("${LEGACY_PACKAGE}");`)).toBe(true);
  });

  it("does not let a preceding type-only import mask a real one", () => {
    // The bug this replaces: with a lazy any-character clause, the match began
    // at the FIRST import in the file and spanned every statement up to this
    // module's `from`, so the clause started with `type` and the whole runtime
    // import was waved through. workspaceEngineCapture.ts hit exactly this —
    // its first import is `import type { WatcherEvent } from
    // "@dohc/workspace-core"` — and the guard reported zero importers for it.
    const source = [
      `import type { WatcherEvent } from "@dohc/workspace-core";`,
      `import { validateThing } from "@dohc/workspace-core";`,
      `import {`,
      `  createVersionedTextStore,`,
      `  type VersionedTextStore,`,
      `} from "${LEGACY_PACKAGE}";`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(source)).toBe(true);
  });

  it("detects runtime loads that are not static imports", () => {
    // A guard a one-line change can walk around is not a guard. None of these
    // forms can be type-only, so the call form alone settles it.
    expect(
      hasRuntimeLegacyImport(`const m = await import("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`const m = require("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`import m = require("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `const { x } = await import("${LEGACY_PACKAGE}/testing");`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`const m = await import( '${LEGACY_PACKAGE}' );`),
    ).toBe(true);
    // Must not fire on a different package that merely shares the prefix.
    expect(
      hasRuntimeLegacyImport(`await import("@dohc/workspace-engine-client");`),
    ).toBe(false);
  });
});
