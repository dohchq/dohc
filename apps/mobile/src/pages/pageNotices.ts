import { documentWords } from "@dohc/interface-words/documents";

export type PageActionName = "retry" | "editAnyway";

/** What History says about the note before Edit anyway: it keeps the original, doesn't track the file, didn't
 * answer, or hasn't been asked yet. */
export type HistoryAnswer = "kept" | "untracked" | "unconfirmed" | null;

/** Edit anyway's message: the cost, then History's line, as the desktop's dialog says it (fileInspectorUi.tsx). */
export function editAnywayMessage(history: HistoryAnswer): string {
  const line = history === "kept" ? documentWords.historyKeeps
    : history === "untracked" ? documentWords.historyDoesNotTrack
    : history === "unconfirmed" ? documentWords.historyUnconfirmed
    : null;
  return line ? `${documentWords.editAnywayBody} ${line}` : documentWords.editAnywayBody;
}
export interface PageNotice { readonly key: string; readonly text: string; readonly action?: { readonly name: PageActionName; readonly label: string } }

/** The strips over a page's text, top to bottom, each with the action it offers. */
export function pageNotices(state: { couldNotOpen: boolean; lossy: boolean; large: boolean }): PageNotice[] {
  return [
    ...(state.couldNotOpen ? [{ key: "couldNotOpen", text: documentWords.couldNotOpenForEditing, action: { name: "retry" as const, label: documentWords.tryAgain } }] : []),
    ...(state.lossy ? [{ key: "lossy", text: documentWords.lossy, action: { name: "editAnyway" as const, label: documentWords.editAnyway } }] : []),
    ...(state.large ? [{ key: "large", text: documentWords.largeFile }] : []),
  ];
}

/** A failure in place of the page offers Try again. */
export const pageFailureAction = { name: "retry" as const, label: documentWords.tryAgain };

/** The handler behind each page action; every action a strip or failure offers has one. */
export type PageHandlers = Record<PageActionName, () => void>;
