import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_ID_PATTERN, CAPABILITY_WAYS, RETIRED_CAPABILITY_IDS, SEPARATE_CAPABILITY_DOORS } from "./capabilities";

describe("capability ids", () => {
  it("uses dotted lowercase identities independent of door names", () => {
    for (const id of Object.keys(CAPABILITIES)) expect(id).toMatch(CAPABILITY_ID_PATTERN);
    for (const invalid of ["file", "File.move", "file.Move", "file-move", "file..move", "file.move.", "file/path.move"]) {
      expect(invalid).not.toMatch(CAPABILITY_ID_PATTERN);
    }
    expect(CAPABILITY_WAYS).toEqual(["control", "palette", "menu", "shortcut", "cli", "mcp", "app"]);
  });

  it("never reuses retired ids and keeps the retirement record", () => {
    for (const id of RETIRED_CAPABILITY_IDS) {
      expect(id).toMatch(CAPABILITY_ID_PATTERN);
      expect(Object.keys(CAPABILITIES)).not.toContain(id);
    }
    expect(new Set(RETIRED_CAPABILITY_IDS).size).toBe(RETIRED_CAPABILITY_IDS.length);
    expect(RETIRED_CAPABILITY_IDS).toMatchSnapshot();
  });

  it("names the app, automation executor, and share-link boundaries without offering them local rows", () => {
    expect(Object.keys(SEPARATE_CAPABILITY_DOORS)).toEqual(["app", "automationExecutor", "shareLink"]);
    for (const door of Object.values(SEPARATE_CAPABILITY_DOORS)) {
      expect(door.source).toBeTruthy();
      expect(door.reason).toBeTruthy();
    }
  });
});
