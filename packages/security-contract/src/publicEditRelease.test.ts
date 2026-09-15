import {describe, expect, it} from "vitest";
import {parsePublicEditRelease} from "./publicEditRelease";

describe("public Edit release marker", () => {
  it("stays closed when absent and accepts only the supported version", () => {
    expect(parsePublicEditRelease(undefined)).toBeUndefined();
    expect(parsePublicEditRelease({version: 1})).toEqual({version: 1});
  });
  it.each([null, {}, [], "1", {version: 2}, {version: "1"}, {version: 1, enabled: true}])("rejects incompatible configuration %j", value => {
    expect(() => parsePublicEditRelease(value)).toThrow(/Public Edit release/);
  });
});
