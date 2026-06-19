import { FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { WikilinkFile } from "./wikilinkPlugin";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";

export type WikilinkPickerState =
  | { open: false }
  | {
      open: true;
      from: number;
      query: string;
    };

type Props = {
  state: WikilinkPickerState;
  files: ReadonlyArray<WikilinkFile>;
  view: {
    coordsAtPos(pos: number): { left: number; top: number; bottom: number };
    state: {
      tr: {
        replaceWith(from: number, to: number, content: unknown): unknown;
        setSelection(s: unknown): unknown;
      };
      schema: { text(s: string): unknown };
      selection: { from: number };
    };
    dispatch(tr: unknown): void;
    focus(): void;
  } | null;
  onDismiss: () => void;
};

export function WikilinkPicker({ state, files, view, onDismiss }: Props) {
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
    const q = state.query.toLowerCase().trim();
    const scored = files.map((f) => {
      const path = f.path.replace(/\.md$/i, "").toLowerCase();
      const title = (f.title ?? "").toLowerCase();
      if (q === "") return { f, score: 4 };
      const leaf = path.split("/").pop() ?? path;
      if (leaf.startsWith(q)) return { f, score: 0 };
      if (leaf.includes(q)) return { f, score: 1 };
      if (path.includes(q)) return { f, score: 2 };
      if (title.includes(q)) return { f, score: 3 };
      return { f, score: -1 };
    });
    return scored
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.f.path.localeCompare(b.f.path))
      .slice(0, 12)
      .map((x) => x.f);
  }, [state.open ? state.query : "", files, state.open]);

  function commit(file: WikilinkFile) {
    if (!view || !state.open) return;
    const cursorPos = view.state.selection.from;
    const pathNoExt = file.path.replace(/\.md$/i, "");
    const insert = `[[${pathNoExt}]]`;
    const tr = view.state.tr.replaceWith(
      state.from,
      cursorPos,
      view.state.schema.text(insert),
    ) as {
      doc: { resolve(pos: number): ResolvedPos };
      setSelection(s: unknown): unknown;
    };
    const afterInsert = state.from + insert.length;
    tr.setSelection(TextSelection.near(tr.doc.resolve(afterInsert)));
    view.dispatch(tr);
    view.focus();
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
      } else if (e.key === "Enter") {
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
    menuWidth: 360,
    menuMaxHeight: 260,
    gap: 4,
  });

  return (
    <div
      className="dohc-wikilink-picker"
      data-placement={position.placement}
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        maxHeight: position.maxHeight,
        zIndex: 60,
      }}
      role="listbox"
      aria-label="page links"
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className="dohc-wikilink-picker__empty">
          No files match "{state.query}"
        </div>
      ) : (
        <div>
          {matches.map((f, i) => {
            const display =
              (f.title ?? "").trim() ||
              (f.path.replace(/\.md$/i, "").split("/").pop() ?? f.path);
            const subpath = f.path.replace(/\.md$/i, "");
            return (
              <button
                key={f.path}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                className={`dohc-wikilink-picker__item${i === activeIdx ? " is-active" : ""}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(f)}
              >
                <FileText size={14} aria-hidden className="shrink-0 text-subtle" />
                <span className="dohc-wikilink-picker__item-title">
                  {display}
                </span>
                <span className="dohc-wikilink-picker__item-path">
                  {subpath}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
