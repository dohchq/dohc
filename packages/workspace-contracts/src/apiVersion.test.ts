import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkApiVersion,
  RELAY_API_VERSION,
  RELAY_API_VERSION_HEADER,
  SHARE_WEB_API_VERSION_HEADER,
} from "./relayValues";

describe("API wire version parsing", () => {
  it("names relay version 2, the same in the Rust relay client", () => {
    const rust = readFileSync(
      new URL("../../../crates/dohc-engine-sync-http/src/lib.rs", import.meta.url),
      "utf8",
    );
    const named = /^const RELAY_API_VERSION: &str = "(\d+)";\r?$/m.exec(rust)?.[1];
    expect([RELAY_API_VERSION, named]).toEqual([2, "2"]);
  });
  it("keeps the relay and share-web counters separate", () => {
    expect(RELAY_API_VERSION_HEADER).not.toBe(SHARE_WEB_API_VERSION_HEADER);
  });
  it.each([null, "1", "2", "999999999"])("accepts %s within its range", (named) => {
    expect(checkApiVersion(named, { min: 1, max: 999999999 })).toBe("accepted");
  });
  it.each([
    "",
    "0",
    "01",
    "1.0",
    "-1",
    "one",
    "1, 1",
    "1, 2",
    "1000000000",
    "1e0",
    " 1",
    "1 ",
    "١",
  ])("refuses malformed %j", (named) => {
    expect(checkApiVersion(named, { min: 1, max: 3 })).toBe("malformed");
  });
  it("compares inclusive bounds and never negotiates up for a missing header", () => {
    const range = { min: 2, max: 3 };
    expect(checkApiVersion(null, range)).toBe("too_old");
    expect(checkApiVersion("1", range)).toBe("too_old");
    expect(checkApiVersion("2", range)).toBe("accepted");
    expect(checkApiVersion("3", range)).toBe("accepted");
    expect(checkApiVersion("4", range)).toBe("too_new");
  });
});
