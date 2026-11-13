#!/usr/bin/env node
// Catch a renderer module that loads an operation declaration at run time.
// A declaration carries its CLI and MCP doors, which the renderer does not ship.
// The check follows value imports from every renderer source through relative modules and @dohc packages.
// It does not follow npm packages or a package export with no TypeScript source.
// It refuses a dynamic import whose module is not a string, because it cannot follow one.
import { existsSync, globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRendererSource } from "./check-ui-rules.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const { parse } = createRequire(join(repoRoot, "package.json"))("@babel/parser");
const fix = "Import its types with `import type`, or import the schema from its contract module, such as @dohc/workspace-contracts/links.";
const extensions = [".ts", ".tsx"];

function childNodes(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (typeof child?.type === "string") result.push(child);
  }
  return result;
}

const typeOnly = node => node.importKind === "type" || node.exportKind === "type"
  || node.specifiers?.length > 0 && node.specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type");

// A family file in workspace-contracts declares operations, however it spells its type.
const declarationFile = /^packages\/workspace-contracts\/src\/(?:.+\/)?[^/]*Declarations\.ts$/u;

// The modules a file loads when it runs, whether it declares an operation
// family, and whether it loads a module it does not name.
function readModule(path, source) {
  const program = parse(source, { sourceType: "module", plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] }).program;
  const imports = [];
  let declares = declarationFile.test(path);
  let unnamed = false;
  const visit = node => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      if (node.source && !typeOnly(node)) imports.push(node.source.value);
    } else if (node.type === "ImportExpression" || node.type === "CallExpression" && node.callee.type === "Import") {
      const [argument] = node.type === "ImportExpression" ? [node.source] : node.arguments;
      if (argument?.type === "StringLiteral") imports.push(argument.value);
      else unnamed = true;
    } else if (node.type === "TSSatisfiesExpression" && node.typeAnnotation.typeName?.name === "OperationFamily") {
      declares = true;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(program);
  return { imports, declares, unnamed };
}

function workspacePackages(root) {
  const packages = new Map();
  for (const path of globSync("{apps,packages,services}/*/package.json", { cwd: root })) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (manifest.name?.startsWith("@dohc/")) packages.set(manifest.name, { dir: posix.dirname(path.replaceAll("\\", "/")), exports: manifest.exports ?? {} });
  }
  return packages;
}

function sourceFile(root, path) {
  const candidates = /\.[cm]?js$/u.test(path) ? extensions.map(extension => path.replace(/\.[cm]?js$/u, extension))
    : extensions.includes(posix.extname(path)) ? [path]
      : [...extensions.map(extension => path + extension), ...extensions.map(extension => path + "/index" + extension)];
  return candidates.find(candidate => existsSync(join(root, candidate))) ?? null;
}

function resolveImport(root, packages, from, request) {
  // A worker import such as ./x.worker.ts?worker&url ships x.worker.ts with the renderer.
  const specifier = request.replace(/[?#].*$/u, "");
  if (specifier.startsWith(".")) return sourceFile(root, posix.join(posix.dirname(from), specifier));
  const name = specifier.split("/").slice(0, 2).join("/");
  const workspacePackage = packages.get(name);
  if (!workspacePackage) return null;
  const target = workspacePackage.exports["." + specifier.slice(name.length)];
  const path = typeof target === "string" ? target : target?.types ?? target?.default;
  return typeof path === "string" ? sourceFile(root, posix.join(workspacePackage.dir, path)) : null;
}

export function checkRendererDeclarations(root) {
  const packages = workspacePackages(root);
  const sources = globSync("apps/desktop/src/renderer/**/*.{ts,tsx}", { cwd: root })
    .map(path => path.replaceAll("\\", "/")).filter(isRendererSource).sort();
  const reachedFrom = new Map(sources.map(path => [path, null]));
  const failures = [];
  for (let index = 0, queue = [...sources]; index < queue.length; index += 1) {
    const path = queue[index];
    const { imports, declares, unnamed } = readModule(path, readFileSync(join(root, path), "utf8"));
    if (unnamed) failures.push(path + " imports a module named by an expression, which this check cannot follow. Name the module with a string.");
    if (declares) {
      const chain = [path];
      while (reachedFrom.get(chain[0])) chain.unshift(reachedFrom.get(chain[0]));
      failures.push(chain[0] + " loads the operation declarations in " + path + " at run time"
        + (chain.length > 2 ? " through " + chain.slice(1, -1).join(", ") : "") + ". " + fix);
      continue;
    }
    for (const specifier of imports) {
      const resolved = resolveImport(root, packages, path, specifier);
      if (resolved && !reachedFrom.has(resolved)) {
        reachedFrom.set(resolved, path);
        queue.push(resolved);
      }
    }
  }
  return { failures, modules: reachedFrom.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const { failures, modules } = checkRendererDeclarations(root);
  if (failures.length) {
    console.error("Renderer declarations check failed:\n" + failures.map(failure => "- " + failure).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Renderer declarations check passed (" + modules + " modules the renderer loads).");
  }
}
