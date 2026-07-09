import { describe, expect, it } from "vitest";
import { resolveIdPrefix } from "./ids";

const threads = [
  { id: "th_abcd", description: "Alpha" },
  { id: "th_abef", description: "Beta" },
  { id: "th_f012", description: "Gamma", aliases: ["gamma"] },
] as const;

describe("resolveIdPrefix", () => {
  it("accepts exact ids, aliases, and unambiguous prefixes", () => {
    expect(resolveIdPrefix("th_abcd", threads, "thread").id).toBe("th_abcd");
    expect(resolveIdPrefix("gamma", threads, "thread").id).toBe("th_f012");
    expect(resolveIdPrefix("th_f", threads, "thread").id).toBe("th_f012");
  });

  it("lists candidates for an ambiguous prefix", () => {
    expect(() => resolveIdPrefix("th_ab", threads, "thread")).toThrow(
      "ambiguous thread 'th_ab': th_abcd (Alpha), th_abef (Beta)",
    );
  });

  it("distinguishes a missing id", () => {
    expect(() => resolveIdPrefix("th_missing", threads, "thread")).toThrow(
      "unknown thread 'th_missing'",
    );
  });
});
