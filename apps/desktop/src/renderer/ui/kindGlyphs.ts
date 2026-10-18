/// <reference path="./lucideIconModules.d.ts" />
import type { IconNode } from "lucide-react";
import { __iconNode as database } from "lucide-react/dist/esm/icons/database.mjs";
import { __iconNode as file } from "lucide-react/dist/esm/icons/file.mjs";
import { __iconNode as fileCode } from "lucide-react/dist/esm/icons/file-code.mjs";
import { __iconNode as fileSpreadsheet } from "lucide-react/dist/esm/icons/file-spreadsheet.mjs";
import { __iconNode as fileText } from "lucide-react/dist/esm/icons/file-text.mjs";
import { __iconNode as image } from "lucide-react/dist/esm/icons/image.mjs";
import { __iconNode as penTool } from "lucide-react/dist/esm/icons/pen-tool.mjs";
import type { FileKindRecord } from "@dohc/workspace-contracts/kinds";

type GlyphId = FileKindRecord["glyphId"];

// Each kind glyph's lucide geometry. A registry glyph id is the lucide icon's
// name. KindGlyph draws these in React and kindGlyphElement in the DOM, so a
// kind has one glyph on both. A `Record` over the registry's glyph ids, so a
// new glyph is a compile error here until it has its icon.
export const KIND_GLYPH_NODES: Record<GlyphId, IconNode> = {
  file,
  "file-text": fileText,
  "file-spreadsheet": fileSpreadsheet,
  "file-code": fileCode,
  "pen-tool": penTool,
  image,
  database,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const templates = new Map<GlyphId, SVGSVGElement>();

// The glyph KindGlyph renders, as a decorative SVG element for DOM that React
// does not draw. Each glyph is built once and cloned after.
export function kindGlyphElement(kind: FileKindRecord, size: number, className: string): SVGSVGElement {
  let template = templates.get(kind.glyphId);
  if (!template) {
    template = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of [
      ["viewBox", "0 0 24 24"],
      ["fill", "none"],
      ["stroke", "currentColor"],
      ["stroke-width", "2"],
      ["stroke-linecap", "round"],
      ["stroke-linejoin", "round"],
      ["aria-hidden", "true"],
    ]) {
      template.setAttribute(name, value);
    }
    for (const [tag, attrs] of KIND_GLYPH_NODES[kind.glyphId]) {
      const part = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) if (name !== "key") part.setAttribute(name, value);
      template.append(part);
    }
    templates.set(kind.glyphId, template);
  }
  const glyph = template.cloneNode(true) as SVGSVGElement;
  glyph.setAttribute("width", String(size));
  glyph.setAttribute("height", String(size));
  glyph.setAttribute("class", `lucide lucide-${kind.glyphId} shrink-0 ${className}`);
  return glyph;
}
