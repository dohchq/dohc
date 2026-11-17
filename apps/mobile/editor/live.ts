// A page edited live (liveAdapter.ts). The page shows the text the app read until the provider is live, then the live
// document replaces it in one paint. It takes edits only while live.
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { post } from "./bridge";
import { createLiveAdapter, type LiveProvider } from "./liveAdapter";

export function followLive(input: {
  /** The read text's body, which the live one replaces. */
  readonly body: HTMLElement;
  readonly readOnly: { destroy(): void };
  readonly label: string;
  endEditing(): void;
}) {
  let shown = false;
  let wasLive = false;

  function show(made: LiveProvider) {
    shown = true;
    const next = document.createElement("div");
    next.className = input.body.className;
    next.hidden = true;
    input.body.after(next);
    const editor = mountLiveBodyEditor(next, {
      body: made.body,
      label: input.label,
      canEdit: () => made.state().status === "live",
      edit(change) {
        if (made.state().status !== "live") return false;
        change();
        return true;
      },
    });
    made.subscribe(() => editor.refresh());
    (window as Window & { __dohcCopyMarkdown?: () => void }).__dohcCopyMarkdown = () =>
      post("markdown", { markdown: yDocToMarkdown(made.doc) });
    // Swapped once the live editor has drawn, so the read text never leaves an empty frame.
    requestAnimationFrame(() =>
      setTimeout(() => {
        input.body.remove();
        input.readOnly.destroy();
        next.hidden = false;
      }, 0),
    );
  }

  const adapter = createLiveAdapter({
    post: (message) => post(message.kind, message),
    changed(made) {
      const live = made.state().status === "live";
      if (live && !shown) show(made);
      // Editing stops at once when the page isn't live: the caret goes, and the keyboard with it.
      if (wasLive && !live) input.endEditing();
      wasLive = live;
    },
  });
  (window as Window & { __dohcLive?: (message: unknown) => void }).__dohcLive = adapter.receive;
}
