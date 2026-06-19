import yaml from "js-yaml";

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/;
const FRONTMATTER_PRIORITY_KEYS = ["id", "title", "icon"] as const;

export type FrontmatterEntry = {
  key: string;
  value: string;
  sourceKey?: string;
  sourceValue?: string;
  rawValue?: unknown;
};

function isFrontmatterMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseFrontmatter(src: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = FM_RE.exec(src);
  if (!match) return { meta: {}, body: src };

  const [, raw, rest] = match;
  let meta: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(raw ?? "");
    if (parsed == null) {
      return isEmptyFrontmatter(raw ?? "")
        ? { meta, body: rest ?? "" }
        : { meta: {}, body: src };
    }
    if (!isFrontmatterMap(parsed)) return { meta: {}, body: src };
    meta = parsed;
  } catch {
    return { meta: {}, body: src };
  }
  return { meta, body: rest ?? "" };
}

function isEmptyFrontmatter(raw: string): boolean {
  return raw.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("#");
  });
}

export function stringifyFrontmatter(meta: Record<string, unknown>): string {
  return yaml.dump(meta, {
    lineWidth: -1,
    sortKeys: false,
  });
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

export function orderFrontmatter(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of FRONTMATTER_PRIORITY_KEYS) {
    if (Object.hasOwn(frontmatter, key)) ordered[key] = frontmatter[key];
  }

  for (const key of Object.keys(frontmatter).sort()) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = frontmatter[key];
  }

  return ordered;
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

export function applyFrontmatter(
  markdown: string,
  props: Record<string, unknown>,
): string {
  const { body } = parseFrontmatter(markdown);
  if (Object.keys(props).length === 0) return body;
  return `---\n${stringifyFrontmatter(props)}---\n${body}`;
}
