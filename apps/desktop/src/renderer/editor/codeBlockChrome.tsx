import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

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

const codeLanguageKey = new PluginKey("dohc-code-language");
const codeBlockContinuationKey = new PluginKey("dohc-code-block-continuation");
const emptyListItemFocusKey = new PluginKey("dohc-empty-list-item-focus");

function stopEditorMouseEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === "code_block" || node.type.name === "codeBlock";
}

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
            // The decoration only rebuilds on doc/meta transactions, so a
            // select built while editable can outlive an editability flip.
            // Refuse to mutate the block once the view is read-only.
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

          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "dohc-code-copy-btn";
          copy.setAttribute("aria-label", "copy code");
          copy.textContent = "copy";
          copy.addEventListener("mousedown", stopEditorMouseEvent);
          copy.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            // The widget key is keyed on pos+language, not the code text, so
            // ProseMirror reuses this DOM (and its captured `node`) across
            // pure text edits. Read the live node at click time so "copy"
            // never writes pre-edit content.
            const blockPos = getPos();
            const current =
              blockPos === undefined ? null : view.state.doc.nodeAt(blockPos);
            const text =
              current && isCodeBlockNode(current)
                ? current.textContent
                : node.textContent;
            const write = navigator.clipboard?.writeText(text);
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

export function makeCodeBlockChromePlugin() {
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
          event.key === "Enter" && (event.metaKey || event.ctrlKey);
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
