#!/usr/bin/env node
// Catch a new raw desktop-bridge read in a renderer component or hook file.
// A read inside the load of a call to the imported useWorkspaceQuery is owned by that query.
// Deliberate evasion is outside this check: adding a fingerprint to scripts/bridge-reads.json also means raising the ceiling below, in a reviewed diff.
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRendererSource } from "./check-ui-rules.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const inventoryPath = "scripts/bridge-reads.json";
// The number of reads scripts/bridge-reads.json lists. Lower it when a read moves to useWorkspaceQuery.
// Raise it only with a new entry for a read that cannot use the query: see `unowned` below.
const ceiling = 242;
const queryModule = "apps/desktop/src/renderer/workspace/useWorkspaceQuery";
const { parse } = createRequire(join(repoRoot, "package.json"))("@babel/parser");
const fix = "Read it in the load of useWorkspaceQuery; apps/desktop/src/renderer/workspace/useWorkspaceQuery.ts says how a late or superseded answer is dropped.";
const unowned = "A read with no workspace session, which runs above the shell's WorkspaceSessionProvider, or one that was in this file before the file gained a hook or component, is listed in " + inventoryPath + " with the ceiling in scripts/check-bridge-reads.mjs raised in the same reviewed change.";
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const wrapperTypes = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);
const callTypes = new Set(["CallExpression", "OptionalCallExpression"]);
const memberTypes = new Set(["MemberExpression", "OptionalMemberExpression"]);
const isHookName = name => /^use[A-Z]/u.test(name ?? "");

// Read methods by name. The exceptions below admit work or change state despite their verbs.
const readVerb = /^(?:get|list|read|inspect|check|preview|find|stat|can|has|load|query|count|compare|detect|suggest)[A-Z]/u;
const notReads = new Set(["searchWorkspace", "syncDms", "checkForUpdates"]);
const namedReads = new Set(["resolveWorkLink", "resolveAutomationControls", "automationShareImpact", "chatDispatchStateForThread", "chatFileMentionsPage", "chatLinks", "chatRunRecordsForThread", "cloudStatus", "linksEdges", "linksIn", "locateRecordHistoryRun", "pendingStopAndRestores", "pollRelayShareDiscussionActivity"]);
// Methods that take an action count by the action they read, and as a read when the action is not a literal at the call.
const readActions = {
  dataset: action => /^(?:describe|list|query|read|inspect|migrationPreviewPage|deletePreview|history|status|exportPreview|permissions|lifecycle|pendingAttempts)|^file$/u.test(action),
  ownerRestore: action => ["options", "status", "unfinished"].includes(action),
  heldNoteChange: action => action === "review",
};

const keyName = node => node?.type === "Identifier" ? node.name : node?.type === "StringLiteral" ? node.value : undefined;
const propertyName = node => node.computed ? keyName(node.property.type === "StringLiteral" ? node.property : null) : keyName(node.property);

function readName(method, argument) {
  if (Object.hasOwn(readActions, method)) {
    if (argument?.type === "ConditionalExpression") return readName(method, argument.consequent) ?? readName(method, argument.alternate);
    const action = argument?.type === "ObjectExpression"
      ? argument.properties.find(property => property.type === "ObjectProperty" && keyName(property.key) === "action")?.value
      : undefined;
    if (action?.type !== "StringLiteral") return method + ":?";
    return readActions[method](action.value) ? method + ":" + action.value : null;
  }
  if (notReads.has(method)) return null;
  return readVerb.test(method) || namedReads.has(method) ? method : null;
}

function childNodes(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (typeof child?.type === "string") result.push(child);
  }
  return result;
}

// Owned when an enclosing function is the load of a useWorkspaceQuery call.
function ownedByQuery(call, parents, isQuery) {
  for (let node = call, parent = parents.get(call); parent; node = parent, parent = parents.get(parent)) {
    if (!functionTypes.has(node.type)) continue;
    const property = node.type === "ObjectMethod" ? node : parent.type === "ObjectProperty" && parent.value === node ? parent : null;
    if (!property || keyName(property.key) !== "load" || property.computed) continue;
    const options = parents.get(property), query = options && parents.get(options);
    if (query && callTypes.has(query.type) && isQuery(query.callee) && query.arguments[1] === options) return true;
  }
  return false;
}

// The expression a function returns, when its body is that expression or one return statement.
function returned(fn) {
  if (fn.body.type !== "BlockStatement") return fn.body;
  return fn.body.body.length === 1 && fn.body.body[0].type === "ReturnStatement" ? fn.body.body[0].argument : null;
}

export function extractBridgeReads(path, source) {
  if (!isRendererSource(path)) return [];
  const program = parse(source, { sourceType: "module", plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] }).program;
  const scopes = new Map(), parents = new Map(), calls = [];
  let hookOrComponent = false;
  const bind = (scope, name, value) => scope.bindings.set(name, { value, scope });
  const walk = (node, scope, parent) => {
    parents.set(node, parent);
    if (node.type === "FunctionDeclaration" && node.id) bind(scope, node.id.name, node);
    if (functionTypes.has(node.type) || node.type === "BlockStatement") scope = { bindings: new Map(), parent: scope };
    scopes.set(node, scope);
    if (node.type.startsWith("JSX") || node.type === "FunctionDeclaration" && isHookName(node.id?.name)) hookOrComponent = true;
    if (functionTypes.has(node.type)) for (const param of node.params) if (param.type === "Identifier") bind(scope, param.name, null);
    if (node.type === "VariableDeclarator") {
      if (node.id.type === "Identifier") {
        if (isHookName(node.id.name) && functionTypes.has(node.init?.type)) hookOrComponent = true;
        bind(scope, node.id.name, node.init);
      } else if (node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          if (property.type === "ObjectProperty" && property.value.type === "Identifier") bind(scope, property.value.name, { type: "Destructured", object: node.init, key: keyName(property.key) });
        }
      }
    }
    if (node.type === "ImportDeclaration" && /(?:^|\/)bridge(?:\.[cm]?[jt]s)?$/u.test(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "bridge") bind(scope, specifier.local.name, { type: "Origin", origin: "factory" });
        if (specifier.type === "ImportNamespaceSpecifier") bind(scope, specifier.local.name, { type: "Origin", origin: "namespace" });
      }
    }
    if (node.type === "ImportDeclaration" && node.source.value.startsWith(".")
      && posix.join(posix.dirname(path), node.source.value).replace(/\.[cm]?[jt]sx?$/u, "") === queryModule) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "useWorkspaceQuery") bind(scope, specifier.local.name, { type: "Origin", origin: "query" });
        if (specifier.type === "ImportNamespaceSpecifier") bind(scope, specifier.local.name, { type: "Origin", origin: "queryNamespace" });
      }
    }
    if (callTypes.has(node.type)) calls.push(node);
    for (const child of childNodes(node)) walk(child, scope, node);
  };
  walk(program, { bindings: new Map(), parent: null }, null);
  if (!hookOrComponent) return [];

  // What an expression is: the bridge factory, its module namespace, the bridge, one bridge method,
  // useWorkspaceQuery, or its module namespace. A local function that returns the bridge is a factory.
  const member = (base, key) => {
    if (!key) return null;
    if (base === "bridge") return "method:" + key;
    if (base === "namespace" && key === "bridge") return "factory";
    return base === "queryNamespace" && key === "useWorkspaceQuery" ? "query" : null;
  };
  const origin = (node, scope, seen = new Set()) => {
    if (!node) return null;
    if (node.type === "Origin") return node.origin;
    if (wrapperTypes.has(node.type)) return origin(node.expression, scope, seen);
    if (functionTypes.has(node.type)) {
      const value = returned(node);
      return value && origin(value, scopes.get(value), seen) === "bridge" ? "factory" : null;
    }
    if (node.type === "Identifier") {
      for (let at = scope; at; at = at.parent) {
        const binding = at.bindings.get(node.name);
        if (!binding) continue;
        return seen.has(binding) ? null : origin(binding.value, binding.scope, new Set(seen).add(binding));
      }
      return null;
    }
    if (callTypes.has(node.type)) return origin(node.callee, scope, seen) === "factory" ? "bridge" : null;
    if (node.type === "Destructured") return member(origin(node.object, scope, seen), node.key);
    if (memberTypes.has(node.type)) {
      const key = propertyName(node);
      if (node.object.type === "Identifier" && ["window", "globalThis"].includes(node.object.name) && key === "dohcDesktop") return "bridge";
      return member(origin(node.object, scope, seen), key);
    }
    return null;
  };
  const isQuery = callee => origin(callee, scopes.get(callee)) === "query";

  const counts = new Map(), reads = [];
  for (const call of calls) {
    const method = origin(call.callee, scopes.get(call));
    const name = method?.startsWith("method:") ? readName(method.slice("method:".length), call.arguments[0]) : null;
    if (!name || ownedByQuery(call, parents, isQuery)) continue;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    reads.push({ fingerprint: path + " | " + name + (count > 1 ? " #" + count : ""), line: call.loc.start.line });
  }
  return reads;
}

export function collectBridgeReads(root) {
  return globSync("apps/desktop/src/renderer/**/*.{ts,tsx}", { cwd: root })
    .map(path => path.replaceAll("\\", "/")).filter(isRendererSource).sort()
    .flatMap(path => extractBridgeReads(path, readFileSync(join(root, path), "utf8")));
}

export function checkBridgeReads(root, inventory, limit = inventory?.sites?.length) {
  if (!Array.isArray(inventory?.sites) || inventory.sites.some(site => typeof site !== "string")
    || new Set(inventory.sites).size !== inventory.sites.length) {
    return { failures: [inventoryPath + ": expected unique site fingerprints."], sites: [] };
  }
  const listed = inventory.sites.length;
  if (listed > limit) {
    return { failures: [inventoryPath + " lists " + listed + " reads, above the ceiling of " + limit + ". The inventory only shrinks. " + fix + " " + unowned], sites: [] };
  }
  const sites = collectBridgeReads(root), allowed = new Set(inventory.sites), current = new Set(sites.map(site => site.fingerprint));
  const failures = sites.filter(site => !allowed.has(site.fingerprint)).map(site => site.fingerprint + " (line " + site.line
    + "): new raw desktop-bridge read in a renderer component or hook. " + fix + " Adding its fingerprint to " + inventoryPath + " is not a fix. " + unowned);
  for (const site of allowed) {
    if (!current.has(site)) failures.push(site + ": stale entry. Remove it from " + inventoryPath + "; the inventory only shrinks.");
  }
  if (listed < limit) failures.push(inventoryPath + " lists " + listed + " reads. Lower the ceiling in scripts/check-bridge-reads.mjs from " + limit + " to " + listed + ".");
  return { failures, sites };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const inventory = JSON.parse(readFileSync(join(root, inventoryPath), "utf8"));
  const { failures, sites } = checkBridgeReads(root, inventory, ceiling);
  if (failures.length) {
    console.error("Bridge reads check failed:\n" + failures.map(failure => "- " + failure).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Bridge reads check passed (" + sites.length + " legacy reads).");
  }
}
