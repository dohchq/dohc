import { describe, expect, it } from "vitest";
import { engineGrantedSelector, recordedShareSelector } from "./shareViewRecords";

describe("a membership's pinned grant", () => {
  const whole = { paths: [], versionId: null, access: "comment", wholeWorkspace: true } as const;

  it("reads back as the whole workspace", () => {
    expect(recordedShareSelector(whole)).toEqual(whole);
  });

  it("is refused with paths, a version, or a flag that is not true", () => {
    for (const damaged of [
      { ...whole, paths: ["docs"] },
      { ...whole, versionId: "v1" },
      { ...whole, wholeWorkspace: "true" },
      { ...whole, wholeWorkspace: false },
    ]) {
      expect(recordedShareSelector(damaged), JSON.stringify(damaged)).toBeNull();
    }
  });

  it("travels to the engine with every dimension", () => {
    expect(engineGrantedSelector(whole)).toEqual(whole);
    expect(engineGrantedSelector({ paths: ["docs"], versionId: null, access: "view" })).toEqual({
      paths: ["docs"],
      versionId: null,
      access: "view",
    });
  });
});
