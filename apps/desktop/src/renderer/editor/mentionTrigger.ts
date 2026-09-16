import { cursorText } from "./cursorText";
import { makeTriggerPlugin } from "./triggerPlugin";
// Notion-style `@`-mention trigger for page wikilinks.
//
// A second trigger surface over the same wikilink node used by the
// `[[` autocomplete (see wikilinkPlugin.ts) — no new schema, no new
// node type. Typing `@query` at a word boundary opens the shared
// `WikilinkPicker`; picking a file inserts a real `wikilink` atom
// node (`extensions.ts`'s `DohcWikilink`) labeled with the file's
// display name, so it reads like a mention pill. Pill rendering,
// click-to-open, and broken-link styling all come from the existing
// node — this module only detects the trigger.
//
// Detection mirrors wikilinkPlugin's `detectAutocomplete`: resolve
// the text node under the cursor, look at the text before it, apply
// the same code-block / inline-code-mark exclusions. The one added
// rule `@` doesn't need: a WORD-BOUNDARY check before the `@` —
// `[[` is unambiguous on its own, but a bare `@` shows up constantly
// in prose (emails, handles), so it must not fire mid-word (e.g.
// `user@example`).

import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'
import { PluginKey } from '@tiptap/pm/state'
import {
  type AutocompleteState,
} from './wikilinkPlugin'

export const mentionPluginKey = new PluginKey('dohc-mention')

// `(?<=^|\s)` — the `@` must be the first character of the text run
// (start-of-block, approximated the same way wikilinkPlugin does: by
// only looking within the current text node) or immediately follow
// whitespace. The query itself excludes whitespace, `@` (so a second
// `@` starts a fresh trigger instead of extending the query) and `[`
// (so typing a `[[` wikilink trigger mid-query cleanly hands off
// instead of being swallowed as mention text).
const MENTION_RE = /(?<=^|\s)@([^\s@[]*)$/

/** Pure: detect an incomplete `@mention` at the cursor. Same shape
 *  and strategy as wikilinkPlugin's `detectAutocomplete` — reused
 *  here so the picker component doesn't need to know which trigger
 *  fired it. */
export function detectMentionAutocomplete(
  doc: ProseMirrorNode,
  cursorPos: number,
  position?: ResolvedPos,
): AutocompleteState {
  const run = cursorText(doc, cursorPos, position)
  if (!run) return { active: false }
  const before = run.text
  const m = MENTION_RE.exec(before)
  if (!m) return { active: false }
  return {
    active: true,
    from: run.from + before.length - m[0].length,
    query: m[1] ?? '',
  }
}

/** Build the mention-trigger plugin. Detection-only — no
 *  decorations of its own. Once a file is picked, the inserted
 *  `wikilink` node is rendered by the extension's own node view, and
 *  while the query is still being typed the raw `@query` text is
 *  just plain text (nothing to hide/replace). Mirrors
 *  makeWikilinkPlugin's `view()` + change-notify pattern. */
export function makeMentionPlugin(
  onAutocompleteChange: (s: AutocompleteState) => void,
) {
  return makeTriggerPlugin({
    key: mentionPluginKey,

  }, detectMentionAutocomplete, onAutocompleteChange)
}
