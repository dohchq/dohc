import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

// R16 ratchet. The legacy TypeScript engine package was deleted in favour of
// the Rust daemon. No production source may restore a dependency on it.
//
// This asserts SET EQUALITY against the empty list below. Adding an importer
// fails, and a separate assertion prevents someone from weakening the guard by
// adding that importer to the allowlist.
//
// Type-only imports are fine — they carry no runtime dependency and vanish at
// build time — so they are not listed and not counted.
//
// "Type-only" here means SYNTACTICALLY type-only: `import type { X }`, or named
// bindings that are each `type`. A plain `import { X }` whose bindings happen to
// be used only in type positions is ALSO erased under this tsconfig
// (isolatedModules, no verbatimModuleSyntax), but this guard counts it as
// runtime on purpose. Deciding otherwise needs whole-file binding-usage
// analysis, and the syntactic form is the one convention worth having. If this
// ever rejects legitimate work, the fix is to add the `type` keyword, not to
// loosen the guard.
//
// This used to say "all eleven type-only importers already write it that way".
// #432 repointed those eleven at @dohc/workspace-contracts, so there are now
// ZERO type-only importers of this package and that evidence is gone. The choice
// stands on its own terms; the parser tests below pin it either way.

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const LEGACY_PACKAGE_NAME = "workspace-engine";
const LEGACY_PACKAGE = `@dohc/${LEGACY_PACKAGE_NAME}`;

// Production files with a RUNTIME import of the legacy engine. Never grow this
// list. The Rust daemon now owns every production engine path.
//
// No other production file names this package at all: #432 repointed the eleven
// type-only importers at @dohc/workspace-contracts, where those types are
// actually declared. The parser tests below still pin the type-only handling
// after the migration reached zero production importers.
const ALLOWED = [] as const;

const SCAN_ROOTS = ["apps", "packages", "services", "scripts", "tools"];

// Shipping code, in any language that reaches a user. `.js` is included because
// two packages expose JavaScript launchers as their `bin` — packages/cli
// bin/dohc.js and packages/mcp bin/dohc-mcp.js — so a legacy dependency added to
// either would ship while a TypeScript-only scan stayed green.
const SCANNED_SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

// Not production: test files, Playwright specs, and build/QA tooling nested in
// a package. Root scripts and tools are scanned because executable maintenance
// code can still load a workspace package.
function isProductionSource(posixPath: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posixPath)) return false;
  if (posixPath.includes("/e2e/")) return false;
  if (posixPath.includes("/scripts/")) return false;
  if (posixPath.includes("/testing/")) return false;
  // Build and test tooling that sits at a PACKAGE ROOT rather than under
  // scripts/ — electron.vite.config.ts, playwright.config.ts, vitest.config.ts.
  // These run on a developer's machine, never a user's.
  //
  // Anchored to a package root — exactly `<root>/<package>/<name>.config.ts`.
  // An unanchored rule would excuse shipping source merely NAMED like config
  // (src/engine.config.ts); a loose one would excuse it anywhere outside src/
  // (lib/foo.config.ts). Neither is tooling.
  if (/^(apps|packages|services)\/[^/]+\/[^/]*\.config\.[cm]?[jt]s$/.test(posixPath)) {
    return false;
  }
  // Compile-check modules exist so tsc proves a contract still type-checks; they
  // are consumed by a test and exported from nothing. A value-shaped legacy
  // import in one would be QA tooling, not a shipped dependency.
  if (/\.compile\.[cm]?tsx?$/.test(posixPath)) return false;
  // Declaration files carry no runtime import — everything in them is erased,
  // including `import Engine = require(…)`.
  if (/\.d\.[cm]?ts$/.test(posixPath)) return false;
  return SCANNED_SOURCE.test(posixPath);
}

type SourceSyntax = "tsx" | "jsx" | "js" | "ts";

function scriptKindFor(posixPath: string): SourceSyntax {
  if (posixPath.endsWith(".tsx")) return "tsx";
  if (posixPath.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?js$/.test(posixPath)) return "js";
  return "ts";
}

function parserPluginsFor(posixPath: string): ParserPlugin[] {
  switch (scriptKindFor(posixPath)) {
    case "tsx":
      return ["typescript", "jsx"];
    case "jsx":
      return ["jsx"];
    case "ts":
      return ["typescript"];
    case "js":
      return [];
  }
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
// comment, `loader.require(…)` masquerading as `require(…)`. The parser already
// knows the difference, so ask it.
const LEGACY_SOURCE_DIR = `packages/${LEGACY_PACKAGE_NAME}/`;

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
function isErasedImport(node: t.ImportDeclaration): boolean {
  if (node.specifiers.length === 0) return false; // bare `import "pkg"` — side effect
  if (node.importKind === "type" || node.importKind === "typeof") return true;
  return node.specifiers.every(
    (specifier) => t.isImportSpecifier(specifier) && specifier.importKind === "type",
  );
}

// Strips the wrappers TypeScript erases: (x), x as T, <T>x, x satisfies T, x!.
// None changes the runtime value, so none may change what this guard sees.
function unwrapExpression(node: t.Expression): t.Expression {
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

// Every specifier this expression could statically be: a literal, the values a
// const of that name is bound to anywhere in the file, or literals joined by
// `+`. Anything computed at runtime is beyond a static guard and is not
// attempted.
//
// Deliberately NOT lexical scope analysis. Two functions may each declare
// `const name = …` with different values, and a file-wide map would let the
// last one visited decide — which can produce a FALSE NEGATIVE, the one
// direction a ratchet must not have. Returning every candidate and flagging if
// ANY is the legacy package biases the ambiguity toward a false positive
// instead, which costs someone an allowlist edit rather than letting a real
// dependency through. A symbol table would be more precise and is not worth it
// for a guard whose realistic input is an ordinary import.
function resolveSpecifiers(
  node: t.Expression,
  stringConsts: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (t.isStringLiteral(node)) return [node.value];
  if (t.isIdentifier(node)) return stringConsts.get(node.name) ?? [];
  // A template whose every substitution resolves statically — `${SCOPE}/pkg` is
  // the same value as the concatenation, so it must not read differently.
  if (t.isTemplateLiteral(node)) {
    let parts: string[] = [node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? ""];
    for (const [index, expression] of node.expressions.entries()) {
      if (!t.isExpression(expression)) return [];
      const values = resolveSpecifiers(expression, stringConsts);
      if (values.length === 0) return [];
      const suffix = node.quasis[index + 1]?.value.cooked ?? node.quasis[index + 1]?.value.raw ?? "";
      parts = parts.flatMap((prefix) => values.map((value) => prefix + value + suffix));
    }
    return parts;
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    if (!t.isExpression(node.left)) return [];
    const left = resolveSpecifiers(node.left, stringConsts);
    const right = resolveSpecifiers(node.right, stringConsts);
    return left.flatMap((l) => right.map((r) => l + r));
  }
  const unwrapped = unwrapExpression(node);
  if (unwrapped !== node) return resolveSpecifiers(unwrapped, stringConsts);
  return [];
}

// The Worker constructor, by local binding rather than by spelling: a bare
// identifier bound to node:worker_threads' Worker, or a member access such as
// `workerThreads.Worker`.
function isWorkerConstructor(expression: t.Node, workerNames: ReadonlySet<string>): boolean {
  if (t.isIdentifier(expression)) return workerNames.has(expression.name);
  if (t.isMemberExpression(expression) && !expression.computed && t.isIdentifier(expression.property)) {
    return expression.property.name === "Worker";
  }
  return false;
}

// `{ eval: true }` in a Worker's options object literal.
function workerRunsEval(
  node: t.NewExpression,
  optionObjects: ReadonlyMap<string, readonly t.ObjectExpression[]>,
): boolean {
  const rawArgument = node.arguments?.[1];
  if (rawArgument === undefined || !t.isExpression(rawArgument)) return false;
  const argument = unwrapExpression(rawArgument);
  // Either inline, or a const holding the options object — `const opts = { eval:
  // true }; new Worker(SRC, opts)` runs source just the same. EVERY candidate for
  // that name is considered, for the same reason specifiers keep every candidate:
  // a later `const opts = { eval: false }` must not hide an earlier evaluated
  // body.
  const candidates = t.isObjectExpression(argument)
    ? [argument]
    : t.isIdentifier(argument)
      ? (optionObjects.get(argument.name) ?? [])
      : [];
  return candidates.some((options) =>
    options.properties.some(
      (property) =>
        t.isObjectProperty(property) &&
        (t.isIdentifier(property.key) || t.isStringLiteral(property.key)) &&
        (t.isIdentifier(property.key) ? property.key.name : property.key.value) === "eval" &&
        t.isBooleanLiteral(property.value, { value: true }),
    ),
  );
}

function hasRuntimeLegacyImport(source: string, fileName = "probe.ts"): boolean {
  const sourceFile = parse(source, {
    createImportExpressions: true,
    plugins: parserPluginsFor(fileName),
    sourceFilename: fileName,
    sourceType: "unambiguous",
  });
  // `createRequire` bindings are runtime loaders under another name, and this
  // repo uses them DELIBERATELY: workspaceDatabase.ts:18 explains that bundlers
  // emitting a CommonJS shim inject their own top-level `const require`, so a
  // second declaration is a SyntaxError. Production therefore names them
  // `requireFromHere` / `requireModule` — and the legacy package does it too
  // (linkedChatStore.ts:199). Matching only a callee literally named `require`
  // would leave the ratchet open along the path the codebase already prefers.
  const requireAliases = new Set<string>(["require"]);
  // The LOCAL name bound to node:module's createRequire. `import { createRequire
  // as makeRequire }` is legal and would defeat a check on the callee's text.
  const createRequireNames = new Set<string>(["createRequire"]);
  // The LOCAL name bound to node:worker_threads' Worker, for the same reason:
  // `import { Worker as ThreadWorker }` is an ordinary refactor away, and a
  // name-only check would stop inspecting evaluated bodies the moment it happened.
  const workerNames = new Set<string>(["Worker"]);
  // A constant holding the retired package name resolves the package just the
  // same, and factoring a specifier into a constant is a
  // routine refactor. Multi-valued so a name declared twice keeps BOTH — see
  // resolveSpecifiers on why that direction is the safe one.
  const stringConsts = new Map<string, readonly string[]>();
  const stringConstExpressions = new Map<string, t.Expression[]>();
  // Object literals bound to a name, so a Worker's options can be reached
  // through a const rather than only inline.
  const optionObjects = new Map<string, t.ObjectExpression[]>();
  // Collect declarations before resolving them, so declaration order does not
  // change which static specifiers the ratchet can see.
  const collectNames = (node: t.Node): void => {
    if (t.isImportDeclaration(node)) {
      for (const specifier of node.specifiers) {
        if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          if (imported === "createRequire") createRequireNames.add(specifier.local.name);
          if (imported === "Worker") workerNames.add(specifier.local.name);
        }
      }
    }
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      const init = node.init;
      if (init !== null && t.isExpression(init)) {
        stringConstExpressions.set(node.id.name, [
          ...(stringConstExpressions.get(node.id.name) ?? []),
          init,
        ]);
      }
      const unwrapped = init !== null && t.isExpression(init) ? unwrapExpression(init) : undefined;
      if (unwrapped !== undefined && t.isObjectExpression(unwrapped)) {
        optionObjects.set(node.id.name, [
          ...(optionObjects.get(node.id.name) ?? []),
          unwrapped,
        ]);
      }
    }
  };
  t.traverseFast(sourceFile, collectNames);
  let resolvedAnotherValue: boolean;
  do {
    resolvedAnotherValue = false;
    for (const [name, expressions] of stringConstExpressions) {
      const values = new Set(stringConsts.get(name) ?? []);
      const previousSize = values.size;
      for (const expression of expressions) {
        for (const value of resolveSpecifiers(expression, stringConsts)) values.add(value);
      }
      if (values.size > previousSize) {
        stringConsts.set(name, [...values]);
        resolvedAnotherValue = true;
      }
    }
  } while (resolvedAnotherValue);
  const collectAliases = (node: t.Node): void => {
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      const init = node.init;
      if (init !== null && t.isCallExpression(init)) {
        const callee = init.callee;
        const isCreateRequire =
          (t.isIdentifier(callee) && createRequireNames.has(callee.name)) ||
          (t.isMemberExpression(callee) &&
            !callee.computed &&
            t.isIdentifier(callee.property) &&
            createRequireNames.has(callee.property.name));
        if (isCreateRequire) requireAliases.add(node.id.name);
      }
    }
  };
  t.traverseFast(sourceFile, collectAliases);
  let found = false;
  const visit = (node: t.Node): void => {
    if (found) return;
    if (t.isImportDeclaration(node)) {
      if (isLegacySpecifier(node.source.value, fileName) && !isErasedImport(node)) {
        found = true;
        return;
      }
    } else if (t.isExportNamedDeclaration(node)) {
      // `export { x } from "pkg"` re-exports a value; `export type { X }` does
      // not — and neither does `export { type X }`, whose specifiers are each
      // type-only while the declaration itself is not.
      const spec = node.source;
      if (spec != null && isLegacySpecifier(spec.value, fileName)) {
        const allSpecifiersErased =
          node.specifiers.length > 0 &&
          node.specifiers.every(
            (specifier) => t.isExportSpecifier(specifier) && specifier.exportKind === "type",
          );
        if (node.exportKind !== "type" && !allSpecifiersErased) {
          found = true;
          return;
        }
      }
    } else if (t.isExportAllDeclaration(node)) {
      if (
        isLegacySpecifier(node.source.value, fileName) &&
        node.exportKind !== "type"
      ) {
        found = true;
        return;
      }
    } else if (t.isTSImportEqualsDeclaration(node)) {
      // `import Engine = require("pkg")`.
      const ref = node.moduleReference;
      if (
        t.isTSExternalModuleReference(ref) &&
        isLegacySpecifier(ref.expression.value, fileName) &&
        node.importKind !== "type"
      ) {
        found = true;
        return;
      }
    } else if (t.isImportExpression(node)) {
      if (
        resolveSpecifiers(node.source, stringConsts).some((candidate) =>
          isLegacySpecifier(candidate, fileName),
        )
      ) {
        found = true;
        return;
      }
    } else if (t.isCallExpression(node) || t.isNewExpression(node)) {
      const arg = node.arguments?.[0];
      // `new Worker(SOURCE, { eval: true })` runs SOURCE as a real module, so a
      // load inside it ships. cliServer.ts already defines such a body as a
      // template literal (REGEX_WORKER_SOURCE) and evals it, which makes this a
      // live shape rather than a hypothetical one. Recurse into the body when it
      // is statically knowable.
      if (t.isNewExpression(node) && isWorkerConstructor(node.callee, workerNames)) {
        if (workerRunsEval(node, optionObjects)) {
          const body = node.arguments?.[0];
          const sources = body !== undefined && t.isExpression(body)
            ? resolveSpecifiers(body, stringConsts)
            : [];
          if (sources.some((source) => hasRuntimeLegacyImport(source, fileName))) {
            found = true;
            return;
          }
        }
      }
      const isStringArg =
        arg !== undefined && t.isExpression(arg) &&
        resolveSpecifiers(arg, stringConsts).some((candidate) =>
          isLegacySpecifier(candidate, fileName),
        );
      if (isStringArg) {
        // `import("pkg")`, and a BARE `require("pkg")` — but not a method call
        // such as `loader.require("pkg")`, which is not Node's require.
        const isBareRequire =
          t.isIdentifier(node.callee) && requireAliases.has(node.callee.name);
        // Node's CommonJS `module.require(...)`, which really does load — unlike
        // an arbitrary `loader.require(...)` method, which does not.
        const isModuleRequire =
          t.isMemberExpression(node.callee) &&
          !node.callee.computed &&
          t.isIdentifier(node.callee.object, { name: "module" }) &&
          t.isIdentifier(node.callee.property, { name: "require" });
        // `createRequire(import.meta.url)("pkg")` — invoked immediately rather
        // than stored, so the callee is another CALL, not an identifier. Real
        // shape in this repo: workspaceDatabase.test.ts:115.
        const calleeIsCreateRequireCall =
          t.isCallExpression(node.callee) &&
          ((t.isIdentifier(node.callee.callee) &&
            createRequireNames.has(node.callee.callee.name)) ||
            (t.isMemberExpression(node.callee.callee) &&
              !node.callee.callee.computed &&
              t.isIdentifier(node.callee.callee.property) &&
              createRequireNames.has(node.callee.callee.property.name)));
        if (isBareRequire || isModuleRequire || calleeIsCreateRequireCall) {
          found = true;
          return;
        }
      }
    }
  };
  t.traverseFast(sourceFile, visit);
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

  it("keeps the retired package directory absent", () => {
    expect(existsSync(join(REPO_ROOT, LEGACY_SOURCE_DIR))).toBe(false);
  });

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
    // Filtered through isProductionSource, not the raw walk. With the raw set, a
    // regression making isProductionSource reject everything would empty
    // `importers` while the sentinels stayed present — and once ALLOWED reaches
    // zero, BOTH assertions would pass vacuously. This asserts the whole
    // selection pipeline, which is the part that has to keep working.
    const scanned = new Set(
      files.map((f) => relative(REPO_ROOT, f).split(sep).join("/")).filter(isProductionSource),
    );
    for (const sentinel of [
      "apps/desktop/src/main.ts",
      "packages/workspace-contracts/src/engine.ts",
      "services/sync-relay/src/errorCodes.ts",
      "scripts/check-brand.mjs",
      "tools/rust-engine-program/run-rust-checks.mjs",
    ]) {
      expect(scanned, `scan root for ${sentinel} was not walked`).toContain(
        sentinel,
      );
    }
  });

  it("matches the allowlist exactly, so the count can only shrink deliberately", () => {
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it("pins the allowlist at zero", () => {
    // Set equality alone passes if someone adds an importer AND its path in one
    // change, so this is a second, louder tripwire. EXACT rather than an upper
    // bound: a ceiling that only caps drifts loose as the list shrinks, and
    // the package has been retired and must stay retired.
    expect(ALLOWED.length).toBe(0);
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
    expect(hasRuntimeLegacyImport(`export * from "${L}";`)).toBe(true);
    expect(hasRuntimeLegacyImport(`export type * from "${L}";`)).toBe(false);

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
    // mcp/tools.ts:398 `requireModule`. Matching only `require` left the
    // ratchet open along the exact path the codebase already prefers.
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
    expect(scriptKindFor("a/b.tsx")).toBe("tsx");
    expect(scriptKindFor("a/b.jsx")).toBe("jsx");
    expect(scriptKindFor("a/b.mjs")).toBe("js");
    expect(scriptKindFor("a/b.ts")).toBe("ts");
  });

  it("resolves a specifier factored into a constant", () => {
    const L = LEGACY_PACKAGE;
    // Factoring a specifier into a const is a routine refactor, so a
    // literal-node-only check would let one walk around the ratchet.
    expect(
      hasRuntimeLegacyImport(`const name = "${L}";
export const m = await import(name);`),
    ).toBe(true);
    // Declared AFTER use — the const map is collected in a separate pass.
    expect(
      hasRuntimeLegacyImport(`export const m = await import(name);
const name = "${L}";`),
    ).toBe(true);
    // Dependencies between constants are also independent of declaration order.
    expect(
      hasRuntimeLegacyImport(`const name = scope + "/workspace-engine";
const scope = "@dohc";
export const m = await import(name);`),
    ).toBe(true);
    // Concatenated literals.
    expect(hasRuntimeLegacyImport(`const m = require("@dohc/" + "workspace-engine");`)).toBe(true);
    const scoped = `const scope = "@dohc/";
const m = require(scope + "workspace-engine");`;
    expect(hasRuntimeLegacyImport(scoped)).toBe(true);
    // A template whose substitutions all resolve statically is the same value as
    // the concatenation, so it must not read differently.
    const templated = `const SCOPE = "@dohc";
const m = await import(\`\${SCOPE}/workspace-engine\`);`;
    expect(hasRuntimeLegacyImport(templated)).toBe(true);
    // …and one whose substitution is computed at runtime is not claimed.
    const runtimeTemplated = `const SCOPE = pick();
const m = await import(\`\${SCOPE}/workspace-engine\`);`;
    expect(hasRuntimeLegacyImport(runtimeTemplated)).toBe(false);

    // A genuinely runtime-computed specifier is beyond any static guard, and is
    // not claimed to be covered.
    expect(hasRuntimeLegacyImport(`const m = await import(pickPackage());`)).toBe(false);
    // A constant for a DIFFERENT package must not match.
    expect(
      hasRuntimeLegacyImport(`const name = "${L}-client";
const m = await import(name);`),
    ).toBe(false);
  });

  it("handles the loader and specifier spellings that need name tracking", () => {
    const L = LEGACY_PACKAGE;
    // createRequire imported under another name — legal, and a callee-text check
    // would never record the binding.
    const aliased = [
      `import { createRequire as makeRequire } from "node:module";`,
      `const load = makeRequire(import.meta.url);`,
      `export const m = load("${L}");`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(aliased)).toBe(true);

    // …and invoked directly under that alias.
    const aliasedDirect = [
      `import { createRequire as makeRequire } from "node:module";`,
      `export const m = makeRequire(import.meta.url)("${L}");`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(aliasedDirect)).toBe(true);

    // A const whose initializer is itself a concatenation.
    const concatConst = [
      `const name = "@dohc/" + "workspace-engine";`,
      `const m = require(name);`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(concatConst)).toBe(true);

    // A const built from another const.
    const chained = [
      `const scope = "@dohc/";`,
      `const name = scope + "workspace-engine";`,
      `const m = require(name);`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(chained)).toBe(true);

    // SHADOWING is resolved conservatively: the same name bound to the legacy
    // package in one scope and something else in another is treated as legacy,
    // because a false negative is the one direction a ratchet must not have.
    const shadowed = [
      `function a() { const name = "${L}"; return require(name); }`,
      `function b() { const name = "other-package"; return require(name); }`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(shadowed)).toBe(true);
    // Reversed declaration order must reach the same answer.
    const shadowedReversed = [
      `function b() { const name = "other-package"; return require(name); }`,
      `function a() { const name = "${L}"; return require(name); }`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(shadowedReversed)).toBe(true);
  });

  it("sees through erased expression wrappers on a specifier", () => {
    const L = LEGACY_PACKAGE;
    // None of these changes the runtime value, so none may hide the specifier.
    expect(hasRuntimeLegacyImport(`const m = await import("${L}" as string);`)).toBe(true);
    expect(hasRuntimeLegacyImport(`const m = await import(("${L}"));`)).toBe(true);
    expect(hasRuntimeLegacyImport(`const m = require("${L}"!);`)).toBe(true);
    const viaConst = `const name = "${L}" as const;
const m = require(name);`;
    expect(hasRuntimeLegacyImport(viaConst)).toBe(true);
  });

  it("looks inside a worker body that is evaluated as source", () => {
    const L = LEGACY_PACKAGE;
    // cliServer.ts really does define an executable body as a template literal
    // (REGEX_WORKER_SOURCE) and pass it to `new Worker(..., { eval: true })`, so
    // a load added inside such a string would ship while the file's own imports
    // stayed clean.
    const evalWorker = [
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export const w = new Worker(SRC, { eval: true, workerData: {} });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(evalWorker)).toBe(true);

    // Without `eval: true` the first argument is a FILE PATH, not source, and
    // must not be parsed as code.
    const pathWorker = [
      `const SRC = "./regexWorker.js";`,
      "export const w = new Worker(SRC, { workerData: {} });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(pathWorker)).toBe(false);

    // The options object reached through a const, not inline.
    const namedOptions = [
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "const opts = { eval: true };",
      "export const w = new Worker(SRC, opts);",
    ].join("\n");
    expect(hasRuntimeLegacyImport(namedOptions)).toBe(true);

    // A LATER `const opts = { eval: false }` must not hide an earlier evaluated
    // body, the same conservative bias specifiers use for shadowed names.
    const shadowedOptions = [
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export function a() { const opts = { eval: true }; return new Worker(SRC, opts); }",
      'export function b() { const opts = { eval: false }; return new Worker("./x.js", opts); }',
    ].join("\n");
    expect(hasRuntimeLegacyImport(shadowedOptions)).toBe(true);

    // Option objects behind an erased wrapper, inline and via a const. `as` does
    // not change what runs, so it must not change what this sees.
    const wrappedInline = [
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export const w = new Worker(SRC, { eval: true } as { eval: boolean });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(wrappedInline)).toBe(true);
    const wrappedConst = [
      "const opts = { eval: true } as { eval: boolean };",
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export const w = new Worker(SRC, opts);",
    ].join("\n");
    expect(hasRuntimeLegacyImport(wrappedConst)).toBe(true);

    // eval: false alone is a path, not source.
    const noEval = [
      `const SRC = "./x.js";`,
      "export function b() { const opts = { eval: false }; return new Worker(SRC, opts); }",
    ].join("\n");
    expect(hasRuntimeLegacyImport(noEval)).toBe(false);

    // The constructor by BINDING, not spelling: an alias refactor is ordinary,
    // and a name-only check would stop inspecting bodies the moment it happened.
    const aliasedCtor = [
      `import { Worker as ThreadWorker } from "node:worker_threads";`,
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export const w = new ThreadWorker(SRC, { eval: true });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(aliasedCtor)).toBe(true);

    const memberCtor = [
      `import * as workerThreads from "node:worker_threads";`,
      "const SRC = `",
      `const e = require("${L}");`,
      "`;",
      "export const w = new workerThreads.Worker(SRC, { eval: true });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(memberCtor)).toBe(true);

    // An eval worker with a clean body stays clean.
    const cleanWorker = [
      "const SRC = `",
      `const { parentPort } = require("node:worker_threads");`,
      "`;",
      "export const w = new Worker(SRC, { eval: true });",
    ].join("\n");
    expect(hasRuntimeLegacyImport(cleanWorker)).toBe(false);
  });

  it("excuses config only at a package root, never shipping source", () => {
    // An unanchored rule would also excuse source merely NAMED like config.
    expect(isProductionSource("apps/desktop/electron.vite.config.ts")).toBe(false);
    expect(isProductionSource("apps/desktop/playwright.config.ts")).toBe(false);
    expect(isProductionSource("packages/cli/vitest.config.ts")).toBe(false);
    expect(isProductionSource("apps/desktop/src/engine.config.ts")).toBe(true);
    expect(isProductionSource("packages/mcp/src/tools.config.ts")).toBe(true);
    // Outside src/ but NOT at a package root — still shipping code.
    expect(isProductionSource("apps/desktop/lib/engine.config.ts")).toBe(true);
    // Compile-check modules prove a contract type-checks; they ship nowhere.
    expect(isProductionSource("packages/workspace-contracts/src/engine.compile.ts")).toBe(false);
    expect(isProductionSource("packages/workspace-core/src/engineContracts.compile.ts")).toBe(
      false,
    );
    // A source file merely CONTAINING "compile" is production.
    expect(isProductionSource("apps/desktop/src/workspaces/compileHelpers.ts")).toBe(true);
    expect(isProductionSource("packages/cli/internal/build.config.ts")).toBe(true);
  });

  it("counts a syntactically-untyped import as runtime, by documented choice", () => {
    // `import { X }` used only in type positions is erased under this tsconfig,
    // but deciding that needs binding-usage analysis. The syntactic form is the
    // convention, so this is a deliberate false positive, pinned here so nobody
    // "fixes" it by accident. (The "eleven type-only importers" this comment used
    // to cite as precedent are gone as of #432.)
    expect(hasRuntimeLegacyImport(`import { VersionedTextStore } from "${LEGACY_PACKAGE}";`)).toBe(
      true,
    );
    expect(
      hasRuntimeLegacyImport(`import type { VersionedTextStore } from "${LEGACY_PACKAGE}";`),
    ).toBe(false);
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

  it("detects a createRequire loader invoked without being stored", () => {
    const L = LEGACY_PACKAGE;
    // The callee is another CALL, not an identifier, so the alias set cannot see
    // it. Real shape in this repo at workspaceDatabase.test.ts:115.
    expect(hasRuntimeLegacyImport(`const m = createRequire(import.meta.url)("${L}");`)).toBe(true);
    expect(hasRuntimeLegacyImport(`const m = mod.createRequire(import.meta.url)("${L}");`)).toBe(
      true,
    );
    // A different immediately-invoked factory is not a module loader.
    expect(hasRuntimeLegacyImport(`const m = makeLoader(x)("${L}");`)).toBe(false);
  });

  it("resolves a relative path that reaches into the legacy package", () => {
    // Reaching into another package's source by relative path is an established
    // pattern here, so a name-only comparison would miss a real dependency.
    const rel = `import { createVersionedTextStore } from "../../../../${LEGACY_SOURCE_DIR}src/index";`;
    expect(hasRuntimeLegacyImport(rel, "apps/desktop/src/workspaces/thing.ts")).toBe(true);
    // Same depth, a DIFFERENT package — must not match.
    const other = `import { x } from "../../../../packages/workspace-contracts/src/engine";`;
    expect(hasRuntimeLegacyImport(other, "apps/desktop/src/workspaces/thing.ts")).toBe(false);
    // A relative path that does not escape into the package.
    expect(hasRuntimeLegacyImport(`import { x } from "./sibling";`, "apps/desktop/src/a.ts")).toBe(
      false,
    );
    // Type-only stays erased even by relative path.
    const relType = `import type { VersionedTextStore } from "../../../../${LEGACY_SOURCE_DIR}src/index";`;
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
