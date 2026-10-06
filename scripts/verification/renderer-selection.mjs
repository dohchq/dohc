import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { readGit } from "../../tools/rust-engine-program/git-read.mjs";

const renderer = "apps/desktop/src/renderer/";
const site = "apps/site/";
const tokensTest = `${renderer}tokens.test.ts`;
const sourceFile = /\.(?:[cm]?[jt]sx?|css)$/u;
const unitTest = /\.test\.tsx?$/u;
const require = createRequire(import.meta.url);

function candidates(path) {
  const stem = path.replace(/\.[cm]?jsx?$/u, "");
  return [path, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(extension => stem + extension),
    ...[".ts", ".tsx", ".js", ".jsx"].map(extension => `${path}/index${extension}`)];
}

function exportTargets(value) {
  return typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(exportTargets) : [];
}

function moduleReferences(path, source, parse) {
  const references = [];
  let ambiguous = false;
  let failed = false;
  const add = (value, {module = false, type = false, escaped = false} = {}) => {
    if (typeof value !== "string") { if (module) ambiguous = true; return; }
    references.push({value, module, type, escaped});
  };
  if (path.endsWith(".css")) {
    for (const match of source.matchAll(/@import\s+(["'])([^"']+)\1/gu)) add(match[2], {module: true, escaped: match[2].includes("\\")});
    return {references, ambiguous};
  }
  if (!/\.[cm]?[jt]sx?$/u.test(path)) return {references, ambiguous};
  const literal = node => node?.type === "StringLiteral" ? node.value
    : node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
  const addModule = (node, options = {}) => add(literal(node), {...options, module: true,
    escaped: node?.extra?.raw?.includes("\\") || node?.quasis?.some(quasi => quasi.value.raw.includes("\\"))});
  const requireNames = new Set(["require"]);
  const requireFactories = new Set(["createRequire"]);
  const nameOf = node => node?.name ?? node?.property?.name ?? node?.property?.value;
  function walk(node, action) {
    if (!node || typeof node !== "object") return;
    action(node);
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "leadingComments", "trailingComments", "innerComments", "extra"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(value => walk(value, action));
      else if (child && typeof child === "object") walk(child, action);
    }
  }
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) && node.source) {
      const type = node.importKind === "type" || node.exportKind === "type" || node.specifiers?.length > 0
        && node.specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type");
      addModule(node.source, {type});
      return;
    }
    if (node.type === "TSImportType") { addModule(node.argument, {type: true}); return; }
    if (node.type === "ImportExpression") { addModule(node.source); return; }
    if (node.type === "TSImportEqualsDeclaration" && node.moduleReference.type === "TSExternalModuleReference") {
      addModule(node.moduleReference.expression, {type: node.importKind === "type"}); return;
    }
    if (node.type === "CallExpression") {
      const name = nameOf(node.callee);
      const directRequire = node.callee?.type === "CallExpression" && requireFactories.has(nameOf(node.callee.callee));
      if (directRequire || requireNames.has(name) || ["mock", "doMock", "importActual", "importOriginal"].includes(name)
        && (node.arguments.length || !["importOriginal", "importActual"].includes(name))) {
        addModule(node.arguments[0]);
      }
      if (node.callee?.type === "MemberExpression" && node.callee.object?.type === "MetaProperty"
        && node.callee.property?.name === "glob") ambiguous = true;
    }
    if (node.type === "StringLiteral") add(node.value);
    if (node.type === "TemplateLiteral" && !node.expressions.length) add(literal(node));
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "leadingComments", "trailingComments", "innerComments", "extra"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  try {
    const tree = parse(source, {sourceType: "unambiguous", createImportExpressions: true,
      plugins: [...(/\.[cm]?tsx?$/u.test(path) ? ["typescript"] : []), ...(/\.[jt]sx$/u.test(path) ? ["jsx"] : [])]});
    walk(tree, node => {
      if (node.type === "ImportDeclaration" && ["node:module", "module"].includes(node.source.value)) {
        for (const specifier of node.specifiers) if (specifier.imported?.name === "createRequire") requireFactories.add(specifier.local.name);
      }
    });
    let size;
    do {
      size = requireNames.size + requireFactories.size;
      walk(tree, node => {
        if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
        if (node.init?.type === "CallExpression" && requireFactories.has(nameOf(node.init.callee))
          || node.init?.type === "Identifier" && requireNames.has(node.init.name)) requireNames.add(node.id.name);
        if (node.init?.type === "Identifier" && requireFactories.has(node.init.name)) requireFactories.add(node.id.name);
      });
    } while (size !== requireNames.size + requireFactories.size);
    visit(tree);
  } catch { ambiguous = true; failed = true; }
  return {references, ambiguous, failed};
}

function literalReferences(source) {
  const references = [];
  for (const match of source.matchAll(/(["'`])((?:\.{1,2}\/|@dohc\/)[^"'`\r\n]+)\1/gu)) {
    const prefix = source.slice(Math.max(0, match.index - 160), match.index);
    const module = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require|mock|doMock|importActual|importOriginal)\s*\(\s*)$/u.test(prefix);
    // Tailwind source directories collect class names, rather than importing
    // renderer behavior. They do not create runtime consumers of a module.
    if (/@source\s*$/u.test(prefix)) continue;
    if (match[2].includes("\\")) continue;
    const value = match[2].split("${")[0];
    references.push({value, module, directory: match[2].includes("${")});
  }
  const ambiguous = /\b(?:import|require|mock|doMock|importActual)\s*\(\s*(?![\s"'`])/u.test(source)
    || /\bimport\.meta\.glob\s*\(/u.test(source)
    || /\b(?:import|require|mock|doMock|importActual)\s*\(\s*`[^`]*\$\{/u.test(source);
  // Escapes can hide any relative path, including its first dot. Retain the
  // existing package gate instead of guessing the decoded reverse edge.
  const escaped = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require|mock|doMock|importActual|importOriginal)\s*\(\s*)["'`][^"'`\r\n]*\\/u.test(source);
  return {references, ambiguous, escaped};
}

// Reverse impact includes type imports, mocks, and literal resource reads.
// Runtime traversal excludes type-only edges when choosing service resources.
export function rendererInputGraph(files, {runtime = false, seeds, parse} = {}) {
  const paths = new Set(files.map(file => file.path));
  const manifests = new Map(files.filter(file => file.path.endsWith("/package.json")).map(file => {
    const manifest = JSON.parse(file.source);
    return [manifest.name, {path: posix.dirname(file.path), manifest}];
  }));
  const sources = new Map(files.map(file => [file.path, file.source]));
  const inputs = new Map(), consumers = new Map(), uncertain = new Set(), native = new Set(), escaped = new Set();
  const pending = new Set(seeds ?? paths);
  if (runtime) parse ??= require("@babel/parser").parse;
  for (const path of pending) {
    const source = sources.get(path) ?? "";
    const dependencies = new Set();
    inputs.set(path, dependencies);
    const {references, ambiguous, escaped: escapedInput} = runtime ? moduleReferences(path, source, parse) : literalReferences(source);
    if (ambiguous) uncertain.add(path);
    if (escapedInput) {
      // Confirm the candidate's role: regexes and test fixture strings also
      // contain text that looks like an escaped import.
      let parsed;
      try { parsed = moduleReferences(path, source, parse ?? require("@babel/parser").parse); }
      catch { parsed = {failed: true}; }
      if (parsed.failed || parsed.references.some(reference => reference.module && reference.escaped)) escaped.add(path);
    }
    for (const {value, module: moduleInput, type: typeOnly, directory} of references) {
      if (runtime && typeOnly) continue;
      if (runtime && moduleInput && /^(?:(?:node:)?(?:child_process|worker_threads|sqlite)(?:\/|$)|electron(?:\/|$)|pg(?:\/|$)|@dohc\/workspace-postgres(?:\/|$))/u.test(value)) native.add(path);
      if (!/^(?:\.{1,2}\/|@dohc\/)/u.test(value)) {
        if (runtime && moduleInput && /^(?:#|@\/|~\/)/u.test(value)) uncertain.add(path);
        continue;
      }
      const reference = value.replace(/[?#].*$/u, "");
      if (!moduleInput && ["./", "../"].includes(reference)) continue;
      const depend = target => { dependencies.add(target); if (seeds) pending.add(target); };
      if (reference.startsWith("@dohc/")) {
        const [scope, name, ...subpath] = reference.split("/");
        const pkg = manifests.get(`${scope}/${name}`);
        const key = subpath.length ? `./${subpath.join("/")}` : ".";
        const exports = pkg?.manifest.exports;
        const targets = exportTargets(typeof exports === "string" ? key === "." && exports : exports?.[key]);
        const resolved = targets.map(target => candidates(posix.join(pkg.path, target)).find(candidate => paths.has(candidate))).filter(Boolean);
        for (const target of resolved) depend(target);
        if (!resolved.length && moduleInput) uncertain.add(path);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), reference));
      const resolved = !directory && candidates(target).find(candidate => paths.has(candidate));
      if (resolved) depend(resolved);
      else {
        // Only source-reading tests/tools and computed module loads expand
        // directories. Runtime strings can instead name links or bundle paths.
        const outsideRenderer = !path.startsWith(renderer) && !path.startsWith(site);
        const sourceReader = outsideRenderer && (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
          || /^(?:scripts|tools)\//u.test(path) || path.includes("/e2e/"));
        const prefix = directory ? target : target.replace(/\/$/u, "") + "/";
        if (!runtime && (directory && moduleInput || !directory && sourceReader && prefix.startsWith(renderer))) {
          for (const candidate of paths) if (candidate.startsWith(renderer) && candidate.startsWith(prefix)) depend(candidate);
        }
        // Missing module inputs must not silently produce an incomplete graph.
        if (moduleInput && !typeOnly) uncertain.add(path);
      }
    }
    for (const dependency of dependencies) {
      if (!consumers.has(dependency)) consumers.set(dependency, new Set());
      consumers.get(dependency).add(path);
    }
  }
  return {inputs, consumers, uncertain, native, escaped};
}

function closure(seeds, graph) {
  const reached = new Set(seeds);
  for (const path of reached) for (const next of graph.get(path) ?? []) reached.add(next);
  return reached;
}

// This scope excludes main-process, storage, IPC, and sharing inputs. The old
// package selection remains the fallback whenever a renderer consumer escapes.
export function focusedRendererSelection(changed, files, {baseFiles, graph, loadParser = () => require("@babel/parser").parse} = {}) {
  if (!changed.length || changed.some(path => !path.startsWith(renderer) || !/\.(?:tsx?|css)$/u.test(path))) return null;
  const sources = new Map(files.map(file => [file.path, file.source]));
  if (!sources.has(tokensTest) || changed.some(path => !sources.has(path) || baseFiles && !baseFiles.has(path))) return null;
  const {consumers, uncertain, escaped} = graph ?? rendererInputGraph(files);
  if (escaped?.size) return null;
  const affected = closure(changed, consumers);
  if ([...affected].some(path => !path.startsWith(renderer) && !path.startsWith(site))) return null;
  // A computed module load in the renderer or site could hide a reverse edge.
  if ([...uncertain].some(path => path.startsWith(renderer) || path.startsWith(site))) return null;
  const tests = [...affected].filter(path => path.startsWith(renderer) && unitTest.test(path));
  // A source edit without a test consumer needs the complete existing gate.
  for (const path of changed) {
    if (path.endsWith(".css")) continue;
    if (![...closure([path], consumers)].some(consumer => tests.includes(consumer))) return null;
  }
  // These source scans are broader than imports: tokens.test.ts reads every
  // renderer module, and the site's Tailwind @source reads the renderer tree.
  tests.push(tokensTest);
  // Planning happens before the canonical frozen install. An older checkout
  // can use package selection until that install provides the parser.
  let parse;
  try { parse = loadParser(); }
  catch (error) { if (error.code === "MODULE_NOT_FOUND") return null; throw error; }
  const runtimeGraph = rendererInputGraph(files, {runtime: true, seeds: tests, parse});
  const testInputs = closure(tests, runtimeGraph.inputs);
  for (const path of testInputs) {
    if (runtimeGraph.uncertain.has(path) || runtimeGraph.native.has(path)
      || /^apps\/desktop\/src\/(?:process|launch|window|preload)\//u.test(path)
      || /^apps\/desktop\/src\/(?:main|entry)\.[cm]?[jt]s$/u.test(path)
      || /(?:^|\/)testing\/engineBinary\.[jt]s$/u.test(path)) return null;
  }
  const testFiles = [...new Set(tests)].map(path => posix.relative("apps/desktop", path)).sort();
  // Leave room for pnpm's script and quoting under cmd.exe's 8,191-char limit.
  // Broad selection also restores native/PG resources for the complete suite.
  if (testFiles.reduce((length, path) => length + path.length + 3, 0) > 6000) return null;
  return {
    packages: ["@dohc/desktop", "@dohc/site"], affected: ["@dohc/desktop", "@dohc/site"], full: false,
    reason: "Renderer inputs and test consumers stay within the renderer and site.",
    testFiles: {"@dohc/desktop": testFiles},
    desktopScripts: false, repository: "source",
    proofs: {accounts: false, selfHostNative: false, desktop: false, smoke: true, statesPage: true},
    needs: {postgres: false, engine: true, desktop: true},
  };
}

export function readRendererFiles(root) {
  const tracked = readGit(["ls-files", "-z"], root).split("\0").filter(Boolean);
  return tracked.filter(path => existsSync(join(root, path)))
    .map(path => ({path, source: sourceFile.test(path) || path.endsWith("/package.json") ? readFileSync(join(root, path), "utf8") : ""}));
}

export function readFocusedRendererSelection(root, changed, baseCommit) {
  if (!changed.length || changed.some(path => !path.startsWith(renderer) || !/\.(?:tsx?|css)$/u.test(path))) return null;
  const files = readRendererFiles(root);
  const tracked = files.map(file => file.path);
  const trackedPaths = new Set(tracked);
  if (changed.some(path => !trackedPaths.has(path) || !existsSync(join(root, path)))) return null;
  const baseFiles = baseCommit ? new Set(readGit(["ls-tree", "-r", "--name-only", "-z", baseCommit], root).split("\0")) : undefined;
  return focusedRendererSelection(changed, files, {baseFiles});
}
