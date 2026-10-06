#!/usr/bin/env node
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const inventoryPath = "scripts/ipc-sites.json";
const { typescriptLanguage } = createRequire(join(repoRoot, "apps/desktop/package.json"))("@codemirror/lang-javascript");
const fix = "Declare a row in an OperationTable in apps/desktop/src/ipc/bridgeContract.ts; operationBridge and registerOperations derive the preload method and the main handler.";

export function isIpcSource(path) {
  return path === "apps/desktop/src/preload.ts" || path === "apps/desktop/src/main.ts"
    || /^apps\/desktop\/src\/ipc\/[^/]+Ipc\.ts$/u.test(path);
}

function children(node) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (!/^(?:Line|Block)Comment$/u.test(child.name)) result.push(child);
  }
  return result;
}

function argumentsOf(node) {
  return children(node.getChild("ArgList")).filter(child => !["(", ")", ","].includes(child.name));
}

function canonical(node, source) {
  if (!node) return "<missing>";
  if (node.name === "String") return JSON.stringify(source.slice(node.from + 1, node.to - 1));
  const parts = children(node);
  return parts.length ? parts.map(child => canonical(child, source)).join("") : source.slice(node.from, node.to);
}

function calleeName(node, source) {
  if (node.name === "InstantiationExpression") return calleeName(node.firstChild, source);
  const parts = children(node);
  if (node.name === "MemberExpression" && parts[1]?.name === "[" && parts[2]?.name === "String") {
    return canonical(parts[0], source) + "." + source.slice(parts[2].from + 1, parts[2].to - 1);
  }
  return canonical(node, source);
}

function ancestor(node, predicate) {
  for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
  return null;
}

function functionName(node, source) {
  return node ? canonical(node.getChild("VariableDefinition"), source) : "<inline>";
}

// Expand the registrar's channel tuple so extending a loop adds a distinct site.
function channelsFor(node, argument, source) {
  if (argument?.name !== "VariableName") return [canonical(argument, source)];
  const loop = ancestor(node, parent => parent.name === "ForStatement");
  const spec = loop?.getChild("ForOfSpec");
  const pattern = spec?.getChild("ArrayPattern");
  const binding = children(pattern).filter(child => child.name === "VariableDefinition");
  const directBinding = spec?.getChild("VariableDefinition");
  const index = binding.findIndex(child => canonical(child, source) === canonical(argument, source));
  const collection = children(spec).find(child => child.name === "ArrayExpression" || child.name === "BinaryExpression");
  const array = collection?.name === "BinaryExpression" ? collection.getChild("ArrayExpression") : collection;
  if (!array) return [canonical(argument, source)];
  if (directBinding && canonical(directBinding, source) === canonical(argument, source)) {
    return children(array).filter(child => !["[", "]", ","].includes(child.name)).map(child => canonical(child, source));
  }
  if (index < 0) return [canonical(argument, source)];
  return children(array).filter(child => child.name === "ArrayExpression").map(tuple =>
    canonical(children(tuple).filter(child => !["[", "]", ","].includes(child.name))[index], source));
}

export function extractIpcSites(path, source) {
  if (!isIpcSource(path)) return [];
  const tree = typescriptLanguage.parser.parse(source);
  const calls = [];
  const visit = node => {
    if (node.name === "CallExpression") calls.push(node);
    for (const child of children(node)) visit(child);
  };
  visit(tree.topNode);
  const preload = path.endsWith("/preload.ts");
  const helpers = new Set();
  const tableHelpers = new Set();
  for (const call of calls) {
    const callee = calleeName(call.firstChild, source);
    if (preload && callee === "ipcRenderer.invoke") {
      const owner = ancestor(call, node => node.name === "FunctionDeclaration");
      if (owner) helpers.add(functionName(owner, source));
    }
    if (callee === "operationBridge") {
      const helper = argumentsOf(call)[1];
      if (helper?.name === "VariableName") tableHelpers.add(canonical(helper, source));
    }
  }
  const sites = [];
  const occurrences = new Map();
  for (const call of calls) {
    const callee = calleeName(call.firstChild, source);
    const handCall = preload
      ? callee === "ipcRenderer.invoke" || helpers.has(callee)
      : callee === "handleIpc" || callee === "ipcMain.handle" || /(?:^|\.)registerHandler$/u.test(callee);
    if (!handCall) continue;
    const owner = ancestor(call, node => node.name === "FunctionDeclaration");
    const argument = argumentsOf(call)[0];
    const firstParameter = owner?.getChild("ParamList")?.getChild("VariableDefinition");
    if (preload && callee === "ipcRenderer.invoke" && argument?.name === "VariableName"
      && canonical(argument, source) === canonical(firstParameter, source)
      && tableHelpers.has(functionName(owner, source))) continue;
    for (const channel of channelsFor(call, argument, source)) {
      const kind = preload ? "preload" : "main";
      const forwarding = argument?.name === "VariableName" && channel === canonical(argument, source);
      const identity = forwarding ? callee + "(" + channel + ")@" + functionName(owner, source) : channel;
      const key = path + " | " + kind + " | " + identity;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      sites.push({ fingerprint: occurrence === 1 ? key : key + " #" + occurrence, line: source.slice(0, call.from).split("\n").length });
    }
  }
  return sites;
}

export function collectIpcSites(root) {
  const paths = ["apps/desktop/src/preload.ts", "apps/desktop/src/main.ts",
    ...globSync("apps/desktop/src/ipc/*Ipc.ts", { cwd: root }).map(path => path.replaceAll("\\", "/"))];
  return paths.sort().flatMap(path => extractIpcSites(path, readFileSync(join(root, path), "utf8")));
}

export function checkIpcSites(root, inventory) {
  if (!Array.isArray(inventory?.sites) || inventory.sites.some(site => typeof site !== "string")
    || new Set(inventory.sites).size !== inventory.sites.length) {
    return { failures: [inventoryPath + ": expected unique site fingerprints."], sites: [] };
  }
  const sites = collectIpcSites(root);
  const allowed = new Set(inventory.sites);
  const current = new Set(sites.map(site => site.fingerprint));
  const failures = sites.filter(site => !allowed.has(site.fingerprint))
    .map(site => site.fingerprint + " (line " + site.line + "): new hand-written IPC site. " + fix);
  for (const site of allowed) {
    if (!current.has(site)) failures.push(site + ": stale entry. Remove it from " + inventoryPath + "; the inventory only shrinks.");
  }
  return { failures, sites };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const inventory = JSON.parse(readFileSync(join(root, inventoryPath), "utf8"));
  const { failures, sites } = checkIpcSites(root, inventory);
  if (failures.length) {
    console.error("IPC sites check failed:\n" + failures.map(failure => "- " + failure).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("IPC sites check passed (" + sites.length + " legacy sites).");
  }
}
