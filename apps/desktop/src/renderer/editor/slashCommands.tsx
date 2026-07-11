import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";

export type SlashCommandId =
  | "wikilink"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bulleted-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "code-block"
  | "divider"
  | "table"
  | "image";

export type SlashCommandItem = {
  id: SlashCommandId;
  label: string;
  hint: string;
  glyph: string;
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
      maxHeight: number;
      placement: FloatingMenuPlacement;
    };

export const CLOSED_SLASH_COMMAND_STATE: SlashCommandState = { open: false };

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "wikilink",
    label: "Link",
    hint: "Link another page",
    glyph: "[[",
    aliases: ["link", "page", "wiki", "wikilink"],
  },
  {
    id: "heading-1",
    label: "Heading 1",
    hint: "Large section heading",
    glyph: "H1",
    aliases: ["h1", "heading", "title"],
  },
  {
    id: "heading-2",
    label: "Heading 2",
    hint: "Medium section heading",
    glyph: "H2",
    aliases: ["h2", "subheading", "subtitle"],
  },
  {
    id: "heading-3",
    label: "Heading 3",
    hint: "Small section heading",
    glyph: "H3",
    aliases: ["h3", "heading", "subheading"],
  },
  {
    id: "bulleted-list",
    label: "Bulleted list",
    hint: "Start a simple list",
    glyph: "-",
    aliases: ["bullet", "bulleted", "list", "ul"],
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    hint: "Start an ordered list",
    glyph: "1.",
    aliases: ["number", "numbered", "ordered", "ol"],
  },
  {
    id: "task-list",
    label: "Todo list",
    hint: "Track checkable work",
    glyph: "[]",
    aliases: ["todo", "task", "checklist", "checkbox"],
  },
  {
    id: "quote",
    label: "Quote",
    hint: "Call out a thought",
    glyph: ">",
    aliases: ["blockquote", "quote"],
  },
  {
    id: "code-block",
    label: "Code block",
    hint: "Write code or raw text",
    glyph: "</>",
    aliases: ["code", "fence", "pre"],
  },
  {
    id: "divider",
    label: "Divider",
    hint: "Separate sections",
    glyph: "-",
    aliases: ["divider", "line", "rule", "separator", "hr"],
  },
  {
    id: "table",
    label: "Table",
    hint: "Insert a simple grid",
    glyph: "tbl",
    aliases: ["table", "grid", "rows", "columns"],
  },
  {
    id: "image",
    label: "Image",
    hint: "Upload a picture",
    glyph: "img",
    aliases: ["image", "img", "picture", "photo", "upload"],
  },
];

const slashCommandKey = new PluginKey("dohc-slash-command");

type SlashCommandChain = {
  deleteRange: (range: { from: number; to: number }) => SlashCommandChain;
  focus: () => SlashCommandChain;
  insertContent: (content: unknown) => SlashCommandChain;
  insertTable: (options: {
    rows: number;
    cols: number;
    withHeaderRow: boolean;
  }) => SlashCommandChain;
  run: () => boolean;
  setCodeBlock: (attrs?: { language?: string }) => SlashCommandChain;
  setHorizontalRule: () => SlashCommandChain;
  setTextSelection: (pos: number) => SlashCommandChain;
  toggleBlockquote: () => SlashCommandChain;
  toggleBulletList: () => SlashCommandChain;
  toggleHeading: (attrs: { level: 1 | 2 | 3 }) => SlashCommandChain;
  toggleOrderedList: () => SlashCommandChain;
  toggleTaskList: () => SlashCommandChain;
};

function isEditableEditor(editor: Editor | null | undefined): boolean {
  if (!editor) return false;
  if ((editor as { isEditable?: boolean }).isEditable === false) return false;
  if ((editor.view as { editable?: boolean }).editable === false) return false;
  return true;
}

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

function readSlashCommandState(
  view: EditorView,
  previous: SlashCommandState,
): SlashCommandState {
  if ((view as { editable?: boolean }).editable === false) {
    return CLOSED_SLASH_COMMAND_STATE;
  }

  const state = view.state as EditorState;
  const selection = state.selection;
  if (!selection.empty) return CLOSED_SLASH_COMMAND_STATE;

  const $from = selection.$from;
  if (!$from.parent.isTextblock) return CLOSED_SLASH_COMMAND_STATE;
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset);
  const match = findSlashCommandMatch(textBeforeCursor);
  if (!match) return CLOSED_SLASH_COMMAND_STATE;

  const from = $from.start() + match.slashOffset;
  const to = selection.from;
  let x = 12;
  let y = 40;
  let maxHeight = FLOATING_MENU_MAX_HEIGHT;
  let placement: FloatingMenuPlacement = "below";
  try {
    const coords = view.coordsAtPos(from);
    const position = resolveFloatingMenuPosition({ cursorRect: coords });
    x = position.x;
    y = position.y;
    maxHeight = position.maxHeight;
    placement = position.placement;
  } catch {
    // Offscreen/jsdom editors cannot always resolve coordinates.
  }

  const query = match.query;
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
    maxHeight,
    placement,
  };
}

export function makeSlashCommandPlugin({
  stateRef,
  setState,
  runCommandRef,
}: {
  stateRef: RefObject<SlashCommandState>;
  setState: Dispatch<SetStateAction<SlashCommandState>>;
  runCommandRef: RefObject<(id: SlashCommandId) => void>;
}) {
  const close = () => setState(CLOSED_SLASH_COMMAND_STATE);

  const refresh = (view: EditorView) => {
    const next = readSlashCommandState(view, stateRef.current);
    setState(next);
  };

  return new Plugin({
    key: slashCommandKey,
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
          setState((current) =>
            current.open
              ? {
                  ...current,
                  selected: items.length ? (current.selected + 1) % items.length : 0,
                }
              : current,
          );
          return true;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setState((current) =>
            current.open
              ? {
                  ...current,
                  selected: items.length
                    ? (current.selected - 1 + items.length) % items.length
                    : 0,
                }
              : current,
          );
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
          close();
          view.focus();
          return true;
        }

        return false;
      },
    },
  });
}

export function SlashCommandMenu({
  state,
  onSelect,
  onHover,
}: {
  state: SlashCommandState;
  onSelect: (id: SlashCommandId) => void;
  onHover: (index: number) => void;
}) {
  if (!state.open) return null;
  const items = filterSlashCommands(state.query);

  return (
    <div
      className="dohc-slash-menu"
      data-placement={state.placement}
      style={{ left: state.x, top: state.y, maxHeight: state.maxHeight }}
      role="listbox"
      aria-label="slash commands"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length ? (
        items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === state.selected}
            className={`dohc-slash-menu__item${index === state.selected ? " is-selected" : ""}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(item.id)}
          >
            <span className="dohc-slash-menu__glyph">{item.glyph}</span>
            <span className="dohc-slash-menu__copy">
              <span className="dohc-slash-menu__label">{item.label}</span>
              <span className="dohc-slash-menu__hint">{item.hint}</span>
            </span>
          </button>
        ))
      ) : (
        <div className="dohc-slash-menu__empty">No commands</div>
      )}
    </div>
  );
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
  const chain = editor
    .chain()
    .focus()
    .deleteRange(range) as unknown as SlashCommandChain;
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
    case "code-block":
      chain.setCodeBlock({ language: "" }).run();
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
