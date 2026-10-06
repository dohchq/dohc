import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { isRendererSource } from "./check-ui-rules.mjs";

const { parseSync } = createRequire(import.meta.url)("oxc-parser");
export const rendererRoot = resolve(import.meta.dirname, "../apps/desktop/src/renderer");
export const transportFiles = ["bridge.ts", "desktopAction.ts", "desktopActionTesting.ts", "desktopOperations.ts"];
export const isRendererTest = file => !isRendererSource("apps/desktop/src/renderer/" + file);
export function children(node) {
  return Object.entries(node).filter(([key]) => key !== "parent").flatMap(([, value]) =>
    (Array.isArray(value) ? value : [value]).filter(child => child && typeof child.type === "string"));
}
const memberName = node => node.computed ? node.property?.value : node.property?.name;

export function rawBridgeCalls(source, path = "renderer.tsx") {
  const { program, errors } = parseSync(path, source);
  if (errors.length) throw new Error(path + ": " + errors[0].message);
  const factories = new Set();
  const namespaces = new Set();
  const handles = new Set();
  const methods = new Set();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !/(?:^|\/)bridge$/u.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.imported?.name === "bridge") factories.add(specifier.local.name);
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
    }
  }
  const bridgeValue = node => {
    if (!node) return false;
    if (node.type === "Identifier") return handles.has(node.name) || node.name === "dohcDesktop";
    if (node.type === "CallExpression") return node.callee.type === "Identifier" && factories.has(node.callee.name)
      || node.callee.type === "MemberExpression" && memberName(node.callee) === "bridge" && namespaces.has(node.callee.object.name);
    if (node.type === "MemberExpression") {
      if (memberName(node) === "dohcDesktop" && ["window", "globalThis"].includes(node.object.name)) return true;
      if (memberName(node) === "current" && node.object.type === "CallExpression" && node.object.callee.name === "useRef") return bridgeValue(node.object.arguments[0]);
      if (memberName(node) === "current") return bridgeValue(node.object);
    }
    return false;
  };
  const nodes = [];
  const visit = node => { nodes.push(node); children(node).forEach(visit); };
  visit(program);
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator") continue;
    const value = node.init?.type === "AwaitExpression" ? node.init.argument : node.init;
    if (value?.type !== "ImportExpression" || !/(?:^|\/)bridge$/u.test(value.source.value ?? "")) continue;
    if (node.id.type === "Identifier") namespaces.add(node.id.name);
    if (node.id.type === "ObjectPattern") for (const property of node.id.properties) {
      if ((property.key?.name ?? property.key?.value) === "bridge" && property.value?.type === "Identifier") factories.add(property.value.name);
    }
  }
  // Retained handles and extracted methods keep the imported bridge's authority.
  let changed;
  do {
    changed = false;
    for (const node of nodes) {
      if (node.type !== "VariableDeclarator" || !node.init) continue;
      const value = node.init.type === "CallExpression" && node.init.callee.name === "useRef" ? node.init.arguments[0] : node.init;
      if (node.id.type === "Identifier") {
        const bridgeMethod = node => node?.type === "MemberExpression" && bridgeValue(node.object)
          || node?.type === "ConditionalExpression" && (bridgeMethod(node.consequent) || bridgeMethod(node.alternate));
        const bindings = bridgeValue(value) ? handles : bridgeMethod(value) ? methods : null;
        if (bindings && !bindings.has(node.id.name)) { bindings.add(node.id.name); changed = true; }
      } else if (node.id.type === "ObjectPattern" && bridgeValue(value)) {
        for (const property of node.id.properties) if (property.value?.type === "Identifier" && !methods.has(property.value.name)) { methods.add(property.value.name); changed = true; }
      }
    }
  } while (changed);
  return nodes.filter(node => node.type === "CallExpression" && (
    node.callee.type === "MemberExpression" && bridgeValue(node.callee.object)
    || node.callee.type === "Identifier" && methods.has(node.callee.name)
  )).length;
}
export function rendererSources(root) {
  return readdirSync(root, { recursive: true }).filter(name => /\.tsx?$/u.test(name) && statSync(join(root, name)).isFile());
}
export function checkRawBridge(root, inventory) {
  const violations = [];
  for (const name of rendererSources(root)) {
    const file = name.split(sep).join("/");
    if (isRendererTest(file) || transportFiles.includes(file)) continue;
    const before = inventory.counts[file] ?? 0;
    const after = rawBridgeCalls(readFileSync(join(root, name), "utf8"), name);
    if (after > before) violations.push("RATCHET " + file + ": raw bridge calls " + before + " -> " + after + ". Use desktopAction or the operation's owner.");
  }
  return violations;
}
