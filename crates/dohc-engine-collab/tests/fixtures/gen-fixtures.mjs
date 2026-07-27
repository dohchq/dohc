// Cross-engine fixture generator for the R11a durable Y.Doc layer.
//
// Produces REAL yjs 13.6.30 update lineages + yjs-computed expectations that the
// Rust durable pipeline must converge on. This is the non-tautological
// cross-engine oracle (fixtures from real yjs, NOT Rust round-tripped) — the
// same pattern the yrs spike and R08 used. Regenerate with:
//
//   node crates/dohc-engine-collab/tests/fixtures/gen-fixtures.mjs
//   DOHC_FIXTURE_OUT=<directory> node crates/dohc-engine-collab/tests/fixtures/gen-fixtures.mjs
//
// yjs is resolved from the workspace node_modules (pnpm; version pinned by
// crates/yrs-spike/scripts/package.json → yjs 13.6.30, the audited interop
// pair). Fixtures are committed so the Rust test is self-contained.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const outputDir = process.env.DOHC_FIXTURE_OUT
  ? resolve(process.env.DOHC_FIXTURE_OUT)
  : here;
mkdirSync(outputDir, { recursive: true });
// yjs lives in the pnpm node_modules of the working checkout. When this runs
// from a git worktree (no node_modules of its own) fall back to the shared main
// checkout three levels up (`<main>/.claude/worktrees/<wt>/`), or an override.
const bases = [
  process.env.DOHC_YJS_BASE,
  repoRoot,
  join(repoRoot, "crates/yrs-spike/scripts"),
  join(repoRoot, "../../.."),
  join(repoRoot, "../../../crates/yrs-spike/scripts"),
].filter(Boolean);
const require = createRequire(join(repoRoot, "package.json"));
let yjsPath = null;
let yjsBase = null;
for (const base of bases) {
  try {
    yjsPath = require.resolve("yjs", { paths: [base] });
    yjsBase = base;
    break;
  } catch {
    /* try next base */
  }
}
if (!yjsPath) {
  throw new Error(
    `could not resolve yjs from any base:\n${bases.join("\n")}\nrun 'pnpm install --filter @dohc/yrs-spike-scripts...' or set DOHC_YJS_BASE`,
  );
}

const tsxBases = [
  repoRoot,
  join(repoRoot, "node_modules/.pnpm"),
  yjsBase,
].filter(Boolean);
let tsxApiPath = null;
for (const base of tsxBases) {
  try {
    tsxApiPath = require.resolve("tsx/esm/api", { paths: [base] });
    break;
  } catch {
    /* try next base */
  }
}
if (!tsxApiPath) {
  throw new Error(
    `could not resolve tsx/esm/api from any base:\n${tsxBases.join("\n")}\nrun 'pnpm install --offline --frozen-lockfile' before regenerating projection fixtures`,
  );
}
const { register } = await import(pathToFileURL(tsxApiPath).href);
const projectionUrl = pathToFileURL(
  join(repoRoot, "packages/ydoc-projection/src/index.ts"),
).href;
const unregisterTsx = register();
const {
  getDohcProseMirrorSchema,
  markdownToYDoc,
  yDocToMarkdown,
} = await import(projectionUrl);
const Y = await import(pathToFileURL(join(dirname(yjsPath), "yjs.mjs")).href);
await unregisterTsx();

const b64 = (u8) => Buffer.from(u8).toString("base64");

// Deterministic PRNG (mulberry32) so regeneration is byte-stable per seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A pool of strings spanning ASCII, CJK, emoji (surrogate pairs), RTL, combining.
const POOL = [
  "hello ",
  "world",
  "café",
  "日本語",
  "😀🎉",
  "مرحبا",
  "á", // combining acute
  "\ttab",
  "line\ncont",
  "Zürich",
  "naïve",
  "𝔘𝔫𝔦",
];

// Capture one incremental update per transaction (mirrors one durable append).
function capture(doc, edit) {
  const before = Y.encodeStateVector(doc);
  edit();
  return b64(Y.encodeStateAsUpdate(doc, before));
}

// Valid UTF-16 code-point boundary offsets of a string (0, then after each code
// point). A real editor NEVER edits inside a surrogate pair; splitting one
// creates a lone surrogate yjs keeps but Rust cannot represent (binding
// constraint 3), which the surrogateProbe fixture demonstrates separately. The
// main corpus stays well-formed so cross-engine convergence is exact.
function boundaries(str) {
  const out = [0];
  let u = 0;
  for (const cp of str) {
    u += cp.length; // 1 or 2 UTF-16 units
    out.push(u);
  }
  return out;
}

function makePlaintext(seed) {
  const r = rng(seed);
  const doc = new Y.Doc();
  const text = doc.getText("plainText");
  const updates = [];
  const ops = 4 + Math.floor(r() * 10);
  for (let i = 0; i < ops; i++) {
    const cur = text.toString();
    const bounds = boundaries(cur); // valid code-point boundary offsets
    if (bounds.length > 4 && r() < 0.3) {
      // Delete a whole number of code points between two boundaries.
      const bi = Math.floor(r() * (bounds.length - 2));
      const at = bounds[bi];
      const bj = bi + 1 + Math.floor(r() * Math.min(3, bounds.length - 1 - bi - 1));
      const del = bounds[bj] - at;
      updates.push(capture(doc, () => text.delete(at, del)));
    } else {
      const at = bounds[Math.floor(r() * bounds.length)];
      const s = POOL[Math.floor(r() * POOL.length)];
      updates.push(capture(doc, () => text.insert(at, s)));
    }
  }
  return {
    seed,
    contentKind: "plaintext",
    updates,
    mergedUpdateB64: b64(Y.mergeUpdates(updates.map((u) => Buffer.from(u, "base64")))),
    stateVectorB64: b64(Y.encodeStateVector(doc)),
    expected: { text: text.toString() },
  };
}

function paragraphRuns(xmlText) {
  return xmlText.toDelta().map((op) => ({
    text: typeof op.insert === "string" ? op.insert : "",
    bold: !!(op.attributes && (op.attributes.bold || op.attributes.strong)),
    italic: !!(op.attributes && (op.attributes.italic || op.attributes.em)),
  }));
}

function makeRichdoc(seed) {
  const r = rng(seed);
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("body");
  const fm = doc.getMap("frontmatter");
  const updates = [];

  // Frontmatter: simple scalars whose YAML spelling is shared by both engines.
  // Rich formatting fidelity is tested independently of the already-pinned
  // sorted-frontmatter projection.
  updates.push(capture(doc, () => fm.set("alpha", `value-${seed}`)));
  updates.push(capture(doc, () => fm.set("count", Math.floor(r() * 100))));

  const paras = 2 + Math.floor(r() * 4);
  for (let p = 0; p < paras; p++) {
    updates.push(
      capture(doc, () => {
        const el = new Y.XmlElement("paragraph");
        const t = new Y.XmlText();
        const s = POOL[Math.floor(r() * POOL.length)] + POOL[Math.floor(r() * POOL.length)];
        const attrs = {};
        if (r() < 0.4) attrs.bold = true;
        if (r() < 0.4) attrs.italic = true;
        t.insert(0, s, Object.keys(attrs).length ? attrs : undefined);
        el.insert(0, [t]);
        frag.insert(frag.length, [el]);
      }),
    );
  }
  // A follow-up formatted insert into the first paragraph, if any.
  if (frag.length > 0) {
    updates.push(
      capture(doc, () => {
        const el = frag.get(0);
        const t = el.get(0);
        t.insert(0, "X", { bold: true });
      }),
    );
  }

  const paragraphs = [];
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i);
    const t = el.get(0);
    paragraphs.push({ runs: paragraphRuns(t) });
  }
  const frontmatter = {};
  for (const [k, v] of fm.entries()) frontmatter[k] = v;

  return {
    seed,
    contentKind: "richdoc",
    updates,
    mergedUpdateB64: b64(Y.mergeUpdates(updates.map((u) => Buffer.from(u, "base64")))),
    stateVectorB64: b64(Y.encodeStateVector(doc)),
    expected: {
      frontmatter,
      paragraphs,
      markdown: yDocToMarkdown(doc),
    },
  };
}

function xmlText(value, marks) {
  const text = new Y.XmlText();
  if (value.length > 0) text.insert(0, value, marks);
  return text;
}

function xmlRuns(runs) {
  const text = new Y.XmlText();
  let offset = 0;
  for (const [value, marks] of runs) {
    if (value.length > 0) {
      text.insert(offset, value, marks ?? {});
      offset += value.length;
    }
  }
  return text;
}

function xmlElement(name, attrs = {}, children = []) {
  const element = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  if (children.length > 0) element.insert(0, children);
  return element;
}

function paragraph(children) {
  return xmlElement(
    "paragraph",
    {},
    typeof children === "string" ? [xmlText(children)] : children,
  );
}

function tableCell(name, text, attrs = {}) {
  return xmlElement(
    name,
    { colspan: 1, rowspan: 1, ...attrs },
    [paragraph(text)],
  );
}

function tableRow(cells) {
  return xmlElement("tableRow", {}, cells);
}

function table(rows) {
  return xmlElement("table", {}, rows);
}

function directRichdoc(blocks, frontmatter = {}) {
  const doc = new Y.Doc();
  if (blocks.length > 0) doc.getXmlFragment("body").insert(0, blocks);
  for (const [key, value] of Object.entries(frontmatter)) {
    doc.getMap("frontmatter").set(key, value);
  }
  return doc;
}

const linkAttrs = (href, title = null) => ({
  href,
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
  title,
});

const RICHDOC_PROJECTION_CASES = [
  {
    name: "headings-marks",
    markdown: [
      "# **bold** *italic* ~~strike~~ `inline` ++underline++ ==highlight==",
      "",
      "## [linked **heading**](https://example.com/docs \"Docs\")",
      "",
      "### level three",
      "",
      "#### level four",
      "",
      "##### level five",
      "",
      "###### level six",
      "",
      "Combined **bold and *italic* and ~~strike~~**.",
    ].join("\n"),
  },
  {
    name: "blocks",
    markdown: [
      "paragraph with <tag> & entity  ",
      "hard break",
      "",
      "---",
      "",
      "> first paragraph with **bold**",
      ">",
      "> second paragraph",
      "> with another line",
      "",
      "> outer",
      "> > nested quote",
    ].join("\n"),
  },
  {
    name: "nested-lists",
    markdown: [
      "- first",
      "  - nested [link](notes/item)",
      "    3. deep ordered",
      "    4. next deep",
      "  - nested sibling",
      "- second",
      "",
      "3. ordered start",
      "4. ordered next",
      "   - bullet inside ordered",
      "",
      "- loose item",
      "",
      "  second paragraph in item",
    ].join("\n"),
  },
  {
    name: "task-lists",
    markdown: [
      "- [ ] open **task**",
      "- [x] completed task",
    ].join("\n"),
  },
  {
    name: "code-blocks",
    markdown: [
      "```ts",
      "const x = 1 < 2 && 3 > 2",
      "```",
      "",
      "```",
      "no language here",
      "```",
      "",
      "```rust",
      "",
      "```",
    ].join("\n"),
  },
  {
    name: "inline-atoms",
    markdown: [
      "A \\* literal, [[notes/plan|Plan]], {{atom:chart range=today}}, and $x^2 + y^2$.",
      "",
      "![alt \\[text\\]](<assets/my image.png> \"image title\")",
      "",
      "![remote](https://example.com/a(b).png)",
    ].join("\n"),
  },
  {
    name: "callouts",
    markdown: [
      "> [!info]+ Blocks inside",
      "> First **paragraph**.",
      ">",
      "> Second paragraph.",
      ">",
      "> - first",
      "> - second with [link](target)",
      ">",
      "> ```ts",
      "> const x = 1",
      "> ```",
      "",
      "> [!custom-thing]- Custom title",
      "> custom body",
    ].join("\n"),
  },
  {
    name: "tables",
    markdown: [
      "| Left | Center | Right | Default |",
      "| :--- | :---: | ---: | --- |",
      "| **bold** | 😀 | 123 | plain |",
      "| a | longer | z | last |",
    ].join("\n"),
  },
  {
    name: "math-blocks",
    markdown: [
      "$$E = mc^2$$",
      "",
      "$$",
      "\\sum_{i=0}^n i = \\frac{n(n+1)}{2}",
      "E = mc^2",
      "$$",
      "",
      "$$$$",
    ].join("\n"),
  },
  {
    name: "table-literal-pipe",
    makeDoc: () =>
      directRichdoc([
        table([
          tableRow([
            tableCell("tableHeader", "Value"),
            tableCell("tableHeader", "Other"),
          ]),
          tableRow([
            tableCell("tableCell", "left | right"),
            tableCell("tableCell", "stable"),
          ]),
        ]),
      ]),
  },
  {
    name: "code-fence-collision",
    makeDoc: () =>
      directRichdoc([
        xmlElement(
          "codeBlock",
          { language: "js" },
          [xmlText("before\n```\nafter")],
        ),
      ]),
  },
  {
    name: "inline-code-backticks",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlRuns([
            ["a`b", { code: {} }],
            [" / "],
            ["`edge`", { code: {} }],
            [" / "],
            [" spaced ", { code: {} }],
            [" / "],
            ["   ", { code: {} }],
          ]),
        ]),
      ]),
  },
  {
    name: "headerless-table",
    makeDoc: () =>
      directRichdoc([
        table([
          tableRow([
            tableCell("tableCell", "first"),
            tableCell("tableCell", "row"),
          ]),
          tableRow([
            tableCell("tableCell", "second"),
            tableCell("tableCell", "row"),
          ]),
        ]),
      ]),
  },
  {
    name: "nested-marks-before-inline-nodes",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlText("linked hard break", {
            link: linkAttrs("https://example.com/hard-break"),
            bold: {},
          }),
          xmlElement("hardBreak"),
          xmlText("after break"),
        ]),
        paragraph([
          xmlText("linked image", {
            link: linkAttrs("https://example.com/image"),
            bold: {},
          }),
          xmlElement("image", {
            src: "assets/picture.png",
            alt: "picture",
            title: null,
          }),
        ]),
      ]),
  },
  {
    name: "frontmatter-table-first",
    makeDoc: () =>
      directRichdoc(
        [
          table([
            tableRow([
              tableCell("tableHeader", "First"),
              tableCell("tableHeader", "Table"),
            ]),
            tableRow([
              tableCell("tableCell", "body"),
              tableCell("tableCell", "row"),
            ]),
          ]),
        ],
        { title: "Table first" },
      ),
  },
  {
    name: "link-delimiters",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlRuns([
            [
              "label ] bracket",
              { link: linkAttrs("https://example.com/a)b") },
            ],
            [" / "],
            ["space href", { link: linkAttrs("docs/my page") }],
            [" / "],
            [
              "quoted title",
              { link: linkAttrs("docs/page", 'say "hello"') },
            ],
          ]),
        ]),
      ]),
  },
  {
    name: "image-alt-delimiter",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlElement("image", {
            src: "assets/image.png",
            alt: "left ] right",
            title: null,
          }),
        ]),
      ]),
  },
  {
    name: "wikilink-delimiters",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlElement("wikilink", {
            target: "folder|name]]tail",
            label: "label|with]]closer",
          }),
        ]),
      ]),
  },
  {
    name: "heading-leading-hash",
    makeDoc: () =>
      directRichdoc([
        xmlElement("heading", { level: 2 }, [xmlText("# starts with hash")]),
      ]),
  },
  {
    name: "paragraph-block-prefixes",
    makeDoc: () =>
      directRichdoc([
        paragraph("> not a quote"),
        paragraph("- not a list"),
        paragraph("1. not an ordered list"),
      ]),
  },
  {
    name: "plain-text-mark-delimiters",
    makeDoc: () =>
      directRichdoc([
        paragraph("*stars* _underscores_ ~~tildes~~"),
      ]),
  },
  {
    name: "marked-text-delimiters",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlRuns([
            ["bold ** delimiter", { bold: {} }],
            [" / "],
            ["italic * delimiter", { italic: {} }],
            [" / "],
            ["strike ~~ delimiter", { strike: {} }],
            [" / "],
            ["underline ++ delimiter", { underline: {} }],
            [" / "],
            ["highlight == delimiter", { highlight: {} }],
          ]),
        ]),
      ]),
  },
  {
    name: "math-dollar-delimiters",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlText("inline "),
          xmlElement("mathInline", { tex: "price $5" }),
        ]),
        xmlElement("mathBlock", { tex: "left $$ right" }),
      ]),
  },
  {
    name: "callout-title-delimiter",
    makeDoc: () =>
      directRichdoc([
        xmlElement(
          "callout",
          { calloutType: "note", fold: "", title: "title ] bracket" },
          [paragraph("body")],
        ),
      ]),
  },
  {
    name: "atom-and-callout-openers",
    makeDoc: () =>
      directRichdoc([
        paragraph([
          xmlElement("inlineAtom", {
            atomId: "chart",
            params: "",
            source: "atom:chart value=left}}right",
          }),
        ]),
        xmlElement(
          "callout",
          { calloutType: "note]spoof", fold: "", title: "title" },
          [paragraph("body")],
        ),
      ]),
  },
  {
    name: "code-language-backtick",
    makeDoc: () =>
      directRichdoc([
        xmlElement("codeBlock", { language: "lang`tick" }, [xmlText("code")]),
      ]),
  },
  {
    name: "multi-block-table-cell-separator",
    makeDoc: () =>
      directRichdoc([
        table([
          tableRow([
            tableCell("tableHeader", "H"),
          ]),
          tableRow([
            xmlElement(
              "tableCell",
              { colspan: 1, rowspan: 1 },
              [paragraph("first"), paragraph("second")],
            ),
          ]),
        ]),
      ]),
  },
];

function makeRichdocProjection(index, fixture) {
  const doc = fixture.makeDoc ? fixture.makeDoc() : markdownToYDoc(fixture.markdown);
  const base = b64(Y.encodeStateAsUpdate(doc));
  const followup = capture(doc, () => {
    doc.getMap("meta").set("projectionFixture", fixture.name);
  });
  const updates = [base, followup];
  return {
    seed: -100 - index,
    contentKind: "richdoc",
    kind: `richdocProjection-${fixture.name}`,
    updates,
    mergedUpdateB64: b64(
      Y.mergeUpdates(updates.map((update) => Buffer.from(update, "base64"))),
    ),
    stateVectorB64: b64(Y.encodeStateVector(doc)),
    coverage: richdocCoverage(doc),
    expected: { markdown: yDocToMarkdown(doc) },
  };
}

function richdocCoverage(doc) {
  const nodes = new Set(["doc"]);
  const marks = new Set();
  const visit = (node) => {
    if (typeof node.toDelta === "function") {
      nodes.add("text");
      for (const op of node.toDelta()) {
        for (const mark of Object.keys(op.attributes ?? {})) marks.add(mark);
      }
      return;
    }
    if (typeof node.nodeName === "string") nodes.add(node.nodeName);
    for (const child of node.toArray()) visit(child);
  };
  visit(doc.getXmlFragment("body"));
  return {
    nodes: [...nodes].sort(),
    marks: [...marks].sort(),
  };
}

// The OffsetKind::Utf16 probe: a leading emoji makes byte and UTF-16 offsets of
// a later boundary DIFFER without any mid-char panic. yjs measures in UTF-16, so
// inserting at index 4 in "😀XYZ" lands before "Z". A Utf16 yrs doc must agree; a
// Bytes yrs doc (index 4 = byte 4 = before "X") diverges.
function makeOffsetProbe() {
  const doc = new Y.Doc();
  const text = doc.getText("plainText");
  const base = capture(doc, () => text.insert(0, "😀XYZ"));
  const insertUpdate = capture(doc, () => text.insert(4, "!"));
  return {
    seed: -1,
    contentKind: "plaintext",
    kind: "offsetProbe",
    baseUpdateB64: base,
    updates: [base, insertUpdate],
    // The Rust test applies `baseUpdateB64` to a Utf16 doc and a Bytes doc, then
    // does a LOCAL insert of "!" at UTF-16 index 4 on each; Utf16 must equal
    // this yjs expectation, Bytes must not.
    expected: { textAfterInsertAt4: text.toString(), insertChar: "!", insertIndex: 4 },
  };
}

// Surrogate-split probe (binding constraint 3): inserting "X" at UTF-16 index 1
// splits the emoji's surrogate pair. yjs keeps the lone surrogates (its string
// stays ill-formed UTF-16); Rust strings CANNOT hold a lone surrogate, so yrs
// diverges. The R11b live adapter must validate isWellFormed() and reject/
// sanitize such an edit BEFORE journaling — this fixture pins that the boundary
// check is load-bearing (Rust must diverge from yjs here).
function makeSurrogateProbe() {
  const doc = new Y.Doc();
  const text = doc.getText("plainText");
  const base = capture(doc, () => text.insert(0, "😀")); // one astral char (2 UTF-16 units)
  const split = capture(doc, () => text.insert(1, "X")); // splits the surrogate pair
  const yjsStr = text.toString();
  return {
    seed: -3,
    contentKind: "plaintext",
    kind: "surrogateProbe",
    updates: [base, split],
    // yjs keeps a lone surrogate here; the Rust replay cannot match it.
    expected: { yjsText: yjsText(yjsStr), wellFormed: isWellFormedUtf16(yjsStr) },
  };
}

// Encode the possibly-ill-formed yjs string as an array of UTF-16 code units so
// the JSON fixture round-trips faithfully (JSON cannot carry a lone surrogate).
function yjsText(str) {
  const units = [];
  for (let i = 0; i < str.length; i++) units.push(str.charCodeAt(i));
  return units;
}
function isWellFormedUtf16(str) {
  return typeof str.isWellFormed === "function"
    ? str.isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);
}

// Nested-frontmatter probe (binding constraint 2): yjs preserves object key
// insertion order; yrs stores Any::Map as a HashMap and re-encodes in random
// order. The Rust projection/canonical MUST sort nested keys, so the fixture's
// expectation is the SORTED nested object.
function makeNestedFrontmatter() {
  const doc = new Y.Doc();
  const fm = doc.getMap("frontmatter");
  const updates = [];
  updates.push(capture(doc, () => fm.set("zeta", "z")));
  updates.push(
    capture(doc, () => fm.set("meta", { gamma: "g", alpha: "a", beta: "b", delta: "d" })),
  );
  const frontmatter = {};
  for (const [k, v] of fm.entries()) frontmatter[k] = v;
  return {
    seed: -2,
    contentKind: "richdoc",
    kind: "nestedFrontmatter",
    updates,
    mergedUpdateB64: b64(Y.mergeUpdates(updates.map((u) => Buffer.from(u, "base64")))),
    expected: { frontmatter },
  };
}

// Clear old generated fixtures in the selected output directory only.
for (const f of readdirSync(outputDir)) {
  if (f.endsWith(".json")) unlinkSync(join(outputDir, f));
}

const manifest = [];
function emit(fx) {
  const name = fx.kind
    ? `${fx.kind}.json`
    : `${fx.contentKind}-${String(fx.seed).padStart(3, "0")}.json`;
  writeFileSync(join(outputDir, name), JSON.stringify(fx, null, 1));
  manifest.push(name);
}

const SEEDS = 24;
for (let s = 1; s <= SEEDS; s++) emit(makePlaintext(s));
for (let s = 1; s <= SEEDS; s++) emit(makeRichdoc(1000 + s));
const allowedOracleFailures = new Set(
  (process.env.DOHC_FIXTURE_ALLOW_ORACLE_FAILURES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const projectionFixtures = RICHDOC_PROJECTION_CASES.map((fixture, index) => {
  try {
    return makeRichdocProjection(index, fixture);
  } catch (error) {
    // The drift checker sets this to the cases the LIVE oracle can no longer
    // produce, so one broken construct cannot blind the check for every other
    // fixture. Regenerating normally still fails loudly on the same case.
    if (allowedOracleFailures.has(fixture.name)) {
      console.error(`ORACLE_FAILURE ${fixture.name}: ${error?.cause?.message ?? error?.message}`);
      return null;
    }
    throw new Error(
      `failed to generate richdocProjection-${fixture.name}.json`,
      { cause: error },
    );
  }
});
const emittedProjectionFixtures = projectionFixtures.filter(Boolean);
const coveredNodes = new Set(
  emittedProjectionFixtures.flatMap((fixture) => fixture.coverage.nodes),
);
const coveredMarks = new Set(
  emittedProjectionFixtures.flatMap((fixture) => fixture.coverage.marks),
);
const schema = getDohcProseMirrorSchema();
const missingNodes = Object.keys(schema.nodes).filter(
  (node) => !coveredNodes.has(node),
);
const missingMarks = Object.keys(schema.marks).filter(
  (mark) => !coveredMarks.has(mark),
);
if (missingNodes.length > 0 || missingMarks.length > 0) {
  throw new Error(
    `richdoc projection fixtures do not cover the TS schema:\nmissing nodes: ${missingNodes.join(", ") || "(none)"}\nmissing marks: ${missingMarks.join(", ") || "(none)"}`,
  );
}
emittedProjectionFixtures.forEach(emit);
emit(makeOffsetProbe());
emit(makeSurrogateProbe());
emit(makeNestedFrontmatter());

writeFileSync(
  join(outputDir, "_manifest.json"),
  JSON.stringify({ fixtures: manifest }, null, 1),
);
console.log(
  `generated ${manifest.length} fixtures (${SEEDS} plaintext + ${SEEDS} random richdoc + ${emittedProjectionFixtures.length} richdoc projection + 3 probes)`,
);
