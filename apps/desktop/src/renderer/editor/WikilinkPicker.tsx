import { FileText } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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

/** How a picked file gets written into the doc.
 *  - "text" — the `[[` picker's original behavior: insert literal
 *    `[[path]]` text. The wikilink pill comes later, from either the
 *    decoration plugin (wikilinkPlugin.ts) or a markdown round-trip.
 *  - "node" — the `@`-mention picker: insert the real `wikilink`
 *    atom node directly, with a `label` attr set to the file's
 *    display name, so it reads like a Notion mention pill
 *    immediately (no decoration/round-trip needed). */
export type WikilinkInsertMode = "text" | "node";

type PickerView = {
  coordsAtPos(pos: number): { left: number; top: number; bottom: number };
  state: {
    tr: {
      replaceWith(from: number, to: number, content: unknown): unknown;
      setSelection(s: unknown): unknown;
    };
    schema: {
      text(s: string): unknown;
      nodes: Record<string, { create(attrs?: Record<string, unknown>): unknown } | undefined>;
    };
    selection: { from: number };
  };
  dispatch(tr: unknown): void;
  focus(): void;
};

type Props = {
  state: WikilinkPickerState;
  files: ReadonlyArray<WikilinkFile>;
  view: PickerView | null;
  /** @default "text" */
  insertMode?: WikilinkInsertMode;
  onDismiss: () => void;
};

/** The picker-list display name for a file: its title, falling back
 *  to the leaf segment of its path. Shared between the list render
 *  and the "node" insert mode's `label` attr so they never drift. */
function defaultDisplayName(file: WikilinkFile): string {
  return (
    (file.title ?? "").trim() ||
    (file.path.replace(/\.md$/i, "").split("/").pop() ?? file.path)
  );
}

/** Replace the `from..cursor` range with the picked file, either as
 *  literal `[[path]]` text or as a real `wikilink` node. Exported
 *  standalone (not a closure inside the component) so it's directly
 *  testable against a real Editor without rendering React. */
export function applyWikilinkPick(
  view: PickerView,
  from: number,
  file: WikilinkFile,
  insertMode: WikilinkInsertMode = "text",
): void {
  const cursorPos = view.state.selection.from;
  const pathNoExt = file.path.replace(/\.md$/i, "");
  let content: unknown;
  let insertedSize: number;
  if (insertMode === "node") {
    const wikilinkNodeType = view.state.schema.nodes.wikilink;
    if (!wikilinkNodeType) return; // schema doesn't have the node — no-op, not a throw.
    content = wikilinkNodeType.create({
      target: pathNoExt,
      label: defaultDisplayName(file),
    });
    insertedSize = 1; // atom nodes occupy a single doc position.
  } else {
    const insert = `[[${pathNoExt}]]`;
    content = view.state.schema.text(insert);
    insertedSize = insert.length;
  }
  const tr = view.state.tr.replaceWith(from, cursorPos, content) as {
    doc: { resolve(pos: number): ResolvedPos };
    setSelection(s: unknown): unknown;
  };
  const afterInsert = from + insertedSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterInsert)));
  view.dispatch(tr);
  view.focus();
}

export function WikilinkPicker({
  state,
  files,
  view,
  insertMode = "text",
  onDismiss,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Stable per-instance prefix for option ids so aria-activedescendant can
  // point at the active option — the editor keeps DOM focus (onMouseDown
  // preventDefault), so this is how AT learns which file is highlighted.
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;

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
    applyWikilinkPick(view, state.from, file, insertMode);
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
      aria-activedescendant={
        matches.length > 0 ? optionId(activeIdx) : undefined
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className="dohc-wikilink-picker__empty">
          No files match "{state.query}"
        </div>
      ) : (
        <div>
          {matches.map((f, i) => {
            const display = defaultDisplayName(f);
            const subpath = f.path.replace(/\.md$/i, "");
            return (
              <button
                key={f.path}
                id={optionId(i)}
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
