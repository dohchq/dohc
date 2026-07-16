// Criterion 2 (+4) — seeded alternating-driver fuzz: a Yjs (JS) peer and a
// yrs (Rust) peer edit the SAME doc in alternating rounds; update delivery is
// randomly ordered, duplicated, and adversarially truncated; some rounds sync
// via state-vector diffs instead of raw update delivery. At the end both
// peers must converge to identical CONTENT (canonical doc JSON), identical
// semantic state vectors, and an identical markdown projection; a yrs
// merge_updates of the full update log and a yrs full-state re-encode
// (compaction/snapshot analogs) must reconstruct the same converged content.
//
// Deterministic BY CONSTRUCTION: every random choice comes from one seeded
// PRNG, and every item in the run — including the base lineage — is minted
// under a fixed, seed-derived client id (the seed content is rebuilt on a
// fixed-clientID doc rather than imported from the projection helpers, whose
// docs mint random client ids). A failing seed replays exactly. This is the
// permanent R11 regression harness.
//
// Usage: pnpm --filter @dohc/yrs-spike-scripts fuzz [-- --seeds 200 --start 1 --strict]
// Certification runs must pass --strict: it promotes fault-injection
// caveats (e.g. a truncated update being ACCEPTED) to hard failures.

import * as Y from "yjs";
import { markdownToYDoc, plainTextToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { canonicalContent, contentDiff, contentsEqual, undeclaredRoots } from "./canonical.js";
import { DOHC_SCHEMA, RustPeer, type EditResult, type RootSchema } from "./rustPeer.js";

const ROUNDS = 10;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FuzzResult {
  failures: string[];
  caveats: string[];
  jsEdits: number;
  rustEdits: number;
  deliveries: number;
  duplicates: number;
  truncations: number;
  // yjs applyUpdate is NOT atomic on malformed input: a rejected truncated
  // update can leave a partially-integrated prefix (pinned deterministically
  // by the truncation-atomicity probe in fidelity.ts). The enforced invariant
  // is that the prefix converges once the genuine update is delivered.
  partialApplies: number;
  svSyncs: number;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "épsilon", "ζeta", "😀emoji", "汉字", "tab\tin", "line"];

// Every edit position is snapped to a code-point boundary (mirroring what
// ProseMirror-driven edits produce; yjs sanitizes mid-pair splits to U+FFFD
// anyway — pinned by the surrogate probe in fidelity.ts). The hard-won
// finding behind this area: yrs's DEFAULT OffsetKind::Bytes counts text
// lengths in UTF-8 bytes and is wire-INCOMPATIBLE with Yjs for non-ASCII
// text (seed 9 diverged and later crashed Yjs's struct store before the
// harness switched every doc to OffsetKind::Utf16).
function snapBoundary(s: string, idx: number): number {
  let at = Math.max(0, Math.min(idx, s.length));
  while (at > 0 && at < s.length) {
    const unit = s.charCodeAt(at);
    if (unit >= 0xdc00 && unit <= 0xdfff) at -= 1; // low surrogate: mid-pair
    else break;
  }
  return at;
}
const MARKS: Array<Record<string, unknown> | undefined> = [
  undefined,
  undefined,
  { bold: {} },
  { italic: {} },
  { bold: {}, italic: {} },
];

// Build the seed doc so EVERY item — including the base lineage — is minted
// under the fixed, seed-derived clientID. The projection helpers create docs
// with random client ids, so their content is cloned onto a fixed-id doc
// (same clone pattern as ydocEngineDriver.replaceDocContent) instead of
// setting clientID after the fact, which would leave the base items random.
function seedJsDoc(mode: "plaintext" | "richdoc", seed: number): Y.Doc {
  const tmp =
    mode === "plaintext"
      ? plainTextToYDoc(`seed ${seed}\nbase line\n`)
      : markdownToYDoc(`# Seed ${seed}\n\nBase paragraph with **bold**.\n\n- item one\n- item two`);
  const doc = new Y.Doc();
  doc.clientID = 1_000_000 + seed;
  for (const field of ["frontmatter", "meta"] as const) {
    const target = doc.getMap(field);
    for (const [k, v] of tmp.getMap(field).entries()) target.set(k, v);
  }
  if (mode === "plaintext") {
    doc.getText("plainText").insert(0, tmp.getText("plainText").toString());
  } else {
    const clones = tmp
      .getXmlFragment("body")
      .toArray()
      .filter(
        (node): node is Y.XmlElement | Y.XmlText =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText,
      )
      .map((node) => node.clone() as Y.XmlElement | Y.XmlText);
    if (clones.length > 0) doc.getXmlFragment("body").insert(0, clones);
  }
  tmp.destroy();
  return doc;
}

async function fuzzOne(rust: RustPeer, seed: number, mode: "plaintext" | "richdoc"): Promise<FuzzResult> {
  const rand = mulberry32(seed * 2 + (mode === "richdoc" ? 1 : 0));
  const pick = (n: number) => Math.floor(rand() * n);
  const word = () => WORDS[pick(WORDS.length)]!;
  const r: FuzzResult = {
    failures: [],
    caveats: [],
    jsEdits: 0,
    rustEdits: 0,
    deliveries: 0,
    duplicates: 0,
    truncations: 0,
    partialApplies: 0,
    svSyncs: 0,
  };
  const fail = (what: string, detail: string) => {
    r.failures.push(`seed ${seed} ${mode} / ${what}: ${detail}`);
  };

  const schema: RootSchema = DOHC_SCHEMA;
  const jsDoc = seedJsDoc(mode, seed);
  const rustId = `fuzz-${seed}-${mode}`;
  await rust.newDoc(rustId, 2_000_000 + seed);

  const allUpdates: Uint8Array[] = [Y.encodeStateAsUpdate(jsDoc)];
  const toRust: Uint8Array[] = [allUpdates[0]!];
  const toJs: Uint8Array[] = [];

  const captured: Uint8Array[] = [];
  jsDoc.on("update", (u: Uint8Array) => captured.push(u));

  const jsEdit = () => {
    r.jsEdits += 1;
    if (mode === "plaintext") {
      const t = jsDoc.getText("plainText");
      jsDoc.transact(() => {
        const s = t.toString();
        if (t.length > 0 && rand() < 0.3) {
          const at = snapBoundary(s, pick(t.length));
          const end = snapBoundary(s, Math.min(at + 1 + pick(4), t.length));
          if (end > at) t.delete(at, end - at);
        } else {
          t.insert(snapBoundary(s, pick(t.length + 1)), `${word()} `);
        }
      });
      return;
    }
    const frag = jsDoc.getXmlFragment("body");
    jsDoc.transact(() => {
      const texts: Y.XmlText[] = [];
      for (let i = 0; i < frag.length; i += 1) {
        const el = frag.get(i);
        if (el instanceof Y.XmlElement && el.get(0) instanceof Y.XmlText) {
          texts.push(el.get(0) as Y.XmlText);
        }
      }
      const roll = rand();
      if (roll < 0.35 || texts.length === 0) {
        const el = new Y.XmlElement("paragraph");
        el.insert(0, [new Y.XmlText(`${word()} ${word()}`)]);
        frag.insert(pick(frag.length + 1), [el]);
      } else if (roll < 0.5 && frag.length > 1) {
        frag.delete(pick(frag.length), 1);
      } else {
        const t = texts[pick(texts.length)]!;
        // XmlText.toString() interleaves formatting tags; recover the plain
        // text (whose offsets match t.length) from the delta instead.
        const s = (t.toDelta() as Array<{ insert: unknown }>)
          .map((d) => (typeof d.insert === "string" ? d.insert : ""))
          .join("");
        if (t.length > 0 && rand() < 0.3) {
          const at = snapBoundary(s, pick(t.length));
          const end = snapBoundary(s, Math.min(at + 1 + pick(3), t.length));
          if (end > at) t.delete(at, end - at);
        } else {
          t.insert(snapBoundary(s, pick(t.length + 1)), ` ${word()}`, MARKS[pick(MARKS.length)]);
        }
      }
    });
  };

  // r.rustEdits counts LANDED edits: the harness reports per-op whether the
  // doc actually changed (a clamped out-of-range delete is a legal no-op,
  // and a no-op's encoded "delta" is still non-empty — it carries the full
  // delete set — so byte length cannot tell). An attempt that misses (typed
  // not-editable target) or no-ops is replaced by a guaranteed fallback
  // edit, so every attempt changes the yrs doc and the alternating-driver
  // guarantee cannot silently degrade to one driver.
  const rustEdit = async () => {
    let result: EditResult | null = null;
    try {
      if (mode === "plaintext") {
        result =
          rand() < 0.3
            ? await rust.textDelete(rustId, "plainText", pick(400), 1 + pick(4))
            : await rust.textInsert(rustId, "plainText", pick(400), `${word()} `);
      } else {
        const roll = rand();
        if (roll < 0.35) {
          result = await rust.xmlInsertParagraph(rustId, "body", pick(12), `${word()} ${word()}`);
        } else if (roll < 0.55) {
          result = await rust.xmlTextDelete(rustId, "body", pick(12), pick(30), 1 + pick(3));
        } else {
          result = await rust.xmlTextInsert(
            rustId,
            "body",
            pick(12),
            pick(30),
            ` ${word()}`,
            MARKS[pick(MARKS.length)],
          );
        }
      }
    } catch (error) {
      // ONLY the harness's typed "target not editable" rejection is legal
      // (the random paragraph index landed on a non-editable node). Anything
      // else is a protocol/build regression and must fail the run, not
      // silently drop Rust edits.
      if (!String(error).includes("not-editable:")) throw error;
    }
    if (result === null || !result.changed) {
      result =
        mode === "plaintext"
          ? await rust.textInsert(rustId, "plainText", 0, `fb${r.rustEdits} `)
          : await rust.xmlInsertParagraph(rustId, "body", 0, `fallback ${r.rustEdits}`);
    }
    r.rustEdits += 1; // landed: the op above verifiably changed the yrs doc
    toJs.push(result.update);
  };

  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = pick(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };

  const deliverToRust = async (u: Uint8Array) => {
    r.deliveries += 1;
    allUpdates.push(u);
    const err = await rust.apply(rustId, u);
    if (err !== null) fail("rust apply", err);
    if (rand() < 0.2) {
      r.duplicates += 1;
      const dupErr = await rust.apply(rustId, u);
      if (dupErr !== null) fail("rust duplicate apply", dupErr);
    }
  };

  const deliverToJs = (u: Uint8Array) => {
    r.deliveries += 1;
    allUpdates.push(u);
    Y.applyUpdate(jsDoc, u);
    if (rand() < 0.2) {
      r.duplicates += 1;
      Y.applyUpdate(jsDoc, u);
    }
  };

  const injectTruncated = async (u: Uint8Array) => {
    if (u.length < 3) return;
    r.truncations += 1;
    const cut = 1 + pick(u.length - 1);
    const bad = u.slice(0, cut);
    const rustErr = await rust.apply(rustId, bad);
    // The JS probe carries the REAL doc's current state (not a blank doc), so
    // a partial mid-decode application against realistic struct-store state
    // is observable. yjs applyUpdate is NOT atomic on malformed input (pinned
    // by the truncation-atomicity probe in fidelity.ts): a rejection may
    // leave a partially-integrated prefix. The enforced invariant is that
    // the prefix CONVERGES once the genuine update is delivered — anything
    // else is corruption and fails the run.
    const probeState = Y.encodeStateAsUpdate(jsDoc);
    const probe = new Y.Doc();
    Y.applyUpdate(probe, probeState);
    const probeBefore = canonicalContent(probe, schema);
    let jsRejected = false;
    try {
      Y.applyUpdate(probe, bad);
    } catch {
      jsRejected = true;
    }
    if (jsRejected && !contentsEqual(probeBefore, canonicalContent(probe, schema))) {
      r.partialApplies += 1;
      Y.applyUpdate(probe, u);
      const reference = new Y.Doc();
      Y.applyUpdate(reference, probeState);
      Y.applyUpdate(reference, u);
      if (!contentsEqual(canonicalContent(probe, schema), canonicalContent(reference, schema))) {
        fail(
          "truncated update corrupted state beyond full-delivery recovery",
          contentDiff(canonicalContent(probe, schema), canonicalContent(reference, schema)),
        );
      }
    }
    if (rustErr === null || !jsRejected) {
      // ACCEPTANCE of truncated bytes: caveat in dev runs, promoted to a hard
      // failure under --strict (certification).
      r.caveats.push(
        `seed ${seed} ${mode}: truncated update (len ${cut}/${u.length}) accepted by ${rustErr === null ? "yrs" : ""}${rustErr === null && !jsRejected ? " and " : ""}${!jsRejected ? "yjs(probe)" : ""}`,
      );
    }
  };

  const flush = async (portion: number) => {
    const nRust = Math.ceil(toRust.length * portion);
    const nJs = Math.ceil(toJs.length * portion);
    for (const u of shuffle(toRust.splice(0, nRust))) {
      if (rand() < 0.1) await injectTruncated(u);
      await deliverToRust(u);
    }
    for (const u of shuffle(toJs.splice(0, nJs))) {
      if (rand() < 0.1) await injectTruncated(u);
      deliverToJs(u);
    }
  };

  const svSync = async () => {
    r.svSyncs += 1;
    // Rust -> JS: everything yrs knows that Yjs does not.
    const rustState = await rust.state(rustId);
    deliverToJs(await rust.diff(rustId, Y.encodeStateVector(jsDoc)));
    // JS -> Rust: everything Yjs knows that yrs does not.
    await deliverToRust(Y.encodeStateAsUpdate(jsDoc, rustState.sv));
  };

  for (let round = 0; round < ROUNDS; round += 1) {
    const edits = 1 + pick(2);
    for (let i = 0; i < edits; i += 1) {
      if (round % 2 === 0) jsEdit();
      else await rustEdit();
    }
    toRust.push(...captured.splice(0));
    if (rand() < 0.25) await svSync();
    else if (rand() < 0.7) await flush(rand());
  }
  toRust.push(...captured.splice(0));
  await flush(1);
  await svSync(); // guarantee both sides hold everything
  toRust.push(...captured.splice(0));
  await flush(1);

  // ---- convergence checks ----
  // The alternating-driver guarantee requires that Rust-side edits actually
  // landed; a run where every rust edit skipped would silently degrade to a
  // one-driver test.
  if (r.rustEdits === 0) {
    fail("rust edits", "no Rust-side edit landed in this run (all skipped)");
  }
  const jsContent = canonicalContent(jsDoc, schema);
  const rustContent = await rust.content(rustId, schema);
  for (const [side, content] of [["js", jsContent], ["rust", rustContent]] as const) {
    const extra = undeclaredRoots(content);
    if (extra.length > 0) fail("undeclared roots", `${side}: ${extra.join(", ")}`);
  }
  if (!contentsEqual(jsContent, rustContent)) {
    fail("converged content", contentDiff(jsContent, rustContent));
  }

  const rustState = await rust.state(rustId);
  const svOf = (sv: Uint8Array) => JSON.stringify([...Y.decodeStateVector(sv).entries()].sort((a, b) => a[0] - b[0]));
  if (svOf(rustState.sv) !== svOf(Y.encodeStateVector(jsDoc))) {
    fail("state vectors", `js=${svOf(Y.encodeStateVector(jsDoc))} rust=${svOf(rustState.sv)}`);
  }

  // Markdown projection of both converged states (projection runs on
  // throwaway docs: yDocToMarkdown can normalize schema-invalid content).
  const project = (state: Uint8Array) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, state);
    return yDocToMarkdown(d);
  };
  const jsState = Y.encodeStateAsUpdate(jsDoc);
  const jsMd = project(jsState);
  const rustMd = project(rustState.update);
  if (jsMd !== rustMd) {
    fail("markdown projection", `js=${JSON.stringify(jsMd.slice(0, 300))}\nrust=${JSON.stringify(rustMd.slice(0, 300))}`);
  }

  // Compaction analogs: yrs merge of the ENTIRE delivered update log, and
  // yrs's full-state re-encode, must both reconstruct the converged content.
  const fromMerged = new Y.Doc();
  Y.applyUpdate(fromMerged, await rust.merge(allUpdates));
  if (!contentsEqual(jsContent, canonicalContent(fromMerged, schema))) {
    fail("yrs merge_updates", contentDiff(jsContent, canonicalContent(fromMerged, schema)));
  }
  const fromReencode = new Y.Doc();
  Y.applyUpdate(fromReencode, rustState.update);
  if (!contentsEqual(jsContent, canonicalContent(fromReencode, schema))) {
    fail("yrs re-encode", contentDiff(jsContent, canonicalContent(fromReencode, schema)));
  }

  // Echo/idempotency: re-applying already-integrated updates changes nothing.
  for (let i = 0; i < 3 && allUpdates.length > 0; i += 1) {
    const u = allUpdates[pick(allUpdates.length)]!;
    Y.applyUpdate(jsDoc, u);
    const err = await rust.apply(rustId, u);
    if (err !== null) fail("re-apply", err);
  }
  if (!contentsEqual(jsContent, canonicalContent(jsDoc, schema))) {
    fail("idempotent re-apply (js)", contentDiff(jsContent, canonicalContent(jsDoc, schema)));
  }
  if (!contentsEqual(jsContent, await rust.content(rustId, schema))) {
    fail("idempotent re-apply (rust)", contentDiff(jsContent, await rust.content(rustId, schema)));
  }

  await rust.free(rustId);
  jsDoc.destroy();
  return r;
}

// ---- main --------------------------------------------------------------------

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
}
const seeds = argNum("seeds", 200);
const start = argNum("start", 1);
// Certification mode: fault-injection caveats (truncated-update acceptance)
// are promoted to hard failures instead of warnings.
const strict = args.includes("--strict");

const rust = new RustPeer();
const totals = { jsEdits: 0, rustEdits: 0, deliveries: 0, duplicates: 0, truncations: 0, partialApplies: 0, svSyncs: 0 };
const allFailures: string[] = [];
const allCaveats: string[] = [];
let passedSeeds = 0;

for (let seed = start; seed < start + seeds; seed += 1) {
  let seedFailures = 0;
  for (const mode of ["plaintext", "richdoc"] as const) {
    const r = await fuzzOne(rust, seed, mode);
    totals.jsEdits += r.jsEdits;
    totals.rustEdits += r.rustEdits;
    totals.deliveries += r.deliveries;
    totals.duplicates += r.duplicates;
    totals.truncations += r.truncations;
    totals.partialApplies += r.partialApplies;
    totals.svSyncs += r.svSyncs;
    allFailures.push(...r.failures);
    allCaveats.push(...r.caveats);
    seedFailures += r.failures.length;
    if (r.failures.length > 0) {
      console.error(`FAIL seed ${seed} (${mode}):`);
      for (const f of r.failures) console.error(`  ${f.split("\n").join("\n  ")}`);
    }
  }
  if (seedFailures === 0) passedSeeds += 1;
  if ((seed - start + 1) % 25 === 0) {
    console.log(`... ${seed - start + 1}/${seeds} seeds done (${passedSeeds} passed)`);
  }
}
rust.close();

console.log(`\nseeds: ${passedSeeds}/${seeds} passed (each seed = plaintext + richdoc run)`);
console.log(
  `totals: jsEdits=${totals.jsEdits} rustEdits=${totals.rustEdits} deliveries=${totals.deliveries} duplicates=${totals.duplicates} truncatedInjections=${totals.truncations} yjsPartialApplies=${totals.partialApplies} svSyncs=${totals.svSyncs}`,
);
if (allCaveats.length > 0) {
  if (strict) {
    console.error(`STRICT: ${allCaveats.length} fault-injection caveat(s) promoted to failures:`);
    for (const c of allCaveats) console.error(`  - ${c}`);
    allFailures.push(...allCaveats);
  } else {
    console.warn(`caveats (${allCaveats.length}) — these are FAILURES under --strict (certification):`);
    for (const c of allCaveats.slice(0, 20)) console.warn(`  - ${c}`);
  }
}
if (allFailures.length > 0) {
  console.error(`\n${allFailures.length} failure(s) across ${seeds} seeds`);
  process.exit(1);
}
