import { test } from "node:test";
import assert from "node:assert/strict";
import { GO_TO_COUNTS, goToIndexFixture } from "./go-to-index-fixture.mjs";
for (const count of [5000, 30000]) test("PR 1 Go to fixture counts at " + count + " files", () => {
  const sources = goToIndexFixture(count);
  assert.equal(sources.listing.files.length, count);
  assert.equal(new Set(sources.listing.files.map(file => file.path)).size, count);
  assert.equal(sources.listing.folders.length, GO_TO_COUNTS.folders);
  for (const kind of ["collections", "apps", "versions", "groups"]) assert.equal(sources[kind].length, GO_TO_COUNTS[kind]);
  assert.equal(sources.versions[0].name, "Main");
  assert.equal(sources.groups[0].name, "General");
  assert.ok(sources.listing.files.some(file => file.path.startsWith("src/")));
  assert.ok(sources.listing.files.some(file => file.path.startsWith("shared-with-me/")));
  // Future admission counts are explicit; no synthetic renderer identities are seeded.
  assert.equal(GO_TO_COUNTS.people, 9);
  assert.equal(GO_TO_COUNTS.agents, 18);
  assert.equal(GO_TO_COUNTS.dms, 7);
});
