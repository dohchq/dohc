import { EditorView } from "@codemirror/view";
import { act, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { AUTOSAVE_DEBOUNCE_MS } from "./useAutosavedTextDraft";

// A text view's test id appears one commit before CodeMirror exists: the view
// creates its EditorView — and with it `.cm-content` — in a passive effect. A
// `querySelector` on the render that found the test id therefore returns null
// often enough to matter, and `as HTMLElement` used to hide exactly that null
// until a later line failed on it. Waiting for the element is the honest read,
// and it is what every interaction here needs anyway: no user can click into an
// editor that has not been built.
export async function textEditorContent(host: HTMLElement): Promise<HTMLElement> {
  return await waitFor(() => {
    const content = host.querySelector(".cm-content");
    if (!(content instanceof HTMLElement)) {
      throw new Error("CodeMirror has not mounted .cm-content yet");
    }
    return content;
  });
}

export function codeEditorView(host: HTMLElement): EditorView {
  const content = host.querySelector(".cm-content");
  if (!(content instanceof HTMLElement)) {
    throw new Error("CodeMirror has not mounted .cm-content yet");
  }
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("CodeMirror has not attached an EditorView");
  return view;
}

export function codeEditorText(host: HTMLElement): string {
  return codeEditorView(host).state.doc.toString();
}

export function replaceCodeEditorText(host: HTMLElement, text: string): void {
  const view = codeEditorView(host);
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

export function appendCodeEditorText(host: HTMLElement, text: string): void {
  const view = codeEditorView(host);
  act(() => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      selection: { anchor: view.state.doc.length + text.length },
    });
  });
}

export async function typeInMarkdownEditor(
  user: ReturnType<typeof userEvent.setup>,
  editor: HTMLElement,
  text: string,
): Promise<void> {
  if (editor.classList.contains("dohc-code-editor")) {
    await textEditorContent(editor);
    appendCodeEditorText(editor, text);
    return;
  }
  await user.type(editor, text);
}

export type CodeEditorTestHost = HTMLElement & {
  value: string;
  readOnly: boolean;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
};

export function codeEditorTestHost(host: HTMLElement): CodeEditorTestHost {
  Object.defineProperties(host, {
    value: {
      configurable: true,
      get: () => codeEditorText(host),
      set: (text: string) => replaceCodeEditorText(host, text),
    },
    readOnly: {
      configurable: true,
      get: () =>
        host.querySelector(".cm-content")?.getAttribute("contenteditable") ===
        "false",
    },
    selectionStart: {
      configurable: true,
      get: () => codeEditorView(host).state.selection.main.from,
    },
    selectionEnd: {
      configurable: true,
      get: () => codeEditorView(host).state.selection.main.to,
    },
    setSelectionRange: {
      configurable: true,
      value: (start: number, end: number) => {
        codeEditorView(host).dispatch({
          selection: { anchor: start, head: end },
        });
      },
    },
  });
  return host as CodeEditorTestHost;
}

export async function findTextEditorContent(): Promise<HTMLElement> {
  return await textEditorContent(await screen.findByTestId("view-text-editor"));
}

// One fake frame stays below the autosave delay.

export const ONE_FRAME_MS = 20;

export async function advanceAutosaveDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
  });
}

// A few of the tests below still need shouldAdvanceTime rather than a bare
// vi.useFakeTimers(): verified empirically, not tied to one specific
// mechanism — removing auto-advance hangs them (React's own effect
// scheduling or update batching needs real macrotask progress a frozen
// fake clock never delivers on its own; user-event/editor chrome can too,
// see settleUserEventAction for the cases that pump instead). The
// debounce or write each of those tests actually pins still fires from
// its own explicit advance either way, so auto-advance changes nothing
// they check.
export function useAutoAdvancingFakeTimers(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

export const LARGE_READ_MODE_FILLER = Array.from(
  { length: 96 },
  (_, index) => `Paragraph ${index + 1}. ${"body ".repeat(160)}`,
).join("\n\n");

// The DOM/layout stubs Tiptap + CodeMirror need under jsdom — shared by every
// describe that renders an editor surface.
export function stubEditorGlobals() {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 16)),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  stubScrollSpy("scrollIntoView");
}

/** jsdom implements neither scroll method, and the jump seams are only
 *  observable through them — so stub one on every element and hand back the
 *  spy the test asserts against. */
export function stubScrollSpy(
  method: "scrollIntoView" | "scrollTo",
  implementation?: (this: HTMLElement) => void,
) {
  const spy = implementation ? vi.fn(implementation) : vi.fn();
  Object.defineProperty(HTMLElement.prototype, method, {
    configurable: true,
    value: spy,
  });
  return spy;
}

// The edit toggle is `disabled={readOnly || opening}`, and a click on a
// disabled button does nothing and does not retry. view-markdown renders while
// the engine open is still answering, so a click fired the moment the button
// exists is dropped whenever the open has not answered yet, and the wait for
// the source surface then times out on a toggle that never happened. Clicking
// a mode toggle more than once is not a fix — the modes cycle — so the enabled
// button is the thing to wait for.
export async function findEnabledMarkdownEditToggle(): Promise<HTMLElement> {
  return await waitFor(() => {
    const toggle = screen.getByTestId("markdown-edit-toggle");
    if (toggle instanceof HTMLButtonElement && toggle.disabled) {
      throw new Error(
        "markdown-edit-toggle is still disabled — the document is opening",
      );
    }
    return toggle;
  });
}

export async function findSourceEditor(): Promise<CodeEditorTestHost> {
  return await waitFor(() => {
    const editor = screen.getByTestId("markdown-editor");
    if (!editor.classList.contains("dohc-code-editor")) {
      throw new Error(
        "markdown-editor is the WYSIWYG surface — the source toggle has not landed yet",
      );
    }
    codeEditorView(editor);
    return codeEditorTestHost(editor);
  });
}

// Why the toggle can be missing at all: registerSourceToggle lands in a
// passive effect, and findByTestId resolves from a MutationObserver callback
// that can beat React's effect flush on a busy box. `toggle?.()` then silently
// does nothing -- the component stays in WYSIWYG and the test spends its whole
// asyncUtil window waiting for a source view nobody ever asked for. Never
// optional-chain a missing toggle away; wait for it.
export async function toggleSourceOnce(read: () => (() => void) | null): Promise<void> {
  const toggle = await waitFor(() => {
    const registered = read();
    if (!registered) throw new Error("registerSourceToggle has not run yet");
    return registered;
  });
  act(() => toggle());
}
