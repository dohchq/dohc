// Criterion 2 (+4) — seeded alternating-driver fuzz: a Yjs (JS) peer and a
// yrs (Rust) peer edit the SAME doc in alternating rounds; update delivery is
// randomly ordered, duplicated, and adversarially truncated; some rounds sync
// via state-vector diffs instead of raw update delivery. At the end both
// peers must converge to identical CONTENT (canonical doc JSON), identical
// semantic state vectors, and an identical markdown projection; a yrs
// merge_updates of the full update log and a yrs full-state re-encode
// (compaction/snapshot analogs) must reconstruct the same converged content.
//
// Deterministic: every random choice comes from one seeded PRNG, and both
// peers use fixed client ids derived from the seed — a failing seed replays
// exactly. This is the permanent R11 regression harness.
//
// Usage: pnpm --filter @dohc/yrs-spike-scripts fuzz [-- --seeds 200 --start 1]

import * as Y from "yjs";
import { markdownToYDoc, plainTextToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { canonicalContent, contentDiff, contentsEqual } from "./canonical.js";
import { DOHC_SCHEMA, RustPeer, type RootSchema } from "./rustPeer.js";

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
    svSyncs: 0,
  };
  const fail = (what: string, detail: string) => {
    r.failures.push(`seed ${seed} ${mode} / ${what}: ${detail}`);
  };

  const schema: RootSchema = DOHC_SCHEMA;
  const jsDoc =
    mode === "plaintext"
      ? plainTextToYDoc(`seed ${seed}\nbase line\n`)
      : markdownToYDoc(`# Seed ${seed}\n\nBase paragraph with **bold**.\n\n- item one\n- item two`);
  jsDoc.clientID = 1_000_000 + seed;
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

  const rustEdit = async () => {
    r.rustEdits += 1;
    let update: Uint8Array | null = null;
    try {
      if (mode === "plaintext") {
        update =
          rand() < 0.3
            ? await rust.textDelete(rustId, "plainText", pick(400), 1 + pick(4))
            : await rust.textInsert(rustId, "plainText", pick(400), `${word()} `);
      } else {
        const roll = rand();
        if (roll < 0.35) {
          update = await rust.xmlInsertParagraph(rustId, "body", pick(12), `${word()} ${word()}`);
        } else if (roll < 0.55) {
          update = await rust.xmlTextDelete(rustId, "body", pick(12), pick(30), 1 + pick(3));
        } else {
          update = await rust.xmlTextInsert(
            rustId,
            "body",
            pick(12),
            pick(30),
            ` ${word()}`,
            MARKS[pick(MARKS.length)],
          );
        }
      }
    } catch {
      // The chosen target was not editable (e.g. the paragraph index landed
      // on a non-element). Skip: the PRNG stream stays aligned either way.
      r.rustEdits -= 1;
      return;
    }
    if (update !== null && update.length > 0) toJs.push(update);
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
    let jsRejected = false;
    try {
      const probe = new Y.Doc(); // never corrupt the real doc with garbage
      Y.applyUpdate(probe, bad);
    } catch {
      jsRejected = true;
    }
    if (rustErr === null || !jsRejected) {
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
  const jsContent = canonicalContent(jsDoc, schema);
  const rustContent = await rust.content(rustId, schema);
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

const rust = new RustPeer();
const totals = { jsEdits: 0, rustEdits: 0, deliveries: 0, duplicates: 0, truncations: 0, svSyncs: 0 };
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
  `totals: jsEdits=${totals.jsEdits} rustEdits=${totals.rustEdits} deliveries=${totals.deliveries} duplicates=${totals.duplicates} truncatedInjections=${totals.truncations} svSyncs=${totals.svSyncs}`,
);
if (allCaveats.length > 0) {
  console.warn(`caveats (${allCaveats.length}):`);
  for (const c of allCaveats.slice(0, 20)) console.warn(`  - ${c}`);
}
if (allFailures.length > 0) {
  console.error(`\n${allFailures.length} failure(s) across ${seeds} seeds`);
  process.exit(1);
}
