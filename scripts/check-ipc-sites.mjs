#!/usr/bin/env node
// Catch ordinary hand-written additions, including likely alias and transport forms.
// Deliberate evasion is outside this check: adding a fingerprint to scripts/ipc-sites.json is easier and creates a reviewed diff.
// Ambiguous bindings, aliases, or collections emit sites instead of receiving exemptions.
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const inventoryPath = "scripts/ipc-sites.json";
const { typescriptLanguage } = createRequire(join(repoRoot, "apps/desktop/package.json"))("@codemirror/lang-javascript");
const fix = "Declare a row in an OperationTable in apps/desktop/src/ipc/bridgeContract.ts; operationBridge and registerOperations derive the preload method and the main handler.";
const collectionFix = "Keep the row list in the loop, or declare the operation in an OperationTable in apps/desktop/src/ipc/bridgeContract.ts; operationBridge and registerOperations derive the preload method and the main handler.";
const isFunction = node => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunction)$/u.test(node?.name);
const isScope = node => isFunction(node) || ["Block", "Script", "ForStatement", "CatchClause"].includes(node.name);
const isHandName = name => name === "ipcRenderer.invoke"
  || ["handleIpc", "ipcMain.handle", "ipcMain.handleOnce", "operationBoundary.handle"].includes(name)
  || /(?:^|\.)registerHandler$/u.test(name);
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
const isReference = node => node?.name === "VariableName"
  || node?.name === "PropertyDefinition" && children(node.parent).length === 1;
const isBindingDefinition = node => node?.name === "VariableDefinition"
  || node?.name === "PropertyName" && node.parent.name === "PatternProperty" && !children(node.parent).some(child => [":", "Spread"].includes(child.name));
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
  const calls = [], candidates = [], bindings = new Map();
  const addBinding = (name, value, scope, property, declaration, entry, kind = "const") => {
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).unshift({ value, scope, property, declaration, entry, kind });
  };
  const cursor = tree.cursor();
  do {
    if (!["CallExpression", "VariableDeclaration", "FunctionDeclaration", "VariableDefinition", "ImportDeclaration", "VariableName", "PropertyDefinition", "PropertyName", "MemberExpression"].includes(cursor.name)) continue;
    const node = cursor.node;
    if (node.name === "CallExpression") calls.push(node);
    // Collect uncalled transports and outside collection uses during the binding walk.
    if (isReference(node) || node.name === "MemberExpression") candidates.push(node);
    if (isBindingDefinition(node)) {
      const declaration = ancestor(node, parent => isFunction(parent) || parent.name === "VariableDeclaration");
      if (declaration?.parent?.name === "ExportDeclaration" || bindings.get(canonical(node, source))?.some(binding => binding.property
        && node.from >= binding.declaration?.from && node.to <= binding.declaration?.to)) candidates.push(node);
      const scope = ancestor(node, isScope), name = canonical(node, source);
      if (node.parent?.name !== "FunctionDeclaration" && !bindings.get(name)?.some(binding => binding.scope?.from === scope?.from
        && node.from >= binding.declaration?.from && node.to <= binding.declaration?.to)) {
        addBinding(name, null, scope);
      }
    }
    if (node.name === "ImportDeclaration" && canonical(node.getChild("String"), source) === '"electron"') {
      const group = children(node.getChild("ImportGroup") ?? node);
      for (let i = 0; i < group.length; i++) {
        if (group[i].name !== "VariableDefinition") continue;
        const entry = !node.getChild("ImportGroup") && group[i - 1]?.name === "import" ? "*"
          : group[i - 1]?.name === "as" ? canonical(group[i - 2], source) : canonical(group[i], source);
        if (["ipcRenderer", "ipcMain", "*"].includes(entry)) {
          addBinding(canonical(group[i], source), null, ancestor(node, isScope), null, node, entry);
        }
      }
    }
    if (node.name === "VariableDeclaration") {
      const parts = children(node);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].name !== "Equals") continue;
        const pattern = parts[i - 1].name === "TypeAnnotation" ? parts[i - 2] : parts[i - 1];
        const value = ["const", "let"].includes(parts[0].name) ? parts[i + 1] : null;
        const scope = ancestor(node, isScope), declaration = { from: pattern.from, to: parts[i + 1].to };
        if (pattern.name === "VariableDefinition") addBinding(canonical(pattern, source), value, scope, null, declaration, null, parts[0].name);
        for (const prop of children(pattern).filter(child => child.name === "PatternProperty")) {
          const key = prop.getChild("PropertyName");
          const definition = prop.getChild("VariableDefinition") ?? (isBindingDefinition(key) ? key : null);
          if (definition) addBinding(canonical(definition, source), value, scope, canonical(key, source), declaration, null, parts[0].name);
        }
      }
    }
    if (node.name === "FunctionDeclaration") addBinding(canonical(node.getChild("VariableDefinition"), source), node, ancestor(node, isScope));
  } while (cursor.next());
  const references = candidates.filter(ref => (ref.name === "MemberExpression" || isBindingDefinition(ref)
    || bindings.has(source.slice(ref.from, ref.to)) || ["ipcRenderer", "ipcMain"].includes(canonical(ref, source)))
    && !ancestor(ref, node => /^(?:Type|Interface|ImportDeclaration)/u.test(node.name)));
  const bindingFor = node => {
    const candidates = bindings.get(canonical(node, source));
    if (!candidates) return;
    for (let scope = node.parent; scope; scope = scope.parent) {
      const binding = candidates.find(binding => binding.scope?.from === scope.from && binding.scope?.name === scope.name);
      if (binding) return binding;
    }
  };
  const resolved = (node, seen = new Set()) => {
    node = unwrap(node);
    const binding = (isReference(node) || isBindingDefinition(node)) && bindingFor(node);
    if (binding?.kind !== "const" || !binding?.value || binding.property || seen.has(binding)) return node;
    return resolved(binding.value, new Set([...seen, binding]));
  };
  const memberName = (receiver, property) => receiver === "*" && ["ipcRenderer", "ipcMain"].includes(property) ? property : receiver + "." + property;
  const entryName = (node, seen = new Set(), aliases = true) => {
    const original = calleeName(node, seen, false);
    return !aliases || isHandName(original) || ["ipcRenderer", "ipcMain"].includes(original) ? original : calleeName(node, seen, aliases);
  };
  const calleeName = (node, seen = new Set(), aliases = true) => {
    node = unwrap(node);
    if (!node) return "<missing>";
    const binding = aliases && (isReference(node) || isBindingDefinition(node)) && bindingFor(node);
    if (binding?.entry) return binding.entry;
    if (binding?.value && !seen.has(binding) && /^(?:VariableName|MemberExpression|CallExpression|FunctionDeclaration|FunctionExpression|ArrowFunction)$/u.test(unwrap(binding.value)?.name)) {
      const name = entryName(binding.value, new Set([...seen, binding]), aliases);
      return binding.property ? memberName(name, binding.property) : name;
    }
    const parts = children(node);
    if (node.name === "MemberExpression") {
      const receiver = entryName(parts[0], seen, aliases), property = canonical(parts[2], source).replace(/^"|"$/gu, "");
      return memberName(receiver, property);
    }
    if (node.name === "CallExpression") {
      const name = entryName(node.firstChild, seen, aliases);
      if (name === "require" && canonical(argumentsOf(node)[0], source) === '"electron"') return "*";
      if (name.endsWith(".bind")) return name.slice(0, -5);
    }
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
    if (of < 0 || index < 0 || !bindingFor(argument) || bindingFor(argument) !== bindingFor(names[index])) return [canonical(argument, source)];
    const collection = parts[of + 1];
    const outside = (node, seen = new Set()) => {
      node = unwrap(node);
      const binding = isReference(node) && bindingFor(node);
      if (binding?.value && !seen.has(binding)) {
        if (references.some(ref => isReference(ref) && bindingFor(ref) === binding
          && !(ref.from >= collection.from && ref.to <= collection.to)
          && !(ref.from >= binding.declaration?.from && ref.to <= binding.declaration?.to))) return canonical(node, source);
        return outside(binding.value, new Set([...seen, binding]));
      }
      if (node?.name === "ArrayExpression") {
        const rows = elements(node);
        for (let i = 0; i < rows.length; i++) if (rows[i].name === "Spread") {
          const name = outside(rows[++i], seen);
          if (name) return name;
        }
      }
    };
    const external = outside(collection);
    if (external) return ["collection(" + external + ") referenced outside its loop"];
    const fallback = "collection(" + expandedText(collection) + ")";
    return arrayRows(collection).map(row => {
      const tuple = pattern && row?.name === "ArrayExpression" ? arrayRows(row) : null;
      const channel = pattern ? tuple && !tuple.includes(null) && tuple[index] : row;
      return channel ? canonical(resolved(channel), source) : fallback;
    });
  };
  const helpers = new Set(), tableHelpers = new Set(), callees = new Map();
  for (const call of calls) {
    const callee = entryName(call.firstChild);
    callees.set(call.from + ":" + call.to, callee);
    if (callee === "ipcRenderer.invoke") {
      const owner = ancestor(call, isFunction);
      if (owner) helpers.add(owner.from);
    }
    if (callee === "operationBridge") {
      const helper = resolved(argumentsOf(call)[1]);
      if (isFunction(helper)) tableHelpers.add(helper.from);
    }
  }
  const sites = [], occurrences = new Map();
  const addSite = (node, identity) => {
    const key = path + " | " + identity;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    sites.push({ fingerprint: occurrence === 1 ? key : key + " #" + occurrence, line: source.slice(0, node.from).split("\n").length });
  };
  for (const call of calls) {
    const callee = callees.get(call.from + ":" + call.to);
    const handCall = isHandName(callee) || helpers.has(resolved(call.firstChild)?.from);
    if (!handCall) continue;
    const owner = ancestor(call, isFunction), argument = resolved(argumentsOf(call)[0]);
    const firstParameter = owner?.getChild("ParamList")?.getChild("VariableDefinition");
    if (callee === "ipcRenderer.invoke" && argument?.name === "VariableName"
      && firstParameter && bindingFor(argument) === bindingFor(firstParameter)
      && tableHelpers.has(owner?.from)) continue;
    for (const channel of channelsFor(call, argument)) {
      const forwarding = argument?.name === "VariableName" && channel === canonical(argument, source);
      const identity = forwarding ? functionName(owner, source) + " forwards " + channel + " to " + callee : channel;
      addSite(call, identity);
    }
  }
  for (const ref of references) {
    if (isBindingDefinition(ref) && !bindingFor(ref)?.property && !isFunction(unwrap(bindingFor(ref)?.value))) continue;
    let expression = ref;
    while (expression.parent && unwrap(expression.parent)?.from === ref.from && unwrap(expression.parent)?.to === ref.to) expression = expression.parent;
    const parent = expression.parent, name = entryName(ref), receiver = ["ipcRenderer", "ipcMain"].includes(name);
    const rawInvoke = name === "ipcRenderer.invoke", registration = ["ipcMain.handle", "ipcMain.handleOnce"].includes(name);
    if (!receiver && parent?.name === "CallExpression" && parent.firstChild.from === expression.from) continue;
    if (!receiver && !rawInvoke && !registration && parent?.name === "ArgList" && callees.get(parent.parent.from + ":" + parent.parent.to) === "operationBridge"
      && argumentsOf(parent.parent)[1]?.from === expression.from) continue;
    if (receiver && isBindingDefinition(ref)) continue;
    if (receiver && parent?.name === "MemberExpression" && parent.firstChild.from === expression.from) continue;
    if (!receiver && !rawInvoke && !registration && !helpers.has(resolved(ref)?.from)) continue;
    addSite(ref, receiver ? "IPC receiver reference: " + name : registration ? "registration transport reference: " + name
      : "invoke transport reference: " + (rawInvoke ? name : canonical(ref, source)));
  }
  return sites;
}

function collectIpcSites(root) {
  return globSync("apps/desktop/src/**/*.ts", { cwd: root }).map(path => path.replaceAll("\\", "/"))
    .filter(isIpcSource).sort().flatMap(path => {
      const source = readFileSync(join(root, path), "utf8");
      // Aliases and helpers resolve within this file, so a site needs an IPC entry name.
      return /(?:ipcRenderer|ipcMain|handleIpc|operationBoundary|registerHandler)\b/u.test(source) ? extractIpcSites(path, source) : [];
    });
}
export function checkIpcSites(root, inventory) {
  if (!Array.isArray(inventory?.sites) || inventory.sites.some(site => typeof site !== "string")
    || new Set(inventory.sites).size !== inventory.sites.length) {
    return { failures: [inventoryPath + ": expected unique site fingerprints."], sites: [] };
  }
  const sites = collectIpcSites(root), allowed = new Set(inventory.sites), current = new Set(sites.map(site => site.fingerprint));
  const added = sites.filter(site => !allowed.has(site.fingerprint)), stale = [...allowed].filter(site => !current.has(site));
  const failures = added.map(site => site.fingerprint + " (line " + site.line + "): new hand-written IPC site. "
    + (site.fingerprint.includes(" referenced outside its loop") ? collectionFix : fix)
    + " Adding its fingerprint to " + inventoryPath + " is not a fix.");
  for (const site of stale) failures.push(site + ": stale entry. Remove it from " + inventoryPath + "; the inventory only shrinks.");
  const isMove = (old, replacement) => {
    const [oldPath, identity] = old.split(" | ");
    const [newPath, newIdentity] = replacement.split(" | ");
    return oldPath !== newPath && identity.replace(/ #\d+$/u, "") === newIdentity.replace(/ #\d+$/u, "");
  };
  const movedOld = stale.filter(old => added.some(site => isMove(old, site.fingerprint)));
  const movedNew = added.filter(site => stale.some(old => isMove(old, site.fingerprint)));
  if (movedNew.length) failures[added.indexOf(movedNew[0])] += "\nIf this change only moves existing hand sites, replace the stale fingerprints with these."
    + "\nStale fingerprints:\n" + movedOld.join("\n") + "\nReplacement fingerprints:\n" + movedNew.map(site => site.fingerprint).join("\n");
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
