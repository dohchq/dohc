import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const renderer = "apps/desktop/src/renderer/";
// Register test-only modules here when their names do not match *.test.*.
const testSupport = new Set([
  "DesktopWorkspaceShell.testSupport.tsx", "DesktopWorkspaceShell.testHarness.tsx",
  "workbench/ChatsView.testHarness.tsx",
  "FileInspector.environment-fixture.ts", "FileInspector.editor-fixture.ts",
  "FileInspector.draft-fixture.ts", "FileInspector.text-fixture.ts",
  "collab/engineDocSaveStateTestHarness.ts", "collab/engineDocLeaseTestHarness.ts",
  "collab/engineDocChunkingTestHarness.ts", "editor/testDocs.ts",
]);
export function isRendererSource(path) {
  return path.startsWith(renderer) && /\.(?:[cm]?ts|tsx)$/u.test(path)
    && !/\.(?:test(?:-d)?|spec)\./u.test(path) && !/(?:^|\/)__tests__\//u.test(path)
    && !testSupport.has(path.slice(renderer.length));
}
export function children(node) {
  return Object.entries(node).filter(([key]) => key !== "parent").flatMap(([, value]) =>
    (Array.isArray(value) ? value : [value]).filter(child => child && typeof child.type === "string"));
}
export function unwrap(node) {
  while (["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression", "ChainExpression"].includes(node?.type)) node = node.expression;
  return node;
}
export function memberName(node) {
  const property = unwrap(node.property ?? node.key);
  return !node.computed ? property?.name ?? property?.value : property?.type === "TemplateLiteral" && property.expressions.length === 0
    ? property.quasis[0].value.cooked : property?.value;
}
export function resolveModule(from, spec) {
  const base = resolve(dirname(from), spec);
  const extensions = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".jsx": [".tsx"] };
  const extension = Object.keys(extensions).find(extension => base.endsWith(extension));
  const candidates = extension ? extensions[extension].map(target => base.slice(0, -extension.length) + target).concat(base)
    : /\.(?:[cm]?ts|tsx)$/u.test(base) ? [base] : [base, base + ".ts", base + ".tsx", base + ".mts"];
  return candidates.find(path => existsSync(path) && statSync(path).isFile()) ?? (extension || /\.(?:[cm]?ts|tsx)$/u.test(base) ? candidates[0] : base + ".ts");
}
