import type { DraftFlush } from "./useAutosavedTextDraft";

export const EDITOR_WRITE_STALL_MS = 20_000;

type PendingEditorDraft = { pending(): boolean; flush: DraftFlush; capture(): void; retired: boolean };
const editors = new Set<PendingEditorDraft>();

async function flushEditor(editor: PendingEditorDraft): Promise<void> {
  try { await editor.flush({ captureOnFailure: true }); }
  finally { if (editor.retired && !editor.pending()) editors.delete(editor); }
}

export function registerPendingEditorDraft(pending: () => boolean, flush: DraftFlush, capture: () => void): () => void {
  const editor = { pending, flush, capture, retired: false };
  editors.add(editor);
  return () => {
    editor.retired = true;
    if (!editor.pending()) editors.delete(editor);
    else void flushEditor(editor).catch(() => {});
  };
}
export function hasPendingEditorDrafts(): boolean {
  return [...editors].some(editor => editor.pending());
}
export async function settlePendingEditorDrafts(): Promise<boolean> {
  for (;;) {
    const pending = [...editors].filter(editor => editor.pending());
    if (pending.length === 0) return true;
    // Flush failures capture recovery before rejecting. The exit guard then
    // checks durability and warns about any text storage could not preserve.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled(pending.map(flushEditor)),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), EDITOR_WRITE_STALL_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (settled === null) {
      // Keep the original writers alive. Recovery replaces only their exit
      // obligation; an edit made after this capture must be drained again.
      for (const editor of pending) {
        if (!editor.pending()) continue;
        try { editor.capture(); } catch { return false; }
        if (editor.pending()) return false;
        if (editor.retired) editors.delete(editor);
      }
      continue;
    }
    // A failed capture must keep the exit blocked, not spin on the same
    // failure. A later exit can retry the retained obligation.
    if (settled.some((result, index) => result.status === "rejected" && pending[index]!.pending())) return false;
  }
}
