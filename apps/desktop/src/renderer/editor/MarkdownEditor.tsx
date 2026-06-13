import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { Extension, type Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { TrailingNode } from "@tiptap/extensions/trailing-node";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { Bold, Code, Italic } from "lucide-react";
import { dohcMarkdownExtensions } from "./extensions";
import { makeInlineAtomPlugin } from "./inlineAtomPlugin";
import {
  makeWikilinkPlugin,
  type AutocompleteState,
  type WikilinkFile,
} from "./wikilinkPlugin";
import { WikilinkPicker } from "./WikilinkPicker";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";

export type MarkdownEditorHandle = {
  focus: () => void;
  getMarkdown: () => string;
};

export type MarkdownEditorCollab = {
  // E4c binds Tiptap Collaboration to this Y.Doc. E4b-2 keeps the prop so the
  // FileInspector surface does not churn again when rich collab lands.
  ydoc: unknown;
  status: "disabled" | "connecting" | "connected" | "disconnected";
  peerCount: number;
  synced: boolean;
};

export type MarkdownEditorProps = {
  value: string;
  onDirty: () => void;
  workspaceId: string;
  path: string;
  knownFiles: ReadonlyArray<WikilinkFile>;
  onOpenWikilink?: (path: string) => void;
  autoFocus?: boolean;
  collab?: MarkdownEditorCollab | null;
};

type SlashCommandId =
  | "wikilink"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bulleted-list"
  | "numbered-list"
  | "quote"
  | "code-block"
  | "divider"
  | "table";

type SlashCommandItem = {
  id: SlashCommandId;
  label: string;
  hint: string;
  glyph: string;
  aliases: string[];
};

type SlashCommandState =
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

const CLOSED_SLASH_COMMAND_STATE: SlashCommandState = { open: false };

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
];

const slashCommandKey = new PluginKey("dohc-slash-command");
const blockControlsKey = new PluginKey("dohc-block-controls");
const codeLanguageKey = new PluginKey("dohc-code-language");
const codeBlockContinuationKey = new PluginKey("dohc-code-block-continuation");

const CODE_LANGUAGE_OPTIONS = [
  { value: "", label: "Plain text" },
  { value: "typescript", label: "TypeScript" },
  { value: "javascript", label: "JavaScript" },
  { value: "tsx", label: "TSX" },
  { value: "jsx", label: "JSX" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Shell" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
] as const;

type DocDescendantNode = {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
  nodeSize: number;
};

type DocLike = {
  descendants: (
    cb: (node: DocDescendantNode, pos: number) => boolean | void,
  ) => void;
  nodeAt: (pos: number) => DocDescendantNode | null;
};

type TopLevelDocLike = {
  forEach: (
    cb: (
      node: {
        type: { name: string };
        attrs?: Record<string, unknown>;
        nodeSize: number;
        textContent?: string;
      },
      offset: number,
      index: number,
    ) => void,
  ) => void;
};

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
};

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

function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === "code_block" || node.type.name === "codeBlock";
}

function isEditableEditor(editor: Editor | null | undefined): boolean {
  if (!editor) return false;
  if ((editor as { isEditable?: boolean }).isEditable === false) return false;
  if ((editor.view as { editable?: boolean }).editable === false) return false;
  return true;
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

function makeSlashCommandPlugin({
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

function stopEditorMouseEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function isBlockControlTarget(nodeName: string): boolean {
  return [
    "paragraph",
    "heading",
    "blockquote",
    "bulletList",
    "orderedList",
    "codeBlock",
    "code_block",
    "horizontalRule",
    "table",
  ].includes(nodeName);
}

function buildBlockControlDecorations(
  doc: unknown,
  onInsertRef: RefObject<(pos: number) => void>,
  onSelectRef: RefObject<(pos: number) => void>,
): DecorationSet {
  const decorations: Decoration[] = [];

  (doc as TopLevelDocLike).forEach((node, offset, index) => {
    if (!isBlockControlTarget(node.type.name)) return;

    const pos = offset;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "dohc-block-node",
        "data-dohc-block-index": String(index),
      }),
    );
    decorations.push(
      Decoration.widget(
        pos + 1,
        () => {
          const wrap = document.createElement("span");
          wrap.className = "dohc-block-affordance";
          wrap.setAttribute("contenteditable", "false");

          const plus = document.createElement("button");
          plus.type = "button";
          plus.className = "dohc-block-gutter-btn dohc-block-plus";
          plus.title = "insert block";
          plus.setAttribute("aria-label", "insert block");
          plus.addEventListener("mousedown", stopEditorMouseEvent);
          plus.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            onInsertRef.current(pos);
          });

          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = "dohc-block-gutter-btn dohc-block-handle";
          handle.title = "select block";
          handle.setAttribute("aria-label", "select block");
          handle.addEventListener("mousedown", stopEditorMouseEvent);
          handle.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            onSelectRef.current(pos);
          });

          wrap.append(plus, handle);
          return wrap;
        },
        { side: -1, key: `dohc-block-controls-${pos}` },
      ),
    );
  });

  return DecorationSet.create(doc as never, decorations);
}

function makeBlockControlsPlugin({
  onInsertRef,
  onSelectRef,
}: {
  onInsertRef: RefObject<(pos: number) => void>;
  onSelectRef: RefObject<(pos: number) => void>;
}) {
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(instance.doc, onInsertRef, onSelectRef);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildBlockControlDecorations(tr.doc, onInsertRef, onSelectRef);
      },
    },
    props: {
      decorations(state) {
        return blockControlsKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function cleanCodeLanguage(value: string): string {
  return (value.trim().match(/^[A-Za-z0-9_+#.-]{0,48}/)?.[0] ?? "").slice(
    0,
    48,
  );
}

function insertParagraphAfterBlock(view: EditorView, blockPos: number): boolean {
  if (view.editable === false) return false;

  const { state } = view;
  const node = state.doc.nodeAt(blockPos);
  const paragraphType = state.schema.nodes.paragraph;
  if (!node || !paragraphType) return false;

  const insertPos = blockPos + node.nodeSize;
  const $insert = state.doc.resolve(insertPos);
  let tr = state.tr;

  if (
    !(
      $insert.nodeAfter?.type === paragraphType &&
      $insert.nodeAfter.content.size === 0
    )
  ) {
    if (
      !$insert.parent.canReplaceWith(
        $insert.index(),
        $insert.index(),
        paragraphType,
      )
    ) {
      return false;
    }
    tr = tr.insert(insertPos, paragraphType.create());
  }

  const selectionPos = Math.min(insertPos + 1, tr.doc.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

function codeBlockAtSelection(state: EditorState): {
  node: DocDescendantNode;
  pos: number;
} | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!isCodeBlockNode(node)) continue;
    return { node: node as unknown as DocDescendantNode, pos: $from.before(depth) };
  }
  return null;
}

function isSelectionAtEndOfCodeBlock(state: EditorState): boolean {
  if (!state.selection.empty) return false;
  const block = codeBlockAtSelection(state);
  if (!block) return false;
  return state.selection.$from.parentOffset >= block.node.textContent.length;
}

function buildCodeLanguageDecorations(doc: unknown): DecorationSet {
  const decorations: Decoration[] = [];

  (doc as DocLike).descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return;

    const language = cleanCodeLanguage(String(node.attrs.language ?? ""));
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "dohc-code-block",
      }),
    );
    decorations.push(
      Decoration.widget(
        pos,
        (view, getPos) => {
          const toolbar = document.createElement("div");
          toolbar.className = "dohc-code-block-toolbar";
          toolbar.setAttribute("contenteditable", "false");

          const left = document.createElement("div");
          left.className = "dohc-code-block-toolbar-left";

          const dot = document.createElement("span");
          dot.className = "dohc-code-block-dot";
          dot.setAttribute("aria-hidden", "true");

          const select = document.createElement("select");
          select.className = "dohc-code-language-select";
          select.setAttribute("aria-label", "code language");
          select.disabled = view.editable === false;

          const hasKnownLanguage = CODE_LANGUAGE_OPTIONS.some(
            (option) => option.value === language,
          );
          const options = hasKnownLanguage
            ? CODE_LANGUAGE_OPTIONS
            : [{ value: language, label: language }, ...CODE_LANGUAGE_OPTIONS];
          for (const option of options) {
            const el = document.createElement("option");
            el.value = option.value;
            el.textContent = option.label;
            select.appendChild(el);
          }
          select.value = language;

          const commit = () => {
            const blockPos = getPos();
            if (blockPos === undefined) return;
            const current = view.state.doc.nodeAt(blockPos);
            if (!current || !isCodeBlockNode(current)) return;

            const nextLanguage = cleanCodeLanguage(select.value);
            const currentLanguage = cleanCodeLanguage(
              String(current.attrs.language ?? ""),
            );
            select.value = nextLanguage;
            if (nextLanguage === currentLanguage) return;

            view.dispatch(
              view.state.tr
                .setNodeMarkup(blockPos, undefined, {
                  ...current.attrs,
                  language: nextLanguage,
                })
                .scrollIntoView(),
            );
          };

          select.addEventListener("mousedown", (event) => event.stopPropagation());
          select.addEventListener("click", (event) => event.stopPropagation());
          select.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              select.value = language;
              view.focus();
            }
          });
          select.addEventListener("change", commit);

          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "dohc-code-copy-btn";
          copy.setAttribute("aria-label", "copy code");
          copy.textContent = "copy";
          copy.addEventListener("mousedown", stopEditorMouseEvent);
          copy.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            const write = navigator.clipboard?.writeText(node.textContent);
            if (!write) return;
            void write.then(() => {
              copy.textContent = "copied";
              window.setTimeout(() => {
                copy.textContent = "copy";
              }, 1200);
            });
          });

          left.append(dot, select);
          toolbar.append(left, copy);
          return toolbar;
        },
        {
          side: -1,
          key: `code-lang-${pos}-${language}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
    const nextNode = (doc as DocLike).nodeAt(pos + node.nodeSize);
    if (!nextNode || !isCodeBlockNode(nextNode)) {
      decorations.push(
        Decoration.widget(
          pos + node.nodeSize,
          (view) => {
            const wrap = document.createElement("div");
            wrap.className = "dohc-code-block-continuation";
            wrap.setAttribute("contenteditable", "false");

            const button = document.createElement("button");
            button.type = "button";
            button.className = "dohc-code-block-continue-btn";
            button.setAttribute("aria-label", "add paragraph below code block");
            button.disabled = view.editable === false;
            button.textContent = "+";
            button.addEventListener("mousedown", stopEditorMouseEvent);
            button.addEventListener("click", (event) => {
              stopEditorMouseEvent(event);
              insertParagraphAfterBlock(view, pos);
            });

            wrap.append(button);
            return wrap;
          },
          {
            side: 1,
            key: `code-continue-${pos}`,
            ignoreSelection: true,
            stopEvent: () => true,
          },
        ),
      );
    }
  });

  return DecorationSet.create(doc as never, decorations);
}

function makeCodeBlockChromePlugin() {
  return new Plugin({
    key: codeLanguageKey,
    state: {
      init(_, instance) {
        return buildCodeLanguageDecorations(instance.doc);
      },
      apply(tr, old) {
        if (!tr.docChanged && !tr.getMeta(codeLanguageKey)) {
          return old.map(tr.mapping, tr.doc);
        }
        return buildCodeLanguageDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return codeLanguageKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function makeCodeBlockContinuationPlugin() {
  return new Plugin({
    key: codeBlockContinuationKey,
    props: {
      handleKeyDown(view, event) {
        const block = codeBlockAtSelection(view.state);
        if (!block) return false;

        const explicitExit =
          event.key === "Enter" && (event.metaKey || event.ctrlKey);
        const arrowExit =
          event.key === "ArrowDown" && isSelectionAtEndOfCodeBlock(view.state);
        if (!explicitExit && !arrowExit) return false;

        event.preventDefault();
        return insertParagraphAfterBlock(view, block.pos);
      },
    },
  });
}

function SlashCommandMenu({
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

function BubbleButton(props: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className={`dohc-bubble-menu__button${props.active ? " is-active" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onDirty,
      knownFiles,
      onOpenWikilink,
      autoFocus,
      collab,
      workspaceId: _workspaceId,
      path: _path,
    },
    ref,
  ) {
    const [acState, setAcState] = useState<AutocompleteState>({ active: false });
    const [slashState, setSlashState] = useState<SlashCommandState>(
      CLOSED_SLASH_COMMAND_STATE,
    );
    const slashStateRef = useRef<SlashCommandState>(slashState);
    const slashCommandRunnerRef = useRef<(id: SlashCommandId) => void>(() => {});
    const blockInsertRef = useRef<(pos: number) => void>(() => {});
    const blockSelectRef = useRef<(pos: number) => void>(() => {});
    const knownFilesRef = useRef<ReadonlyMap<string, WikilinkFile>>(new Map());
    const dirtyTrackingReadyRef = useRef(false);
    const onOpenWikilinkRef = useRef<((target: string) => void) | null>(
      onOpenWikilink ?? null,
    );

    useEffect(() => {
      slashStateRef.current = slashState;
    }, [slashState]);

    useEffect(() => {
      const map = new Map<string, WikilinkFile>();
      for (const file of knownFiles) {
        map.set(file.path, file);
        map.set(file.path.replace(/\.md$/i, ""), file);
      }
      knownFilesRef.current = map;
    }, [knownFiles]);

    useEffect(() => {
      onOpenWikilinkRef.current = onOpenWikilink ?? null;
    }, [onOpenWikilink]);

    const dohcPlugins = useMemo(
      () =>
        Extension.create({
          name: "dohcDecorations",
          addProseMirrorPlugins() {
            const wikilinkClickPlugin = new Plugin({
              key: new PluginKey("dohc-wikilink-click"),
              props: {
                handleClick(_view, _pos, event) {
                  const target = event.target as HTMLElement | null;
                  const el = target?.closest(
                    "[data-wikilink-target], [data-dohc-wikilink]",
                  ) as HTMLElement | null;
                  if (!el) return false;
                  const path =
                    el.getAttribute("data-wikilink-target") ??
                    el.getAttribute("data-dohc-wikilink");
                  if (!path) return false;
                  event.preventDefault();
                  onOpenWikilinkRef.current?.(path);
                  return true;
                },
              },
            });

            return [
              makeSlashCommandPlugin({
                stateRef: slashStateRef,
                setState: setSlashState,
                runCommandRef: slashCommandRunnerRef,
              }),
              makeBlockControlsPlugin({
                onInsertRef: blockInsertRef,
                onSelectRef: blockSelectRef,
              }),
              makeWikilinkPlugin(
                () => knownFilesRef.current,
                (state) => setAcState(state),
              ),
              wikilinkClickPlugin,
              makeCodeBlockChromePlugin(),
              makeCodeBlockContinuationPlugin(),
              makeInlineAtomPlugin(),
            ];
          },
        }),
      [],
    );

    const extensions = useMemo(
      () => [
        StarterKit.configure({
          trailingNode: false,
        }),
        ...dohcMarkdownExtensions,
        TableKit,
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
        Placeholder.configure({
          includeChildren: true,
          showOnlyCurrent: false,
          placeholder: ({ node }) => {
            if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
              return "";
            }
            if (node.type.name === "heading") return "Heading";
            return "Type '/' for commands";
          },
        }),
        TrailingNode.configure({
          node: "paragraph",
          notAfter: ["paragraph"],
        }),
        dohcPlugins,
      ],
      [dohcPlugins],
    );

    const editor = useEditor(
      {
        extensions,
        content: value,
        contentType: "markdown",
        editorProps: {
          attributes: {
            class: "dohc-notion-editor",
            "data-testid": "markdown-editor",
          },
        },
        immediatelyRender: false,
        onUpdate() {
          if (!dirtyTrackingReadyRef.current) return;
          onDirty();
        },
      },
      [extensions],
    );

    useEffect(() => {
      dirtyTrackingReadyRef.current = false;
      if (!editor) return;
      const frame = requestAnimationFrame(() => {
        dirtyTrackingReadyRef.current = true;
      });
      return () => cancelAnimationFrame(frame);
    }, [editor]);

    const openSlashMenuAtPosition = useCallback(
      (pos: number) => {
        const view = editor?.view;
        if (!view) return;

        let x = 12;
        let y = 40;
        let maxHeight = FLOATING_MENU_MAX_HEIGHT;
        let placement: FloatingMenuPlacement = "below";
        try {
          const coords = view.coordsAtPos(pos);
          const position = resolveFloatingMenuPosition({ cursorRect: coords });
          x = position.x;
          y = position.y;
          maxHeight = position.maxHeight;
          placement = position.placement;
        } catch {
          // Offscreen/jsdom editors cannot always resolve coordinates.
        }

        setSlashState({
          open: true,
          from: pos,
          to: pos,
          query: "",
          selected: 0,
          x,
          y,
          maxHeight,
          placement,
        });
      },
      [editor],
    );

    const insertBlockAfter = useCallback(
      (pos: number) => {
        const view = editor?.view;
        if (!view || !isEditableEditor(editor)) return;

        const { state } = view;
        const node = state.doc.nodeAt(pos);
        const paragraph = state.schema.nodes.paragraph;
        if (!node || !paragraph) return;

        const canReuseEmptyParagraph =
          node.type.name === "paragraph" && node.textContent.length === 0;
        const selectionPos = canReuseEmptyParagraph ? pos + 1 : pos + node.nodeSize + 1;
        const tr = canReuseEmptyParagraph
          ? state.tr
          : state.tr.insert(pos + node.nodeSize, paragraph.create());
        tr
          .setSelection(TextSelection.near(tr.doc.resolve(selectionPos)))
          .scrollIntoView();
        view.dispatch(tr);
        view.focus();
        openSlashMenuAtPosition(selectionPos);
      },
      [editor, openSlashMenuAtPosition],
    );

    const selectBlock = useCallback(
      (pos: number) => {
        const view = editor?.view;
        if (!view) return;
        const node = view.state.doc.nodeAt(pos);
        if (!node) return;
        view.dispatch(
          view.state.tr
            .setSelection(NodeSelection.create(view.state.doc, pos))
            .scrollIntoView(),
        );
        view.focus();
      },
      [editor],
    );

    useEffect(() => {
      blockInsertRef.current = insertBlockAfter;
      blockSelectRef.current = selectBlock;
    }, [insertBlockAfter, selectBlock]);

    const runSlashCommand = useCallback(
      (id: SlashCommandId) => {
        const state = slashStateRef.current;
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
        }
      },
      [editor],
    );

    useEffect(() => {
      slashCommandRunnerRef.current = runSlashCommand;
    }, [runSlashCommand]);

    useEffect(() => {
      if (!autoFocus || !editor) return;
      const frame = requestAnimationFrame(() => editor.commands.focus("end"));
      return () => cancelAnimationFrame(frame);
    }, [autoFocus, editor]);

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          editor?.commands.focus();
        },
        getMarkdown() {
          return editor?.getMarkdown() ?? value;
        },
      }),
      [editor, value],
    );

    const pickerView = editor
      ? (editor.view as Parameters<typeof WikilinkPicker>[0]["view"])
      : null;
    const pickerState: Parameters<typeof WikilinkPicker>[0]["state"] =
      acState.active
        ? { open: true, from: acState.from, query: acState.query }
        : { open: false };

    return (
      <div className="dohc-tiptap-editor" data-collab-state={collab?.status ?? "local"}>
        {collab && collab.status !== "disabled" ? (
          <div className="dohc-editor-presence" role="status" aria-live="polite">
            <span className="dohc-editor-presence-dot" aria-hidden="true" />
            <span>
              {collab.synced
                ? collab.peerCount === 0
                  ? "Live · just you"
                  : `${collab.peerCount + 1} editing`
                : "Syncing"}
            </span>
          </div>
        ) : null}
        <EditorContent editor={editor} />
        {editor ? (
          <BubbleMenu
            editor={editor}
            className="dohc-bubble-menu"
            shouldShow={({ editor: instance }) => !instance.state.selection.empty}
          >
            <BubbleButton
              label="Bold"
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Italic"
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Code"
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
            >
              <Code size={14} aria-hidden />
            </BubbleButton>
          </BubbleMenu>
        ) : null}
        <SlashCommandMenu
          state={slashState}
          onSelect={runSlashCommand}
          onHover={(index) =>
            setSlashState((current) =>
              current.open ? { ...current, selected: index } : current,
            )
          }
        />
        <WikilinkPicker
          state={pickerState}
          files={knownFiles}
          view={pickerView}
          onDismiss={() => setAcState({ active: false })}
        />
      </div>
    );
  },
);
