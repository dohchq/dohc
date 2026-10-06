#!/usr/bin/env node
// Types carry the capability rules (read vs command, owned operations, data inputs, opaque task).
// This check covers what types cannot: who may reach transport, and the form of handlers.
// Usage: node scripts/check-renderer-async.mjs [rendererRoot] [--strict]
// The default renderer uses the base raw-call inventory until migration completes.
import { checkRawBridge, children, isRendererTest, rendererRoot as defaultRoot, transportFiles } from "./check-raw-bridge.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

const [rendererRoot = defaultRoot, mode = "--ratchet"] = process.argv.slice(2);
const { parseSync } = createRequire(import.meta.url)("oxc-parser");
const root = resolve(rendererRoot);
const rel = (p) => relative(root, p).split(sep).join("/");
const registryPath = join(root, "desktopActionOwners.json");
const owners = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : {};
const ownedOperations = new Map(Object.entries(owners).flatMap(([file, ops]) => ops.map((op) => [op, file])));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/u.test(name)) files.push(path);
  }
})(root);

function role(path) {
  const r = rel(path);
  if (isRendererTest(r)) return "test";
  if (transportFiles.includes(r)) return "transport";
  if (Object.hasOwn(owners, r)) return "owner";
  if (r.startsWith("data/")) return "data";
  return "view";
}
const resolveModule = (from, spec) => {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`].find((p) => existsSync(p) && statSync(p).isFile()) ?? `${base}.ts`;
};

const findings = [];
const promiseMethods = new Set(["then", "catch", "finally"]);
const schedulers = new Set(["setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame"]);
const memberName = node => node.computed ? node.property?.value : node.property?.name;
const isString = (n) => n?.type === "Literal" && typeof n.value === "string";
const isFunction = (n) => ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(n?.type);
const hookArity = { useDesktopAction: { request: 1, handlers: [2] }, useDesktopLoad: { request: 1, handlers: [3] }, useDesktopCommand: { request: 1, handlers: [2, 3] }, useDesktopEvent: { request: 1, handlers: [2] } };

for (const path of files) {
  const kind = role(path);
  if (kind === "test" || kind === "transport") continue;
  const text = readFileSync(path, "utf8");
  const { program, errors } = parseSync(path, text);
  if (errors.length) { findings.push(`PARSE ${rel(path)}: ${errors[0].message}`); continue; }
  const line = (node) => text.slice(0, node.start).split("\n").length;
  const report = (node, code, message) => findings.push(`${code} ${rel(path)}:${line(node)}: ${message}`);
  const importRoles = new Map();
  const declarations = new Map(); // same-file name -> initializer or function
  const declarationCount = new Map();
  const setters = new Set();

  const checkDependency = (node, spec, runtime) => {
    const target = spec.startsWith(".") ? resolveModule(path, spec) : null;
    const targetRel = target ? rel(target) : "";
    if (runtime && kind !== "owner" && targetRel === "bridge.ts") report(node, "RA1", "only registered resource owners may import the desktop bridge. Use the desktopAction hooks.");
    if (runtime && targetRel === "desktopActionTesting.ts") report(node, "RA6", "task completion is for tests. Production code cannot wait on a task; put follow-up work in delivery or in the resource owner.");
    if (kind === "data" && runtime && (spec === "react" || (target && role(target) !== "data"))) report(node, "RA4", "data executors may import only packages, types, and other data executors.");
    return targetRel;
  };
  for (const statement of program.body) {
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source) {
      const runtime = statement.exportKind !== "type" && (statement.type === "ExportAllDeclaration" || statement.specifiers.some(s => s.exportKind !== "type"));
      const targetRel = checkDependency(statement, statement.source.value, runtime);
      if (runtime && transportFiles.includes(targetRel)) {
        report(statement, "RA7", "do not re-export desktopAction, desktopActionTesting, or bridge. Import the hooks by name where they are used.");
      }
    }
    if (statement.type === "ImportDeclaration") {
      const spec = statement.source.value;
      const target = spec.startsWith(".") ? resolveModule(path, spec) : null;
      const targetRole = target ? role(target) : "package";
      for (const s of statement.specifiers) importRoles.set(s.local.name, targetRole);
      const runtimeImport = statement.importKind !== "type" && (statement.specifiers.length === 0 || statement.specifiers.some(s => s.importKind !== "type"));
      const targetRel = checkDependency(statement, spec, runtimeImport);
      if (targetRel !== "desktopActionTesting.ts" && statement.specifiers.some((s) => s.imported?.name === "settledTasks")) {
        report(statement, "RA6", "task completion is for tests. Production code cannot wait on a task; put follow-up work in delivery or in the resource owner.");
      }
      if (targetRel === "desktopAction.ts" && statement.specifiers.some((s) => s.type !== "ImportSpecifier" || s.imported.name !== s.local.name)) {
        report(statement, "RA7", "import the desktopAction hooks by name, without an alias or namespace, so the check can see each call.");
      }
    }
    if (kind === "data") {
      const decl = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      const allowed = statement.type === "ImportDeclaration" || (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(statement.type) && !statement.declaration)
        || ["FunctionDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(decl?.type);
      if (!allowed) report(statement, "RA4", "data executors hold no module state: only functions and types at top level. Keep caches in their resource owner or pass them as context.");
    }
  }

  const count = (name) => declarationCount.set(name, (declarationCount.get(name) ?? 0) + 1);
  const countPattern = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") count(pattern.name);
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach((p) => countPattern(p.type === "RestElement" ? p.argument : p.value));
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach((e) => countPattern(e?.type === "RestElement" ? e.argument : e));
    else if (pattern.type === "AssignmentPattern") countPattern(pattern.left);
    else if (pattern.type === "RestElement") countPattern(pattern.argument);
  };
  for (const statement of program.body) if (statement.type === "ImportDeclaration") for (const s of statement.specifiers) count(s.local.name);
  const collect = (node) => {
    if (node.type === "FunctionDeclaration" && node.id) { declarations.set(node.id.name, node); count(node.id.name); }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) { declarations.set(node.id.name, node.init); count(node.id.name); }
    if (node.type === "VariableDeclarator" && node.id?.type !== "Identifier") countPattern(node.id);
    if (isFunction(node)) node.params.forEach(countPattern);
    if (node.type === "VariableDeclarator" && node.id?.type === "ArrayPattern" && node.init?.type === "CallExpression"
      && /^(?:useState|useReducer)$/u.test(node.init.callee.name ?? "") && node.id.elements[1]?.type === "Identifier") setters.add(node.id.elements[1].name);
    children(node).forEach(collect);
  };
  collect(program);

  // The same-file function a name refers to, through useCallback; null when unknown or declared more than once.
  const localFunction = (name) => {
    if ((declarationCount.get(name) ?? 0) !== 1) return null;
    const target = declarations.get(name);
    if (isFunction(target)) return target;
    if (target?.type === "CallExpression" && target.callee.name === "useCallback" && isFunction(target.arguments[0])) return target.arguments[0];
    return null;
  };
  // A function defers work if it is async, awaits, chains, schedules, or calls a same-file function that does.
  const deferring = (fn, seen = new Set()) => {
    if (seen.has(fn)) return false;
    seen.add(fn);
    if (fn.async) return true;
    let found = false;
    const scan = (node) => {
      if (found) return;
      if (node.type === "AwaitExpression") { found = true; return; }
      if (node.type === "CallExpression") {
        const callee = node.callee;
        if (callee.type === "MemberExpression" && (promiseMethods.has(memberName(callee))
          || ["window", "globalThis"].includes(callee.object.name) && schedulers.has(memberName(callee)))
          || callee.type === "Identifier" && schedulers.has(callee.name)) { found = true; return; }
      }
      if (node.type === "UnaryExpression" && node.operator === "void" && node.argument.type === "CallExpression") {
        const callee = node.argument.callee;
        const resolved = callee.type === "Identifier" && ((setters.has(callee.name) && declarationCount.get(callee.name) === 1) || localFunction(callee.name));
        if (!resolved) { found = true; return; }
      }
      if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        // A name declared more than once in the file cannot be resolved here; treat it as deferring.
        if ((declarationCount.get(node.callee.name) ?? 0) > 1) { found = true; return; }
        const callee = localFunction(node.callee.name);
        if (callee && deferring(callee, seen)) { found = true; return; }
      }
      children(node).forEach(scan);
    };
    scan(fn.body);
    return found;
  };
  const checkHandler = (node, where) => {
    if (isFunction(node)) {
      if (deferring(node)) report(where, "RA3", "handlers are synchronous, including the same-file functions they call. A name declared twice, or a voided call to anything but a same-file synchronous function, counts as unverifiable. Issue follow-up work through another hook, rename the helper, or move the operation into its resource owner.");
      return;
    }
    if (node.type === "Identifier") {
      if (setters.has(node.name) && declarationCount.get(node.name) === 1) return;
      if ((declarationCount.get(node.name) ?? 0) > 1) return report(where, "RA3", `handler "${node.name}" is declared more than once in this file. Give each handler its own name.`);
      const target = localFunction(node.name);
      if (target) return checkHandler(target, where);
    }
    report(where, "RA3", "unsupported handler form. Use an inline function, a function declared once in this file, or a state setter, so the check can see it is synchronous.");
  };
  const checkHandlers = (arg, where) => {
    let object = arg;
    if (arg?.type === "Identifier" && (declarationCount.get(arg.name) ?? 0) === 1 && declarations.get(arg.name)?.type === "ObjectExpression") object = declarations.get(arg.name);
    if (object?.type !== "ObjectExpression") return report(where, "RA3", "pass handlers as an object literal written in this file.");
    for (const property of object.properties) {
      if (property.type !== "Property") { report(property, "RA3", "spread handlers are not supported. List each handler."); continue; }
      if (property.key.name === "scope") continue;
      checkHandler(property.value, property);
    }
  };

  const callees = new Set();
  const markCallees = (node) => { if (node.type === "CallExpression" && node.callee.type === "Identifier") callees.add(node.callee); children(node).forEach(markCallees); };
  markCallees(program);
  const importedNames = new Set(program.body.filter((s) => s.type === "ImportDeclaration").flatMap((s) => s.specifiers.map((sp) => sp.local)));
  const visit = (node) => {
    if (node.type === "Identifier" && Object.hasOwn(hookArity, node.name) && !callees.has(node) && !importedNames.has(node)
      && !program.body.some((s) => s.type === "ImportDeclaration" && s.specifiers.some((sp) => sp.imported === node))) {
      report(node, "RA7", "use the desktopAction hooks only as direct calls. Do not alias, re-export, or pass them around.");
    }
    if (kind !== "owner" && ((node.type === "Identifier" && node.name === "dohcDesktop") || (isString(node) && node.value === "dohcDesktop"))) {
      report(node, "RA1", "views cannot reach window.dohcDesktop. Use the desktopAction hooks, or desktopMetadata() for platform, devTools, and window role.");
    }
    if (node.type === "ImportExpression") {
      if (!isString(node.source)) report(node, "RA7", "dynamic imports must name a literal module so its renderer boundary can be checked.");
      else {
        const targetRel = checkDependency(node, node.source.value, true);
        if (targetRel === "desktopAction.ts") report(node, "RA7", "import the desktopAction hooks by name, without a dynamic import.");
      }
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && Object.hasOwn(hookArity, node.callee.name)) {
      const { request: requestIndex, handlers } = hookArity[node.callee.name];
      if (requestIndex !== null) {
        const request = node.arguments[requestIndex];
        if (isString(request)) {
          if (ownedOperations.has(request.value)) report(request, "RA5", `operation "${request.value}" is owned by ${ownedOperations.get(request.value)}. Use that owner.`);
        } else if (node.callee.name === "useDesktopEvent" || !(request?.type === "Identifier" && importRoles.get(request.name) === "data")) {
          report(request ?? node, "RA2", "the request must be an operation name or a data executor imported from renderer/data/.");
        }
      }
      for (const index of handlers) {
        const arg = node.arguments[index];
        if (!arg) continue;
        if (node.callee.name === "useDesktopEvent") checkHandler(arg, arg);
        else checkHandlers(arg, arg);
      }
    }
    children(node).forEach(visit);
  };
  visit(program);
}

const unique = [...new Set(findings)];
for (const f of unique) console.log(f);
console.log(JSON.stringify({ files: files.length, findings: unique.length }));
const inventory = mode === "--ratchet" && root === defaultRoot
  ? JSON.parse(readFileSync(new URL("./renderer-raw-bridge-inventory.json", import.meta.url), "utf8")) : null;
const violations = inventory ? unique.filter(finding => {
  const match = /^RA1 (.+?):\d+:/.exec(finding);
  return !match || !Object.hasOwn(inventory.counts, match[1]);
}) : [...unique];
if (inventory) {
  const raw = checkRawBridge(root, inventory);
  for (const line of raw) console.log(line);
  violations.push(...raw);
  console.log(JSON.stringify({ legacyRA1: unique.filter(line => line.startsWith("RA1 ")).length, violations: violations.length }));
}
process.exitCode = violations.length ? 1 : 0;
