import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("../e2e/workspace-shares.spec.ts", import.meta.url),
  "utf8",
);

const confidentialDeclaration = "const confidentialTest = test.extend({});";
const confidentialUse = 'confidentialTest.use({ screenshot: "off", trace: "off" });';
const describeMarker = 'confidentialTest.describe("View link lifecycle", () => {';
const nextTestMarker = '\n\ntest("receive side:';
const declarationStart = source.indexOf(confidentialDeclaration);
const describeStart = source.indexOf(describeMarker);
const describeEnd = source.indexOf(nextTestMarker, describeStart);

if (declarationStart === -1 || describeStart === -1 || describeEnd === -1) {
  throw new Error("Could not isolate the View link lifecycle block.");
}

const lifecycle = source.slice(describeStart, describeEnd);
const outsideDedicatedLifecycle =
  source.slice(0, declarationStart) + source.slice(describeEnd);

function expectStatusBeforeEquality(
  reference: string,
  status: 401 | 404,
  equality: string,
): void {
  const statusAssertion = `expect(${reference}.status).toBe(${status});`;
  const statusAt = lifecycle.indexOf(statusAssertion);
  const equalityAt = lifecycle.indexOf(equality);
  const firstEqualityAt = lifecycle.indexOf(`.toEqual(${reference});`);

  expect(
    statusAt,
    `${reference} must have an explicit ${status} assertion in the View link lifecycle block`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    equalityAt,
    `${reference} must remain the equality oracle`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    statusAt,
    `${reference}'s ${status} assertion must precede its first equality use`,
  ).toBeLessThan(firstEqualityAt);
  expect(
    firstEqualityAt,
    `${reference}'s first equality use must remain the expected oracle`,
  ).toBe(equalityAt + equality.indexOf(".toEqual("));
}

describe("workspace shares E2E source contract", () => {
  test("scopes confidential diagnostics and pins the reference refusals", () => {
    const adjacentRegistration = [
      confidentialDeclaration,
      confidentialUse,
      "",
      describeMarker,
    ].join("\n");

    expect(
      source.startsWith(adjacentRegistration, declarationStart),
      "the dedicated confidential test setup must be top-level and adjacent to its lifecycle",
    ).toBe(true);
    expect(
      declarationStart === 0 || source[declarationStart - 1] === "\n",
      "the dedicated confidential test declaration must start at file scope",
    ).toBe(true);
    expect(lifecycle).not.toContain(confidentialUse);
    expect(outsideDedicatedLifecycle).not.toContain("confidentialTest");
    expectStatusBeforeEquality(
      "neverValidExchange",
      404,
      "expect(oldSecretAfterReset).toEqual(neverValidExchange);",
    );
    expectStatusBeforeEquality(
      "neverValidRead",
      401,
      "expect(oldCapabilityAfterReset).toEqual(neverValidRead);",
    );
    expectStatusBeforeEquality(
      "missingNamedShare",
      404,
      "expect(namedAfterEnd).toEqual(missingNamedShare);",
    );
  });
});
