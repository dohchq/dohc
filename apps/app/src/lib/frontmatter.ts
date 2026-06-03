import yaml from 'js-yaml'

// Frontmatter parser. Uses js-yaml so atoms can have nested config
// (arrays of objects, multiline templates via the `|` block scalar,
// etc.).
//
// Returns the parsed meta object plus the body after the closing ---.

const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/
const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const
type FrontmatterPriorityKey = (typeof FRONTMATTER_PRIORITY_KEYS)[number]

export function parseFrontmatter(src: string): {
  meta: Record<string, unknown>
  body: string
} {
  const m = FM_RE.exec(src)
  if (!m) return { meta: {}, body: src }
  const [, raw, rest] = m
  let meta: Record<string, unknown> = {}
  try {
    const parsed = yaml.load(raw ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>
    }
  } catch {
    // Keep the raw bytes visible/editable. Dropping the malformed block here
    // would make first collaborative bootstrap a lossy import.
    return { meta: {}, body: src }
  }
  return { meta, body: rest ?? '' }
}

// Convenience: pull a string field with a default.
export function fmString(meta: Record<string, unknown>, key: string, fallback = ''): string {
  const v = meta[key]
  return typeof v === 'string' ? v : fallback
}

// ── D4.19 — page properties (Notion-style frontmatter editing) ──────
// The properties UI reads ORDERED key/value entries and writes them
// back losslessly-enough (js-yaml round-trip). Frontmatter in dohc
// is simple key:value, so a yaml.dump rebuild is safe + clean.

export type FmEntry = { key: string; value: string }

/** Ordered frontmatter entries (insertion order preserved by
 *  js-yaml). Non-string values are stringified for display. */
export function frontmatterEntries(body: string): FmEntry[] {
  const { meta } = parseFrontmatter(body)
  return Object.entries(meta).map(([key, value]) => ({
    key,
    value: value == null ? '' : String(value),
  }))
}

/** Rebuild `body` with the given frontmatter props (preserving the
 *  post-frontmatter content verbatim). Empty props ⇒ no frontmatter
 *  block at all. js-yaml handles quoting/escaping. */
export function applyFrontmatter(
  body: string,
  props: Record<string, string>,
): string {
  const { body: rest } = parseFrontmatter(body)
  const keys = Object.keys(props)
  if (keys.length === 0) return rest
  // lineWidth:-1 ⇒ never wrap long values; keep one key per line.
  const dumped = yaml.dump(props, { lineWidth: -1 })
  return `---\n${dumped}---\n${rest}`
}

// ── D4.22 — page title as a frontmatter property ────────────────────
// The page TITLE lives in frontmatter (`title:`), alongside `id`, not
// in the markdown content. The title field edits this key. Source
// view reads: `---\nid: …\ntitle: …\n<user props>\n---\n<content>`.
// Cleaner than a `# H1`-in-body title: one metadata home, a pure
// content body, no extract/reattach dance.

/** Set (or clear) the frontmatter `title:` key, keeping a tidy key
 *  order: id, title, icon, then the user's other props in their
 *  original order. An empty/blank title drops the key. */
export function setFrontmatterTitle(body: string, title: string): string {
  const props = orderedFrontmatterProps(body, {
    title: title.trim() ? title : null,
  })
  return applyFrontmatter(body, props)
}

/** Set (or clear) the frontmatter `icon:` key (the page's emoji
 *  icon, Notion-style). Key order: id, title, icon, then the user's
 *  other props. A null/blank icon drops the key. */
export function setFrontmatterIcon(body: string, icon: string | null): string {
  const props = orderedFrontmatterProps(body, {
    icon: icon?.trim() ? icon.trim() : null,
  })
  return applyFrontmatter(body, props)
}

function orderedFrontmatterProps(
  body: string,
  overrides: Partial<Record<FrontmatterPriorityKey, string | null>>,
): Record<string, string> {
  const entries = frontmatterEntries(body)
  const current = new Map(entries.map((entry) => [entry.key, entry.value]))
  const props: Record<string, string> = {}

  for (const key of FRONTMATTER_PRIORITY_KEYS) {
    const value = Object.hasOwn(overrides, key)
      ? overrides[key]
      : current.get(key)
    if (value) props[key] = value
  }

  for (const entry of entries) {
    if (!FRONTMATTER_PRIORITY_KEYS.includes(entry.key as FrontmatterPriorityKey)) {
      props[entry.key] = entry.value
    }
  }

  return props
}
