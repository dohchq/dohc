import { describe, expect, it } from "vitest";
import fixture from "../relay-error-codes.json";
import { RELAY_ERRORS, RELAY_ERROR_STATUSES } from "./errorCodes";

describe("relay error codes", () => {
  it("matches the checked-in fixture exactly", () => {
    const exported = Object.entries(RELAY_ERROR_STATUSES).map(([code, status]) => ({
      code,
      status,
    }));

    expect(exported).toEqual(fixture);
    expect(fixture).toEqual(exported);
    expect(Object.isFrozen(RELAY_ERROR_STATUSES)).toBe(true);
    expect(Object.isFrozen(RELAY_ERRORS)).toBe(true);
    expect(Object.values(RELAY_ERRORS).every(Object.isFrozen)).toBe(true);
  });
});
