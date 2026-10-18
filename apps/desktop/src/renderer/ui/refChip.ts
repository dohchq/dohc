// The reference chip's look, one recipe for Ref (React) and refElement (DOM).
// Hover and selected lay the ink fills over the inset surface instead of
// replacing it.
const CHIP =
  "inline-flex h-[22px] max-w-full min-w-0 items-center gap-[5px] whitespace-nowrap rounded border bg-panel-2 px-[7px] align-[1px] text-[13px] leading-none text-ink";
export const REF_HOVER =
  "cursor-pointer transition-colors duration-75 hover:bg-[image:linear-gradient(var(--color-hover),var(--color-hover))]";
export const REF_SELECTED = "bg-[image:linear-gradient(var(--color-selected),var(--color-selected))]";
export const REF_NAME = "min-w-0 truncate";

// A dashed border marks a target that does not resolve.
export function refChipClass(missing: boolean | undefined): string {
  return `${CHIP} ${missing ? "border-dashed border-subtle/50" : "border-line"}`;
}
