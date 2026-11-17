import { watchWindowFocus, windowFocused } from "../windowFocus";

// The chats this window shows, by thread, so a notice about a run the person
// can already see is skipped.
const shown = new Map<string, Set<Element>>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function showChat(threadId: string, element: Element): () => void {
  const elements = shown.get(threadId) ?? new Set<Element>();
  elements.add(element);
  shown.set(threadId, elements);
  changed();
  return () => {
    elements.delete(element);
    if (elements.size === 0 && shown.get(threadId) === elements) shown.delete(threadId);
    changed();
  };
}

// The messages this window shows, by id, so a mention or reply Notice reads
// only once its own message shows. A comment folded into a post's card is
// not shown. Rows mount, unmount and re-attach their refs on every render,
// so listeners hear only when a message starts or stops showing.
const shownMessages = new Map<string, Set<Element>>();
const reported = new Set<string>();
const touched = new Set<string>();
let flushQueued = false;
const flushMessages = () => {
  flushQueued = false;
  let moved = false;
  for (const id of touched) {
    const now = (shownMessages.get(id)?.size ?? 0) > 0;
    if (now === reported.has(id)) continue;
    moved = true;
    if (now) reported.add(id);
    else reported.delete(id);
  }
  touched.clear();
  if (moved) changed();
};
const touch = (messageId: string) => {
  touched.add(messageId);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flushMessages);
  }
};

// Marks an element as showing a message until the returned function runs.
export function showMessage(messageId: string, element: Element): () => void {
  const elements = shownMessages.get(messageId) ?? new Set<Element>();
  elements.add(element);
  shownMessages.set(messageId, elements);
  touch(messageId);
  return () => {
    elements.delete(element);
    if (elements.size === 0 && shownMessages.get(messageId) === elements)
      shownMessages.delete(messageId);
    touch(messageId);
  };
}

const showing = (elements: Set<Element> | undefined) =>
  document.visibilityState === "visible" &&
  windowFocused() &&
  [...(elements ?? [])].some(
    (element) => element.isConnected && (element.checkVisibility?.() ?? true),
  );

// Whether a visible element in a visible, focused window shows the message now.
export function messageOnScreen(messageId: string): boolean {
  return showing(shownMessages.get(messageId));
}

// Whether a visible element in a visible, focused window shows the chat now.
// A background tab keeps its chat mounted but hidden, and a person working in
// another window isn't looking at this one.
export function chatOnScreen(threadId: string): boolean {
  return showing(shown.get(threadId));
}

// Calls `listener` when a chat or message shows or hides, or the window gains or loses
// focus or visibility, so a caller can ask chatOnScreen again.
export function watchChatsOnScreen(listener: () => void): () => void {
  listeners.add(listener);
  const unwatchFocus = watchWindowFocus(listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    listeners.delete(listener);
    unwatchFocus();
    document.removeEventListener("visibilitychange", listener);
  };
}
