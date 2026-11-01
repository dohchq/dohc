// The chats this window shows, by thread, so a notice about a run the person
// can already see is skipped.
const shown = new Map<string, Set<Element>>();

// Marks an element as showing a chat until the returned function runs.
export function showChat(threadId: string, element: Element): () => void {
  const elements = shown.get(threadId) ?? new Set<Element>();
  elements.add(element);
  shown.set(threadId, elements);
  return () => {
    elements.delete(element);
    if (elements.size === 0 && shown.get(threadId) === elements) shown.delete(threadId);
  };
}

// Whether a visible element in a visible, focused window shows the chat now.
// A background tab keeps its chat mounted but hidden, and a person working in
// another window isn't looking at this one.
export function chatOnScreen(threadId: string): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  return [...(shown.get(threadId) ?? [])].some((element) => element.isConnected && (element.checkVisibility?.() ?? true));
}
