// Every surface explains `document-too-dense` in these words. A live note keeps
// its deleted blocks, and they count toward the bound, so the note never
// shrinks back under it; only new notes start without that history.
export const DOCUMENT_TOO_DENSE_CAUSE =
  "This note has grown too large to edit live with others, counting its past edits as well as what it holds now, so removing text won't bring it back under the limit.";
export const DOCUMENT_TOO_DENSE_NEXT = "Move its text into new, smaller notes and continue there.";
