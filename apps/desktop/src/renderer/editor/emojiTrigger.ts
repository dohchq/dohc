// `:shortcode:` emoji autocomplete trigger.
//
// A THIRD trigger surface alongside `[[` wikilinks (wikilinkPlugin.ts) and
// `@`-mentions (mentionTrigger.ts) — same detection shape, same shared
// picker infrastructure conventions, but it inserts PLAIN UNICODE TEXT
// (see EmojiPicker.tsx's `applyEmojiPick`). No schema/node involved, so
// there is zero round-trip surface: the emoji character is just text,
// same as if the user had typed or pasted it directly.
//
// Detection mirrors wikilinkPlugin's `detectAutocomplete` / mentionTrigger's
// `detectMentionAutocomplete`: walk to the text node under the cursor, look
// at the text before it, apply the same code-block / inline-code-mark
// exclusions, require the trigger character to sit at a word boundary
// (start-of-node or after whitespace) so `12:30` and URLs don't fire.
//
// One extra rule the other two triggers don't need: the query must be at
// least 2 characters before the picker opens (`:s` does nothing, `:sm`
// opens) — a bare `:` shows up too often in prose (times, URLs, ratios) to
// pop a picker on the very first character.
//
// A SECOND behavior layered on top: typing the *closing* colon of a
// complete, known shortcode (`:smile:`) inserts the emoji immediately,
// Slack/GitHub-style, without waiting for the user to pick from the list.
// That's handled via `appendTransaction` (not a manual `view.dispatch` from
// inside `view.update`) so the replacement is folded into the same
// transaction cycle instead of racing a second dispatch.

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { PMDocLike } from './inlineAtomPlugin'
import { isCodeBlock, isCodeMark, type AutocompleteState } from './wikilinkPlugin'
import { EMOJI_DATA, type EmojiEntry } from './emojiData'

export const emojiPluginKey = new PluginKey('dohc-emoji')

// Lazily-built shortcode -> entry map. A module-level constant is fine —
// EMOJI_DATA is a static built-in table, not something that changes at
// runtime.
const EMOJI_BY_SHORTCODE: ReadonlyMap<string, EmojiEntry> = new Map(
  EMOJI_DATA.map((entry) => [entry.shortcode, entry]),
)

export function lookupEmoji(shortcode: string): EmojiEntry | undefined {
  return EMOJI_BY_SHORTCODE.get(shortcode)
}

// Opening trigger: `:` at a word boundary followed by 2+ shortcode-ish
// characters (letters, digits, `_`, `+`, `-` — covers every entry in
// emojiData.ts, e.g. `+1`, `t_rex`) with NO closing colon yet.
const EMOJI_TRIGGER_RE = /(?<=^|\s):([a-zA-Z0-9_+-]{2,})$/

// Completion trigger: same, but the closing `:` has just been typed.
const EMOJI_COMPLETE_RE = /(?<=^|\s):([a-zA-Z0-9_+-]{2,}):$/

/** PURE: detect an incomplete `:shortcode` at the cursor, same shape and
 *  strategy as wikilinkPlugin's `detectAutocomplete` / mentionTrigger's
 *  `detectMentionAutocomplete`. */
export function detectEmojiAutocomplete(
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
    const m = EMOJI_TRIGGER_RE.exec(before)
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

export type CompleteEmojiShortcode = {
  from: number
  to: number
  shortcode: string
}

/** PURE: detect a JUST-CLOSED `:shortcode:` at the cursor (the closing
 *  colon is the last character before cursorPos). Doesn't check whether
 *  the shortcode is actually known — callers combine this with
 *  `lookupEmoji`. */
export function detectCompleteEmojiShortcode(
  doc: PMDocLike,
  cursorPos: number,
): CompleteEmojiShortcode | null {
  let found: CompleteEmojiShortcode | null = null
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    if (isCodeBlock(parent)) return
    if ((node.marks ?? []).some(isCodeMark)) return
    const nodeStart = pos
    const nodeEnd = pos + node.text.length
    if (cursorPos < nodeStart || cursorPos > nodeEnd) return
    const before = node.text.slice(0, cursorPos - nodeStart)
    const m = EMOJI_COMPLETE_RE.exec(before)
    if (!m) return
    found = {
      from: nodeStart + before.length - m[0].length,
      to: cursorPos,
      shortcode: m[1] ?? '',
    }
    return false // stop descending
  })
  return found
}

/** Build the emoji-trigger plugin.
 *  - `appendTransaction` handles the "typed the closing colon of a known
 *    shortcode" auto-insert, folded into the same transaction that typed
 *    the colon (no extra dispatch cycle).
 *  - `view.update` handles the open-picker notification, same pattern as
 *    makeMentionPlugin / makeWikilinkPlugin. */
export function makeEmojiPlugin(onAutocompleteChange: (s: AutocompleteState) => void) {
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
    key: emojiPluginKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const sel = newState.selection
      if (!sel.empty) return null
      const found = detectCompleteEmojiShortcode(
        newState.doc as unknown as PMDocLike,
        sel.from,
      )
      if (!found) return null
      const entry = lookupEmoji(found.shortcode)
      if (!entry) return null
      return newState.tr.insertText(entry.emoji, found.from, found.to)
    },
    view(view) {
      function recompute() {
        const state = view.state
        const s = detectEmojiAutocomplete(
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
