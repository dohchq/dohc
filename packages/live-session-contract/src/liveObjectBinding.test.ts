import { describe, expect, it } from "vitest";
import vectors from "./liveObjectBinding.vectors.json";
import { parseLiveObjectBinding } from "./liveObjectBinding.js";

const canonical = vectors.accepted.find(
  (row) => row.name === "canonical-binding",
)!;
const illFormedSurrogates = [
  ["leading", "\ud800"],
  ["trailing", "\udc00"],
] as const;
const identifierFields = [
  "workspaceId",
  "mainVersionId",
  "objectId",
  "lineageClaimId",
] as const;

describe("LiveObjectBinding shared vectors", () => {
  for (const row of vectors.accepted) {
    it(`accepts and normalizes: ${row.name}`, () => {
      const parsed = parseLiveObjectBinding(row.input);
      expect(parsed).toEqual(row.normalized);
      expect(parsed).not.toBe(row.input);
      expect(parsed.selectorPaths).not.toBe(row.input.selectorPaths);
    });
  }

  for (const row of vectors.refused) {
    it(`refuses: ${row.name}`, () => {
      expect(() => parseLiveObjectBinding(row.input)).toThrow(TypeError);
    });
  }

  for (const field of identifierFields) {
    for (const [kind, surrogate] of illFormedSurrogates) {
      it(`refuses an unpaired ${kind} surrogate in ${field}`, () => {
        const input = structuredClone(canonical.input) as Record<
          string,
          unknown
        >;
        input[field] = `before${surrogate}after`;

        expect(() => parseLiveObjectBinding(input)).toThrow(TypeError);
      });
    }
  }

  for (const [kind, surrogate] of illFormedSurrogates) {
    it(`refuses an unpaired ${kind} surrogate in currentPath`, () => {
      const input = structuredClone(canonical.input);
      input.currentPath = `notes/${surrogate}.md`;

      expect(() => parseLiveObjectBinding(input)).toThrow(TypeError);
    });

    it(`refuses an unpaired ${kind} surrogate in selectorPaths`, () => {
      const input = structuredClone(canonical.input);
      input.selectorPaths = [`notes/${surrogate}.md`];

      expect(() => parseLiveObjectBinding(input)).toThrow(TypeError);
    });
  }

  it("preserves paired supplementary characters", () => {
    const pair = "\ud83d\ude00";
    const input = structuredClone(canonical.input);
    input.workspaceId = `workspace-${pair}`;
    input.currentPath = `notes/${pair}.md`;
    input.selectorPaths = [`notes/${pair}.md`];

    expect(parseLiveObjectBinding(input)).toMatchObject({
      workspaceId: `workspace-${pair}`,
      currentPath: `notes/${pair}.md`,
      selectorPaths: [`notes/${pair}.md`],
    });
  });

  it("refuses a sparse selectorPaths array", () => {
    const input = structuredClone(canonical.input);
    input.selectorPaths = new Array<string>(1);

    expect(() => parseLiveObjectBinding(input)).toThrow(TypeError);
  });
});
