// The rows above a document's body (title, properties, the frontmatter as
// written) sit in the editor's 720px reading measure inside its 56px gutters.
export const TOPMATTER_ROW = "box-border w-full bg-bg px-14";
export const TOPMATTER_MEASURE = "mx-auto max-w-[720px]";

// The properties' pills, 14px under the title, as the drawing spaces them.
// The loading line holds one line of pills, so nothing moves when they arrive.
export const PROPERTIES_PANEL = `${TOPMATTER_ROW} pt-3.5`;
export const PROPERTIES_LINE = `${TOPMATTER_MEASURE} flex min-h-6 flex-wrap items-center gap-1.5`;

// A name or a block the page cannot save, said beside the edit it refused.
export const TOPMATTER_FLAG = "overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-danger";
