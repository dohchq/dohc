// Compact find/replace overlay chip pinned to the editor's top-right
// corner. All state lives in the `findReplaceKey` ProseMirror plugin
// (findReplace.ts) — this component is a thin controlled view: it
// subscribes to `editor.state`, renders it, and dispatches
// `FindReplaceAction`s back in. No local search state here on purpose, so
// closing/reopening the bar (or a future second view of it) can never
// drift from what the decorations are actually highlighting.

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ChevronDown, ChevronUp, Replace, X } from "lucide-react";
import {
  buildReplaceActiveTransaction,
  buildReplaceAllTransaction,
  CLOSED_FIND_REPLACE_STATE,
  findReplaceKey,
  type FindReplaceAction,
  type FindReplaceState,
} from "./findReplace";

export function FindReplaceBar({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<FindReplaceState>(CLOSED_FIND_REPLACE_STATE);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;
    const sync = () => setState(findReplaceKey.getState(editor.state) ?? CLOSED_FIND_REPLACE_STATE);
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  useEffect(() => {
    if (state.open) findInputRef.current?.focus();
  }, [state.open]);

  useEffect(() => {
    if (!editor || !state.open || state.activeIndex < 0) return;
    editor.view.dom
      .querySelector(".dohc-find-match--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [editor, state.open, state.activeIndex]);

  if (!editor || !state.open) return null;

  const dispatch = (action: FindReplaceAction) => {
    editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, action));
  };

  const close = () => {
    dispatch({ type: "close" });
    editor.commands.focus();
  };

  const readOnly = !editor.isEditable;
  const total = state.matches.length;
  const position = state.activeIndex >= 0 ? state.activeIndex + 1 : 0;

  return (
    <div className="dohc-find-replace" role="search" aria-label="find and replace">
      <div className="dohc-find-replace__row">
        <input
          ref={findInputRef}
          type="text"
          className="dohc-find-replace__input"
          placeholder="Find"
          value={state.query}
          onChange={(event) => dispatch({ type: "setQuery", query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              dispatch({ type: event.shiftKey ? "prev" : "next" });
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <span className="dohc-find-replace__count" aria-live="polite">
          {position}/{total}
        </span>
        <button
          type="button"
          className="dohc-find-replace__icon-btn"
          aria-label="previous match"
          title="previous match (Shift+Enter)"
          disabled={total === 0}
          onClick={() => dispatch({ type: "prev" })}
        >
          <ChevronUp size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="dohc-find-replace__icon-btn"
          aria-label="next match"
          title="next match (Enter)"
          disabled={total === 0}
          onClick={() => dispatch({ type: "next" })}
        >
          <ChevronDown size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={`dohc-find-replace__icon-btn${state.caseSensitive ? " is-active" : ""}`}
          aria-label="match case"
          aria-pressed={state.caseSensitive}
          title="match case"
          onClick={() => dispatch({ type: "toggleCase" })}
        >
          Aa
        </button>
        {readOnly ? null : (
          <button
            type="button"
            className={`dohc-find-replace__icon-btn${state.replaceOpen ? " is-active" : ""}`}
            aria-label={state.replaceOpen ? "hide replace" : "show replace"}
            aria-pressed={state.replaceOpen}
            title="replace"
            onClick={() => dispatch({ type: "toggleReplace" })}
          >
            <Replace size={13} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="dohc-find-replace__icon-btn"
          aria-label="close find"
          title="close (Esc)"
          onClick={close}
        >
          <X size={13} aria-hidden />
        </button>
      </div>
      {readOnly || !state.replaceOpen ? null : (
        <div className="dohc-find-replace__row dohc-find-replace__row--replace">
          <input
            type="text"
            className="dohc-find-replace__input"
            placeholder="Replace"
            value={state.replacement}
            onChange={(event) =>
              dispatch({ type: "setReplacement", replacement: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <button
            type="button"
            className="dohc-find-replace__text-btn"
            disabled={total === 0}
            onClick={() => {
              const tr = buildReplaceActiveTransaction(editor.state, state);
              if (tr) editor.view.dispatch(tr);
            }}
          >
            Replace
          </button>
          <button
            type="button"
            className="dohc-find-replace__text-btn"
            disabled={total === 0}
            onClick={() => {
              const { tr, count } = buildReplaceAllTransaction(editor.state, state);
              if (count > 0) editor.view.dispatch(tr);
            }}
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
