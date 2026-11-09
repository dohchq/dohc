import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { READER_PHASE, readerTestArgs, readerTestMismatches, readerTests } from "../tools/rust-engine-program/reader-tests.mjs";

const crates = new URL("../crates/", import.meta.url);

test("the phase selects a test by its ignore reason, under any attributes, in any folder", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-reader-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "a/src/nested"), { recursive: true });
  writeFileSync(join(root, "a/src/lib.rs"), `
#[test]
#[ignore = "${READER_PHASE}"]
fn reads_one() {}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "${READER_PHASE}"]
#[should_panic(expected = "a reader")]
async fn reads_two() {}

#[test]
#[ignore = "manual measurement"]
fn measures() {}

#[test]
fn reads_nothing() {}
`);
  writeFileSync(join(root, "a/src/nested/tests.rs"), `    #[test]\n    #[ignore = "${READER_PHASE}"]\n    fn reads_three() {}\n`);
  writeFileSync(join(root, "a/src/nested/notes.md"), `#[ignore = "${READER_PHASE}"]\nfn not_rust() {}\n`);
  assert.deepEqual(readerTests(root), ["reads_one", "reads_three", "reads_two"]);
});

test("every ignored test that needs only a staged reader runs in the phase", () => {
  const names = readerTests();
  // The tests named in the issue that widened the phase, across both crates and test kinds.
  for (const name of ["a_reader_built_lineage_adopts_its_successor", "reader_restore_no_reader_prefix_refuses_before_fencing",
    "real_reader_proves_frontmatter_source_without_rewriting_live_state", "real_reader_settles_without_edits_and_revalidates_after_restart",
    "reader_restore_dispatches_outside_the_actor_at_every_phase", "outside_reader_fold_refuses_file_staleness",
    "real_reader_refuses_a_note_over_its_capacity_once_without_a_crash"]) {
    assert.ok(names.includes(name), name);
  }
  // A test that needs more than the staged reader says what else in its reason.
  const others = new Set();
  for (const path of readdirSync(crates, { recursive: true })) {
    if (!path.endsWith(".rs")) continue;
    for (const [, reason] of readFileSync(new URL(path.replaceAll("\\", "/"), crates), "utf8").matchAll(/#\[ignore = "([^"]*DOHC_ENGINE_READER_CONFIG[^"]*)"\]/gu)) {
      if (reason !== READER_PHASE) others.add(reason);
    }
  }
  assert.deepEqual([...others].sort(), [
    "requires DOHC_ENGINE_READER_CONFIG and DOHC_READER_FIXTURES for the real staged bundle",
    "requires DOHC_ENGINE_READER_CONFIG from the staged packaged/image layout",
  ]);
});

test("the phase lists and runs only ignored tests whose last name segment it selects", () => {
  assert.deepEqual(readerTestArgs("run", ["b", "a", "b"]),
    ["nextest", "run", "--locked", "--workspace", "--run-ignored", "ignored-only", "-E", "test(/(^|::)b$/) | test(/(^|::)a$/)"]);
  assert.equal(readerTestArgs("list", ["a"])[1], "list");
  const reused = ["--cargo-metadata", "target/nextest/cargo-metadata.json", "--binaries-metadata", "target/nextest/binaries-metadata.json",
    "--workspace-remap", "/checkout", "--target-dir-remap", "/checkout/target"];
  for (const command of ["list", "run"]) assert.deepEqual(readerTestArgs(command, ["a"], reused),
    ["nextest", command, ...reused, "--run-ignored", "ignored-only", "-E", "test(/(^|::)a$/)"]);
  assert.throws(() => readerTestArgs("run", []), /No test has the reader phase's ignore reason/u);
});

test("the phase refuses a list that selects a regression other than as often as its sources declare it", () => {
  const list = suites => ({ "rust-suites": Object.fromEntries(Object.entries(suites).map(([id, tests]) =>
    [id, { testcases: Object.fromEntries(Object.entries(tests).map(([name, status]) => [name, { ignored: true, "filter-match": { status } }])) }])) });
  const listed = list({
    "dohc-engine-collab": { "a::tests::reads_one": "matches", "b::reads_one_more": "mismatch" },
    "dohc-engine-runtime::reader_settlement": { reads_two: "matches" },
  });
  assert.deepEqual(readerTestMismatches(["reads_one", "reads_two"], listed), []);
  // Renamed or moved out of the build: declared, never found.
  assert.deepEqual(readerTestMismatches(["reads_one", "reads_two", "reads_three"], listed), ["reads_three (declared 1, found 0)"]);
  // Another ignored test with the same name would run too.
  const shadowed = list({ "dohc-engine-collab": { "a::reads_one": "matches", "b::reads_one": "matches" } });
  assert.deepEqual(readerTestMismatches(["reads_one"], shadowed), ["reads_one (declared 1, found 2)"]);
  assert.deepEqual(readerTestMismatches(["reads_one"], {}), ["reads_one (declared 1, found 0)"]);
});
