import { describe, expect, it } from "vitest";
import {
  RELAY_API_VERSION,
  RELAY_API_VERSION_HEADER,
} from "@dohc/workspace-contracts/relay-values";
import { RELAY_API_VERSIONS, relayApiVersionRefusal } from "./apiVersion";

function headers(version?: string): Headers {
  return new Headers(version === undefined ? {} : { [RELAY_API_VERSION_HEADER]: version });
}

describe("relay API version", () => {
  it("serves the version this build speaks, and a request that names none", () => {
    expect(RELAY_API_VERSIONS.max).toBe(RELAY_API_VERSION);
    expect(relayApiVersionRefusal(headers(String(RELAY_API_VERSION)))).toBeNull();
    expect(relayApiVersionRefusal(headers())).toBeNull();
  });

  it("names which side must update", () => {
    const range = { min: 2, max: 3 };
    expect(relayApiVersionRefusal(headers("1"), range)?.code).toBe("api_version_too_old");
    expect(relayApiVersionRefusal(headers(), range)?.code).toBe("api_version_too_old");
    expect(relayApiVersionRefusal(headers("2"), range)).toBeNull();
    expect(relayApiVersionRefusal(headers("3"), range)).toBeNull();
    expect(relayApiVersionRefusal(headers("4"), range)?.code).toBe("api_version_too_new");
  });

  it("refuses a value that is not one positive integer", () => {
    for (const value of ["", "0", "01", "1.0", "-1", "one", "1, 2", "1".repeat(10)]) {
      const refusal = relayApiVersionRefusal(headers(value));
      expect(refusal?.code, value).toBe("bad_request");
      expect(refusal?.statusCode, value).toBe(400);
    }
  });
});
