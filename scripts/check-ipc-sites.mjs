#!/usr/bin/env node
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const inventoryPath = "scripts/ipc-sites.json";
const { typescriptLanguage } = createRequire(join(repoRoot, "apps/desktop/package.json"))("@codemirror/lang-javascript");
const fix = "Declare a row in an OperationTable in apps/desktop/src/ipc/bridgeContract.ts; operationBridge and registerOperations derive the preload method and the main handler.";
const isFunction = node => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunction)$/u.test(node?.name);
const isScope = node => isFunction(node) || node.name === "Block" || node.name === "Script";
const isIpcSource = path => path.startsWith("apps/desktop/src/") && path.endsWith(".ts")
  && !path.startsWith("apps/desktop/src/renderer/")
  && !/\.(?:test(?:-d)?|spec|testSupport)\.|\/(?:__tests__|testing|fixtures)\//u.test(path);

function children(node) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (!/^(?:Line|Block)Comment$/u.test(child.name)) result.push(child);
  }
  return result;
}
const elements = node => children(node).filter(child => !["(", ")", "[", "]", ","].includes(child.name));
const argumentsOf = node => elements(node.getChild("ArgList"));
function unwrap(node) {
  while (node && (node.name === "ParenthesizedExpression" || node.name === "InstantiationExpression"
    || node.name === "PrefixCast" || node.name === "PostfixExpression" && node.lastChild?.name === "LogicOp"
    || node.name === "BinaryExpression" && children(node).some(child => ["as", "satisfies"].includes(child.name)))) {
    node = node.name === "ParenthesizedExpression" ? elements(node)[0]
      : node.name === "PrefixCast" ? node.lastChild : node.firstChild;
  }
  return node;
}
function canonical(node, source) {
  if (!node) return "<missing>";
  if (node.name === "String") return JSON.stringify(source.slice(node.from + 1, node.to - 1));
  const parts = children(node);
  return parts.length ? parts.map(child => canonical(child, source)).join("") : source.slice(node.from, node.to);
}
function ancestor(node, predicate) {
  for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
  return null;
}
function functionName(node, source) {
  if (!node) return "<inline>";
  if (node.parent?.name === "Property") {
    const caller = ancestor(node, parent => parent.name === "CallExpression");
    return (caller ? canonical(unwrap(caller.firstChild), source) + "." : "") + canonical(node.parent.getChild("PropertyDefinition"), source);
  }
  const name = node.getChild("VariableDefinition") ?? node.parent?.getChild("VariableDefinition")
    ?? node.parent?.getChild("PropertyName");
  return name ? canonical(name, source) : functionName(ancestor(node, isFunction), source) + "/<inline>";
}

export function extractIpcSites(path, source) {
  if (!isIpcSource(path)) return [];
  const tree = typescriptLanguage.parser.parse(source);
  const calls = [], bindings = new Map();
  const addBinding = (name, value, scope, property) => {
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push({ value, scope, property });
  };
  const visit = node => {
    if (node.name === "CallExpression") calls.push(node);
    if (node.name === "VariableDeclaration") {
      const parts = children(node);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].name !== "Equals") continue;
        const pattern = parts[i - 1].name === "TypeAnnotation" ? parts[i - 2] : parts[i - 1];
        const value = parts[0].name === "const" ? parts[i + 1] : null;
        const scope = ancestor(node, isScope);
        if (pattern.name === "VariableDefinition") addBinding(canonical(pattern, source), value, scope);
        for (const prop of children(pattern).filter(child => child.name === "PatternProperty")) {
          const key = prop.getChild("PropertyName");
          addBinding(canonical(prop.getChild("VariableDefinition") ?? key, source), value, scope, canonical(key, source));
        }
      }
    }
    if (node.name === "FunctionDeclaration") addBinding(canonical(node.getChild("VariableDefinition"), source), node, ancestor(node, isScope));
    if (node.name === "VariableDefinition" && node.parent.name === "ParamList") addBinding(canonical(node, source), null, ancestor(node, isFunction));
    for (const child of children(node)) visit(child);
  };
  visit(tree.topNode);
  const bindingFor = node => {
    const name = canonical(node, source);
    for (let scope = node.parent; scope; scope = scope.parent) {
      const binding = bindings.get(name)?.find(binding => binding.scope?.from === scope.from && binding.scope?.name === scope.name);
      if (binding) return binding;
    }
  };
  const resolved = (node, seen = new Set()) => {
    node = unwrap(node);
    const binding = node?.name === "VariableName" && bindingFor(node);
    if (!binding?.value || binding.property || seen.has(binding)) return node;
    return resolved(binding.value, new Set([...seen, binding]));
  };
  const calleeName = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return "<missing>";
    const binding = node.name === "VariableName" && bindingFor(node);
    if (binding?.value && !seen.has(binding) && /^(?:VariableName|MemberExpression|CallExpression|FunctionDeclaration|FunctionExpression|ArrowFunction)$/u.test(unwrap(binding.value)?.name)) {
      return calleeName(binding.value, new Set([...seen, binding])) + (binding.property ? "." + binding.property : "");
    }
    const parts = children(node);
    if (node.name === "MemberExpression") return calleeName(parts[0], seen) + "." + canonical(parts[2], source).replace(/^"|"$/gu, "");
    if (node.name === "CallExpression" && calleeName(node.firstChild, seen).endsWith(".bind")) return calleeName(node.firstChild, seen).slice(0, -5);
    return isFunction(node) ? functionName(node, source) : canonical(node, source);
  };
  const expandedText = (node, seen = new Set()) => {
    const value = resolved(node);
    const key = value && value.name + ":" + value.from + ":" + value.to;
    if (!value || seen.has(key)) return canonical(node, source);
    const parts = children(value);
    return parts.length ? parts.map(child => expandedText(child, new Set([...seen, key]))).join("") : canonical(value, source);
  };
  // Unresolved rows retain their collection text so an added row cannot disappear.
  const arrayRows = (node, seen = new Set()) => {
    const array = resolved(node);
    if (array?.name !== "ArrayExpression" || seen.has(array.from)) return [null];
    const parts = elements(array), rows = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].name === "Spread") rows.push(...arrayRows(parts[++i], new Set([...seen, array.from])));
      else rows.push(resolved(parts[i]));
    }
    return rows;
  };
  const channelsFor = (call, argument) => {
    if (argument?.name !== "VariableName") return [canonical(argument, source)];
    const spec = ancestor(call, node => node.name === "ForStatement")?.getChild("ForOfSpec");
    const parts = children(spec), of = parts.findIndex(child => child.name === "of");
    const pattern = spec?.getChild("ArrayPattern");
    const names = pattern ? elements(pattern) : [spec?.getChild("VariableDefinition")];
    const index = names.findIndex(node => canonical(node, source) === canonical(argument, source));
    if (of < 0 || index < 0) return [canonical(argument, source)];
    const collection = parts[of + 1];
    const fallback = "collection(" + expandedText(collection) + ")";
    return arrayRows(collection).map(row => {
      const tuple = pattern && row?.name === "ArrayExpression" ? arrayRows(row) : null;
      const channel = pattern ? tuple && !tuple.includes(null) && tuple[index] : row;
      return channel ? canonical(resolved(channel), source) : fallback;
    });
  };
  const helpers = new Set(), tableHelpers = new Set();
  for (const call of calls) {
    if (calleeName(call.firstChild) === "ipcRenderer.invoke") {
      const owner = ancestor(call, isFunction);
      if (owner) helpers.add(owner.from);
    }
    if (calleeName(call.firstChild) === "operationBridge") {
      const helper = resolved(argumentsOf(call)[1]);
      if (isFunction(helper)) tableHelpers.add(helper.from);
    }
  }
  const sites = [], occurrences = new Map();
  for (const call of calls) {
    const callee = calleeName(call.firstChild);
    const handCall = callee === "ipcRenderer.invoke" || helpers.has(resolved(call.firstChild)?.from)
      || ["handleIpc", "ipcMain.handle", "ipcMain.handleOnce", "operationBoundary.handle"].includes(callee)
      || /(?:^|\.)registerHandler$/u.test(callee);
    if (!handCall) continue;
    const owner = ancestor(call, isFunction), argument = argumentsOf(call)[0];
    const firstParameter = owner?.getChild("ParamList")?.getChild("VariableDefinition");
    if (callee === "ipcRenderer.invoke" && argument?.name === "VariableName"
      && canonical(argument, source) === canonical(firstParameter, source) && tableHelpers.has(owner?.from)) continue;
    for (const channel of channelsFor(call, argument)) {
      const forwarding = argument?.name === "VariableName" && channel === canonical(argument, source);
      const identity = forwarding ? functionName(owner, source) + " forwards " + channel + " to " + callee : channel;
      const key = path + " | " + identity;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      sites.push({ fingerprint: occurrence === 1 ? key : key + " #" + occurrence, line: source.slice(0, call.from).split("\n").length });
    }
  }
  return sites;
}

export function collectIpcSites(root) {
  return globSync("apps/desktop/src/**/*.ts", { cwd: root }).map(path => path.replaceAll("\\", "/"))
    .filter(isIpcSource).sort().flatMap(path => extractIpcSites(path, readFileSync(join(root, path), "utf8")));
}
export function checkIpcSites(root, inventory) {
  if (!Array.isArray(inventory?.sites) || inventory.sites.some(site => typeof site !== "string")
    || new Set(inventory.sites).size !== inventory.sites.length) {
    return { failures: [inventoryPath + ": expected unique site fingerprints."], sites: [] };
  }
  const sites = collectIpcSites(root), allowed = new Set(inventory.sites), current = new Set(sites.map(site => site.fingerprint));
  const added = sites.filter(site => !allowed.has(site.fingerprint)), stale = [...allowed].filter(site => !current.has(site));
  const failures = added.map(site => site.fingerprint + " (line " + site.line + "): new hand-written IPC site. " + fix
    + " Adding its fingerprint to " + inventoryPath + " is not a fix.");
  for (const site of stale) failures.push(site + ": stale entry. Remove it from " + inventoryPath + "; the inventory only shrinks.");
  if (added.length && stale.length) failures[0] += "\nif this change only moves existing hand sites, replace the stale fingerprints with these."
    + "\nStale fingerprints:\n" + stale.join("\n") + "\nReplacement fingerprints:\n" + added.map(site => site.fingerprint).join("\n");
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
