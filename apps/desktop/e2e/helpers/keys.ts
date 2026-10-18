// The chords that move the caret to the start and end of a text field or
// document. macOS has no Control+Home or Control+End; Command with an arrow
// does the same there.
export const DOCUMENT_START = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";
export const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
