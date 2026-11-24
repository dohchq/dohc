import { describe, expect, it } from "vitest";
import {
  engineGrantedSelector,
  recordedShareSelector,
  sharePinAtStatedLevel,
} from "./shareViewRecords";

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

const pin = { paths: ["docs", "tasks"], versionId: null, access: "view" };

describe("sharePinAtStatedLevel", () => {
  it.each([
    ["view", "edit"],
    ["edit", "view"],
    ["comment", "edit"],
    ["edit", "comment"],
  ])("moves a pin at %s to the stated %s and keeps its paths and version", (pinned, stated) => {
    for (const versionId of [null, "saved-version"]) {
      expect(
        sharePinAtStatedLevel(
          { ...pin, versionId, access: pinned },
          { paths: ["docs", "tasks"], versionId, access: stated },
        ),
      ).toEqual({ paths: ["docs", "tasks"], versionId, access: stated });
    }
  });

  it("keeps the pin when the stated level is the pinned one", () => {
    expect(sharePinAtStatedLevel(pin, { ...pin })).toBeNull();
  });

  it.each([
    ["wider paths", { paths: ["docs", "tasks", "secrets"], versionId: null }],
    ["narrower paths", { paths: ["docs"], versionId: null }],
    ["other paths", { paths: ["docs", "plans"], versionId: null }],
    ["reordered paths", { paths: ["tasks", "docs"], versionId: null }],
    ["a version", { paths: ["docs", "tasks"], versionId: "saved-version" }],
  ])("keeps the pin when the statement names %s", (_name, stated) => {
    expect(sharePinAtStatedLevel(pin, { ...stated, access: "edit" })).toBeNull();
  });

  it("keeps a version pin when the statement names main or another version", () => {
    const versionPin = { paths: [], versionId: "saved-version", access: "view" };
    expect(
      sharePinAtStatedLevel(versionPin, { paths: [], versionId: "other-version", access: "edit" }),
    ).toBeNull();
    expect(
      sharePinAtStatedLevel(versionPin, { paths: ["docs"], versionId: null, access: "edit" }),
    ).toBeNull();
  });

  it.each([
    ["no statement", undefined],
    ["a chat share", null],
    ["an unknown level", { paths: ["docs", "tasks"], versionId: null, access: "owner" }],
    ["no level", { paths: ["docs", "tasks"], versionId: null }],
    [
      "a path the relay cannot issue",
      { paths: ["../docs", "tasks"], versionId: null, access: "edit" },
    ],
  ])("keeps the pin when the statement is %s", (_name, stated) => {
    expect(sharePinAtStatedLevel(pin, stated)).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["without a level", { paths: ["docs", "tasks"], versionId: null }],
    ["without paths or a version", { paths: [], versionId: null, access: "view" }],
  ])("gives a pin that is %s no level", (_name, pinned) => {
    expect(
      sharePinAtStatedLevel(pinned, { paths: ["docs", "tasks"], versionId: null, access: "edit" }),
    ).toBeNull();
  });
});
