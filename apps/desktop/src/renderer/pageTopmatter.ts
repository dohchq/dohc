// The rows above a document's body (title, properties, the frontmatter as
// written) sit in the editor's 720px reading measure inside its 56px gutters.
export const TOPMATTER_ROW = "box-border w-full bg-bg px-14";
export const TOPMATTER_MEASURE = "mx-auto max-w-[720px]";

// The properties' pills, 14px under the title, as the drawing spaces them.
// The loading line holds one line of pills, so nothing moves when they arrive.
export const PROPERTIES_PANEL = `${TOPMATTER_ROW} pt-3.5`;
export const PROPERTIES_LINE = `${TOPMATTER_MEASURE} flex min-h-6 flex-wrap items-center gap-1.5`;

const FLAG = "overflow-hidden text-ellipsis whitespace-nowrap text-[11px]";
// A name the page cannot save, said beside the edit it refused.
export const TOPMATTER_FLAG = `${FLAG} text-danger`;
// Properties the page can show but not save, in the lossy note's tone.
export const TOPMATTER_READ_ONLY_FLAG = `${FLAG} text-warning`;
