import { fileKindForPath, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import { basenameOf } from "../path";
import { kindGlyphElement } from "./kindGlyphs";

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

// Ref's span as DOM, for ProseMirror widgets and node views, which draw DOM
// rather than React: the kind glyph, then the display name (the title when
// the caller has one, otherwise the basename), with the path in its tooltip.
// `opens` gives it the hover of a chip that opens its target on click.
export function refElement(props: {
  path: string;
  title?: string;
  kind?: FileKindRecord;
  missing?: boolean;
  opens?: boolean;
}): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = props.opens ? `${refChipClass(props.missing)} ${REF_HOVER}` : refChipClass(props.missing);
  if (props.missing) chip.dataset.missing = "true";
  if (props.path) chip.title = props.path;
  const name = document.createElement("span");
  name.className = REF_NAME;
  name.textContent = props.title || basenameOf(props.path);
  chip.append(kindGlyphElement(props.kind ?? fileKindForPath(props.path), 13, "text-muted"), name);
  return chip;
}
