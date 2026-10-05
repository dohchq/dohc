import { Database, FileCode, FileSpreadsheet, FileText, Image, PenTool, type LucideIcon } from "lucide-react";
import type { FileKindRecord } from "@dohc/workspace-contracts/kinds";

// One kind, one glyph, one name: every surface draws a file's kind through
// this part, so the glyph comes from the kind registry and never from a
// surface's own choice. The glyph says the kind, so the kind's name is its
// accessible label and never a visible word. A caller with only a path passes
// `fileKindForPath(path)`. Size and color are the caller's.
//
// A `Record` over the registry's glyph ids, so a new glyph is a compile error
// here until it has its icon.
const GLYPHS: Record<FileKindRecord["glyphId"], LucideIcon> = {
  "file-text": FileText,
  "file-spreadsheet": FileSpreadsheet,
  "file-code": FileCode,
  "pen-tool": PenTool,
  image: Image,
  database: Database,
};

export function KindGlyph(props: { kind: FileKindRecord; size: number; className?: string }) {
  const Glyph = GLYPHS[props.kind.glyphId];
  return (
    <Glyph
      role="img"
      aria-label={props.kind.name}
      size={props.size}
      className={`shrink-0 ${props.className ?? ""}`}
    />
  );
}
