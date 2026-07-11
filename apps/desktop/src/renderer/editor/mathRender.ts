import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView, NodeView } from "@tiptap/pm/view";

// Desktop-only KaTeX rendering for the `mathInline` / `mathBlock` atom nodes.
//
// The nodes themselves (extensions.ts / the projection copy) stay pure: they
// only carry the raw TeX in a `tex` attr and re-emit `$`/`$$` losslessly. This
// module is where the desktop editor turns that TeX into rendered math via a
// ProseMirror NodeView, wired through editorProps.nodeViews in MarkdownEditor.
// The projection package never imports this file, so it never pulls in KaTeX.
//
// KaTeX is loaded lazily (dynamic import, cached) so it stays out of the
// editor's initial bundle — a document with no math never pays for it.

type KatexModule = {
  render: (
    tex: string,
    element: HTMLElement,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      errorColor?: string;
    },
  ) => void;
};

let katexPromise: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = import("katex").then(
      (mod) => (mod.default ?? mod) as unknown as KatexModule,
    );
  }
  return katexPromise;
}

// Render `tex` into `target`. Empty TeX gets an `--empty` placeholder class;
// invalid TeX renders KaTeX's own error output plus an `--error` class for a
// visible warning style. A stale async result (the node changed while KaTeX was
// loading) is discarded via the `data-math-token` guard so a slow first import
// can never repaint newer content.
export function renderMathInto(
  target: HTMLElement,
  tex: string,
  displayMode: boolean,
): void {
  const token = String(Date.now()) + ":" + tex;
  target.dataset.mathToken = token;

  if (tex.trim().length === 0) {
    target.textContent = "";
    target.classList.add("dohc-math--empty");
    target.classList.remove("dohc-math--error");
    return;
  }
  target.classList.remove("dohc-math--empty");

  void loadKatex()
    .then((katex) => {
      if (target.dataset.mathToken !== token) return;
      try {
        katex.render(tex, target, { displayMode, throwOnError: true });
        target.classList.remove("dohc-math--error");
      } catch {
        katex.render(tex, target, {
          displayMode,
          throwOnError: false,
          errorColor: "var(--dohc-math-error-color, #c0392b)",
        });
        target.classList.add("dohc-math--error");
      }
    })
    .catch(() => {
      // KaTeX failed to load — never lose the content: show the raw source.
      if (target.dataset.mathToken !== token) return;
      target.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
      target.classList.add("dohc-math--error");
    });
}

// A ProseMirror NodeView that renders math and swaps to an editable source
// field when the node is selected/clicked (mirrors the Obsidian live-preview
// toggle). Commit on Enter (inline) / Cmd+Enter (block) / blur; Escape cancels.
export function makeMathNodeView(
  displayMode: boolean,
): (
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
) => NodeView {
  const nodeName = displayMode ? "mathBlock" : "mathInline";

  return (initialNode, view, getPos) => {
    const dom = document.createElement(displayMode ? "div" : "span");
    dom.className = displayMode
      ? "dohc-math dohc-math-block"
      : "dohc-math dohc-math-inline";
    dom.setAttribute(
      displayMode ? "data-dohc-math-block" : "data-dohc-math-inline",
      "",
    );

    const preview = document.createElement(displayMode ? "div" : "span");
    preview.className = "dohc-math__preview";
    dom.appendChild(preview);

    let currentTex = String(initialNode.attrs.tex ?? "");
    let editing = false;
    let field: HTMLTextAreaElement | HTMLInputElement | null = null;
    // The field's value at the moment editing began (or the last remote value
    // adopted while the field was still untouched). The commit gate compares
    // against THIS, not currentTex, so an opened-but-unedited field never
    // clobbers a concurrent remote edit — see exitEditing / update.
    let baseline = "";

    const paint = () => renderMathInto(preview, currentTex, displayMode);

    const commit = (value: string): void => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      if (value === currentTex) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { tex: value }));
    };

    // `nextValue === null` cancels (keep currentTex); otherwise commit ONLY if
    // the user actually changed the field (`value !== baseline`). Opening the
    // source editor and clicking away with no local edit must not dispatch —
    // otherwise a concurrent remote tex change (which advanced currentTex but
    // not the untouched field) would be silently overwritten. When the user
    // DID edit locally and a remote edit also landed, their text wins on
    // commit: last-writer-wins.
    const exitEditing = (nextValue: string | null): void => {
      if (!editing) return;
      editing = false;
      dom.classList.remove("dohc-math--editing");
      const el = field;
      field = null;
      if (el) {
        const value = el.value;
        el.remove();
        preview.style.removeProperty("display");
        if (nextValue !== null && value !== baseline) commit(value);
      }
    };

    const enterEditing = (): void => {
      if (editing || !view.editable) return;
      editing = true;
      dom.classList.add("dohc-math--editing");
      const el = displayMode
        ? document.createElement("textarea")
        : document.createElement("input");
      if (el instanceof HTMLInputElement) el.type = "text";
      el.className = "dohc-math__source";
      el.value = currentTex;
      baseline = currentTex;
      el.spellcheck = false;
      preview.style.display = "none";
      dom.appendChild(el);
      field = el;
      el.focus();
      el.select();
      // Referenced as HTMLElement so addEventListener resolves the keyboard
      // event map on the union element type.
      const listenerTarget: HTMLElement = el;
      listenerTarget.addEventListener("blur", () => exitEditing(el.value));
      listenerTarget.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          exitEditing(null);
          view.focus();
          return;
        }
        // Enter commits inline math; a block textarea keeps Enter for newlines
        // and commits on Cmd/Ctrl+Enter.
        const commitKey =
          event.key === "Enter" &&
          (!displayMode || event.metaKey || event.ctrlKey);
        if (commitKey) {
          event.preventDefault();
          exitEditing(el.value);
          view.focus();
        }
      });
    };

    dom.addEventListener("click", (event) => {
      if (!editing && view.editable) {
        event.preventDefault();
        enterEditing();
      }
    });

    paint();

    return {
      dom,
      update(updated) {
        if (updated.type.name !== nodeName) return false;
        currentTex = String(updated.attrs.tex ?? "");
        if (!editing) {
          paint();
        } else if (field && field.value === baseline) {
          // A remote edit landed while the source field is open but still
          // untouched: adopt the new tex into the field (and advance baseline)
          // so blur won't commit a stale value over the remote change. Once the
          // user has typed locally (value !== baseline) we leave their text be.
          field.value = currentTex;
          baseline = currentTex;
        }
        return true;
      },
      // Selecting the node (click, arrow-into, or `/math` insert) opens the
      // source editor; deselecting commits and returns to the rendered view.
      selectNode() {
        enterEditing();
      },
      deselectNode() {
        exitEditing(field ? field.value : null);
      },
      // While editing, the source field owns keyboard/mouse events.
      stopEvent() {
        return editing;
      },
      ignoreMutation() {
        return true;
      },
      destroy() {
        exitEditing(null);
      },
    };
  };
}
