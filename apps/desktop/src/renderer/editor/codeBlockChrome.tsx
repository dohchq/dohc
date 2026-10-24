import { hasPrimaryModifier } from "../../shortcuts/shortcutRegistry";
import { mapWidgetOwners } from "./widgetOwnership";
import { stopEditorMouseEvent, isCodeBlockNode } from "./pmHelpers";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { ReportShellFailure } from "../shell/useShellError";
import {
  COPY_TILE_CLASS,
  COPY_TILE_STATE_CLASS,
  COPY_WORDS,
  createCopy,
  type CopyFeedback,
} from "../ui/CopyButton";

type ErrorReporter = () => ReportShellFailure | null;

// The copy tile's three icons as lucide draws them (Copy, Check,
// TriangleAlert), for a toolbar ProseMirror owns and React does not render.
const COPY_ICON_MARKUP: Record<CopyFeedback | "rest", string> = {
  rest: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  copied: '<path d="M20 6 9 17l-5-5"/>',
  failed: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

function copyIcon(feedback: CopyFeedback | null): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(name, value);
  svg.innerHTML = COPY_ICON_MARKUP[feedback ?? "rest"];
  return svg;
}

// What each toolbar's copy needs when ProseMirror destroys the toolbar.
const disposeToolbar = new WeakMap<Node, () => void>();

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
  { value: "mermaid", label: "Mermaid" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
] as const;

const codeLanguageKey = new PluginKey("dohc-code-language");
const codeBlockContinuationKey = new PluginKey("dohc-code-block-continuation");
const emptyListItemFocusKey = new PluginKey("dohc-empty-list-item-focus");

function directElementChild(
  parent: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
): HTMLElement | null {
  for (const child of parent.children) {
    if (child instanceof HTMLElement && predicate(child)) return child;
  }
  return null;
}

export function findEmptyListItemParagraph(
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const item = target.closest("li");
  if (!item) return null;
  const paragraph =
    directElementChild(item, (child) => child.tagName === "P") ??
    directElementChild(item, (child) => child.tagName === "DIV")?.querySelector(
      ":scope > p",
    );
  if (!(paragraph instanceof HTMLElement)) return null;
  const text = paragraph.textContent?.replace(/\u200b/g, "").trim() ?? "";
  return text.length === 0 ? paragraph : null;
}

function focusEmptyListItemParagraph(
  view: EditorView,
  event: MouseEvent,
): boolean {
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    view.editable === false
  ) {
    return false;
  }
  const paragraph = findEmptyListItemParagraph(event.target);
  if (!paragraph || !view.dom.contains(paragraph)) return false;

  const candidates: number[] = [];
  for (const offset of [0, paragraph.childNodes.length]) {
    try {
      const pos = view.posAtDOM(paragraph, offset);
      candidates.push(pos, pos + 1);
    } catch {
      // The DOM may be between ProseMirror-managed nodes during teardown.
    }
  }

  for (const pos of candidates) {
    if (pos < 0 || pos > view.state.doc.content.size) continue;
    const $pos = view.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) continue;
    event.preventDefault();
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, pos))
        .scrollIntoView(),
    );
    view.focus();
    return true;
  }
  return false;
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
  node: ProseMirrorNode;
  pos: number;
} | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!isCodeBlockNode(node)) continue;
    return { node, pos: $from.before(depth) };
  }
  return null;
}

function isSelectionAtEndOfCodeBlock(state: EditorState): boolean {
  if (!state.selection.empty) return false;
  const block = codeBlockAtSelection(state);
  if (!block) return false;
  return state.selection.$from.parentOffset >= block.node.textContent.length;
}

function buildCodeLanguageDecorations(
  doc: ProseMirrorNode,
  owners: Map<number, string>,
  nextOwnerKey: () => string,
  report: ErrorReporter,
): DecorationSet {
  const decorations: Decoration[] = [];
  // A textblock holds only inline content, so the walk never enters one.
  doc.descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return !node.isTextblock;
    const ownerKey = owners.get(pos) ?? nextOwnerKey();

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
            if (view.editable === false) return;
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

          // The shared copy tile, drawn here because React does not render
          // this toolbar. Its name stays "copy code".
          const copy = document.createElement("button");
          copy.type = "button";
          copy.setAttribute("aria-label", "copy code");
          const status = document.createElement("span");
          status.setAttribute("role", "status");
          status.setAttribute("aria-live", "polite");
          status.className = "sr-only";
          let announce: ReturnType<typeof setTimeout> | null = null;
          const draw = (feedback: CopyFeedback | null) => {
            copy.className = `dohc-code-copy-btn ${COPY_TILE_CLASS} ${COPY_TILE_STATE_CLASS[feedback ?? "rest"]}`;
            copy.title = feedback ? COPY_WORDS[feedback] : "Copy code";
            copy.replaceChildren(copyIcon(feedback));
            status.textContent = "";
            if (announce !== null) clearTimeout(announce);
            announce = feedback
              ? setTimeout(() => {
                  status.textContent = COPY_WORDS[feedback];
                }, 0)
              : null;
          };
          const action = createCopy({
            // The widget key uses block ownership and language, not code
            // text, so ProseMirror reuses this DOM (and its captured `node`)
            // across pure text edits. Read the live node at click time so
            // the copy never writes pre-edit content.
            getText: () => {
              const blockPos = getPos();
              const current = blockPos === undefined ? null : view.state.doc.nodeAt(blockPos);
              return current && isCodeBlockNode(current) ? current.textContent : node.textContent;
            },
            report,
            show: draw,
          });
          draw(null);
          copy.addEventListener("mousedown", stopEditorMouseEvent);
          copy.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            void action.copy();
          });

          left.append(dot, select);
          toolbar.append(left, copy, status);
          disposeToolbar.set(toolbar, () => {
            action.dispose();
            if (announce !== null) clearTimeout(announce);
          });
          return toolbar;
        },
        {
          side: -1,
          // Prose edits before this block preserve its toolbar and live getPos.
          key: `code-lang-${ownerKey}-${language}`,
          ownerKey,
          ignoreSelection: true,
          stopEvent: () => true,
          destroy: (toolbar) => disposeToolbar.get(toolbar)?.(),
        },
      ),
    );
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

// `report` reaches the shell's error hook, for a copy the clipboard refused.
export function makeCodeBlockChromePlugin(report: ErrorReporter = () => null) {
  let nextId = 0;
  const nextOwnerKey = () => String(nextId++);
  return new Plugin({
    key: codeLanguageKey,
    state: {
      init(_, instance) {
        return buildCodeLanguageDecorations(instance.doc, new Map(), nextOwnerKey, report);
      },
      apply(tr, old) {
        if (!tr.docChanged && !tr.getMeta(codeLanguageKey)) {
          return old.map(tr.mapping, tr.doc);
        }
        return buildCodeLanguageDecorations(tr.doc, mapWidgetOwners(old, tr.mapping), nextOwnerKey, report);
      },
    },
    view(view) {
      let editable = view.editable;
      return {
        update(nextView) {
          if (nextView.editable === editable) return;
          editable = nextView.editable;
          for (const select of nextView.dom.querySelectorAll<HTMLSelectElement>(
            ".dohc-code-language-select",
          )) {
            select.disabled = !editable;
          }
        },
      };
    },
    props: {
      decorations(state) {
        return codeLanguageKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}

function nodeFollowsBlock(state: EditorState, blockPos: number): boolean {
  const node = state.doc.nodeAt(blockPos);
  if (!node) return false;
  return state.doc.resolve(blockPos + node.nodeSize).nodeAfter != null;
}

export function makeCodeBlockContinuationPlugin() {
  return new Plugin({
    key: codeBlockContinuationKey,
    props: {
      handleKeyDown(view, event) {
        const block = codeBlockAtSelection(view.state);
        if (!block) return false;

        const explicitExit =
          event.key === "Enter" && hasPrimaryModifier(event, window.dohcDesktop?.platform);
        // ArrowDown only takes over when the code block is the last child of
        // its parent — otherwise native navigation must move into the
        // following content instead of injecting a blank paragraph (which
        // would dirty the doc on a pure navigation keypress).
        const arrowExit =
          event.key === "ArrowDown" &&
          isSelectionAtEndOfCodeBlock(view.state) &&
          !nodeFollowsBlock(view.state, block.pos);
        if (!explicitExit && !arrowExit) return false;

        if (!insertParagraphAfterBlock(view, block.pos)) return false;
        event.preventDefault();
        return true;
      },
    },
  });
}

export function makeEmptyListItemFocusPlugin() {
  return new Plugin({
    key: emptyListItemFocusKey,
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          return focusEmptyListItemParagraph(view, event);
        },
      },
    },
  });
}
