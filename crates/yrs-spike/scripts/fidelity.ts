// Criterion 1 — fidelity corpus (synthetic + harvested) through yrs.
//
// For each doc, the JS reference (Yjs 13.6.30 + @dohc/ydoc-projection) and
// the Rust harness (yrs) must agree on CONTENT — canonical doc JSON (maps,
// text deltas with attributes, full XML tree) AND the markdown projection —
// in both directions:
//   JS -> Rust : yrs applies the JS-encoded updates (in order AND in reverse
//                order, exercising the pending-update store) and its content
//                view equals the Yjs view.
//   Rust -> JS : yrs re-encodes its full state; a fresh Y.Doc built from
//                those bytes projects the SAME canonical JSON and markdown.
// Plus: state vectors agree semantically, cross diffs are no-ops, and a yrs
// merge_updates of the whole log reconstructs the same content (compaction).
//
// Usage: pnpm --filter @dohc/yrs-spike-scripts fidelity
// (harvested fixtures are optional: run scripts/harvest.mjs first)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { markdownToYDoc, plainTextToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import yaml from "js-yaml";
import { canonicalContent, contentDiff, contentsEqual } from "./canonical.js";
import { DOHC_SCHEMA, RustPeer } from "./rustPeer.js";
import { CORPUS } from "./corpus.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "harvested");

interface DocCase {
  name: string;
  source: "synthetic" | "harvested";
  updates: Uint8Array[];
}

function loadCases(): DocCase[] {
  const cases: DocCase[] = CORPUS.map((entry) => {
    const doc = entry.kind === "plaintext" ? plainTextToYDoc(entry.markdown) : markdownToYDoc(entry.markdown);
    return {
      name: `corpus: ${entry.name}`,
      source: "synthetic",
      updates: [Y.encodeStateAsUpdate(doc)],
    };
  });
  if (existsSync(FIXTURES)) {
    const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as Array<{
      name: string;
      files: string[];
    }>;
    for (const doc of manifest) {
      cases.push({
        name: `harvested: ${doc.name}`,
        source: "harvested",
        updates: doc.files.map((f) => new Uint8Array(readFileSync(join(FIXTURES, doc.name, f)))),
      });
    }
  } else {
    console.warn("NOTE: no harvested fixtures found (run harvest.mjs); synthetic corpus only.");
  }
  return cases;
}

function svMap(sv: Uint8Array): string {
  const decoded = Y.decodeStateVector(sv);
  return JSON.stringify([...decoded.entries()].sort((a, b) => a[0] - b[0]));
}

// SPIKE FINDING (pinned by doc-05/doc-09 of the harvested corpus):
// yDocToMarkdown is NOT read-only. y-prosemirror's createNodeFromYElement
// DELETES a PM-schema-invalid element (e.g. an empty listItem, which is
// CRDT-legal) from the Y.Doc as a side effect of projection. Projections in
// this harness therefore always run on a throwaway doc built from encoded
// state, never on a doc that later gets re-encoded for comparison.
function projectMarkdown(state: Uint8Array): { markdown: string; afterProjection: unknown } {
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, state);
  const markdown = yDocToMarkdown(scratch);
  // The doc AFTER projection (post any schema-normalization deletions) — both
  // lineages must normalize identically.
  return { markdown, afterProjection: canonicalContent(scratch, DOHC_SCHEMA) };
}

// SPIKE CAVEAT (pinned by the "frontmatter scalar types" corpus entry):
// yrs stores nested plain-object values (Any::Map) in a std HashMap, so a
// yrs RE-ENCODE emits nested map entries in nondeterministic (per-process)
// order, while Yjs preserves insertion order. Convergence and semantic
// content are unaffected; the only projection-visible surface is YAML key
// order of NESTED frontmatter objects (top-level keys are sorted by
// orderFrontmatter). Markdown mismatches whose sole difference is
// frontmatter key order are classified as this caveat, not a failure.
function frontmatterOrderOnly(a: string, b: string): boolean {
  if (a === b) return false;
  return normalizeFm(a) === normalizeFm(b);
}
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/;
function normalizeFm(markdown: string): string {
  const match = FM_RE.exec(markdown);
  if (!match) return markdown;
  const sorted = yaml.dump(yaml.load(match[1] ?? "") ?? {}, { sortKeys: true, lineWidth: -1 });
  return `---\n${sorted}---\n${match[2] ?? ""}`;
}

let docSeq = 0;
const failures: string[] = [];
const caveats: string[] = [];

function check(name: string, cond: boolean, detail: () => string): void {
  if (!cond) {
    failures.push(`${name}: ${detail()}`);
    console.error(`  FAIL ${name}\n    ${detail().split("\n").join("\n    ")}`);
  }
}

function checkMarkdown(name: string, expected: string, actual: string, label: string): void {
  if (expected === actual) return;
  if (frontmatterOrderOnly(expected, actual)) {
    caveats.push(`${name}: ${label} differs only in nested frontmatter key order (yrs Any::Map)`);
    console.warn(`  CAVEAT ${name}: ${label} differs only in nested frontmatter key order`);
    return;
  }
  check(name, false, () => `expected: ${JSON.stringify(expected.slice(0, 400))}\nactual:   ${JSON.stringify(actual.slice(0, 400))}`);
}

async function runCase(rust: RustPeer, c: DocCase): Promise<void> {
  // JS reference doc. Markdown is projected on a throwaway clone (see
  // projectMarkdown) so the projection's schema-normalization side effect
  // cannot mutate the lineage under comparison.
  const jsDoc = new Y.Doc();
  for (const u of c.updates) Y.applyUpdate(jsDoc, u);
  const jsContent = canonicalContent(jsDoc, DOHC_SCHEMA);
  const jsState = Y.encodeStateAsUpdate(jsDoc);
  const jsProjection = projectMarkdown(jsState);
  const jsMarkdown = jsProjection.markdown;
  const jsSv = Y.encodeStateVector(jsDoc);

  // JS -> Rust, in order.
  const idFwd = `fid-${(docSeq += 1)}`;
  await rust.newDoc(idFwd);
  for (const u of c.updates) {
    const err = await rust.apply(idFwd, u);
    check(`${c.name} / rust apply`, err === null, () => String(err));
  }
  const rustContent = await rust.content(idFwd);
  check(`${c.name} / content JS->Rust (in order)`, contentsEqual(jsContent, rustContent), () =>
    contentDiff(jsContent, rustContent),
  );

  // JS -> Rust, reverse delivery order (pending-update store).
  if (c.updates.length > 1) {
    const idRev = `fid-${(docSeq += 1)}`;
    await rust.newDoc(idRev);
    for (const u of [...c.updates].reverse()) {
      const err = await rust.apply(idRev, u);
      check(`${c.name} / rust apply (reversed)`, err === null, () => String(err));
    }
    const revContent = await rust.content(idRev);
    check(`${c.name} / content JS->Rust (reverse order)`, contentsEqual(jsContent, revContent), () =>
      contentDiff(jsContent, revContent),
    );
    await rust.free(idRev);
  }

  // State vectors agree semantically.
  const rustState = await rust.state(idFwd);
  check(
    `${c.name} / state vector`,
    svMap(rustState.sv) === svMap(jsSv),
    () => `js=${svMap(jsSv)} rust=${svMap(rustState.sv)}`,
  );

  // Cross diffs are no-ops: Rust's diff against the JS sv applies nothing new.
  const rustDiff = await rust.diff(idFwd, jsSv);
  const before = canonicalContent(jsDoc, DOHC_SCHEMA);
  Y.applyUpdate(jsDoc, rustDiff);
  check(
    `${c.name} / rust diff vs js sv is a no-op`,
    contentsEqual(before, canonicalContent(jsDoc, DOHC_SCHEMA)),
    () => contentDiff(before, canonicalContent(jsDoc, DOHC_SCHEMA)),
  );

  // Rust -> JS: rebuild a fresh Y.Doc purely from yrs's re-encoded state.
  const fromRust = new Y.Doc();
  Y.applyUpdate(fromRust, rustState.update);
  const fromRustContent = canonicalContent(fromRust, DOHC_SCHEMA);
  check(`${c.name} / content Rust->JS`, contentsEqual(jsContent, fromRustContent), () =>
    contentDiff(jsContent, fromRustContent),
  );
  const rustProjection = projectMarkdown(rustState.update);
  checkMarkdown(`${c.name} / markdown projection Rust->JS`, jsMarkdown, rustProjection.markdown, "projection");
  // The projection's schema-normalization side effect (invalid-node deletion)
  // must land IDENTICALLY on both lineages — a settle after either path
  // yields the same normalized doc.
  check(
    `${c.name} / post-projection normalization matches`,
    contentsEqual(jsProjection.afterProjection, rustProjection.afterProjection),
    () => contentDiff(jsProjection.afterProjection, rustProjection.afterProjection),
  );

  // JS -> Rust again with the re-encoded lineage (round trip closes).
  const idBack = `fid-${(docSeq += 1)}`;
  await rust.newDoc(idBack);
  const err = await rust.apply(idBack, Y.encodeStateAsUpdate(fromRust));
  check(`${c.name} / re-encoded apply`, err === null, () => String(err));
  const backContent = await rust.content(idBack);
  check(`${c.name} / content JS->Rust (round trip)`, contentsEqual(jsContent, backContent), () =>
    contentDiff(jsContent, backContent),
  );
  await rust.free(idBack);

  // Compaction analog: yrs merges the whole update log into one update; a
  // fresh Y.Doc built from the merged update converges to the same content.
  const merged = await rust.merge(c.updates);
  const fromMerged = new Y.Doc();
  Y.applyUpdate(fromMerged, merged);
  check(
    `${c.name} / yrs merge_updates convergence`,
    contentsEqual(jsContent, canonicalContent(fromMerged, DOHC_SCHEMA)),
    () => contentDiff(jsContent, canonicalContent(fromMerged, DOHC_SCHEMA)),
  );
  const mergedProjection = projectMarkdown(merged);
  checkMarkdown(`${c.name} / markdown after yrs merge`, jsMarkdown, mergedProjection.markdown, "merged projection");

  await rust.free(idFwd);
}

// SPIKE PROBE — surrogate-pair splitting. An insert at a UTF-16 index inside
// a surrogate pair is expressible through the Yjs API; yjs 13.6.30 sanitizes
// the split halves to U+FFFD at insert time, so the wire stays well-formed
// and yrs (whose Rust strings cannot hold lone surrogates) agrees exactly.
// This probe PINS that agreement: if a future yjs stops sanitizing (or a
// future yrs changes substitution), it fails loudly. NOTE the related
// hard-won fuzz finding this probe complements: yrs's DEFAULT
// OffsetKind::Bytes counts text lengths in UTF-8 bytes and is
// wire-INCOMPATIBLE with Yjs for non-ASCII text (clock misalignment,
// content divergence, downstream Yjs struct-store crashes) — the harness
// always opens docs with OffsetKind::Utf16.
async function surrogateProbe(rust: RustPeer): Promise<void> {
  const doc = new Y.Doc();
  const t = doc.getText("plainText");
  t.insert(0, "a😀b");
  t.insert(2, "X"); // mid-pair: yjs sanitizes to a�X�b
  const jsText = t.toString();
  const id = "surrogate-probe";
  await rust.newDoc(id);
  const err = await rust.apply(id, Y.encodeStateAsUpdate(doc));
  const rustContent = (await rust.content(id)) as Record<string, { delta?: Array<{ insert: string }> }>;
  const rustText = (rustContent.plainText?.delta ?? []).map((d) => d.insert).join("");
  await rust.free(id);
  const wellFormed = (jsText as string & { isWellFormed(): boolean }).isWellFormed();
  console.log(
    `surrogate probe: js holds ${wellFormed ? "well-formed (yjs sanitized)" : "LONE-SURROGATE"} text; yrs apply ${err === null ? "accepted" : `rejected (${err})`}; yrs text ${JSON.stringify(rustText)} vs js ${JSON.stringify(jsText)}`,
  );
  check(
    "surrogate probe / mid-pair insert converges",
    err === null && rustText === jsText && wellFormed,
    () => `wellFormed=${wellFormed} err=${String(err)} js=${JSON.stringify(jsText)} rust=${JSON.stringify(rustText)}`,
  );
}

const cases = loadCases();
const rust = new RustPeer();
await surrogateProbe(rust);
let passed = 0;
for (const c of cases) {
  const beforeFailures = failures.length;
  await runCase(rust, c);
  const ok = failures.length === beforeFailures;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name} (${c.updates.length} update blob${c.updates.length === 1 ? "" : "s"})`);
}
rust.close();

console.log(`\n${passed}/${cases.length} docs passed (${cases.filter((c) => c.source === "harvested").length} harvested, ${cases.filter((c) => c.source === "synthetic").length} synthetic)`);
if (caveats.length > 0) {
  console.warn(`\n${caveats.length} known-caveat divergence(s) (nested frontmatter Any::Map key order — see SPIKE_REPORT.md):`);
  for (const c of caveats) console.warn(`  - ${c}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
