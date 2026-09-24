import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { YdocLoopbackEngine } from "../testing/ydocLoopbackEngine";
import { YdocLiveAdapter } from "./ydocLiveAdapter";
import { YDOC_METHOD } from "./ydocWireContract";

const fixture = new URL(
  "../../../../crates/dohc-engine-collab/tests/owner-source/owner-source-seed.json",
  import.meta.url,
);

it("the daemon source fixture comes from the real captured Markdown seeder", async () => {
  const markdown = "# Shared\n\nStarting together.\n";
  const canonical = "# Shared\n\nStarting together.";
  const engine = new YdocLoopbackEngine();
  engine.seedFile({ workspace: "workspace", versionId: "main", path: "owner.md", content: markdown, contentKind: "richdoc" });
  const adapter = new YdocLiveAdapter(engine);
  const session = await adapter.openSession({ workspace: "workspace", versionId: "main", path: "owner.md", contentKind: "richdoc" });
  try {
    const records = engine.requests.filter((request) => request.method === YDOC_METHOD.recordUpdate);
    expect(records).toHaveLength(1);
    const seed = records[0]!.params as { seed: boolean; updateBase64: string };
    expect(seed.seed).toBe(true);
    const bytes = Array.from(Buffer.from(seed.updateBase64, "base64"));
    if (process.env.UPDATE_OWNER_SOURCE_FIXTURE === "1") {
      writeFileSync(fixture, `${JSON.stringify({ markdown, canonical, bytes })}\n`);
    }
    const retained = JSON.parse(readFileSync(fixture, "utf8")) as { markdown: string; canonical: string; bytes: number[] };
    expect(retained.markdown).toBe(markdown);
    expect(retained.canonical).toBe(canonical);
    for (const update of [bytes, retained.bytes]) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Uint8Array.from(update));
        expect(yDocToMarkdown(doc)).toBe(canonical);
        expect(doc.getMap("meta").get("dohcMarkdownSource")).toBe(markdown);
        expect(doc.getMap("meta").get("dohcMarkdownSourceSha256")).toBe(createHash("sha256").update(markdown).digest("hex"));
        expect(doc.getMap("meta").get("dohcMarkdownSourceProjectionSha256")).toBe(createHash("sha256").update(canonical).digest("hex"));
      } finally {
        doc.destroy();
      }
    }
  } finally {
    await session.close();
    adapter.dispose();
  }
});

const lexicalFixture = new URL(
  "../../../../crates/dohc-engine-collab/tests/owner-source/owner-source-lexical.json",
  import.meta.url,
);

// Ordinary files that differ from their projection only in spelling. The seed
// keeps each file's bytes, and the engine must start a live session from that
// seed without rewriting the file.
const LEXICAL: Record<string, string> = {
  "star-bullets": "* one\n* two\n",
  "plus-bullets": "+ one\n+ two\n",
  "star-tasks": "* [ ] open\n* [X] done\n",
  "repeated-ordinals": "1. one\n1. two\n1. three\n",
  "paren-ordinals": "1) one\n2) two\n",
  "loose-list": "- one\n\n- two\n",
  "compact-table": "Left | Right\n--- | ---\na | b\n",
  "table-after-paragraph": "Scores:\n\n| Name | Score |\n|---|--:|\n| Ada | 3 |\n",
  "table-row-without-pipes": "| Name |\n|---|\nAda\n",
  "table-then-heading": "| Name |\n|---|\n| Ada |\n# Next\n",
  "plain-ampersands": "Tom & Jerry, 5 > 3 and 2 < 4\n\n* one\n* two\n",
};

it("the lexical source fixtures come from the real captured Markdown seeder", async () => {
  const engine = new YdocLoopbackEngine();
  const adapter = new YdocLiveAdapter(engine);
  const actual: Record<string, { markdown: string; canonical: string; bytes: number[] }> = {};
  try {
    for (const [name, markdown] of Object.entries(LEXICAL)) {
      const path = `${name}.md`;
      engine.seedFile({ workspace: "workspace", versionId: "main", path, content: markdown, contentKind: "richdoc" });
      const before = engine.requests.length;
      const session = await adapter.openSession({ workspace: "workspace", versionId: "main", path, contentKind: "richdoc" });
      try {
        const records = engine.requests.slice(before).filter((request) => request.method === YDOC_METHOD.recordUpdate);
        expect(records).toHaveLength(1);
        const seed = records[0]!.params as { seed: boolean; updateBase64: string };
        expect(seed.seed).toBe(true);
        const bytes = Array.from(Buffer.from(seed.updateBase64, "base64"));
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, Uint8Array.from(bytes));
          actual[name] = { markdown, canonical: yDocToMarkdown(doc), bytes };
        } finally {
          doc.destroy();
        }
      } finally {
        await session.close();
      }
    }
  } finally {
    adapter.dispose();
  }
  if (process.env.UPDATE_OWNER_SOURCE_LEXICAL_FIXTURE === "1") {
    writeFileSync(lexicalFixture, `${JSON.stringify(actual, null, 1)}\n`);
  }
  const retained = JSON.parse(readFileSync(lexicalFixture, "utf8")) as typeof actual;
  expect(Object.keys(retained)).toEqual(Object.keys(LEXICAL));
  for (const [name, markdown] of Object.entries(LEXICAL)) {
    for (const seed of [actual[name]!, retained[name]!]) {
      expect(seed.markdown).toBe(markdown);
      expect(seed.canonical).not.toBe(markdown);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Uint8Array.from(seed.bytes));
        expect(yDocToMarkdown(doc)).toBe(seed.canonical);
        const meta = doc.getMap("meta");
        expect(meta.get("dohcMarkdownSource")).toBe(markdown);
        expect(meta.get("dohcMarkdownSourceSha256")).toBe(createHash("sha256").update(markdown).digest("hex"));
        expect(meta.get("dohcMarkdownSourceProjectionSha256")).toBe(createHash("sha256").update(seed.canonical).digest("hex"));
      } finally {
        doc.destroy();
      }
    }
  }
});
