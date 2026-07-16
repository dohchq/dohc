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
// Usage: pnpm --filter @dohc/yrs-spike-scripts fidelity [-- --require-harvested]
// Harvested fixtures are optional for a dev run (scripts/harvest.mjs
// produces them); CERTIFICATION runs must pass --require-harvested so the
// real-lineage half of criterion 1 cannot silently drop out.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { markdownToYDoc, plainTextToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import yaml from "js-yaml";
import { canonicalContent, contentDiff, contentsEqual, stableStringify, undeclaredRoots } from "./canonical.js";
import { DOHC_SCHEMA, RustPeer } from "./rustPeer.js";
import { CORPUS } from "./corpus.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "harvested");

interface DocCase {
  name: string;
  source: "synthetic" | "harvested";
  updates: Uint8Array[];
}

// Synthetic MULTI-update lineages: drive incremental edits and capture every
// per-transaction update event, so the reverse-order/pending-update-store
// path runs on every fresh checkout even without harvested fixtures.
function incrementalCases(): DocCase[] {
  const capture = (doc: Y.Doc, edits: Array<() => void>): Uint8Array[] => {
    const updates: Uint8Array[] = [Y.encodeStateAsUpdate(doc)];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    for (const edit of edits) doc.transact(edit);
    return updates;
  };

  const plain = plainTextToYDoc("base line\n");
  const t = plain.getText("plainText");
  const plainUpdates = capture(
    plain,
    Array.from({ length: 12 }, (_, i) => () => {
      if (i % 4 === 3) t.delete(0, 2);
      else t.insert(t.length, `edit ${i} — 汉字 ${"😀".repeat((i % 3) + 1)}\n`);
    }),
  );

  const rich = markdownToYDoc("# Incremental\n\nSeed paragraph.");
  const frag = rich.getXmlFragment("body");
  const richUpdates = capture(
    rich,
    Array.from({ length: 12 }, (_, i) => () => {
      if (i % 3 === 0) {
        const el = new Y.XmlElement("paragraph");
        el.insert(0, [new Y.XmlText(`para ${i} with émoji 😀`)]);
        frag.insert(Math.min(i % (frag.length + 1), frag.length), [el]);
      } else {
        const first = frag.get(frag.length - 1);
        const text = first instanceof Y.XmlElement ? first.get(0) : null;
        if (text instanceof Y.XmlText) {
          text.insert(text.length, ` +${i}`, i % 2 === 0 ? { bold: {} } : undefined);
        }
      }
    }),
  );

  return [
    { name: "corpus: incremental plaintext lineage", source: "synthetic", updates: plainUpdates },
    { name: "corpus: incremental richdoc lineage", source: "synthetic", updates: richUpdates },
  ];
}

function loadCases(requireHarvested: boolean): { cases: DocCase[]; harvestedPresent: boolean } {
  const cases: DocCase[] = CORPUS.map((entry) => {
    const doc = entry.kind === "plaintext" ? plainTextToYDoc(entry.markdown) : markdownToYDoc(entry.markdown);
    return {
      name: `corpus: ${entry.name}`,
      source: "synthetic" as const,
      updates: [Y.encodeStateAsUpdate(doc)],
    };
  });
  cases.push(...incrementalCases());
  const harvestedPresent = existsSync(FIXTURES);
  if (harvestedPresent) {
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
  } else if (requireHarvested) {
    console.error(
      "FATAL: --require-harvested was passed but no harvested fixtures exist (run scripts/harvest.mjs). Certification runs must include the real-lineage corpus.",
    );
    process.exit(1);
  }
  return { cases, harvestedPresent };
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
// The caveat is admitted ONLY when: both markdowns carry frontmatter, the
// bodies are byte-identical, and the two YAML docs parse deep-equal (so the
// difference is strictly key sequence, nothing else).
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/;
function frontmatterOrderOnly(a: string, b: string): boolean {
  if (a === b) return false;
  const ma = FM_RE.exec(a);
  const mb = FM_RE.exec(b);
  if (!ma || !mb) return false;
  if ((ma[2] ?? "") !== (mb[2] ?? "")) return false; // bodies must match exactly
  let pa: unknown;
  let pb: unknown;
  try {
    pa = yaml.load(ma[1] ?? "");
    pb = yaml.load(mb[1] ?? "");
  } catch {
    return false;
  }
  type Sortable = Parameters<typeof stableStringify>[0];
  return stableStringify(pa as Sortable) === stableStringify(pb as Sortable);
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

// undeclaredRoot placeholders compare equal WITHOUT their contents being
// read — any occurrence means the declared schema no longer covers the doc
// and the comparison is unsound. Hard failure.
function checkNoUndeclared(name: string, ...contents: unknown[]): void {
  for (const content of contents) {
    const extra = undeclaredRoots(content);
    check(`${name} / no undeclared roots`, extra.length === 0, () => `undeclared root(s): ${extra.join(", ")}`);
  }
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
  checkNoUndeclared(c.name, jsContent, rustContent);
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

// SPIKE PROBE — OffsetKind::Bytes wire hazard, pinned deterministically.
// yrs's DEFAULT OffsetKind::Bytes measures text offsets in UTF-8 bytes;
// Yjs measures in UTF-16 code units. The failure mode is PROBABILISTIC in
// general fuzzing (ASCII and boundary-aligned offsets behave identically —
// several pre-fix seeds passed), so this probe pins two deterministic
// manifestations with emoji content (4 UTF-8 bytes, 2 UTF-16 units):
//   1. positional divergence from UTF-16 intent: the same insert request
//      lands at a different position under Bytes than under Utf16;
//   2. a UTF-16-valid offset that is byte-INVALID (mid-char) panics yrs
//      outright (block.rs subtract-with-overflow), killing the process.
// The pre-fix fuzz additionally produced cross-peer content divergence and
// a downstream Yjs struct-store crash (seed 9) through this mechanism.
async function bytesModeProbe(rust: RustPeer): Promise<void> {
  const textOf = async (peer: RustPeer, id: string): Promise<string> => {
    const content = (await peer.content(id)) as Record<string, { delta?: Array<{ insert: string }> }>;
    return (content.plainText?.delta ?? []).map((d) => d.insert).join("");
  };

  // 1. Positional divergence (no crash): same requests, both modes.
  const run = async (id: string, mode: "utf16" | "bytes"): Promise<string> => {
    await rust.newDoc(id, 222, mode);
    await rust.textInsert(id, "plainText", 0, "😀😀😀");
    await rust.textInsert(id, "plainText", 4, "X"); // utf16 4 = after 2nd emoji; byte 4 = after 1st
    const text = await textOf(rust, id);
    await rust.free(id);
    return text;
  };
  const utf16Text = await run("bytes-probe-16", "utf16");
  const bytesText = await run("bytes-probe-8", "bytes");
  console.log(`bytes-mode probe: utf16=${JSON.stringify(utf16Text)} bytes=${JSON.stringify(bytesText)}`);
  check(
    "bytes probe / utf16 doc lands the edit at the UTF-16 offset",
    utf16Text === "😀😀X😀",
    () => JSON.stringify(utf16Text),
  );
  check(
    "bytes probe / bytes doc lands the SAME request at a different position (wire-hazard pinned)",
    bytesText === "😀X😀😀",
    () => JSON.stringify(bytesText),
  );

  // 2. Mid-char byte offset panics yrs — run on a DISPOSABLE peer (the panic
  // kills the child; the shared peer must survive the probe).
  const crashPeer = new RustPeer();
  let crashed = false;
  try {
    await crashPeer.newDoc("bytes-probe-crash", 222, "bytes");
    await crashPeer.textInsert("bytes-probe-crash", "plainText", 0, "😀😀😀");
    await crashPeer.textInsert("bytes-probe-crash", "plainText", 2, "X"); // byte 2 = mid-emoji
  } catch (error) {
    crashed = /exited/.test(String(error));
  } finally {
    crashPeer.close();
  }
  console.log(`bytes-mode probe: mid-char byte offset ${crashed ? "panicked yrs (pinned)" : "did NOT panic"}`);
  check(
    "bytes probe / mid-char byte offset panics yrs (block.rs subtract overflow)",
    crashed,
    () => "expected the Bytes-mode harness to die on a byte-invalid offset; it survived — re-characterize the hazard before trusting Bytes mode",
  );
}

// SPIKE PROBE — truncation atomicity, pinned over EVERY cut point (fault
// model: truncation only; arbitrary-byte robustness is future cargo-fuzz
// work). NEW FINDING from the review batch: yjs 13.6.30 applyUpdate is NOT
// atomic on malformed input — a rejected truncated update can leave a
// partially-integrated prefix of the real items. yrs decodes fully before
// applying, so it IS atomic. The invariants pinned here:
//   - neither side ever ACCEPTS a truncated update (every cut rejects),
//   - yrs state is byte-unchanged across every rejected cut (atomic),
//   - yjs partial prefixes ALWAYS converge once the full update arrives
//     (0 permanent divergences across every cut).
async function truncationAtomicityProbe(rust: RustPeer): Promise<void> {
  const doc = new Y.Doc();
  doc.clientID = 42;
  const t = doc.getText("plainText");
  doc.transact(() => t.insert(0, "hello world "));
  doc.transact(() => t.insert(t.length, "second edit 汉字 "));
  doc.transact(() => t.insert(t.length, "third 😀 edit"));
  const full = Y.encodeStateAsUpdate(doc);
  const fullContent = canonicalContent(doc, DOHC_SCHEMA);

  const id = "truncation-probe";
  await rust.newDoc(id);
  const rustBaseline = await rust.content(id, DOHC_SCHEMA);
  let jsAccepted = 0;
  let rustAccepted = 0;
  let jsPartial = 0;
  let jsPermanent = 0;
  for (let cut = 1; cut < full.length; cut += 1) {
    const bad = full.slice(0, cut);
    const rustErr = await rust.apply(id, bad);
    if (rustErr === null) rustAccepted += 1;
    const probe = new Y.Doc();
    let threw = false;
    try {
      Y.applyUpdate(probe, bad);
    } catch {
      threw = true;
    }
    if (!threw) jsAccepted += 1;
    else if (!contentsEqual(canonicalContent(probe, DOHC_SCHEMA), {})) jsPartial += 1;
    try {
      Y.applyUpdate(probe, full);
      if (!contentsEqual(canonicalContent(probe, DOHC_SCHEMA), fullContent)) jsPermanent += 1;
    } catch {
      jsPermanent += 1;
    }
  }
  const rustAfter = await rust.content(id, DOHC_SCHEMA);
  await rust.free(id);
  console.log(
    `truncation probe: ${full.length - 1} cuts — yrs accepted=${rustAccepted}, yjs accepted=${jsAccepted}, yjs partial-prefix applies=${jsPartial} (non-atomic reject, pinned), permanent divergences=${jsPermanent}`,
  );
  check("truncation probe / yrs never accepts a truncated update", rustAccepted === 0, () => `${rustAccepted} cuts accepted`);
  check("truncation probe / yjs never accepts a truncated update", jsAccepted === 0, () => `${jsAccepted} cuts accepted`);
  check(
    "truncation probe / yrs state unchanged across every rejected cut (atomic)",
    contentsEqual(rustBaseline, rustAfter),
    () => contentDiff(rustBaseline, rustAfter),
  );
  check(
    "truncation probe / every yjs partial prefix converges on full delivery",
    jsPermanent === 0,
    () => `${jsPermanent} cuts left permanently divergent state`,
  );
}

const requireHarvested = process.argv.includes("--require-harvested");
const { cases, harvestedPresent } = loadCases(requireHarvested);
const rust = new RustPeer();
await surrogateProbe(rust);
await bytesModeProbe(rust);
await truncationAtomicityProbe(rust);
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
if (!harvestedPresent) {
  console.warn(
    "\nWARNING: NO HARVESTED FIXTURES — the real-lineage half of criterion 1 was NOT exercised. " +
      "Run scripts/harvest.mjs against a copied engine.db; certification runs must pass --require-harvested.",
  );
}
if (caveats.length > 0) {
  console.warn(`\n${caveats.length} known-caveat divergence(s) (nested frontmatter Any::Map key order — see SPIKE_REPORT.md):`);
  for (const c of caveats) console.warn(`  - ${c}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
