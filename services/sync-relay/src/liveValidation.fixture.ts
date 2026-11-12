import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";

const { encodeStateAsUpdate } = createRequire(new URL("../../../packages/ydoc-projection/package.json", import.meta.url))("yjs") as {
  encodeStateAsUpdate(doc: ReturnType<typeof markdownToYDoc>): Uint8Array;
};
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function nestedEmphasis(depth: number) {
  const source = "*".repeat(depth) + "b" + " a*".repeat(depth);
  const doc = markdownToYDoc(`*b${" a".repeat(depth)}*`), meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", source);
  meta.set("dohcMarkdownSourceSha256", sha256(source));
  meta.set("dohcMarkdownSourceProjectionSha256", sha256(yDocToMarkdown(doc)));
  try { return { source, checkpoint: encodeStateAsUpdate(doc) }; } finally { doc.destroy(); }
}
