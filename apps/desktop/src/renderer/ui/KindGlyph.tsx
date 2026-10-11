import { AppWindow, Database, File, FileCode, FileSpreadsheet, FileText, Image, PenTool, type LucideIcon } from "lucide-react";
import type { FileKindRecord } from "@dohc/workspace-contracts/kinds";

// One kind, one glyph, one name: every surface draws a file's kind through
// this part, so the glyph comes from the kind registry and never from a
// surface's own choice. The glyph says the kind, so a visible word never
// does. A caller with only a path passes `fileKindForPath(path)`. Size and
// color are the caller's.
//
// Beside a name the glyph is decorative: the control is named by its own
// text, and a glyph label would rename it. A glyph standing alone asks for
// `labelled`, and the kind's name becomes its accessible name.
//
// A `Record` over the registry's glyph ids, so a new glyph is a compile error
// here until it has its icon.
const GLYPHS: Record<FileKindRecord["glyphId"], LucideIcon> = {
  file: File,
  "file-text": FileText,
  "file-spreadsheet": FileSpreadsheet,
  "file-code": FileCode,
  "pen-tool": PenTool,
  image: Image,
  database: Database,
};

export function KindGlyph(props: {
  kind: FileKindRecord;
  size: number;
  className?: string;
  labelled?: boolean;
}) {
  const Glyph = GLYPHS[props.kind.glyphId];
  const label = props.labelled
    ? { role: "img", "aria-label": props.kind.name }
    : { "aria-hidden": true };
  return <Glyph {...label} size={props.size} className={`shrink-0 ${props.className ?? ""}`} />;
}

// An app is a folder, not a file kind, so the registry has no record for it.
// A surface that lists an app as an object draws this glyph beside its name.
export function AppGlyph(props: { size: number; className?: string }) {
  return <AppWindow aria-hidden size={props.size} className={`shrink-0 ${props.className ?? ""}`} />;
}
