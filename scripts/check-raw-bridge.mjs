import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { children, isRendererSource, memberName, resolveModule, unwrap } from "./renderer-source.mjs";

const { parseSync } = createRequire(import.meta.url)("oxc-parser");
export const rendererRoot = resolve(import.meta.dirname, "../apps/desktop/src/renderer");
export const transportFiles = ["bridge.ts", "desktopAction.ts", "desktopActionTesting.ts", "desktopOperations.ts"];
export const isRendererTest = file => !isRendererSource("apps/desktop/src/renderer/" + file);

// Counts every scoped bridge or window.dohcDesktop reference; acquiring a handle adds a reference before its uses.
export function rawBridgeReferences(source, path = "renderer.tsx", parsed = parseSync(path, source), lines = null) {
  const { program, errors } = parsed;
  if (errors.length) throw new Error(path + ": " + errors[0].message);
  const references = [], bindings = [], assignments = [], declared = new Set();
  const bridgeModule = spec => typeof spec === "string" && /(?:^|[\\/])bridge\.(?:[cm]?ts|tsx)$/u.test(resolveModule(path, spec));
  const bind = (pattern, scope, value, raw = false, assignment = false) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      if (!assignment) declared.add(pattern);
      let owner = scope;
      if (assignment) while (owner && !owner.names.has(pattern.name)) owner = owner.parent;
      if (!owner) return;
      const binding = owner.names.get(pattern.name) ?? { raw, values: [] };
      binding.raw ||= raw;
      if (value) binding.values.push(value);
      owner.names.set(pattern.name, binding); bindings.push(binding);
    } else if (pattern.type === "AssignmentPattern") { bind(pattern.left, scope, value, raw, assignment); bind(pattern.left, scope, pattern.right, raw, assignment); }
    else if (["RestElement", "TSParameterProperty"].includes(pattern.type)) bind(pattern.argument ?? pattern.parameter, scope, value, raw, assignment);
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => {
      const desktop = ["window", "globalThis"].includes(unwrap(value)?.name) && memberName(property) === "dohcDesktop";
      if (desktop) references.push({ node: property, scope, raw: true });
      bind(property.value ?? property.argument, scope, value, raw || desktop, assignment);
    });
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(element => bind(element, scope, value, raw, assignment));
  };
  const visit = (node, scope, parent) => {
    if (node.type.startsWith("TS") && unwrap(node) === node && !["TSEnumDeclaration", "TSEnumBody", "TSEnumMember", "TSModuleDeclaration", "TSModuleBlock", "TSExportAssignment", "TSParameterProperty"].includes(node.type)) return;
    const fn = /^(?:Function|ArrowFunction)/u.test(node.type);
    if (["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSEnumMember"].includes(node.type)) bind(node.id, scope);
    if (fn || ["BlockStatement", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement", "ClassExpression", "ClassBody", "StaticBlock", "TSEnumBody", "TSModuleBlock"].includes(node.type)) scope = { names: new Map(), parent: scope, fn: fn || ["StaticBlock", "TSModuleBlock"].includes(node.type) };
    if (fn) { if (node.type === "FunctionExpression") bind(node.id, scope); node.params.forEach(param => bind(param, scope)); }
    if (node.type === "ClassExpression") bind(node.id, scope);
    if (node.type === "CatchClause") bind(node.param, scope);
    if (node.type === "ImportDeclaration") {
      node.specifiers.forEach(spec => bind(spec.local, scope, null, node.importKind !== "type" && spec.importKind !== "type" && bridgeModule(node.source.value) && (spec.imported?.name === "bridge" || spec.type === "ImportNamespaceSpecifier")));
      return;
    }
    if (node.type === "VariableDeclarator") {
      let owner = scope;
      if (parent.kind === "var") while (owner.parent && !owner.fn) owner = owner.parent;
      bind(node.id, owner, node.init);
    }
    if (node.type === "AssignmentExpression" && node.operator === "=") assignments.push({ node, scope });
    const dynamicBridge = node.type === "ImportExpression" && bridgeModule(node.source.value);
    const globalBridge = node.type === "MemberExpression" && memberName(node) === "dohcDesktop" && ["window", "globalThis"].includes(unwrap(node.object)?.name);
    const staticName = (parent?.type === "MemberExpression" && parent.property === node || ["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type) && parent.key === node) && !parent.computed || parent?.type === "ExportSpecifier" && parent.exported === node;
    if (dynamicBridge || globalBridge || node.type === "Identifier" && !declared.has(node) && !staticName && !["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent?.type)) references.push({ node, scope, raw: dynamicBridge || globalBridge || node.name === "dohcDesktop" });
    children(node).forEach(child => visit(child, scope, node));
  };
  visit(program, { names: new Map(), parent: null, fn: true });
  for (const { node, scope } of assignments) bind(node.left, scope, node.right, false, true);
  for (const reference of references) {
    for (let scope = reference.scope; scope; scope = scope.parent) if (scope.names.has(reference.node.name)) { reference.binding = scope.names.get(reference.node.name); break; }
  }
  const byNode = new Map(references.map(ref => [ref.node, ref]));
  const derived = node => {
    if (/^(?:Function|ArrowFunction)/u.test(node.type)) return false;
    const ref = byNode.get(node);
    return ref?.raw || ref?.binding?.raw || children(node).some(derived);
  };
  // Copies and destructured values retain authority, but shadowing creates a separate binding.
  let changed;
  do {
    changed = false;
    for (const binding of bindings) if (!binding.raw && binding.values.some(derived)) { binding.raw = true; changed = true; }
  } while (changed);
  const counted = references.filter(ref => ref.raw || ref.binding?.raw);
  lines?.push(...counted.map(ref => source.slice(0, ref.node.start).split("\n").length));
  return counted.length;
}
export function rendererSources(root) {
  return readdirSync(root, { recursive: true }).filter(name => /\.(?:[cm]?ts|tsx)$/u.test(name) && statSync(join(root, name)).isFile());
}
export function checkRawBridge(root, inventory, referenceCounts = new Map()) {
  const violations = [];
  for (const name of rendererSources(root)) {
    const file = name.split(sep).join("/");
    if (isRendererTest(file) || transportFiles.includes(file)) continue;
    const before = inventory.counts[file] ?? 0;
    const after = referenceCounts.get(file) ?? rawBridgeReferences(readFileSync(join(root, name), "utf8"), name);
    if (after > before) {
      const lines = [];
      rawBridgeReferences(readFileSync(join(root, name), "utf8"), name, undefined, lines);
      violations.push("RATCHET " + file + ":" + [...new Set(lines)].join(",") + ": raw bridge references exceed inventory count " + before + " -> " + after + ". Use desktopAction or the operation's owner.");
    }
  }
  return violations;
}
