// Notion-style `@`-mention trigger for page wikilinks.
//
// A SECOND trigger surface over the SAME wikilink node used by the
// `[[` autocomplete (see wikilinkPlugin.ts) — no new schema, no new
// node type. Typing `@query` at a word boundary opens the shared
// `WikilinkPicker`; picking a file inserts a real `wikilink` atom
// node (`extensions.ts`'s `DohcWikilink`) labeled with the file's
// display name, so it reads like a mention pill. Pill rendering,
// click-to-open, and broken-link styling all come from the existing
// node — this module only detects the trigger.
//
// Detection mirrors wikilinkPlugin's `detectAutocomplete`: walk to
// the text node under the cursor, look at the text before it, apply
// the same code-block / inline-code-mark exclusions. The one added
// rule `@` doesn't need: a WORD-BOUNDARY check before the `@` —
// `[[` is unambiguous on its own, but a bare `@` shows up constantly
// in prose (emails, handles), so it must not fire mid-word (e.g.
// `user@example`).

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { PMDocLike } from './inlineAtomPlugin'
import {
  isCodeBlock,
  isCodeMark,
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

/** PURE: detect an incomplete `@mention` at the cursor. Same shape
 *  and strategy as wikilinkPlugin's `detectAutocomplete` — reused
 *  here so the picker component doesn't need to know which trigger
 *  fired it. */
export function detectMentionAutocomplete(
  doc: PMDocLike,
  cursorPos: number,
): AutocompleteState {
  let found: AutocompleteState = { active: false }
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if ((node.marks ?? []).some(isCodeMark)) return
    const nodeStart = pos
    const nodeEnd = pos + node.text.length
    if (cursorPos < nodeStart || cursorPos > nodeEnd) return
    const before = node.text.slice(0, cursorPos - nodeStart)
    const m = MENTION_RE.exec(before)
    if (!m) return
    found = {
      active: true,
      from: nodeStart + before.length - m[0].length,
      query: m[1] ?? '',
    }
    return false // stop descending
  })
  return found
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
  let last: AutocompleteState = { active: false }
  function notify(next: AutocompleteState) {
    if (next.active && last.active) {
      if (next.from === last.from && next.query === last.query) return
    } else if (!next.active && !last.active) {
      return
    }
    last = next
    onAutocompleteChange(next)
  }
  return new Plugin({
    key: mentionPluginKey,
    view(view) {
      function recompute() {
        const state = view.state
        const s = detectMentionAutocomplete(
          state.doc as unknown as PMDocLike,
          state.selection.from,
        )
        notify(s)
      }
      recompute()
      return {
        update() {
          recompute()
        },
        destroy() {
          notify({ active: false })
        },
      }
    },
  })
}
