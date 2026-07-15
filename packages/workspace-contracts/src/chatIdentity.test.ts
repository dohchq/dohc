import { describe, expect, it } from "vitest";
import {
  MAX_PREFERRED_NAME_LENGTH,
  PreferredName,
  agentDisplayLabel,
  preferredNameFromInput,
} from "./chatIdentity";

describe("chat identity", () => {
  it("normalizes a configured owner name", () => {
    expect(preferredNameFromInput("  Ice de Vera  ")).toBe("Ice de Vera");
    expect(preferredNameFromInput("   ")).toBeUndefined();
  });

  it("bounds and validates names", () => {
    expect(PreferredName.safeParse("x".repeat(MAX_PREFERRED_NAME_LENGTH)).success).toBe(true);
    expect(PreferredName.safeParse("x".repeat(MAX_PREFERRED_NAME_LENGTH + 1)).success).toBe(false);
    expect(PreferredName.safeParse("Ice\u0000Admin").success).toBe(false);
    expect(PreferredName.safeParse("Ice\u202eAdmin").success).toBe(false);
    expect(PreferredName.safeParse("Ice\u2066Admin\u2069").success).toBe(false);
    expect(PreferredName.safeParse("Ice\u200eAdmin").success).toBe(false);
    expect(PreferredName.safeParse("Ice\u2028Admin").success).toBe(false);
    expect(PreferredName.safeParse("Ice\u2029Admin").success).toBe(false);
  });

  it("formats agent attribution once", () => {
    expect(agentDisplayLabel("Ice")).toBe("Ice's agent");
    expect(agentDisplayLabel("Ice's agent")).toBe("Ice's agent");
    expect(agentDisplayLabel("Ice’s agent")).toBe("Ice’s agent");
  });
});
