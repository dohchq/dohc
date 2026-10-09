import { expect, it } from "vitest";
import { visibleSharePath } from "./shareSelector";

it("matches exact paths and slash ancestors, including overlapping scopes", () => {
  const scope = { paths: ["Trip", "Trip/Plans"], versionId: null };
  for (const path of ["Trip", "Trip/Plans", "Trip/Plans/day.md"]) expect(visibleSharePath(scope, path)).toBe(path);
  for (const path of ["Trips/day.md", "Trip-old", "Budget/Trip"]) expect(visibleSharePath(scope, path)).toBeNull();
});

it("selects a whole tracked version only when the selector has a version", () => {
  expect(visibleSharePath({ paths: [], versionId: "version" }, "Notes/a.md")).toBe("Notes/a.md");
  expect(visibleSharePath({ paths: [], versionId: null }, "Notes/a.md")).toBeNull();
});

it.each([".env", "Trip/.env", "Trip/.env.local", "Trip/config.env", "Trip/.dohc/token", "../Trip/a.md", "/Trip/a.md", "node_modules/file"])
  ("excludes secret, ignored or invalid path %s", path => {
    expect(visibleSharePath({ paths: [], versionId: "version" }, path)).toBeNull();
  });

it("returns the normalized spelling that the relay previously served", () => {
  expect(visibleSharePath({ paths: ["Trip"], versionId: null }, "Trip\\a.md")).toBe("Trip/a.md");
});
