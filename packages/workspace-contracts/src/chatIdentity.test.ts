import { describe, expect, it } from "vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PreferredName } from "./chatIdentity";
import {
  MAX_PREFERRED_NAME_LENGTH,
  agentDisplayLabel,
  preferredNameFromInput,
} from "./chatIdentityValues";

describe("chat identity", () => {
  const decodePreferredName = Schema.decodeUnknownResult(PreferredName);

  it("normalizes a configured owner name", () => {
    expect(preferredNameFromInput("  Ice de Vera  ")).toBe("Ice de Vera");
    expect(preferredNameFromInput("   ")).toBeUndefined();

    const decoded = decodePreferredName("  Ice de Vera  ");
    expect(Result.isSuccess(decoded) && decoded.success).toBe("Ice de Vera");
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
    expect(Result.isSuccess(decodePreferredName("Ice 👩\u200d💻"))).toBe(true);
    for (const name of [
      "Ice\u0000Admin",
      "Ice\u202eAdmin",
      "Ice\u2066Admin\u2069",
      "Ice\u200eAdmin",
      "Ice\u200bAdmin",
      "Ice\u2028Admin",
      "Ice\u2029Admin",
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
    expect(() => preferredNameFromInput("Ice\u202eAdmin")).toThrow(
      "Names cannot contain control characters.",
    );
  });

  it("formats agent attribution once", () => {
    expect(agentDisplayLabel("Ice")).toBe("Ice's agent");
    expect(agentDisplayLabel("Ice's agent")).toBe("Ice's agent");
    expect(agentDisplayLabel("Ice’s agent")).toBe("Ice’s agent");
  });
});
