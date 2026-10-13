import { FileText } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { WikilinkFile } from "./wikilinkPlugin";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";
import {
  MENU_ACTIVE_OPTION,
  MENU_EMPTY,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ICON,
  MENU_PATH,
  MENU_ROW,
  MENU_ROW_TONE,
  MENU_TITLE,
  menuEnterFrom,
  movedPointer,
  moveInMenu,
  revealMenuRow,
} from "../ui/Menu";

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
type WikilinkInsertMode = "text" | "node";

type Props = {
  state: WikilinkPickerState;
  files: ReadonlyArray<WikilinkFile>;
  view: EditorView | null;
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
  view: EditorView,
  from: number,
  file: WikilinkFile,
  insertMode: WikilinkInsertMode = "text",
): void {
  const cursorPos = view.state.selection.from;
  const pathNoExt = file.path.replace(/\.md$/i, "");
  let content: ProseMirrorNode;
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
  const tr = view.state.tr.replaceWith(from, cursorPos, content);
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Stable per-instance prefix for option ids so aria-activedescendant can
  // point at the active option — the editor keeps DOM focus (onMouseDown
  // preventDefault), so this is how AT learns which file is highlighted.
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
      // During IME composition, Enter, Escape and the arrows work the
      // candidate list. Some platforms mark those keys only with keyCode 229.
      if (e.isComposing || e.keyCode === 229) return;
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
        const next = moveInMenu(e, activeIdx, matches.map((file) => file.path));
        if (next !== null) setActiveIdx(next);
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
      ref={listRef}
      className={`dohc-wikilink-picker ${MENU_FRAME} ${MENU_ENTER}`}
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
      aria-label="page links"
      aria-activedescendant={
        matches.length > 0 ? optionId(activeIdx) : undefined
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className={MENU_EMPTY}>No files match "{state.query}"</div>
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
                tabIndex={-1}
                aria-selected={i === activeIdx}
                data-active={i === activeIdx || undefined}
                className={`${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} data-active:text-ink`}
                // Only a pointer that moves picks the active option, so a
                // list that opens or scrolls under a still pointer keeps the
                // keys' choice.
                onMouseMove={(event) => {
                  if (movedPointer(event) && i !== activeIdx) setActiveIdx(i);
                }}
                onClick={() => commit(f)}
              >
                <span className={`${MENU_ICON} text-subtle`}>
                  <FileText size={14} aria-hidden />
                </span>
                <span className={MENU_TITLE}>{display}</span>
                {/* A page at the workspace root without a title: its path is its name. */}
                {subpath === display ? null : <span className={MENU_PATH}>{subpath}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
