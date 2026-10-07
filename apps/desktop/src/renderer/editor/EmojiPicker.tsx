import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EMOJI_DATA, type EmojiEntry } from "./emojiData";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";
import {
  MENU_ACTIVE_OPTION,
  MENU_EMPTY,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ROW,
  MENU_ROW_TONE,
  menuEnterFrom,
  movedPointer,
  moveInMenu,
  revealMenuRow,
} from "../ui/Menu";

export type EmojiPickerState =
  | { open: false }
  | {
      open: true;
      from: number;
      query: string;
    };

type Props = {
  state: EmojiPickerState;
  view: EditorView | null;
  onDismiss: () => void;
};

/** Replace the `from..cursor` range (the `:query` text, no closing colon)
 *  with the picked emoji as PLAIN TEXT — no node, no schema involvement.
 *  Exported standalone (not a closure inside the component) so it's
 *  directly testable against a real Editor without rendering React, same
 *  convention as WikilinkPicker's `applyWikilinkPick`. */
export function applyEmojiPick(view: EditorView, from: number, entry: EmojiEntry): void {
  const cursorPos = view.state.selection.from;
  const tr = view.state.tr.insertText(entry.emoji, from, cursorPos);
  const afterInsert = from + entry.emoji.length;
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterInsert)));
  view.dispatch(tr);
  view.focus();
}

/** Pure: fuzzy-rank EMOJI_DATA against a query, matching on shortcode
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Stable per-instance prefix for option ids so aria-activedescendant can
  // point at the active option — the editor keeps DOM focus (onMouseDown
  // preventDefault), so this is how AT learns which emoji is highlighted.
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    setActiveIdx(0);
  }, [state.open ? state.query : ""]);

  // Only the list scrolls to show the active option; scrollIntoView would
  // scroll the editor pane under it too.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (state.open && list) revealMenuRow(list, itemRefs.current[activeIdx]);
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
      // The editor keeps the typed keys, Home and End for the query, so only
      // the arrows move the active option.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const next = moveInMenu(e.key, activeIdx, matches.map((entry) => entry.shortcode));
        if (next !== null) setActiveIdx(next);
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
      ref={listRef}
      className={`dohc-emoji-picker ${MENU_FRAME} ${MENU_ENTER}`}
      data-placement={position.placement}
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        maxHeight: position.maxHeight,
        zIndex: 60,
        ...menuEnterFrom(position.placement),
      }}
      role="listbox"
      aria-label="emoji"
      aria-activedescendant={
        matches.length > 0 ? optionId(activeIdx) : undefined
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className={MENU_EMPTY}>No emoji match "{state.query}"</div>
      ) : (
        <div>
          {matches.map((entry, i) => (
            <button
              key={entry.shortcode}
              id={optionId(i)}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === activeIdx}
              data-active={i === activeIdx || undefined}
              className={`${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} data-active:text-ink`}
              // Only a pointer that moves picks the active option, so a list
              // that opens or scrolls under a still pointer keeps the keys'.
              onMouseMove={(event) => {
                if (movedPointer(event) && i !== activeIdx) setActiveIdx(i);
              }}
              onClick={() => commit(entry)}
            >
              <span className="grid w-5 shrink-0 place-items-center text-base leading-none" aria-hidden>
                {entry.emoji}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">:{entry.shortcode}:</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
