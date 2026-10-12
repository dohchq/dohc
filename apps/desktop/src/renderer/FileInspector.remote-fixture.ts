import {
  getDohcYDocBodyFragment,
  getDohcYDocPlainText,
  markdownToYDoc,
} from "@dohc/ydoc-projection";
import { FRONTMATTER_SOURCE_META_KEY } from "@dohc/ydoc-projection/frontmatter";
import { recordFrontmatterSourceItems } from "@dohc/ydoc-projection/frontmatter-map";
import * as Y from "yjs";

/**
 * A remote writer replacing a live rich document in one transaction. The
 * canonical TypeScript writer builds `markdown`, and its frontmatter values,
 * meta values, and body blocks replace the document's. Shared types are
 * cloned, never re-serialized.
 */
export function replaceYDocWithMarkdown(doc: Y.Doc, markdown: string): void {
  if (getDohcYDocPlainText(doc)) {
    throw new Error("replaceYDocWithMarkdown replaces rich documents only.");
  }
  const written = markdownToYDoc(markdown);
  try {
    doc.transact(() => {
      const frontmatter = doc.getMap<unknown>("frontmatter");
      const meta = doc.getMap<unknown>("meta");
      replaceMap(frontmatter, written.getMap<unknown>("frontmatter"));
      replaceMap(meta, written.getMap<unknown>("meta"));
      // Kept frontmatter text names the items it was written for, which are
      // this document's copies now.
      if (meta.has(FRONTMATTER_SOURCE_META_KEY)) {
        recordFrontmatterSourceItems(frontmatter, meta);
      }

      const body = getDohcYDocBodyFragment(doc);
      body.delete(0, body.length);
      // Every top-level block is an element.
      body.insert(
        0,
        getDohcYDocBodyFragment(written)
          .toArray()
          .flatMap((block) => (block instanceof Y.XmlElement ? [block.clone()] : [])),
      );
    });
  } finally {
    written.destroy();
  }
}

function replaceMap(target: Y.Map<unknown>, source: Y.Map<unknown>): void {
  target.clear();
  source.forEach((value, key) => {
    target.set(key, value instanceof Y.AbstractType ? value.clone() : value);
  });
}
