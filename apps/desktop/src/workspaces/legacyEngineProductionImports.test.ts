import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
// Seven other production files name this package but import only TYPES, so they
// are absent by design, not by omission — see the parser tests below.
const ALLOWED = [
  "apps/desktop/src/collab/ydocEngineProviderSession.ts",
  "apps/desktop/src/workspaces/workspaceEngineCapture.ts",
] as const;

const SCAN_ROOTS = ["apps", "packages", "services"];

// Not production: the legacy package itself, test files, Playwright specs, and
// build/QA tooling.
function isProductionSource(posixPath: string): boolean {
  if (posixPath.startsWith("packages/workspace-engine/")) return false;
  if (/\.(test|spec)\.tsx?$/.test(posixPath)) return false;
  if (posixPath.includes("/e2e/")) return false;
  if (posixPath.includes("/scripts/")) return false;
  if (posixPath.includes("/testing/")) return false;
  // Declaration files carry no runtime import — everything in them is erased,
  // including `import Engine = require(…)`. `/\.tsx?$/` alone matches them.
  if (posixPath.endsWith(".d.ts")) return false;
  return /\.tsx?$/.test(posixPath);
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
function isLegacySpecifier(specifier: string): boolean {
  return specifier === LEGACY_PACKAGE || specifier.startsWith(`${LEGACY_PACKAGE}/`);
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
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec) && isLegacySpecifier(spec.text) && !isErasedImport(node)) {
        found = true;
        return;
      }
    } else if (ts.isExportDeclaration(node)) {
      // `export { x } from "pkg"` re-exports a value; `export type { X }` does
      // not — and neither does `export { type X }`, whose specifiers are each
      // type-only while the declaration itself is not.
      const spec = node.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteral(spec) && isLegacySpecifier(spec.text)) {
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
        ts.isStringLiteral(ref.expression) &&
        isLegacySpecifier(ref.expression.text) &&
        !node.isTypeOnly
      ) {
        found = true;
        return;
      }
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isStringArg = arg !== undefined && ts.isStringLiteral(arg) && isLegacySpecifier(arg.text);
      if (isStringArg) {
        // `import("pkg")`, and a BARE `require("pkg")` — but not a method call
        // such as `loader.require("pkg")`, which is not Node's require.
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isBareRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (isDynamicImport || isBareRequire) {
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
    .filter((p) =>
      hasRuntimeLegacyImport(readFileSync(join(REPO_ROOT, p), "utf8")),
    )
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
