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
const LEGACY_PACKAGE = "@dohc/workspace-engine";

// Production files with a RUNTIME import of the legacy engine. Shrink this list
// as the migration proceeds; never grow it.
//
// Both entries are blocked on the same thing (#391): `workspaceEngineCapture`
// imports the two store factories used by the daemon-unavailable fallback, and
// `ydocEngineProviderSession` is the legacy provider session that fallback
// selects. Its Rust replacement already exists.
//
// No other production file names this package at all: #432 repointed the eleven
// type-only importers at @dohc/workspace-contracts, where those types are
// actually declared. The parser tests below still pin the type-only handling,
// because the two entries above import types alongside their values.
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
  // are consumed by a test and exported from nothing. Two exist today
  // (workspace-contracts/src/engine.compile.ts,
  // workspace-engine/src/engineContracts.compile.ts) and a value-shaped legacy
  // import in one would be QA tooling, not a shipped dependency.
  if (/\.compile\.[cm]?tsx?$/.test(posixPath)) return false;
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

// Strips the wrappers TypeScript erases: (x), x as T, <T>x, x satisfies T, x!.
// None changes the runtime value, so none may change what this guard sees.
function unwrapExpression(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
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
  node: ts.Expression,
  stringConsts: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isIdentifier(node)) return stringConsts.get(node.text) ?? [];
  // A template whose every substitution resolves statically — `${SCOPE}/pkg` is
  // the same value as the concatenation, so it must not read differently.
  if (ts.isTemplateExpression(node)) {
    let parts: string[] = [node.head.text];
    for (const span of node.templateSpans) {
      const values = resolveSpecifiers(span.expression, stringConsts);
      if (values.length === 0) return [];
      parts = parts.flatMap((prefix) => values.map((v) => prefix + v + span.literal.text));
    }
    return parts;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
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
function isWorkerConstructor(expression: ts.Expression, workerNames: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expression)) return workerNames.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "Worker";
  return false;
}

// `{ eval: true }` in a Worker's options object literal.
function workerRunsEval(
  node: ts.NewExpression,
  optionObjects: ReadonlyMap<string, readonly ts.ObjectLiteralExpression[]>,
): boolean {
  const rawArgument = node.arguments?.[1];
  if (rawArgument === undefined) return false;
  const argument = unwrapExpression(rawArgument);
  // Either inline, or a const holding the options object — `const opts = { eval:
  // true }; new Worker(SRC, opts)` runs source just the same. EVERY candidate for
  // that name is considered, for the same reason specifiers keep every candidate:
  // a later `const opts = { eval: false }` must not hide an earlier evaluated
  // body.
  const candidates = ts.isObjectLiteralExpression(argument)
    ? [argument]
    : ts.isIdentifier(argument)
      ? (optionObjects.get(argument.text) ?? [])
      : [];
  return candidates.some((options) =>
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "eval" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    ),
  );
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
  // The LOCAL name bound to node:module's createRequire. `import { createRequire
  // as makeRequire }` is legal and would defeat a check on the callee's text.
  const createRequireNames = new Set<string>(["createRequire"]);
  // The LOCAL name bound to node:worker_threads' Worker, for the same reason:
  // `import { Worker as ThreadWorker }` is an ordinary refactor away, and a
  // name-only check would stop inspecting evaluated bodies the moment it happened.
  const workerNames = new Set<string>(["Worker"]);
  // `const name = "@dohc/workspace-engine"; await import(name)` resolves the
  // package just the same, and factoring a specifier into a constant is a
  // routine refactor. Multi-valued so a name declared twice keeps BOTH — see
  // resolveSpecifiers on why that direction is the safe one.
  const stringConsts = new Map<string, readonly string[]>();
  // Object literals bound to a name, so a Worker's options can be reached
  // through a const rather than only inline.
  const optionObjects = new Map<string, ts.ObjectLiteralExpression[]>();
  const addConst = (name: string, values: readonly string[]): void => {
    if (values.length === 0) return;
    stringConsts.set(name, [...(stringConsts.get(name) ?? []), ...values]);
  };
  // Two passes: import aliases and string consts first, so a const declared
  // after its use — or a createRequire alias imported below it — still resolves.
  const collectNames = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "createRequire") createRequireNames.add(element.name.text);
          if (imported === "Worker") workerNames.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined) addConst(node.name.text, resolveSpecifiers(init, stringConsts));
      const unwrapped = init === undefined ? undefined : unwrapExpression(init);
      if (unwrapped !== undefined && ts.isObjectLiteralExpression(unwrapped)) {
        optionObjects.set(node.name.text, [
          ...(optionObjects.get(node.name.text) ?? []),
          unwrapped,
        ]);
      }
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(sourceFile);
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined && ts.isCallExpression(init)) {
        const callee = init.expression;
        const isCreateRequire =
          (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) &&
            createRequireNames.has(callee.name.text));
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
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const arg = node.arguments?.[0];
      // `new Worker(SOURCE, { eval: true })` runs SOURCE as a real module, so a
      // load inside it ships. cliServer.ts already defines such a body as a
      // template literal (REGEX_WORKER_SOURCE) and evals it, which makes this a
      // live shape rather than a hypothetical one. Recurse into the body when it
      // is statically knowable.
      if (ts.isNewExpression(node) && isWorkerConstructor(node.expression, workerNames)) {
        if (workerRunsEval(node, optionObjects)) {
          const body = node.arguments?.[0];
          const sources = body === undefined ? [] : resolveSpecifiers(body, stringConsts);
          if (sources.some((source) => hasRuntimeLegacyImport(source, fileName))) {
            found = true;
            return;
          }
        }
      }
      const isStringArg =
        arg !== undefined &&
        resolveSpecifiers(arg, stringConsts).some((candidate) =>
          isLegacySpecifier(candidate, fileName),
        );
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
        // `createRequire(import.meta.url)("pkg")` — invoked immediately rather
        // than stored, so the callee is another CALL, not an identifier. Real
        // shape in this repo: workspaceDatabase.test.ts:115.
        const calleeIsCreateRequireCall =
          ts.isCallExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            createRequireNames.has(node.expression.expression.text)) ||
            (ts.isPropertyAccessExpression(node.expression.expression) &&
              createRequireNames.has(node.expression.expression.name.text)));
        if (isDynamicImport || isBareRequire || isModuleRequire || calleeIsCreateRequireCall) {
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
    ]) {
      expect(scanned, `scan root for ${sentinel} was not walked`).toContain(
        sentinel,
      );
    }
  });

  it("matches the allowlist exactly, so the count can only shrink deliberately", () => {
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it("pins the allowlist size at exactly two", () => {
    // Set equality alone passes if someone adds an importer AND its path in one
    // change, so this is a second, louder tripwire. EXACT rather than an upper
    // bound: a ceiling that only caps drifts loose as the list shrinks, and
    // shrinking is the whole point — removing an importer should have to edit
    // this number, which is how the win gets recorded instead of assumed.
    expect(ALLOWED.length).toBe(2);
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
    expect(isProductionSource("packages/workspace-engine/src/engineContracts.compile.ts")).toBe(
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
