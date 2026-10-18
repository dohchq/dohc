import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { fileKindForPath, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import { basenameOf } from "../path";
import { KIND_GLYPHS } from "./KindGlyph";
import { REF_HOVER, REF_NAME, refChipClass } from "./refChip";

type GlyphId = FileKindRecord["glyphId"];

// KindGlyph's icons, each rendered once by React into a detached element when
// this module loads. A module evaluates outside React's render and commit,
// where flushSync renders at once; inside them it would leave the element
// empty. Each chip clones its glyph's template.
const GLYPH_TEMPLATES = renderGlyphTemplates();

function renderGlyphTemplates(): Record<GlyphId, SVGSVGElement> {
  const ids = Object.keys(KIND_GLYPHS) as GlyphId[];
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(ids.map((id) => createElement(KIND_GLYPHS[id], { key: id, "aria-hidden": true }))));
  const templates = Object.fromEntries(ids.map((id, index) => [id, host.children[index].cloneNode(true)]));
  root.unmount();
  return templates as Record<GlyphId, SVGSVGElement>;
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
  const glyph = GLYPH_TEMPLATES[(props.kind ?? fileKindForPath(props.path)).glyphId].cloneNode(true) as SVGSVGElement;
  glyph.setAttribute("width", "13");
  glyph.setAttribute("height", "13");
  glyph.classList.add("shrink-0", "text-muted");
  const name = document.createElement("span");
  name.className = REF_NAME;
  name.textContent = props.title || basenameOf(props.path);
  chip.append(glyph, name);
  return chip;
}
