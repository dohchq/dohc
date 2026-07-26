// TypeScript oracle for the engine yjs↔yrs replay-parity gate.
//
// The committed fixtures contain real yjs v1 updates. The committed goldens
// contain the resulting yjs document content after those updates are delivered
// in each scenario's explicit replay order. Rust replays the same bytes through
// the daemon-owned Y.Doc path in
// crates/dohc-workspace-engine/tests/ydoc_replay_parity.rs.
//
// Regenerate both committed artifacts with:
//   DOHC_EMIT_YDOC_REPLAY_GOLDENS=1 pnpm --filter @dohc/desktop exec vitest run \
//     src/collab/ydocReplayParityGoldens.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

interface AuthoredUpdate {
  id: string;
  author: string;
  updateBase64: string;
}

interface ReplayScenario {
  name: string;
  contentKind: "plaintext" | "richdoc";
  dimensions: string[];
  authoredUpdates: AuthoredUpdate[];
  replayOrder: string[];
}

interface FixtureCorpus {
  _readme: string;
  schema: Record<string, "map" | "text" | "xmlFragment">;
  scenarios: ReplayScenario[];
}

interface GoldenCorpus {
  _readme: string;
  normalization: string[];
  scenarios: Record<string, Json>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(
  HERE,
  "../../../../tools/rust-engine-program/ydoc-replay-fixtures.json",
);
const GOLDENS_PATH = join(
  HERE,
  "../../../../tools/rust-engine-program/ydoc-replay-goldens.json",
);

const SCHEMA = {
  frontmatter: "map",
  meta: "map",
  body: "xmlFragment",
  plainText: "text",
} as const;

function deterministicDoc(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  // Yjs exposes clientID specifically as the struct id namespace. Assigning it
  // before the first transaction makes the committed update bytes reproducible.
  doc.clientID = clientID;
  return doc;
}

function capture(
  doc: Y.Doc,
  id: string,
  author: string,
  edit: () => void,
): AuthoredUpdate {
  const before = Y.encodeStateVector(doc);
  doc.transact(edit, `replay-parity:${author}:${id}`);
  return {
    id,
    author,
    updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString(
      "base64",
    ),
  };
}

function xmlText(
  runs: Array<[string, Record<string, unknown>?]>,
): Y.XmlText {
  const text = new Y.XmlText();
  let offset = 0;
  for (const [value, marks] of runs) {
    text.insert(offset, value, marks);
    offset += value.length;
  }
  return text;
}

function xmlElement(
  name: string,
  attrs: Record<string, unknown> = {},
  children: Array<Y.XmlElement | Y.XmlText> = [],
): Y.XmlElement {
  const element = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    // y-prosemirror uses JSON attrs despite Yjs' string-only declaration.
    element.setAttribute(key, value as string);
  }
  if (children.length > 0) {
    element.insert(0, children);
  }
  return element;
}

function paragraph(
  value: string | Array<Y.XmlElement | Y.XmlText>,
): Y.XmlElement {
  return xmlElement(
    "paragraph",
    {},
    typeof value === "string" ? [xmlText([[value]])] : value,
  );
}

function listItem(text: string): Y.XmlElement {
  return xmlElement("listItem", {}, [paragraph(text)]);
}

function tableCell(name: "tableHeader" | "tableCell", text: string) {
  return xmlElement(
    name,
    { colspan: 1, rowspan: 1, colwidth: null },
    [paragraph(text)],
  );
}

function plaintextEditing(): ReplayScenario {
  const doc = deterministicDoc(101);
  const text = doc.getText("plainText");
  const authoredUpdates = [
    capture(doc, "plain-1", "solo", () =>
      text.insert(0, "alpha\nbeta\ngamma"),
    ),
    capture(doc, "plain-2", "solo", () =>
      text.insert(5, " inserted"),
    ),
    capture(doc, "plain-3", "solo", () => text.delete(0, 2)),
    capture(doc, "plain-4", "solo", () =>
      text.insert(text.length, "\nfinal"),
    ),
  ];
  return {
    name: "plain-text-inserts-deletes-reversed",
    contentKind: "plaintext",
    dimensions: [
      "plain text",
      "inserts",
      "deletes",
      "dependent updates delivered in reverse authored order",
    ],
    authoredUpdates,
    replayOrder: authoredUpdates.map(({ id }) => id).reverse(),
  };
}

function concurrentPlaintext(): ReplayScenario {
  const base = deterministicDoc(201);
  const baseText = base.getText("plainText");
  const baseUpdate = capture(base, "concurrent-base", "base", () =>
    baseText.insert(0, "shared document"),
  );

  const peerA = deterministicDoc(202);
  const peerB = deterministicDoc(203);
  const baseBytes = Buffer.from(baseUpdate.updateBase64, "base64");
  Y.applyUpdate(peerA, baseBytes);
  Y.applyUpdate(peerB, baseBytes);
  const aText = peerA.getText("plainText");
  const bText = peerB.getText("plainText");
  const a1 = capture(peerA, "concurrent-a1", "peer-a", () =>
    aText.insert(7, "A😀 "),
  );
  const a2 = capture(peerA, "concurrent-a2", "peer-a", () =>
    aText.delete(0, 1),
  );
  const b1 = capture(peerB, "concurrent-b1", "peer-b", () =>
    bText.insert(7, "B́ "),
  );
  const b2 = capture(peerB, "concurrent-b2", "peer-b", () =>
    bText.insert(bText.length, " / peer B"),
  );

  return {
    name: "concurrent-peers-causally-scrambled",
    contentKind: "plaintext",
    dimensions: [
      "concurrent edits",
      "common base",
      "two clients",
      "causal dependencies delivered before their prerequisites",
      "out-of-order convergence",
    ],
    authoredUpdates: [baseUpdate, a1, a2, b1, b2],
    replayOrder: [b2.id, a2.id, baseUpdate.id, b1.id, a1.id],
  };
}

function unicodePlaintext(): ReplayScenario {
  const doc = deterministicDoc(301);
  const text = doc.getText("plainText");
  const authoredUpdates = [
    capture(doc, "unicode-1", "unicode-author", () =>
      text.insert(
        0,
        "astral 😀 𝔘 | combining e\u0301 a\u0308 | 日本語 | مرحبا | 👩‍👩‍👧‍👦",
      ),
    ),
    capture(doc, "unicode-2", "unicode-author", () =>
      text.insert(9, "🎯"),
    ),
    // Delete the complete U+1D518 scalar (two UTF-16 units), never an interior
    // surrogate boundary; the live adapter rejects such ill-formed edits.
    capture(doc, "unicode-3", "unicode-author", () => {
      const start = text.toString().indexOf("𝔘");
      text.delete(start, "𝔘".length);
    }),
    capture(doc, "unicode-4", "unicode-author", () =>
      text.insert(text.length, "\nZ͑a͒l̓g̾ō"),
    ),
  ];
  return {
    name: "unicode-astral-combining-and-multiscript",
    contentKind: "plaintext",
    dimensions: [
      "unicode",
      "astral-plane scalars",
      "combining characters",
      "ZWJ emoji",
      "CJK",
      "RTL",
      "UTF-16 boundary delete",
    ],
    authoredUpdates,
    replayOrder: ["unicode-4", "unicode-2", "unicode-1", "unicode-3"],
  };
}

function richdocStructureAndMarks(): ReplayScenario {
  const doc = deterministicDoc(401);
  const body = doc.getXmlFragment("body");
  const frontmatter = doc.getMap("frontmatter");
  const meta = doc.getMap("meta");

  const base = capture(doc, "rich-1", "rich-author", () => {
    frontmatter.set("title", "Replay parity");
    frontmatter.set("nested", {
      zeta: "last",
      alpha: "first",
      flags: [true, false],
    });
    meta.set("schemaVersion", 1);
    meta.set("htmlAtom", {
      mode: "separate",
      sanitized: true,
    });

    const markedParagraph = paragraph([
      xmlText([
        ["plain "],
        ["bold", { bold: {} }],
        [" italic", { italic: {} }],
        [" strike", { strike: {} }],
        [" underline", { underline: {} }],
        [" highlight", { highlight: {} }],
        [" code", { code: {} }],
        [
          " linked",
          {
            link: {
              href: "https://example.com/路径?q=值",
              title: "Docs",
              target: "_blank",
              rel: "noopener noreferrer nofollow",
              class: null,
            },
          },
        ],
      ]),
      xmlElement("hardBreak"),
      xmlElement("image", {
        src: "assets/picture.png",
        alt: "picture ] alt",
        title: "A title",
      }),
      xmlElement("escapedPunctuation", { value: "*" }),
      xmlElement("wikilink", {
        target: "Projects/dohc#Gate",
        label: "Gate plan",
      }),
      xmlElement("inlineAtom", {
        atomId: "chart",
        params: "range=today",
        source: "atom:chart range=today",
      }),
      xmlElement("mathInline", { tex: "x^2 + y^2" }),
    ]);

    const blocks = [
      xmlElement("heading", { level: 2 }, [
        xmlText([["Structural replay"]]),
      ]),
      markedParagraph,
      xmlElement("blockquote", {}, [paragraph("quoted paragraph")]),
      xmlElement("bulletList", {}, [
        listItem("bullet one"),
        listItem("bullet two"),
      ]),
      xmlElement("orderedList", { start: 3 }, [
        listItem("ordered three"),
        listItem("ordered four"),
      ]),
      xmlElement("taskList", {}, [
        xmlElement("taskItem", { checked: false }, [
          paragraph("open task"),
        ]),
        xmlElement("taskItem", { checked: true }, [
          paragraph("completed task"),
        ]),
      ]),
      xmlElement("codeBlock", { language: "ts" }, [
        xmlText([["const answer = 42;\nconsole.log(answer);"]]),
      ]),
      xmlElement("horizontalRule"),
      xmlElement("table", {}, [
        xmlElement("tableRow", {}, [
          tableCell("tableHeader", "Name"),
          tableCell("tableHeader", "Value"),
        ]),
        xmlElement("tableRow", {}, [
          tableCell("tableCell", "emoji"),
          tableCell("tableCell", "😀"),
        ]),
      ]),
      xmlElement(
        "callout",
        { calloutType: "info", fold: "+", title: "Details" },
        [paragraph("callout body")],
      ),
      xmlElement("mathBlock", { tex: "\\sum_{i=0}^n i" }),
    ];
    body.insert(0, blocks);
  });

  const formatEdit = capture(doc, "rich-2", "rich-author", () => {
    const heading = body.get(0) as Y.XmlElement;
    heading.setAttribute("level", 3 as unknown as string);
    const marked = body.get(1) as Y.XmlElement;
    const firstText = marked.get(0) as Y.XmlText;
    firstText.insert(0, "edited ", { bold: {}, italic: {} });
    frontmatter.set("updated", true);
  });

  const structuralEdit = capture(doc, "rich-3", "rich-author", () => {
    // Remove the horizontal rule and append a new block. This update is
    // delivered before the base so both its delete set and insertion park.
    body.delete(7, 1);
    body.insert(body.length, [
      paragraph("tail with astral 😀 and combining e\u0301"),
    ]);
  });

  return {
    name: "richdoc-full-structure-marks-and-delete",
    contentKind: "richdoc",
    dimensions: [
      "richdoc XML structure",
      "frontmatter and meta maps",
      "all richdoc projection block/inline constructs",
      "bold italic strike underline highlight code and link marks",
      "element attributes",
      "structural delete",
      "dependent updates delivered before base",
    ],
    authoredUpdates: [base, formatEdit, structuralEdit],
    replayOrder: [structuralEdit.id, base.id, formatEdit.id],
  };
}

function largeRichdoc(): ReplayScenario {
  const doc = deterministicDoc(501);
  const body = doc.getXmlFragment("body");
  const base = capture(doc, "large-1", "large-author", () => {
    const blocks = Array.from({ length: 96 }, (_, index) =>
      paragraph(
        `section ${index.toString().padStart(3, "0")} — ` +
          `${"0123456789abcdef".repeat(12)} — 😀 e\u0301 日本語`,
      ),
    );
    body.insert(0, blocks);
  });
  const edit = capture(doc, "large-2", "large-author", () => {
    const middle = body.get(48) as Y.XmlElement;
    const text = middle.get(0) as Y.XmlText;
    text.insert(0, "MIDDLE EDIT: ", { bold: {} });
    body.delete(16, 8);
    body.insert(16, [paragraph("replacement block after bulk delete")]);
  });
  return {
    name: "large-richdoc-bulk-and-followup",
    contentKind: "richdoc",
    dimensions: [
      "large-ish document",
      "96 XML blocks",
      "roughly 20 KiB visible text",
      "bulk structural delete",
      "formatted follow-up delivered before base",
    ],
    authoredUpdates: [base, edit],
    replayOrder: [edit.id, base.id],
  };
}

function replay(scenario: ReplayScenario, order: string[]): Y.Doc {
  const byId = new Map(
    scenario.authoredUpdates.map((update) => [update.id, update]),
  );
  expect(new Set(order).size, `${scenario.name}: replay ids unique`).toBe(
    scenario.authoredUpdates.length,
  );
  const doc = deterministicDoc(900_000);
  for (const id of order) {
    const update = byId.get(id);
    expect(update, `${scenario.name}: replay update ${id} exists`).toBeDefined();
    Y.applyUpdate(doc, Buffer.from(update!.updateBase64, "base64"));
  }
  return doc;
}

function buildCorpus(): {
  fixtures: FixtureCorpus;
  goldens: GoldenCorpus;
} {
  const scenarios = [
    plaintextEditing(),
    concurrentPlaintext(),
    unicodePlaintext(),
    richdocStructureAndMarks(),
    largeRichdoc(),
  ];
  const goldenScenarios: Record<string, Json> = {};
  for (const scenario of scenarios) {
    const authoredOrder = scenario.authoredUpdates.map(({ id }) => id);
    expect(
      scenario.replayOrder,
      `${scenario.name}: replay order must differ from authored order`,
    ).not.toEqual(authoredOrder);
    const authored = normalize(canonicalContent(replay(scenario, authoredOrder)));
    const delivered = normalize(
      canonicalContent(replay(scenario, scenario.replayOrder)),
    );
    expect(
      delivered,
      `${scenario.name}: yjs itself must converge across authored and replay order`,
    ).toEqual(authored);
    goldenScenarios[scenario.name] = delivered;
  }

  return {
    fixtures: {
      _readme:
        "Real yjs v1 update streams for the yjs↔yrs replay-parity gate. authoredUpdates records causal/authorship order; replayOrder is deliberately different in every scenario and is the order the Rust daemon must ingest. Emitted by apps/desktop/src/collab/ydocReplayParityGoldens.test.ts; packages/ is a read-only oracle.",
      schema: SCHEMA,
      scenarios,
    },
    goldens: {
      _readme:
        "Yjs-computed semantic document state after each fixture stream's replayOrder. The Rust daemon replay test normalizes its yrs state identically and compares against these committed values.",
      normalization: [
        "deep-sort all JSON object/map keys",
        "merge adjacent string delta runs with identical attributes",
        "drop empty delta attribute objects",
        "omit empty declared roots",
        "exclude CRDT client ids, clocks, tombstones, update bytes, state vectors, and history because the richdoc projection consumes visible typed-root content rather than wire identity",
      ],
      scenarios: goldenScenarios,
    },
  };
}

function canonicalContent(doc: Y.Doc): Json {
  const roots: Record<string, Json> = {};
  for (const [name, kind] of Object.entries(SCHEMA)) {
    if (kind === "map") {
      const map = doc.getMap(name);
      if (map.size === 0) continue;
      const value: Record<string, Json> = {};
      for (const [key, entry] of map.entries()) {
        value[key] = { type: "any", value: plainJson(entry) };
      }
      roots[name] = { type: "map", value };
    } else if (kind === "text") {
      const text = doc.getText(name);
      if (text.length === 0) continue;
      roots[name] = {
        type: "text",
        delta: deltaJson(text.toDelta() as DeltaItem[]),
      };
    } else {
      const fragment = doc.getXmlFragment(name);
      if (fragment.length === 0) continue;
      roots[name] = {
        type: "xmlFragment",
        children: xmlChildren(fragment),
      };
    }
  }
  for (const name of doc.share.keys()) {
    if (!(name in SCHEMA)) {
      roots[name] = { type: "undeclaredRoot" };
    }
  }
  return roots;
}

interface DeltaItem {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

function deltaJson(delta: DeltaItem[]): Json[] {
  return delta.map((item) => {
    const run: Record<string, Json> = {
      insert: plainJson(item.insert),
    };
    if (item.attributes !== undefined) {
      run.attrs = plainJson(item.attributes);
    }
    return run;
  });
}

function xmlChildren(node: Y.XmlFragment | Y.XmlElement): Json[] {
  const children: Json[] = [];
  for (let index = 0; index < node.length; index += 1) {
    children.push(xmlJson(node.get(index)));
  }
  return children;
}

function xmlJson(
  node: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment,
): Json {
  if (node instanceof Y.XmlElement) {
    return {
      type: "element",
      tag: node.nodeName,
      attrs: plainJson(node.getAttributes()),
      children: xmlChildren(node),
    };
  }
  if (node instanceof Y.XmlText) {
    return {
      type: "xmlText",
      delta: deltaJson(node.toDelta() as DeltaItem[]),
    };
  }
  if (node instanceof Y.XmlFragment) {
    return { type: "xmlFragment", children: xmlChildren(node) };
  }
  return { type: "unsupported", debug: String(node) };
}

function plainJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return { __bytes__: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(plainJson);
  if (typeof value === "object") {
    const object: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      object[key] = plainJson(entry);
    }
    return object;
  }
  return String(value);
}

function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;

  const normalized: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = normalize(value[key]!);
    if (
      key === "attrs" &&
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 0
    ) {
      continue;
    }
    normalized[key] = entry;
  }
  if (Array.isArray(normalized.delta)) {
    normalized.delta = mergeDeltaRuns(normalized.delta);
  }
  return normalized;
}

function mergeDeltaRuns(delta: Json[]): Json[] {
  const merged: Json[] = [];
  for (const item of delta) {
    const previous = merged.at(-1);
    if (
      isDeltaRun(previous) &&
      isDeltaRun(item) &&
      typeof previous.insert === "string" &&
      typeof item.insert === "string" &&
      stableStringify(previous.attrs ?? null) ===
        stableStringify(item.attrs ?? null)
    ) {
      previous.insert += item.insert;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function isDeltaRun(
  value: Json | undefined,
): value is { insert: Json; attrs?: Json } {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "insert" in value
  );
}

function stableStringify(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("yjs replay-parity oracle", () => {
  it("matches the committed update corpus and normalized goldens", async () => {
    const produced = buildCorpus();
    if (process.env.DOHC_EMIT_YDOC_REPLAY_GOLDENS === "1") {
      await Promise.all([
        writeFile(
          FIXTURES_PATH,
          `${JSON.stringify(produced.fixtures, null, 2)}\n`,
        ),
        writeFile(
          GOLDENS_PATH,
          `${JSON.stringify(produced.goldens, null, 2)}\n`,
        ),
      ]);
      return;
    }

    const [fixtures, goldens] = await Promise.all([
      readFile(FIXTURES_PATH, "utf8"),
      readFile(GOLDENS_PATH, "utf8"),
    ]);
    expect(produced.fixtures).toEqual(JSON.parse(fixtures));
    expect(produced.goldens).toEqual(JSON.parse(goldens));
  });
});
