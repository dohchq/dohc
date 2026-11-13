import { watchWindowFocus, windowFocused } from "../windowFocus";

// The chats this window shows, by thread, so a notice about a run the person
// can already see is skipped, and a message's notice reads once they see it.
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

// Whether a visible element in a visible, focused window shows the chat now.
// A background tab keeps its chat mounted but hidden, and a person working in
// another window isn't looking at this one.
export function chatOnScreen(threadId: string): boolean {
  if (document.visibilityState !== "visible" || !windowFocused()) return false;
  return [...(shown.get(threadId) ?? [])].some(
    (element) => element.isConnected && (element.checkVisibility?.() ?? true),
  );
}

// Calls `listener` when a chat shows or hides, or the window gains or loses
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
