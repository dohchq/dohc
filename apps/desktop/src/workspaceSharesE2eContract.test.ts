import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import {
  VISITOR_KEYS,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  isObjectProperty,
  isStringLiteral,
  isVariableDeclarator,
  type CallExpression,
  type Node,
  type VariableDeclarator,
} from "@babel/types";
import { describe, expect, test } from "vitest";

const harmlessFormattingVariant = `
const confidentialTest =
  test.extend(
    {},
  );

test("an unrelated registration can move", () => {});

confidentialTest.use({
  trace: "off",
  screenshot: "off",
});

confidentialTest.describe(
  "View link lifecycle",
  () => {
    confidentialTest("runs the lifecycle", async () => {
      confidentialTest.setTimeout(300_000);
    });
  },
);
`;

function descendants(root: Node): Node[] {
  const found: Node[] = [];

  function visit(node: Node): void {
    found.push(node);
    const record = node as unknown as Record<string, unknown>;
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = record[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item !== null && typeof item === "object" && "type" in item) {
            visit(item as Node);
          }
        }
      } else if (child !== null && typeof child === "object" && "type" in child) {
        visit(child as Node);
      }
    }
  }

  visit(root);
  return found;
}

function isConfidentialMemberCall(
  call: CallExpression,
  property?: string,
): boolean {
  const callee = call.callee;
  return (
    isMemberExpression(callee) &&
    !callee.computed &&
    isIdentifier(callee.object, { name: "confidentialTest" }) &&
    isIdentifier(callee.property) &&
    (property === undefined || callee.property.name === property)
  );
}

function isTestExtend(call: CallExpression): boolean {
  const callee = call.callee;
  return (
    isMemberExpression(callee) &&
    !callee.computed &&
    isIdentifier(callee.object, { name: "test" }) &&
    isIdentifier(callee.property, { name: "extend" }) &&
    call.arguments.length === 1 &&
    isObjectExpression(call.arguments[0]) &&
    call.arguments[0].properties.length === 0
  );
}

function diagnosticsOptions(call: CallExpression): Record<string, string> | null {
  if (call.arguments.length !== 1 || !isObjectExpression(call.arguments[0])) {
    return null;
  }

  const entries: [string, string][] = [];
  for (const property of call.arguments[0].properties) {
    if (
      !isObjectProperty(property) ||
      property.computed ||
      !isIdentifier(property.key) ||
      !isStringLiteral(property.value)
    ) {
      return null;
    }
    entries.push([property.key.name, property.value.value]);
  }
  return Object.fromEntries(entries);
}

function expectConfidentialLifecycle(candidateSource: string): void {
  const program = parse(candidateSource, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program;
  const nodes = descendants(program);
  const calls = nodes.filter(isCallExpression);
  const declarations = nodes.filter(
    (node): node is VariableDeclarator =>
      isVariableDeclarator(node) && isIdentifier(node.id, { name: "confidentialTest" }),
  );
  const topLevelDeclarationKinds = program.body.flatMap((statement) =>
    statement.type === "VariableDeclaration" &&
    statement.declarations.some((declaration) =>
      isIdentifier(declaration.id, { name: "confidentialTest" }),
    )
      ? [statement.kind]
      : [],
  );
  const topLevelDeclarations = program.body.flatMap((statement) =>
    statement.type === "VariableDeclaration"
      ? statement.declarations.filter(
          (declaration): declaration is VariableDeclarator =>
            isIdentifier(declaration.id, { name: "confidentialTest" }),
        )
      : [],
  );
  const topLevelCalls = program.body.flatMap((statement) =>
    isExpressionStatement(statement) && isCallExpression(statement.expression)
      ? [statement.expression]
      : [],
  );

  expect(declarations, "confidentialTest must have one declaration").toHaveLength(1);
  expect(
    topLevelDeclarations,
    "the confidentialTest declaration must be at file scope",
  ).toHaveLength(1);
  expect(
    topLevelDeclarationKinds[0],
    "the confidentialTest declaration must be const",
  ).toBe("const");
  expect(
    isCallExpression(topLevelDeclarations[0]?.init) &&
      isTestExtend(topLevelDeclarations[0].init),
    "confidentialTest must be the dedicated empty test extension",
  ).toBe(true);

  const uses = calls.filter((call) => isConfidentialMemberCall(call, "use"));
  expect(uses, "confidentialTest must have one diagnostics registration").toHaveLength(1);
  expect(
    topLevelCalls.includes(uses[0]),
    "the confidential diagnostics registration must be at file scope",
  ).toBe(true);
  expect(diagnosticsOptions(uses[0])).toEqual({
    screenshot: "off",
    trace: "off",
  });

  const lifecycles = calls.filter((call) =>
    isConfidentialMemberCall(call, "describe"),
  );
  expect(lifecycles, "confidentialTest must have one lifecycle suite").toHaveLength(1);
  const lifecycle = lifecycles[0];
  expect(
    topLevelCalls.includes(lifecycle),
    "the View link lifecycle must be registered at file scope",
  ).toBe(true);
  expect(
    lifecycle.arguments.length >= 1 &&
      isStringLiteral(lifecycle.arguments[0], { value: "View link lifecycle" }),
    'the confidential suite must remain named "View link lifecycle"',
  ).toBe(true);

  const lifecycleCalls = new Set(descendants(lifecycle).filter(isCallExpression));
  const lifecycleTests = calls.filter(
    (call) => isIdentifier(call.callee, { name: "confidentialTest" }) && lifecycleCalls.has(call),
  );
  expect(lifecycleTests, "the View link lifecycle must have one confidential test").toHaveLength(
    1,
  );

  const outsideTests = calls.filter(
    (call) =>
      isIdentifier(call.callee, { name: "confidentialTest" }) &&
      !lifecycleCalls.has(call),
  );
  expect(
    outsideTests,
    "confidential tests must stay inside the View link lifecycle",
  ).toHaveLength(0);

  const unexpectedOutsideMembers = calls.filter(
    (call) =>
      isConfidentialMemberCall(call) &&
      !isConfidentialMemberCall(call, "use") &&
      !isConfidentialMemberCall(call, "describe") &&
      !lifecycleCalls.has(call),
  );
  expect(
    unexpectedOutsideMembers,
    "other confidentialTest configuration must stay inside the lifecycle",
  ).toHaveLength(0);
}

describe("workspace shares E2E source contract", () => {
  test("accepts harmless formatting and unrelated test reordering", () => {
    expectConfidentialLifecycle(harmlessFormattingVariant);
  });

  test("rejects duplicate diagnostics or confidential tests outside the lifecycle", () => {
    const duplicateDiagnostics = harmlessFormattingVariant.replace(
      "confidentialTest.describe(",
      'confidentialTest.use({ screenshot: "off", trace: "off" });\n\nconfidentialTest.describe(',
    );
    const outsideLifecycle = `${harmlessFormattingVariant}\nconfidentialTest("outside", () => {});`;

    expect(() => expectConfidentialLifecycle(duplicateDiagnostics)).toThrow();
    expect(() => expectConfidentialLifecycle(outsideLifecycle)).toThrow();
  });

  test("keeps confidential diagnostics within the dedicated lifecycle", () => {
    const e2eSource = readFileSync(
      new URL("../e2e/workspace-shares.spec.ts", import.meta.url),
      "utf8",
    );

    expectConfidentialLifecycle(e2eSource);
  });
});
