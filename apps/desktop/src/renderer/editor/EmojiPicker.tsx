import { useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { EMOJI_DATA, type EmojiEntry } from "./emojiData";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";

export type EmojiPickerState =
  | { open: false }
  | {
      open: true;
      from: number;
      query: string;
    };

type PickerView = {
  coordsAtPos(pos: number): { left: number; top: number; bottom: number };
  state: {
    tr: {
      insertText(text: string, from: number, to: number): unknown;
      setSelection(s: unknown): unknown;
    };
    selection: { from: number };
  };
  dispatch(tr: unknown): void;
  focus(): void;
};

type Props = {
  state: EmojiPickerState;
  view: PickerView | null;
  onDismiss: () => void;
};

/** Replace the `from..cursor` range (the `:query` text, no closing colon)
 *  with the picked emoji as PLAIN TEXT — no node, no schema involvement.
 *  Exported standalone (not a closure inside the component) so it's
 *  directly testable against a real Editor without rendering React, same
 *  convention as WikilinkPicker's `applyWikilinkPick`. */
export function applyEmojiPick(view: PickerView, from: number, entry: EmojiEntry): void {
  const cursorPos = view.state.selection.from;
  const tr = view.state.tr.insertText(entry.emoji, from, cursorPos) as {
    doc: { resolve(pos: number): ResolvedPos };
    setSelection(s: unknown): unknown;
  };
  const afterInsert = from + entry.emoji.length;
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterInsert)));
  view.dispatch(tr);
  view.focus();
}

/** PURE: fuzzy-rank EMOJI_DATA against a query, matching on shortcode
 *  (preferred) then keywords. Lower score = better match. Exported for
 *  direct unit testing of the ranking without rendering the picker. */
export function rankEmoji(query: string, entries: ReadonlyArray<EmojiEntry> = EMOJI_DATA) {
  const q = query.toLowerCase().trim();
  const scored = entries.map((entry) => {
    if (q === "") return { entry, score: 5 };
    const shortcode = entry.shortcode.toLowerCase();
    if (shortcode === q) return { entry, score: 0 };
    if (shortcode.startsWith(q)) return { entry, score: 1 };
    if (shortcode.includes(q)) return { entry, score: 2 };
    const keywords = entry.keywords.map((k) => k.toLowerCase());
    if (keywords.some((k) => k.startsWith(q))) return { entry, score: 3 };
    if (keywords.some((k) => k.includes(q))) return { entry, score: 4 };
    return { entry, score: -1 };
  });
  return scored
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.entry.shortcode.localeCompare(b.entry.shortcode));
}

export function EmojiPicker({ state, view, onDismiss }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setActiveIdx(0);
  }, [state.open ? state.query : ""]);

  useEffect(() => {
    if (!state.open) return;
    itemRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, state.open]);

  const matches = useMemo(() => {
    if (!state.open) return [];
    return rankEmoji(state.query)
      .slice(0, 24)
      .map((x) => x.entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open ? state.query : ""]);

  function commit(entry: EmojiEntry) {
    if (!view || !state.open) return;
    applyEmojiPick(view, state.from, entry);
    onDismiss();
  }

  useEffect(() => {
    if (!state.open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => (i + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        // Tab commits (rather than moving focus out of the editor) —
        // matches the "typing the full shortcode" fast path so either
        // way of finishing an emoji lands the same result.
        e.preventDefault();
        e.stopPropagation();
        const selected = matches[activeIdx];
        if (selected) commit(selected);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state.open, matches, activeIdx, onDismiss, view, state]);

  const coords =
    state.open && view
      ? (() => {
          try {
            return view.coordsAtPos(state.from);
          } catch {
            return null;
          }
        })()
      : null;

  if (!state.open || !coords) return null;
  const position = resolveFloatingMenuPosition({
    cursorRect: coords,
    menuWidth: 280,
    menuMaxHeight: 240,
    gap: 4,
  });

  return (
    <div
      className="dohc-emoji-picker"
      data-placement={position.placement}
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        maxHeight: position.maxHeight,
        zIndex: 60,
      }}
      role="listbox"
      aria-label="emoji"
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className="dohc-emoji-picker__empty">No emoji match "{state.query}"</div>
      ) : (
        <div>
          {matches.map((entry, i) => (
            <button
              key={entry.shortcode}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              className={`dohc-emoji-picker__item${i === activeIdx ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => commit(entry)}
            >
              <span className="dohc-emoji-picker__item-glyph" aria-hidden>
                {entry.emoji}
              </span>
              <span className="dohc-emoji-picker__item-shortcode">:{entry.shortcode}:</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
