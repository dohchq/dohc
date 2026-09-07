import { describe, expect, it } from "vitest";
import {
  HOST_CONTROL_IDENTIFIER_MAX_BYTES,
  HOST_MODE_VALUES,
  nextHostEpoch,
  nextHostTransitionGeneration,
  parseHostControlIdentifier,
  parseHostEpoch,
  parseHostMode,
  parseHostTransitionGeneration,
} from "./hostControl.js";

describe("host-control shared contract", () => {
  it("accepts only the two host modes", () => {
    expect(HOST_MODE_VALUES).toEqual(["device", "service"]);
    expect(parseHostMode("device")).toBe("device");
    expect(parseHostMode("service")).toBe("service");
    for (const value of [undefined, null, "", "Device", "local", 1]) {
      expect(() => parseHostMode(value)).toThrow();
    }
  });

  function pinsSafeIntegerRange<T extends number>(
    parse: (value: unknown) => T,
    next: (value: T) => T,
  ): void {
    expect(parse(1)).toBe(1);
    expect(parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
      NaN,
      "1",
    ]) {
      expect(() => parse(value)).toThrow();
    }
    expect(next(parse(1))).toBe(2);
    expect(() => next(parse(Number.MAX_SAFE_INTEGER))).toThrow(/exhausted/);
  }

  it("pins the host epoch safe-integer range", () => {
    pinsSafeIntegerRange(parseHostEpoch, nextHostEpoch);
  });

  it("pins the host transition generation safe-integer range", () => {
    pinsSafeIntegerRange(
      parseHostTransitionGeneration,
      nextHostTransitionGeneration,
    );
  });

  it("validates identifiers by UTF-8 bytes and well-formed text", () => {
    expect(HOST_CONTROL_IDENTIFIER_MAX_BYTES).toBe(1_024);
    expect(parseHostControlIdentifier("a")).toBe("a");
    expect(parseHostControlIdentifier("a".repeat(1_024))).toHaveLength(1_024);
    expect(parseHostControlIdentifier("😀")).toBe("😀");
    expect(() => parseHostControlIdentifier("")).toThrow();
    expect(() => parseHostControlIdentifier("a".repeat(1_025))).toThrow();
    expect(() => parseHostControlIdentifier("é".repeat(513))).toThrow();
    expect(() => parseHostControlIdentifier("a\u0000b")).toThrow(/control/);
    expect(() => parseHostControlIdentifier("a\u001fb")).toThrow(/control/);
    expect(() => parseHostControlIdentifier("a\u007fb")).toThrow(/control/);
    expect(() => parseHostControlIdentifier("\ud800")).toThrow(/UTF-16/);
    expect(() => parseHostControlIdentifier("\udc00")).toThrow(/UTF-16/);
  });
});
