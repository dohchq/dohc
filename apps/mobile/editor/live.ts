// A page edited live (liveAdapter.ts). The page shows the text the app read until the provider is live, then the live
// document replaces it in one paint. It takes edits only while live.
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { readsBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
import { post } from "./bridge";
import { opensFormat, refuseFormat } from "./format";
import { createLiveAdapter, type LiveProvider } from "./liveAdapter";

export function followLive(input: {
  /** The read text's body, which the live one replaces. */
  readonly body: HTMLElement;
  readonly readOnly: { destroy(): void };
  readonly label: string;
  endEditing(): void;
}) {
  let shown: LiveProvider | null = null;
  let host: HTMLDivElement | null = null;
  let wasLive = false;
  let refused = false;
  let editor: ReturnType<typeof mountLiveBodyEditor> | null = null;

  function refuse() {
    refused = true;
    input.endEditing();
    editor?.destroy();
    editor = null;
    refuseFormat();
  }

  function show(made: LiveProvider) {
    shown = made;
    if (!opensFormat(made.doc)) {
      refuse();
      return;
    }
    const first = !host;
    const next = host ?? document.createElement("div");
    host = next;
    if (first) {
      next.className = input.body.className;
      next.hidden = true;
      input.body.after(next);
    }
    const takesEdits = () => !refused && shown === made && made.state().status === "live";
    let sequence = readsBodySequence(made.doc);
    const mount = () =>
      mountLiveBodyEditor(next, {
        doc: made.doc,
        label: input.label,
        canEdit: takesEdits,
        edit(change) {
          if (!takesEdits()) return false;
          change();
          return true;
        },
        unwritten: (why) => why !== "guarded" && post("unwritten", { why }),
      });
    editor?.destroy();
    editor = mount();
    made.doc.on("update", () => {
      if (refused || shown !== made) return;
      if (!opensFormat(made.doc)) return refuse();
      if (readsBodySequence(made.doc) === sequence) return;
      sequence = !sequence;
      editor?.destroy();
      editor = mount();
    });
    made.subscribe(() => shown === made && editor?.refresh());
    (window as Window & { __dohcCopyMarkdown?: () => void }).__dohcCopyMarkdown = () =>
      post("markdown", { markdown: yDocToMarkdown(made.doc) });
    // Swapped once the live editor has drawn, so the read text never leaves an empty frame.
    if (first)
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (refused) return;
          input.body.remove();
          input.readOnly.destroy();
          next.hidden = false;
        }, 0),
      );
  }

  const adapter = createLiveAdapter({
    post: (message) => post(message.kind, message),
    changed(made) {
      if (refused) return;
      const live = made.state().status === "live";
      if (live && shown !== made) show(made);
      // Editing stops at once when the page isn't live: the caret goes, and the keyboard with it.
      if (wasLive && !live) input.endEditing();
      wasLive = live;
    },
  });
  (window as Window & { __dohcLive?: (message: unknown) => void }).__dohcLive = adapter.receive;
}
