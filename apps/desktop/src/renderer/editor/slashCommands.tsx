import { isEditableEditor } from "./pmHelpers";
import { useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  ChevronRight,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Info,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  SquareCode,
  Table,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  MENU_ACTIVE_OPTION,
  MENU_DETAIL,
  MENU_EMPTY,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ICON,
  MENU_ROW,
  MENU_ROW_TONE,
  MENU_TITLE,
  menuEnterFrom,
  movedPointer,
  revealMenuRow,
} from "../ui/Menu";
import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import { compareRelativePositions, type RelativePosition, type XmlFragment } from "yjs";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";
import { MERMAID_STARTER_SNIPPET } from "./mermaidRender";

type YTiptap = typeof import("@tiptap/y-tiptap");

export type SlashCommandId =
  | "wikilink"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bulleted-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "callout"
  | "toggle"
  | "code-block"
  | "mermaid"
  | "math"
  | "divider"
  | "table"
  | "image";

type SlashCommandItem = {
  id: SlashCommandId;
  label: string;
  hint: string;
  icon: LucideIcon;
  aliases: string[];
};

export type SlashCommandState =
  | { open: false }
  | {
      open: true;
      from: number;
      to: number;
      query: string;
      selected: number;
      x: number;
      y: number;
      // Bottom-edge anchor (CSS `bottom`) for "above" placement — see
      // FloatingMenuPosition.bottom. Null when the menu is top-anchored.
      bottom: number | null;
      maxHeight: number;
      placement: FloatingMenuPlacement;
    };

export const CLOSED_SLASH_COMMAND_STATE: SlashCommandState = { open: false };

export function slashCommandStatesEqual(
  left: SlashCommandState,
  right: SlashCommandState,
): boolean {
  if (!left.open || !right.open) return left.open === right.open;
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.query === right.query &&
    left.selected === right.selected &&
    left.x === right.x &&
    left.y === right.y &&
    left.maxHeight === right.maxHeight &&
    left.placement === right.placement
  );
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "wikilink",
    label: "Link",
    hint: "Link another page",
    icon: Link,
    aliases: ["link", "page", "wiki", "wikilink"],
  },
  {
    id: "heading-1",
    label: "Heading 1",
    hint: "Large section heading",
    icon: Heading1,
    aliases: ["h1", "heading", "title"],
  },
  {
    id: "heading-2",
    label: "Heading 2",
    hint: "Medium section heading",
    icon: Heading2,
    aliases: ["h2", "subheading", "subtitle"],
  },
  {
    id: "heading-3",
    label: "Heading 3",
    hint: "Small section heading",
    icon: Heading3,
    aliases: ["h3", "heading", "subheading"],
  },
  {
    id: "bulleted-list",
    label: "Bulleted list",
    hint: "Start a simple list",
    icon: List,
    aliases: ["bullet", "bulleted", "list", "ul"],
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    hint: "Start an ordered list",
    icon: ListOrdered,
    aliases: ["number", "numbered", "ordered", "ol"],
  },
  {
    id: "task-list",
    label: "Todo list",
    hint: "Track checkable work",
    icon: ListTodo,
    aliases: ["todo", "task", "checklist", "checkbox"],
  },
  {
    id: "quote",
    label: "Quote",
    hint: "Call out a thought",
    icon: Quote,
    aliases: ["blockquote", "quote"],
  },
  {
    id: "callout",
    label: "Callout",
    hint: "Highlighted info box",
    icon: Info,
    aliases: [
      "callout",
      "note",
      "tip",
      "info",
      "warning",
      "danger",
      "admonition",
      "aside",
    ],
  },
  {
    id: "toggle",
    label: "Toggle",
    hint: "Collapsible callout",
    icon: ChevronRight,
    aliases: ["toggle", "fold", "collapse", "details", "accordion"],
  },
  {
    id: "code-block",
    label: "Code block",
    hint: "Write code or raw text",
    icon: SquareCode,
    aliases: ["code", "fence", "pre"],
  },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    hint: "Flowchart, sequence & more",
    icon: Workflow,
    aliases: ["mermaid", "diagram", "flowchart", "chart", "graph"],
  },
  {
    id: "math",
    label: "Math block",
    hint: "TeX equation with $$",
    icon: Sigma,
    aliases: ["math", "equation", "tex", "latex", "katex"],
  },
  {
    id: "divider",
    label: "Divider",
    hint: "Separate sections",
    icon: Minus,
    aliases: ["divider", "line", "rule", "separator", "hr"],
  },
  {
    id: "table",
    label: "Table",
    hint: "Insert a simple grid",
    icon: Table,
    aliases: ["table", "grid", "rows", "columns"],
  },
  {
    id: "image",
    label: "Image",
    hint: "Upload a picture",
    icon: Image,
    aliases: ["image", "img", "picture", "photo", "upload"],
  },
];

const slashCommandKey = new PluginKey<DismissedSlash | null>("dohc-slash-command");

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) => {
    if (command.label.toLowerCase().includes(normalized)) return true;
    return command.aliases.some((alias) => alias.includes(normalized));
  });
}

export function findSlashCommandMatch(
  textBeforeCursor: string,
): { slashOffset: number; query: string } | null {
  const match = /(?:^|\s)\/([A-Za-z0-9_-]{0,40})$/.exec(textBeforeCursor);
  if (!match) return null;
  const matchedText = match[0] ?? "";
  const slashOffset = match.index + matchedText.lastIndexOf("/");
  return { slashOffset, query: match[1]?.toLowerCase() ?? "" };
}

// The trigger the caret is in: its "/" position and the query typed after it.
function findSlashTrigger(state: EditorState): { from: number; query: string } | null {
  const selection = state.selection;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const match = findSlashCommandMatch($from.parent.textBetween(0, $from.parentOffset));
  return match ? { from: $from.start() + match.slashOffset, query: match.query } : null;
}

// The "/" whose menu Escape closed, with a Y.js anchor on it when the editor
// is bound to a Y.Doc.
type DismissedSlash = { from: number; anchor: RelativePosition | null };

type YSyncState = { type: XmlFragment; binding: ProsemirrorBinding };

// y-tiptap anchors a position to the character before it, so the position
// after the "/" anchors the "/" itself.
function anchorSlash(yTiptap: YTiptap, sync: YSyncState, from: number): RelativePosition {
  return yTiptap.absolutePositionToRelativePosition(from + 1, sync.type, sync.binding.mapping);
}

function readSlashCommandState(
  view: EditorView,
  previous: SlashCommandState,
): SlashCommandState {
  if (view.editable === false) {
    return CLOSED_SLASH_COMMAND_STATE;
  }

  const trigger = findSlashTrigger(view.state);
  if (!trigger || slashCommandKey.getState(view.state)?.from === trigger.from) {
    return CLOSED_SLASH_COMMAND_STATE;
  }

  const from = trigger.from;
  const to = view.state.selection.from;
  let x = 12;
  let y = 40;
  let bottom: number | null = null;
  let maxHeight = FLOATING_MENU_MAX_HEIGHT;
  let placement: FloatingMenuPlacement = "below";
  try {
    const coords = view.coordsAtPos(from);
    const position = resolveFloatingMenuPosition({ cursorRect: coords });
    x = position.x;
    y = position.y;
    bottom = position.bottom ?? null;
    maxHeight = position.maxHeight;
    placement = position.placement;
  } catch {
    // Offscreen/jsdom editors cannot always resolve coordinates.
  }

  const query = trigger.query;
  const selected = previous.open && previous.query === query ? previous.selected : 0;
  const itemCount = filterSlashCommands(query).length;
  return {
    open: true,
    from,
    to,
    query,
    selected: itemCount ? Math.min(selected, itemCount - 1) : 0,
    x,
    y,
    bottom,
    maxHeight,
    placement,
  };
}

export function makeSlashCommandPlugin({
  stateRef,
  setState,
  runCommandRef,
  yTiptap = null,
}: {
  stateRef: RefObject<SlashCommandState>;
  setState: Dispatch<SetStateAction<SlashCommandState>>;
  runCommandRef: RefObject<(id: SlashCommandId) => void>;
  // The lazily loaded y-tiptap module, when the editor is bound to a Y.Doc.
  yTiptap?: YTiptap | null;
}) {
  const publish = (next: SlashCommandState) => {
    if (slashCommandStatesEqual(stateRef.current, next)) return;
    stateRef.current = next;
    setState(next);
  };

  const close = () => publish(CLOSED_SLASH_COMMAND_STATE);

  const refresh = (view: EditorView) => {
    const next = readSlashCommandState(view, stateRef.current);
    publish(next);
  };

  return new Plugin<DismissedSlash | null>({
    key: slashCommandKey,
    // The menu stays closed while the caret is in the dismissed trigger.
    // Leaving it and coming back, or a new "/", opens the menu.
    state: {
      init: () => null,
      apply(tr, dismissed, oldState, state) {
        const dismissing = tr.getMeta(slashCommandKey) === true;
        if (!dismissed && !dismissing) return null;
        const trigger = findSlashTrigger(state);
        if (!trigger) return null;
        // Read from the old state: this state's later plugins aren't built yet.
        const sync: YSyncState | undefined = yTiptap?.ySyncPluginKey.getState(oldState);
        const anchor = (from: number) => (yTiptap && sync ? anchorSlash(yTiptap, sync, from) : null);
        if (dismissing || !dismissed) return { from: trigger.from, anchor: anchor(trigger.from) };

        // Y.js applies a remote edit, or an undo, by replacing the whole
        // document, which maps every position away. Its anchor still finds the
        // "/" when the "/" survives.
        const change: { isChangeOrigin?: boolean } | undefined = yTiptap
          ? tr.getMeta(yTiptap.ySyncPluginKey)
          : undefined;
        const mapped = tr.mapping.mapResult(dismissed.from);
        const same = change?.isChangeOrigin
          ? dismissed.anchor !== null &&
            compareRelativePositions(dismissed.anchor, anchor(trigger.from))
          : !mapped.deleted && mapped.pos === trigger.from;
        return same ? { from: trigger.from, anchor: dismissed.anchor } : null;
      },
    },
    view(view) {
      refresh(view);
      return {
        update(nextView) {
          refresh(nextView);
        },
        destroy() {
          close();
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        const slashState = stateRef.current;
        if (!slashState.open) return false;

        const items = filterSlashCommands(slashState.query);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          publish({
            ...slashState,
            selected: items.length ? (slashState.selected + 1) % items.length : 0,
          });
          return true;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          publish({
            ...slashState,
            selected: items.length
              ? (slashState.selected - 1 + items.length) % items.length
              : 0,
          });
          return true;
        }

        if (event.key === "Enter" || event.key === "Tab") {
          const command = items[slashState.selected] ?? items[0];
          if (!command) return false;
          event.preventDefault();
          runCommandRef.current(command.id);
          return true;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          view.dispatch(view.state.tr.setMeta(slashCommandKey, true));
          view.focus();
          return true;
        }

        return false;
      },
    },
  });
}

// The slash menu, drawn from the Menu part's recipe. The editor keeps focus
// and its keys move the active option (handleKeyDown above), so the option
// takes the selected fill whenever it is active, and the list scrolls only
// itself to show it.
export function SlashCommandMenu({
  state,
  onSelect,
  onHover,
}: {
  state: SlashCommandState;
  onSelect: (id: SlashCommandId) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = state.open ? state.selected : -1;
  const query = state.open ? state.query : "";
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && selected >= 0) revealMenuRow(list, optionRefs.current[selected]);
  }, [selected, query]);

  if (!state.open) return null;
  const items = filterSlashCommands(state.query);

  return (
    <div
      ref={listRef}
      className={`dohc-slash-menu ${MENU_FRAME} ${MENU_ENTER}`}
      data-placement={state.placement}
      // Above the cursor the menu anchors by its bottom edge: filtering
      // changes its content height, and a top-anchored box (whose top assumes
      // the full maxHeight) would leap up and down with every keystroke.
      style={{
        ...(state.placement === "above" && state.bottom !== null
          ? { left: state.x, bottom: state.bottom, maxHeight: state.maxHeight }
          : { left: state.x, top: state.y, maxHeight: state.maxHeight }),
        ...menuEnterFrom(state.placement),
      }}
      role="listbox"
      aria-label="slash commands"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length ? (
        items.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === state.selected}
              data-active={index === state.selected || undefined}
              className={`dohc-slash-menu__item ${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} data-active:text-ink`}
              // Only a pointer that moves picks the active option, so a menu
              // that opens or scrolls under a still pointer keeps the keys'.
              onMouseMove={(event) => {
                if (movedPointer(event) && index !== state.selected) onHover(index);
              }}
              onClick={() => onSelect(item.id)}
            >
              <span className={`${MENU_ICON} text-subtle`}>
                <Icon size={14} aria-hidden />
              </span>
              <span className={MENU_TITLE}>{item.label}</span>
              <span className={MENU_DETAIL}>{item.hint}</span>
            </button>
          );
        })
      ) : (
        <div className={MENU_EMPTY}>No commands</div>
      )}
    </div>
  );
}

// Select the empty `mathBlock` closest to the insertion point so its NodeView
// opens in edit mode. Scanning (rather than trusting a computed position) is
// robust to how block insertion reshapes the surrounding paragraph/caret.
function selectInsertedMathBlock(editor: Editor, near: number): void {
  editor.commands.command(({ tr, dispatch }) => {
    let target: number | null = null;
    tr.doc.descendants((node, pos) => {
      if (node.type.name !== "mathBlock") return;
      if (String(node.attrs.tex ?? "") !== "") return;
      if (target === null || Math.abs(pos - near) < Math.abs(target - near)) {
        target = pos;
      }
    });
    if (target === null) return false;
    if (dispatch) tr.setSelection(NodeSelection.create(tr.doc, target));
    return true;
  });
}

// The callout command matches several type-named aliases (see its `aliases`).
// When the query is one of the concrete callout types, insert that type; every
// other alias ("callout"/"admonition"/"aside") falls back to a plain note.
const CALLOUT_TYPE_BY_ALIAS: Record<string, string> = {
  note: "note",
  tip: "tip",
  info: "info",
  warning: "warning",
  danger: "danger",
};

function calloutTypeForQuery(query: string): string {
  return CALLOUT_TYPE_BY_ALIAS[query.trim().toLowerCase()] ?? "note";
}

export function runSlashCommand(
  editor: Editor | null,
  id: SlashCommandId,
  state: SlashCommandState,
  setSlashState: Dispatch<SetStateAction<SlashCommandState>>,
  // `/image` doesn't insert text like the other commands — it opens a native
  // file picker and, once files are chosen, writes+inserts them the same way
  // paste/drop do. That pathway lives in imagePaste.ts and needs the current
  // document's workspace context, which this module doesn't know about — so
  // MarkdownEditor.tsx threads it in as a callback, the same way it threads
  // `openSlashMenuAtPosition` into `insertBlockAfter`.
  insertImage?: (view: EditorView, pos: number) => void,
): void {
  if (!state.open || !editor || !isEditableEditor(editor)) return;

  const range = { from: state.from, to: state.to };
  const chain = editor.chain().focus().deleteRange(range);
  setSlashState(CLOSED_SLASH_COMMAND_STATE);

  switch (id) {
    case "wikilink":
      chain.insertContent("[[]]").setTextSelection(state.from + 2).run();
      return;
    case "heading-1":
      chain.toggleHeading({ level: 1 }).run();
      return;
    case "heading-2":
      chain.toggleHeading({ level: 2 }).run();
      return;
    case "heading-3":
      chain.toggleHeading({ level: 3 }).run();
      return;
    case "bulleted-list":
      chain.toggleBulletList().run();
      return;
    case "numbered-list":
      chain.toggleOrderedList().run();
      return;
    case "task-list":
      chain.toggleTaskList().run();
      return;
    case "quote":
      chain.toggleBlockquote().run();
      return;
    case "callout":
      chain
        .insertContent({
          type: "callout",
          // A type-specific alias (`/warning`, `/info`, …) inserts that type
          // directly instead of always defaulting to a note the user then has
          // to switch by hand.
          attrs: { calloutType: calloutTypeForQuery(state.query), title: "", fold: "" },
          content: [{ type: "paragraph" }],
        })
        .run();
      return;
    case "toggle":
      chain
        .insertContent({
          type: "callout",
          attrs: { calloutType: "note", title: "", fold: "-" },
          content: [{ type: "paragraph" }],
        })
        .run();
      return;
    case "code-block":
      chain.setCodeBlock({ language: "" }).run();
      return;
    case "mermaid":
      chain.setCodeBlock({ language: "mermaid" }).insertContent(MERMAID_STARTER_SNIPPET).run();
      return;
    case "math":
      // Insert an empty `$$` block, then select it so its NodeView opens
      // straight into the source editor (selectNode → edit mode), ready for
      // TeX input. Selection is resolved by scanning for the inserted node
      // rather than a guessed position (block insertion shifts the caret).
      chain.insertContent({ type: "mathBlock", attrs: { tex: "" } }).run();
      selectInsertedMathBlock(editor, state.from);
      return;
    case "divider":
      chain.setHorizontalRule().run();
      return;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      return;
    case "image":
      chain.run();
      insertImage?.(editor.view, state.from);
      return;
  }
}
