import { isCodeBlock, isCodeMark, isEditableEditor } from "./pmHelpers";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
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
  MENU_SECTION,
  MENU_TITLE,
  menuEnterFrom,
  movedPointer,
  revealMenuRow,
} from "../ui/Menu";
import type { Editor } from "@tiptap/core";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import { compareRelativePositions, type RelativePosition, type XmlFragment } from "yjs";
import { isComposingKey } from "../ui/keys";
import {
  FLOATING_MENU_MAX_HEIGHT,
  FLOATING_LIST_MIN_HEIGHT,
  floatingMenuBounds,
  resolveFloatingMenuPosition,
  useCloseOnScrollAway,
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

type SlashCommandSection = "Basic blocks" | "Lists" | "Blocks" | "Media & links";

type SlashCommandItem = {
  id: SlashCommandId;
  section: SlashCommandSection;
  label: string;
  hint: string;
  icon: LucideIcon;
  aliases: string[];
};

export type GutterSlashTarget = {
  blockPos: number;
  reuseEmpty: boolean;
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
      maxWidth?: number;
      placement: FloatingMenuPlacement;
      gutterTarget?: GutterSlashTarget;
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
    left.maxWidth === right.maxWidth &&
    left.placement === right.placement &&
    left.gutterTarget?.blockPos === right.gutterTarget?.blockPos &&
    left.gutterTarget?.reuseEmpty === right.gutterTarget?.reuseEmpty
  );
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "heading-1",
    section: "Basic blocks",
    label: "Heading 1",
    hint: "Large section heading",
    icon: Heading1,
    aliases: ["h1", "heading", "title"],
  },
  {
    id: "heading-2",
    section: "Basic blocks",
    label: "Heading 2",
    hint: "Medium section heading",
    icon: Heading2,
    aliases: ["h2", "subheading", "subtitle"],
  },
  {
    id: "heading-3",
    section: "Basic blocks",
    label: "Heading 3",
    hint: "Small section heading",
    icon: Heading3,
    aliases: ["h3", "heading", "subheading"],
  },
  {
    id: "bulleted-list",
    section: "Lists",
    label: "Bulleted list",
    hint: "Start a bulleted list",
    icon: List,
    aliases: ["bullet", "bulleted", "list", "ul"],
  },
  {
    id: "numbered-list",
    section: "Lists",
    label: "Numbered list",
    hint: "Start an ordered list",
    icon: ListOrdered,
    aliases: ["number", "numbered", "ordered", "ol"],
  },
  {
    id: "task-list",
    section: "Lists",
    label: "Todo list",
    hint: "Track tasks with checkboxes",
    icon: ListTodo,
    aliases: ["todo", "task", "checklist", "checkbox"],
  },
  {
    id: "quote",
    section: "Blocks",
    label: "Quote",
    hint: "Insert a block quote",
    icon: Quote,
    aliases: ["blockquote", "quote"],
  },
  {
    id: "callout",
    section: "Blocks",
    label: "Callout",
    hint: "Highlighted info box",
    icon: Info,
    aliases: ["callout", "note", "tip", "info", "warning", "danger", "admonition", "aside"],
  },
  {
    id: "toggle",
    section: "Blocks",
    label: "Toggle",
    hint: "Collapsible section",
    icon: ChevronRight,
    aliases: ["toggle", "fold", "collapse", "details", "accordion"],
  },
  {
    id: "code-block",
    section: "Blocks",
    label: "Code block",
    hint: "Write code or raw text",
    icon: SquareCode,
    aliases: ["code", "fence", "pre"],
  },
  {
    id: "table",
    section: "Blocks",
    label: "Table",
    hint: "Insert rows and columns",
    icon: Table,
    aliases: ["table", "grid", "rows", "columns"],
  },
  {
    id: "divider",
    section: "Blocks",
    label: "Divider",
    hint: "Separate sections",
    icon: Minus,
    aliases: ["divider", "line", "rule", "separator", "hr"],
  },
  {
    id: "math",
    section: "Blocks",
    label: "Math block",
    hint: "TeX equation with $$",
    icon: Sigma,
    aliases: ["math", "equation", "tex", "latex", "katex"],
  },
  {
    id: "mermaid",
    section: "Blocks",
    label: "Mermaid diagram",
    hint: "Flowchart, sequence & more",
    icon: Workflow,
    aliases: ["mermaid", "diagram", "flowchart", "chart", "graph"],
  },
  {
    id: "image",
    section: "Media & links",
    label: "Image",
    hint: "Insert an image",
    icon: Image,
    aliases: ["image", "img", "picture", "photo", "upload"],
  },
  {
    id: "wikilink",
    section: "Media & links",
    label: "Link",
    hint: "Link another page",
    icon: Link,
    aliases: ["link", "page", "wiki", "wikilink"],
  },
];

type GutterSlashPending = GutterSlashTarget & {
  xmlChild: ReturnType<XmlFragment["get"]> | null;
};

type SlashPluginState = {
  dismissed: DismissedSlash | null;
  gutter: GutterSlashPending | null;
};

type SlashPluginMeta = { type: "dismiss" } | { type: "open-gutter"; target: GutterSlashTarget };

const EMPTY_SLASH_PLUGIN_STATE: SlashPluginState = { dismissed: null, gutter: null };

const slashCommandKey = new PluginKey<SlashPluginState>("dohc-slash-command");

export function openGutterSlashCommand(view: EditorView, target: GutterSlashTarget): void {
  view.dispatch(
    view.state.tr
      .setMeta(slashCommandKey, { type: "open-gutter", target } satisfies SlashPluginMeta)
      .setMeta("addToHistory", false),
  );
}

export function dismissSlashCommand(view: EditorView): void {
  view.dispatch(
    view.state.tr
      .setMeta(slashCommandKey, { type: "dismiss" } satisfies SlashPluginMeta)
      .setMeta("addToHistory", false),
  );
}

function slashCommandScore(command: SlashCommandItem, normalized: string): number {
  const label = command.label.toLowerCase();
  if (label === normalized || command.aliases.some((alias) => alias === normalized)) return 0;
  if (label.startsWith(normalized)) return 1;
  if (command.aliases.some((alias) => alias.startsWith(normalized))) return 2;
  if (label.includes(normalized)) return 3;
  if (command.aliases.some((alias) => alias.includes(normalized))) return 4;
  return -1;
}

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return SLASH_COMMANDS;
  return SLASH_COMMANDS.map((command, index) => ({
    command,
    index,
    score: slashCommandScore(command, normalized),
  }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.command);
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
  if (isCodeBlock($from.parent)) return null;
  if ((state.storedMarks ?? $from.marks()).some(isCodeMark)) return null;
  // Each leaf counts as one character, its size, so offsets are positions.
  // A hard break starts a line, where a "/" opens the menu.
  const match = findSlashCommandMatch(
    $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
      leaf.type.name === "hardBreak" ? "\n" : "￼",
    ),
  );
  if (!match) return null;
  const from = $from.start() + match.slashOffset;
  if (state.doc.nodeAt(from)?.marks.some(isCodeMark)) return null;
  return { from, query: match.query };
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

function readSlashCommandState(view: EditorView, previous: SlashCommandState): SlashCommandState {
  if (view.editable === false) {
    return CLOSED_SLASH_COMMAND_STATE;
  }

  const pluginState = slashCommandKey.getState(view.state);
  const gutter = pluginState?.gutter ?? null;
  if (gutter) {
    const node = view.state.doc.nodeAt(gutter.blockPos);
    if (!node) return CLOSED_SLASH_COMMAND_STATE;
    const anchorPos = gutter.reuseEmpty
      ? Math.min(gutter.blockPos + 1, view.state.doc.content.size)
      : Math.min(gutter.blockPos + node.nodeSize, view.state.doc.content.size);
    let x = 12;
    let y = 40;
    let bottom: number | null = null;
    let maxHeight = FLOATING_MENU_MAX_HEIGHT;
    let maxWidth: number | undefined;
    let placement: FloatingMenuPlacement = "below";
    try {
      const dom = view.nodeDOM(gutter.blockPos);
      const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
      const cursorRect =
        rect && (rect.width > 0 || rect.height > 0)
          ? { left: rect.left, top: rect.bottom, bottom: rect.bottom }
          : view.coordsAtPos(anchorPos);
      const position = resolveFloatingMenuPosition({
        cursorRect,
        bounds: floatingMenuBounds(view.dom),
        menuMinHeight: FLOATING_LIST_MIN_HEIGHT,
      });
      x = position.x;
      y = position.y;
      bottom = position.bottom ?? null;
      maxHeight = position.maxHeight;
      maxWidth = position.maxWidth;
      placement = position.placement;
    } catch {
      // Offscreen/jsdom editors cannot always resolve coordinates.
    }
    const selected = previous.open && previous.query === "" ? previous.selected : 0;
    const itemCount = SLASH_COMMANDS.length;
    return {
      open: true,
      from: anchorPos,
      to: anchorPos,
      query: "",
      selected: itemCount ? Math.min(selected, itemCount - 1) : 0,
      x,
      y,
      bottom,
      maxHeight,
      maxWidth,
      placement,
      gutterTarget: { blockPos: gutter.blockPos, reuseEmpty: gutter.reuseEmpty },
    };
  }

  const trigger = findSlashTrigger(view.state);
  if (!trigger || pluginState?.dismissed?.from === trigger.from) {
    return CLOSED_SLASH_COMMAND_STATE;
  }

  const from = trigger.from;
  const to = view.state.selection.from;
  let x = 12;
  let y = 40;
  let bottom: number | null = null;
  let maxHeight = FLOATING_MENU_MAX_HEIGHT;
  let maxWidth: number | undefined;
  let placement: FloatingMenuPlacement = "below";
  try {
    const coords = view.coordsAtPos(from);
    const position = resolveFloatingMenuPosition({
      cursorRect: coords,
      bounds: floatingMenuBounds(view.dom),
      menuMinHeight: FLOATING_LIST_MIN_HEIGHT,
    });
    x = position.x;
    y = position.y;
    bottom = position.bottom ?? null;
    maxHeight = position.maxHeight;
    maxWidth = position.maxWidth;
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
    maxWidth,
    placement,
  };
}

function materializeGutterText(
  view: EditorView,
  gutter: GutterSlashPending,
  text: string,
): boolean {
  const { state } = view;
  const node = state.doc.nodeAt(gutter.blockPos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || !paragraph) return false;
  const reuse =
    gutter.reuseEmpty && node.type.name === "paragraph" && node.textContent.length === 0;
  const insertAt = reuse ? gutter.blockPos + 1 : gutter.blockPos + node.nodeSize + 1;
  const tr = reuse
    ? state.tr
    : state.tr.insert(gutter.blockPos + node.nodeSize, paragraph.create());
  const inserted = text === "/" ? "/" : /^[A-Za-z0-9_-]+$/u.test(text) ? `/${text}` : text;
  tr.insertText(inserted, insertAt);
  tr.setSelection(TextSelection.create(tr.doc, insertAt + inserted.length)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

function topLevelChildIndexAt(doc: EditorState["doc"], blockPos: number): number {
  let found = -1;
  let index = 0;
  doc.forEach((_child, pos) => {
    if (pos === blockPos) found = index;
    index += 1;
  });
  return found;
}

function topLevelBlockPosAtIndex(doc: EditorState["doc"], childIndex: number): number | null {
  if (childIndex < 0 || childIndex >= doc.childCount) return null;
  let pos = 0;
  for (let index = 0; index < childIndex; index += 1) {
    pos += doc.child(index).nodeSize;
  }
  return pos;
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

  return new Plugin<SlashPluginState>({
    key: slashCommandKey,
    // The menu stays closed while the caret is in the dismissed trigger.
    // Leaving it and coming back, or a new "/", opens the menu.
    state: {
      init: () => EMPTY_SLASH_PLUGIN_STATE,
      apply(tr, prev, oldState, state) {
        const meta = tr.getMeta(slashCommandKey) as SlashPluginMeta | undefined;
        // Read from the old state: this state's later plugins aren't built yet.
        const sync: YSyncState | undefined = yTiptap?.ySyncPluginKey.getState(oldState);
        const anchor = (from: number) =>
          yTiptap && sync ? anchorSlash(yTiptap, sync, from) : null;

        if (meta?.type === "open-gutter") {
          const childIndex = topLevelChildIndexAt(state.doc, meta.target.blockPos);
          const xmlChild =
            sync && childIndex >= 0 && childIndex < sync.type.length
              ? sync.type.get(childIndex)
              : null;
          return {
            dismissed: prev.dismissed,
            gutter: { ...meta.target, xmlChild },
          };
        }

        const dismissing = meta?.type === "dismiss";
        const change: { isChangeOrigin?: boolean } | undefined = yTiptap
          ? tr.getMeta(yTiptap.ySyncPluginKey)
          : undefined;

        let gutter: GutterSlashPending | null = null;
        if (prev.gutter && !dismissing) {
          if (change?.isChangeOrigin) {
            let nextBlockPos: number | null = null;
            if (sync && prev.gutter.xmlChild !== null) {
              const targetChild = prev.gutter.xmlChild;
              const nextIndex = sync.type.toArray().findIndex((child) => child === targetChild);
              if (nextIndex >= 0) nextBlockPos = topLevelBlockPosAtIndex(state.doc, nextIndex);
            } else {
              const mapped = tr.mapping.mapResult(prev.gutter.blockPos);
              if (!mapped.deleted) nextBlockPos = mapped.pos;
            }
            const node = nextBlockPos !== null ? state.doc.nodeAt(nextBlockPos) : null;
            if (nextBlockPos !== null && node) {
              gutter = {
                blockPos: nextBlockPos,
                reuseEmpty: node.type.name === "paragraph" && node.textContent.length === 0,
                xmlChild: prev.gutter.xmlChild,
              };
            }
          } else if (!tr.docChanged && !tr.selectionSet) {
            gutter = prev.gutter;
          }
        }

        const trigger = findSlashTrigger(state);
        if (!prev.dismissed && !dismissing) {
          return gutter ? { dismissed: null, gutter } : EMPTY_SLASH_PLUGIN_STATE;
        }
        if (!trigger) return gutter ? { dismissed: null, gutter } : EMPTY_SLASH_PLUGIN_STATE;
        if (dismissing || !prev.dismissed) {
          return {
            dismissed: { from: trigger.from, anchor: anchor(trigger.from) },
            gutter: null,
          };
        }

        // Y.js applies a remote edit, or an undo, by replacing the whole
        // document, which maps every position away. Its anchor still finds the
        // "/" when the "/" survives.
        const mapped = tr.mapping.mapResult(prev.dismissed.from);
        const same = change?.isChangeOrigin
          ? prev.dismissed.anchor !== null &&
            compareRelativePositions(prev.dismissed.anchor, anchor(trigger.from))
          : !mapped.deleted && mapped.pos === trigger.from;
        return same
          ? { dismissed: { from: trigger.from, anchor: prev.dismissed.anchor }, gutter }
          : gutter
            ? { dismissed: null, gutter }
            : EMPTY_SLASH_PLUGIN_STATE;
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
      handleDOMEvents: {
        compositionstart(view) {
          if (slashCommandKey.getState(view.state)?.gutter) dismissSlashCommand(view);
          return false;
        },
        paste(view) {
          if (slashCommandKey.getState(view.state)?.gutter) dismissSlashCommand(view);
          return false;
        },
      },
      handleTextInput(view, _from, _to, text) {
        const gutter = slashCommandKey.getState(view.state)?.gutter;
        if (!gutter || text.length === 0) return false;
        return materializeGutterText(view, gutter, text);
      },
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
            selected: items.length ? (slashState.selected - 1 + items.length) % items.length : 0,
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
          dismissSlashCommand(view);
          view.focus();
          return true;
        }

        const gutter = slashCommandKey.getState(view.state)?.gutter;
        if (gutter) {
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            dismissSlashCommand(view);
            return true;
          }
          if (
            !isComposingKey(event) &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            event.key.length === 1
          ) {
            event.preventDefault();
            return materializeGutterText(view, gutter, event.key);
          }
        }

        return false;
      },
    },
  });
}

function groupSlashCommands(items: SlashCommandItem[]): Array<{
  section: SlashCommandSection;
  entries: Array<{ item: SlashCommandItem; index: number }>;
}> {
  const groups: Array<{
    section: SlashCommandSection;
    entries: Array<{ item: SlashCommandItem; index: number }>;
  }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const last = groups[groups.length - 1];
    if (last && last.section === item.section) {
      last.entries.push({ item, index });
    } else {
      groups.push({ section: item.section, entries: [{ item, index }] });
    }
  }
  return groups;
}

// The slash menu, drawn from the Menu part's recipe. The editor keeps focus
// and its keys move the active option (handleKeyDown above), so the option
// takes the selected fill whenever it is active, and the list scrolls only
// itself to show it.
export function SlashCommandMenu({
  state,
  view = null,
  onSelect,
  onHover,
  onDismiss,
}: {
  state: SlashCommandState;
  view?: EditorView | null;
  onSelect: (id: SlashCommandId) => void;
  onHover: (index: number) => void;
  onDismiss?: () => void;
}) {
  const menuId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = state.open ? state.selected : -1;
  const query = state.open ? state.query : "";
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && selected >= 0) revealMenuRow(list, optionRefs.current[selected]);
  }, [selected, query]);

  useEffect(() => {
    if (!state.open || !onDismiss) return;
    function onPointerDown(event: MouseEvent) {
      if (listRef.current?.contains(event.target as Node)) return;
      onDismiss?.();
    }
    window.addEventListener("mousedown", onPointerDown, true);
    return () => window.removeEventListener("mousedown", onPointerDown, true);
  }, [state.open, onDismiss]);

  useCloseOnScrollAway(listRef, view, state.open && onDismiss ? state.from : null, () =>
    onDismiss?.(),
  );

  if (!state.open) return null;
  const items = filterSlashCommands(state.query);
  const showSections = state.query.trim() === "";

  const renderOption = (item: SlashCommandItem, index: number) => {
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
  };

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
        maxWidth: state.maxWidth,
        ...menuEnterFrom(state.placement),
      }}
      role="listbox"
      aria-label="Slash commands"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length ? (
        showSections ? (
          groupSlashCommands(items).map((group, groupIndex) => {
            const headingId = `${menuId}-section-${groupIndex}`;
            return (
              <div key={group.section} role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  role="presentation"
                  className={`${MENU_SECTION}${groupIndex > 0 ? " mt-1" : ""}`}
                >
                  {group.section}
                </div>
                {group.entries.map(({ item, index }) => renderOption(item, index))}
              </div>
            );
          })
        ) : (
          items.map((item, index) => renderOption(item, index))
        )
      ) : (
        <div className={MENU_EMPTY}>No matching commands.</div>
      )}
    </div>
  );
}

function focusInsertedCalloutTitle(editor: Editor, near: number): void {
  const focus = () => {
    if (editor.isDestroyed) return false;
    let target: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "callout") return;
      if (node.attrs.fold !== "-" || String(node.attrs.title ?? "") !== "") return;
      if (target === null || Math.abs(pos - near) < Math.abs(target - near)) {
        target = pos;
      }
    });
    if (target === null) return false;
    const dom = editor.view.nodeDOM(target);
    if (!(dom instanceof HTMLElement)) return false;
    const input = dom.querySelector<HTMLInputElement>(".dohc-callout-title-input");
    if (!input) return false;
    input.focus();
    return true;
  };
  if (!focus()) requestAnimationFrame(() => void focus());
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

  let commandFrom = state.from;
  let chain = editor.chain().focus();
  if (state.gutterTarget) {
    const { blockPos, reuseEmpty } = state.gutterTarget;
    const targetNode = editor.state.doc.nodeAt(blockPos);
    const paragraph = editor.state.schema.nodes.paragraph;
    if (!targetNode || !paragraph) {
      setSlashState(CLOSED_SLASH_COMMAND_STATE);
      return;
    }
    if (reuseEmpty && targetNode.type.name === "paragraph" && targetNode.textContent.length === 0) {
      commandFrom = blockPos + 1;
      chain = chain.command(({ tr, dispatch }) => {
        if (dispatch) {
          tr.setSelection(TextSelection.create(tr.doc, commandFrom));
          tr.setMeta(slashCommandKey, { type: "dismiss" } satisfies SlashPluginMeta);
        }
        return true;
      });
    } else {
      const insertPos = blockPos + targetNode.nodeSize;
      commandFrom = insertPos + 1;
      chain = chain.command(({ tr, dispatch }) => {
        if (dispatch) {
          tr.insert(insertPos, paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, commandFrom));
          tr.setMeta(slashCommandKey, { type: "dismiss" } satisfies SlashPluginMeta);
        }
        return true;
      });
    }
  } else {
    chain = chain.deleteRange({ from: state.from, to: state.to });
  }
  setSlashState(CLOSED_SLASH_COMMAND_STATE);

  switch (id) {
    case "wikilink":
      chain
        .insertContent("[[]]")
        .setTextSelection(commandFrom + 2)
        .run();
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
      focusInsertedCalloutTitle(editor, commandFrom);
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
      selectInsertedMathBlock(editor, commandFrom);
      return;
    case "divider":
      chain.setHorizontalRule().run();
      return;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      return;
    case "image":
      chain.run();
      insertImage?.(editor.view, commandFrom);
      return;
  }
}
