import { readFileSync } from "node:fs";
// Vite rewrites a literal `new URL(path, import.meta.url)` into a served asset URL.
import { URL as NodeURL } from "node:url";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import * as Y from "yjs";

/**
 * Frontmatter the canonical TypeScript writer keeps in shared Y types: maps
 * with a `__proto__` or `constructor` key, an exact integer beside one, and a
 * literal key spelled like the integer's marker. `exact` and `nested` hold the
 * same integer as plain Yjs Any, and `settings` and `status` are ordinary
 * values. The block is canonical, so a document keeps no text for it and every
 * surface writes it from the values.
 */
export const EDGE_FRONTMATTER = [
  "---",
  "exact: 9007199254740993",
  "hostile:",
  "  __proto__: nested-value",
  "  constructor: own",
  "literal:",
  "  - constructor: hostile-constructor",
  "  - $dohcBigInt: 9007199254740993",
  "mixed:",
  "  - constructor: hostile-constructor",
  "  - 9007199254740993",
  "nested:",
  "  exact: 9007199254740993",
  "settings:",
  "  pinned: true",
  "status: draft",
  "---",
  "",
  "",
].join("\n");

export const EDGE_MARKDOWN = `${EDGE_FRONTMATTER}Body\n`;

/** Each property's text in the properties panel, on one line. */
export const EDGE_DISPLAY: Readonly<Record<string, string>> = {
  exact: "9007199254740993",
  hostile: "{__proto__: nested-value, constructor: own}",
  literal: "[{constructor: hostile-constructor}, {$dohcBigInt: 9007199254740993}]",
  mixed: "[{constructor: hostile-constructor}, 9007199254740993]",
  nested: "{exact: 9007199254740993}",
  settings: "{pinned: true}",
  status: "draft",
};

/** The document as a desktop receives it: the canonical TypeScript writer, then the Yjs wire. */
export function receivedYDoc(markdown: string): Y.Doc {
  const written = markdownToYDoc(markdown);
  const received = new Y.Doc();
  try {
    Y.applyUpdate(received, Y.encodeStateAsUpdate(written));
  } finally {
    written.destroy();
  }
  return received;
}

type RecordedVector = { name: string; bytes: number[]; markdown: string };
let recordedVectors: RecordedVector[] | undefined;

/**
 * A document from the update bytes in live-bootstrap.json, with the Markdown
 * the projection wrote for it. The TypeScript writer recorded these bytes
 * (packages/ydoc-projection/src/liveBootstrapVectors.test.ts) and the Rust
 * engine's tests decode the same bytes.
 */
export function recordedYDoc(name: string): { doc: Y.Doc; markdown: string } {
  recordedVectors ??= JSON.parse(readFileSync(new NodeURL(
    "../../../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json",
    import.meta.url,
  ), "utf8")) as RecordedVector[];
  const vector = recordedVectors.find((candidate) => candidate.name === name);
  if (!vector) throw new Error(`live-bootstrap.json has no vector ${name}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(vector.bytes));
  return { doc, markdown: vector.markdown };
}
