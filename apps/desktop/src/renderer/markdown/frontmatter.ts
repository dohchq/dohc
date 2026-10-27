import {
  frontmatterValueFlowYaml,
  frontmatterValueYaml,
  leadingFrontmatter,
  loadMarkdownFrontmatter,
  writeMarkdownFrontmatter,
} from "@dohc/ydoc-projection/frontmatter";

// Frontmatter reads and writes with the rules the engine settles by, so a
// local edit keeps the text a person wrote the way a settle does.
export { orderFrontmatter } from "@dohc/ydoc-projection/frontmatter";

/** Why a document's properties cannot be edited one at a time. */
export { FRONTMATTER_EDIT_REFUSED_MESSAGE } from "@dohc/ydoc-projection/frontmatter";

export type FrontmatterEntry = {
  key: string;
  value: string;
  sourceKey?: string;
  sourceValue?: string;
  rawValue?: unknown;
  // A list of text, shown and edited as its items with commas between them.
  list?: true;
  // Why the value shows but can't be edited here.
  readOnly?: string;
};

/** Frontmatter values and the text after the block. A document without a readable block is all body. */
export function parseFrontmatter(src: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const loaded = loadMarkdownFrontmatter(src);
  return loaded ? { meta: loaded.meta, body: loaded.rest } : { meta: {}, body: src };
}

function splitRawFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  // A block that does not read stays out of the body too, as the engine keeps
  // it, so the editor never renders it as Markdown.
  const block = leadingFrontmatter(markdown);
  if (!block) return { frontmatter: null, body: markdown };
  return { frontmatter: block.text, body: markdown.slice(block.text.length) };
}

export function markdownEditorBody(markdown: string): string {
  return splitRawFrontmatter(markdown).body;
}

export function mergeMarkdownEditorBody(sourceMarkdown: string, body: string): string {
  const split = splitRawFrontmatter(sourceMarkdown);
  if (!split.frontmatter) return body;
  const separator = split.body.startsWith("\n") && !body.startsWith("\n") ? "\n" : "";
  return `${split.frontmatter}${separator}${body}`;
}

export function displayFrontmatterValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return frontmatterValueYaml(value).trimEnd();
  } catch {
    return String(value);
  }
}

// A list's text splits back on commas and drops the spaces around each item,
// so only items that come back the same can be edited as text.
function listProblem(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (typeof item !== "string") return "some items aren't text";
    if (/[\r\n]/u.test(item)) return "an item has a line break";
    if (item.includes(",")) return "an item has a comma";
    if (item === "" || item !== item.trim()) return "an item is blank or starts or ends with a space";
  }
  return null;
}

const EDIT_THE_TEXT = "Edit the file's text instead.";

function flowText(value: unknown): string {
  try {
    return frontmatterValueFlowYaml(value);
  } catch {
    return String(value);
  }
}

/** A property's text on one line, and whether it edits as a list or not at all. */
function propertyText(value: unknown): Pick<FrontmatterEntry, "value" | "list" | "readOnly"> {
  if (Array.isArray(value)) {
    const problem = listProblem(value);
    return problem === null
      ? { value: value.join(", "), list: true }
      : { value: flowText(value), readOnly: `dohc can't edit this list here because ${problem}. ${EDIT_THE_TEXT}` };
  }
  if (value !== null && typeof value === "object") {
    return { value: flowText(value), readOnly: `dohc can't edit a value with named fields here. ${EDIT_THE_TEXT}` };
  }
  return { value: displayFrontmatterValue(value) };
}

/** A list's text as its items: split on commas, trimmed, with blank items dropped. */
export function listItems(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/** Entries in the order of `pairs`. An object would list integer-like keys first. */
export function frontmatterEntriesFromPairs(
  pairs: Iterable<readonly [string, unknown]>,
): FrontmatterEntry[] {
  return Array.from(pairs, ([key, rawValue]) => {
    const text = propertyText(rawValue);
    return {
      key,
      ...text,
      sourceKey: key,
      sourceValue: text.value,
      rawValue,
    };
  });
}

/** The document's properties in the order the file holds them. */
export function frontmatterEntries(markdown: string): FrontmatterEntry[] {
  const loaded = loadMarkdownFrontmatter(markdown);
  return loaded ? frontmatterEntriesFromPairs(loaded.keys.map((key) => [key, loaded.meta[key]])) : [];
}

/** Write frontmatter values into a document, keeping the text of every entry whose value did not change. */
export function applyFrontmatter(
  markdown: string,
  props: Record<string, unknown>,
  renamed?: ReadonlyMap<string, string>,
): string {
  return writeMarkdownFrontmatter(markdown, props, renamed);
}
