import { describe, expect, it } from "vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PreferredName } from "./chatIdentity";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "./chatIdentityValues";

describe("chat identity", () => {
  const decodePreferredName = Schema.decodeUnknownResult(PreferredName);

  it("normalizes a configured owner name", () => {
    expect(preferredNameFromInput("  Sam Rivera  ")).toBe("Sam Rivera");
    expect(preferredNameFromInput("   ")).toBeUndefined();

    const decoded = decodePreferredName("  Sam Rivera  ");
    expect(Result.isSuccess(decoded) && decoded.success).toBe("Sam Rivera");
  });

  it("bounds and validates names", () => {
    const empty = decodePreferredName(" ");
    expect(Result.isFailure(empty)).toBe(true);
    if (Result.isFailure(empty)) {
      expect(empty.failure.message).toBe(
        "Enter the name your agent should use.",
      );
    }
    expect(
      Result.isSuccess(decodePreferredName("x".repeat(MAX_PREFERRED_NAME_LENGTH))),
    ).toBe(true);
    const tooLong = decodePreferredName("x".repeat(MAX_PREFERRED_NAME_LENGTH + 1));
    expect(Result.isFailure(tooLong)).toBe(true);
    if (Result.isFailure(tooLong)) {
      expect(tooLong.failure.message).toBe(
        `Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`,
      );
    }
    expect(Result.isSuccess(decodePreferredName("می\u200cثم"))).toBe(true);
    expect(Result.isSuccess(decodePreferredName("Sam 👩\u200d💻"))).toBe(true);
    for (const name of [
      "Sam\u0000Admin",
      "Sam\u202eAdmin",
      "Sam\u2066Admin\u2069",
      "Sam\u200eAdmin",
      "Sam\u200bAdmin",
      "Sam\u2028Admin",
      "Sam\u2029Admin",
    ]) {
      const result = decodePreferredName(name);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toBe(
          "Names cannot contain control characters.",
        );
      }
    }
    expect(() => preferredNameFromInput("x".repeat(MAX_PREFERRED_NAME_LENGTH + 1))).toThrow(
      `Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`,
    );
    expect(() => preferredNameFromInput("Sam\u202eAdmin")).toThrow(
      "Names cannot contain control characters.",
    );
  });

});
