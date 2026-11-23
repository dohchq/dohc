import { hasPrimaryModifier } from "../../shortcuts/shortcutRegistry";
import { mapWidgetOwners, ownersByPlace, replacesDocument, withSteps } from "./widgetOwnership";
import { documentChange, stopEditorMouseEvent, isCodeBlockNode } from "./pmHelpers";
import { CODE_LANGUAGE_OPTIONS, cleanCodeLanguage } from "./codeLanguages";
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
  failed:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

const WRAP_ICON_MARKUP =
  '<line x1="3" x2="21" y1="6" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" x2="10" y1="18" y2="18"/>';
const CHEVRON_DOWN_MARKUP = '<path d="m6 9 6 6 6-6"/>';

function toolbarIcon(markup: string, size = 13, className?: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value);
  if (className) svg.setAttribute("class", className);
  svg.innerHTML = markup;
  return svg;
}

function copyIcon(feedback: CopyFeedback | null): SVGSVGElement {
  return toolbarIcon(COPY_ICON_MARKUP[feedback ?? "rest"]);
}

// What each toolbar's copy needs when ProseMirror destroys the toolbar.
const disposeToolbar = new WeakMap<Node, () => void>();

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

export function findEmptyListItemParagraph(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const item = target.closest("li");
  if (!item) return null;
  const paragraph =
    directElementChild(item, (child) => child.tagName === "P") ??
    directElementChild(item, (child) => child.tagName === "DIV")?.querySelector(":scope > p");
  if (!(paragraph instanceof HTMLElement)) return null;
  const text = paragraph.textContent?.replace(/\u200b/g, "").trim() ?? "";
  return text.length === 0 ? paragraph : null;
}

function focusEmptyListItemParagraph(view: EditorView, event: MouseEvent): boolean {
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
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView(),
    );
    view.focus();
    return true;
  }
  return false;
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

  if (!($insert.nodeAfter?.type === paragraphType && $insert.nodeAfter.content.size === 0)) {
    if (!$insert.parent.canReplaceWith($insert.index(), $insert.index(), paragraphType)) {
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
  wrappedOwners: Set<string>,
): DecorationSet {
  const decorations: Decoration[] = [];
  // A textblock holds only inline content, so the walk never enters one.
  doc.descendants((node, pos) => {
    if (!isCodeBlockNode(node)) return !node.isTextblock;
    decorations.push(
      codeBlockToolbar(node, pos, owners.get(pos) ?? nextOwnerKey(), report, wrappedOwners),
    );
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function codeBlockToolbar(
  node: ProseMirrorNode,
  pos: number,
  ownerKey: string,
  report: ErrorReporter,
  wrappedOwners: Set<string>,
): Decoration {
  const language = cleanCodeLanguage(String(node.attrs.language ?? ""));
  return Decoration.widget(
    pos,
    (view, getPos) => {
      const toolbar = document.createElement("div");
      toolbar.className = "dohc-code-block-toolbar";
      toolbar.setAttribute("contenteditable", "false");

      const left = document.createElement("div");
      left.className = "dohc-code-block-toolbar-left";

      const picker = document.createElement("span");
      picker.className = "dohc-code-language-picker";

      const labelEl = document.createElement("span");
      labelEl.className = "dohc-code-language-label";
      labelEl.setAttribute("aria-hidden", "true");

      const chevron = toolbarIcon(CHEVRON_DOWN_MARKUP, 12, "dohc-code-language-chevron");

      const select = document.createElement("select");
      select.className = "dohc-code-language-select";
      select.setAttribute("aria-label", "Code language");
      select.disabled = view.editable === false;

      const hasKnownLanguage = CODE_LANGUAGE_OPTIONS.some((option) => option.value === language);
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
      const syncLabel = (value: string) => {
        const matched = options.find((option) => option.value === value);
        labelEl.textContent = matched?.label ?? (value || "plain text");
      };
      syncLabel(language);

      const commit = () => {
        if (view.editable === false) return;
        const blockPos = getPos();
        if (blockPos === undefined) return;
        const current = view.state.doc.nodeAt(blockPos);
        if (!current || !isCodeBlockNode(current)) return;

        const nextLanguage = cleanCodeLanguage(select.value);
        const currentLanguage = cleanCodeLanguage(String(current.attrs.language ?? ""));
        select.value = nextLanguage;
        syncLabel(nextLanguage);
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
          syncLabel(language);
          view.focus();
        }
      });
      select.addEventListener("change", commit);

      const wrapBtn = document.createElement("button");
      wrapBtn.type = "button";
      wrapBtn.setAttribute("aria-label", "Wrap lines");
      wrapBtn.title = "Wrap lines";
      wrapBtn.appendChild(toolbarIcon(WRAP_ICON_MARKUP));
      const syncWrap = (wrapped: boolean) => {
        wrapBtn.setAttribute("aria-pressed", String(wrapped));
        wrapBtn.className = `dohc-code-wrap-btn${wrapped ? " is-active" : ""}`;
        toolbar.classList.toggle("is-wrapped", wrapped);
        const nextSibling = toolbar.nextElementSibling;
        if (nextSibling instanceof HTMLElement && nextSibling.tagName === "PRE") {
          nextSibling.classList.toggle("dohc-code-wrapped", wrapped);
        }
      };
      syncWrap(wrappedOwners.has(ownerKey));
      wrapBtn.addEventListener("mousedown", stopEditorMouseEvent);
      wrapBtn.addEventListener("click", (event) => {
        stopEditorMouseEvent(event);
        const next = !wrappedOwners.has(ownerKey);
        if (next) wrappedOwners.add(ownerKey);
        else wrappedOwners.delete(ownerKey);
        syncWrap(next);
      });

      // The shared copy tile, drawn here because React does not render
      // this toolbar. Its name stays "Copy code".
      const copy = document.createElement("button");
      copy.type = "button";
      copy.setAttribute("aria-label", "Copy code");
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

      picker.append(labelEl, chevron, select);
      left.append(picker);
      const actions = document.createElement("div");
      actions.className = "dohc-code-block-toolbar-actions";
      actions.append(wrapBtn, copy, status);
      toolbar.append(left, actions);
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
  );
}

// `report` reaches the shell's error hook, for a copy the clipboard refused.
export function makeCodeBlockChromePlugin(report: ErrorReporter = () => null) {
  let nextId = 0;
  const nextOwnerKey = () => String(nextId++);
  const wrappedOwners = new Set<string>();
  return new Plugin({
    key: codeLanguageKey,
    state: {
      init(_, instance) {
        return buildCodeLanguageDecorations(
          instance.doc,
          new Map(),
          nextOwnerKey,
          report,
          wrappedOwners,
        );
      },
      // Only the code blocks that start inside the changed range get their
      // toolbar again; the rest move with the edit and keep their DOM.
      apply(tr, old) {
        if (!tr.docChanged) return old;
        const { range: changed, mapping } = documentChange(tr.before, tr.doc);
        const decorations = old.map(mapping, tr.doc);
        if (!changed) return decorations;
        // A remote update places nothing by its steps, so its toolbars keep
        // their owners by place, as callout headers do.
        const remote = replacesDocument(tr);
        const range = remote ? changed : withSteps(changed, tr);
        // A toolbar sits before its block, so content inserted at a block's
        // start leaves its toolbar at the start of the range.
        const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
        tr.doc.nodesBetween(
          range.from,
          Math.min(range.to + 1, tr.doc.content.size),
          (node, pos) => {
            if (!isCodeBlockNode(node)) return !node.isTextblock;
            if (pos >= range.from) blocks.push({ node, pos });
            return false;
          },
        );
        const previous = old.find(range.from, range.toBefore);
        const owners = remote
          ? ownersByPlace(
              previous,
              blocks.map(({ pos }) => pos),
            )
          : mapWidgetOwners(previous, tr.mapping);
        if (!remote && owners.size < blocks.length) {
          const usedOwners = new Set(owners.values());
          for (const dec of previous) {
            const key = dec.spec.ownerKey;
            if (typeof key !== "string" || usedOwners.has(key)) continue;
            const mapped = tr.mapping.mapResult(dec.from, -1);
            if (!mapped.deleted && !owners.has(mapped.pos)) {
              const beforeNode = tr.before.nodeAt(dec.from);
              const afterNode = tr.doc.nodeAt(mapped.pos);
              if (
                beforeNode &&
                afterNode &&
                isCodeBlockNode(beforeNode) &&
                isCodeBlockNode(afterNode) &&
                beforeNode.content.eq(afterNode.content)
              ) {
                owners.set(mapped.pos, key);
                usedOwners.add(key);
              }
            }
          }
        }
        const toolbars = blocks.map(({ node, pos }) =>
          codeBlockToolbar(node, pos, owners.get(pos) ?? nextOwnerKey(), report, wrappedOwners),
        );
        return decorations.remove(decorations.find(range.from, range.to)).add(tr.doc, toolbars);
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

function indentCodeBlock(
  view: EditorView,
  block: { node: ProseMirrorNode; pos: number },
  outdent: boolean,
): boolean {
  if (view.editable === false) return false;
  const { state } = view;
  const { from, to } = state.selection;
  const contentStart = block.pos + 1;
  const contentEnd = contentStart + block.node.content.size;
  if (from < contentStart || to > contentEnd) return false;
  const text = block.node.textContent;
  const startOffset = from - contentStart;
  const endOffset = to - contentStart;

  if (!outdent && from === to) {
    view.dispatch(state.tr.insertText("  ", from, to).scrollIntoView());
    return true;
  }

  const lineStart = text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const effectiveEnd =
    endOffset > startOffset && text[endOffset - 1] === "\n" ? endOffset - 1 : endOffset;
  const nextNewline = text.indexOf("\n", effectiveEnd);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;

  const lines = text.slice(lineStart, lineEnd).split("\n");
  let newStart = startOffset;
  let newEnd = endOffset;
  let cursor = lineStart;
  let changed = false;

  const updated = lines.map((line) => {
    const lineFrom = cursor;
    cursor += line.length + 1;
    if (!outdent) {
      changed = true;
      if (lineFrom <= startOffset) newStart += 2;
      if (lineFrom <= endOffset) newEnd += 2;
      return `  ${line}`;
    }
    const remove = line.startsWith("  ")
      ? 2
      : line.startsWith("\t") || line.startsWith(" ")
        ? 1
        : 0;
    if (remove > 0) {
      changed = true;
      if (lineFrom < startOffset) newStart -= Math.min(remove, startOffset - lineFrom);
      if (lineFrom < endOffset) newEnd -= Math.min(remove, endOffset - lineFrom);
    }
    return line.slice(remove);
  });

  if (!changed) return true;
  const tr = state.tr.insertText(
    updated.join("\n"),
    contentStart + lineStart,
    contentStart + lineEnd,
  );
  tr.setSelection(TextSelection.create(tr.doc, contentStart + newStart, contentStart + newEnd));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function makeCodeBlockContinuationPlugin() {
  return new Plugin({
    key: codeBlockContinuationKey,
    props: {
      handleKeyDown(view, event) {
        const block = codeBlockAtSelection(view.state);
        if (!block) return false;

        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (!indentCodeBlock(view, block, event.shiftKey)) return false;
          event.preventDefault();
          return true;
        }

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
