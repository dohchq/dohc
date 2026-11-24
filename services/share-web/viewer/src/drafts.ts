// Unsent text, kept per composer for the life of the tab, so moving between files, Groups and tabs never loses it.
// Session storage holds it across a reload; a tab that blocks storage keeps it in memory for the page's life.
const PREFIX = "dohc.draft.";
const memory = new Map<string, string>();

export function readDraft(key: string): string {
  try {
    const stored = sessionStorage.getItem(PREFIX + key);
    if (stored !== null) return stored;
  } catch {
    /* Storage is unavailable; memory holds the draft. */
  }
  return memory.get(key) ?? "";
}

/** An empty text clears the draft. */
export function writeDraft(key: string, text: string): void {
  if (text) memory.set(key, text);
  else memory.delete(key);
  try {
    if (text) sessionStorage.setItem(PREFIX + key, text);
    else sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* Storage is unavailable or full; memory holds the draft. */
  }
}
