import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown } from "./import-export.js";

// Agent and CLI edits and the engine's Markdown reader write through this same call.
it("an edit that puts a line break into an empty line keeps what someone types there", () => {
  const writer = markdownToYDoc("One.\n");
  const line = new Y.XmlElement("paragraph");
  line.insert(0, [new Y.XmlText()]);
  getDohcYDocBodyFragment(writer).push([line]);
  const typist = new Y.Doc();
  Y.applyUpdate(typist, Y.encodeStateAsUpdate(writer));
  try {
    const before = Y.encodeStateVector(typist);
    ((getDohcYDocBodyFragment(typist).get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(
      0,
      "from b",
    );
    const fromTypist = Y.encodeStateAsUpdate(typist, before);

    const schema = getDohcProseMirrorSchema();
    const fragment = getDohcYDocBodyFragment(writer);
    const current = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    const target = schema.topNodeType.create(null, [
      current.child(0),
      schema.nodes.paragraph!.create(null, schema.nodes.hardBreak!.create()),
    ]);
    const mapping = new Map<Y.XmlElement, ProseMirrorNode>([
      [fragment.get(0) as Y.XmlElement, current.child(0)],
    ]);
    const writerBefore = Y.encodeStateVector(writer);
    writer.transact(() => {
      updateYFragment(writer, fragment, target, { mapping, isOMark: new Map() });
    });
    const fromWriter = Y.encodeStateAsUpdate(writer, writerBefore);

    Y.applyUpdate(writer, fromTypist);
    Y.applyUpdate(typist, fromWriter);
    const saved = yDocToMarkdown(writer);
    expect(yDocToMarkdown(typist)).toBe(saved);
    expect(saved).toContain("from b");
  } finally {
    writer.destroy();
    typist.destroy();
  }
});

// The patch in patches/ rewrites updateYFragment in both of the package's entries. An upgrade
// or a second copy of the package would drop it without a word, so this fails first.
const MARK = "dohc: keep empty text pieces";

it("loads y-prosemirror 1.3.7 with the empty-piece patch, through import and require", async () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("y-prosemirror");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  expect(
    version,
    "patches/y-prosemirror@1.3.7.patch was written for 1.3.7: rewrite it and run the empty-piece race tests before upgrading",
  ).toBe("1.3.7");
  const imported = await import("y-prosemirror");
  expect(imported.updateYFragment.toString()).toContain(MARK);
  expect((require("y-prosemirror") as typeof imported).updateYFragment.toString()).toContain(MARK);
});
