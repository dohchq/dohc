import * as yaml from "js-yaml";
import {
  type FrontmatterKeyEdit,
  loadMarkdownFrontmatter,
  writeMarkdownFrontmatter,
} from "@dohc/ydoc-projection/frontmatter";

// Frontmatter reads and writes with the rules the engine settles by, so a
// local edit keeps the text a person wrote the way a settle does.
export { orderFrontmatter } from "@dohc/ydoc-projection/frontmatter";

export type FrontmatterEntry = {
  key: string;
  value: string;
  sourceKey?: string;
  sourceValue?: string;
  rawValue?: unknown;
};

/** Frontmatter values and the text after the block. A document without a readable block is all body. */
export function parseFrontmatter(src: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const loaded = loadMarkdownFrontmatter(src);
  return loaded ? { meta: loaded.meta, body: loaded.rest } : { meta: {}, body: src };
}

export function displayFrontmatterValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return yaml
      .dump(value, {
        lineWidth: -1,
        sortKeys: false,
      })
      .trimEnd();
  } catch {
    return String(value);
  }
}

export function frontmatterEntriesFromMeta(
  meta: Record<string, unknown>,
): FrontmatterEntry[] {
  return Object.entries(meta).map(([key, rawValue]) => {
    const value = displayFrontmatterValue(rawValue);
    return {
      key,
      value,
      sourceKey: key,
      sourceValue: value,
      rawValue,
    };
  });
}

export function frontmatterEntries(markdown: string): FrontmatterEntry[] {
  return frontmatterEntriesFromMeta(parseFrontmatter(markdown).meta);
}

/** Write frontmatter values into a document, keeping the text of every entry whose value did not change. */
export function applyFrontmatter(
  markdown: string,
  props: Record<string, unknown>,
  edit?: FrontmatterKeyEdit,
): string {
  return writeMarkdownFrontmatter(markdown, props, edit);
}
