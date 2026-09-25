import { frontmatterAsWritten, loadMarkdownFrontmatter } from "@dohc/ydoc-projection/frontmatter";
import { useEffect, useState } from "react";
import type * as Y from "yjs";

/** A Markdown file's frontmatter block as written, and the body after it. No block when the body keeps it. */
export function splitFrontmatter(markdown: string): { block: string; body: string } {
  const loaded = loadMarkdownFrontmatter(markdown);
  if (!loaded) return { block: "", body: markdown };
  return { block: markdown.slice(0, markdown.length - loaded.rest.length), body: loaded.rest };
}

/** A live document's frontmatter block as its file holds it, following shared edits. */
export function useFrontmatterAsWritten(doc: Y.Doc): string {
  const [block, setBlock] = useState(() => frontmatterAsWritten(doc));
  useEffect(() => {
    const update = () => setBlock(frontmatterAsWritten(doc));
    const maps = [doc.getMap("frontmatter"), doc.getMap("meta")];
    update();
    for (const map of maps) map.observe(update);
    return () => {
      for (const map of maps) map.unobserve(update);
    };
  }, [doc]);
  return block;
}

// The viewer has no property form, so the block shows exactly as written:
// every comment, anchor, and key an agent reading the file receives.
export function PropertiesAsWritten({ block }: { block: string }) {
  const text = block.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!text) return null;
  return (
    <section className="markdown" aria-label="Properties">
      <p className="section-label">Properties</p>
      <pre>
        <code>{text}</code>
      </pre>
    </section>
  );
}
