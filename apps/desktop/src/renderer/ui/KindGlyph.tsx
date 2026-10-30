import {
  AppWindow,
  Database,
  File,
  FileCode,
  FileDiff,
  FileSpreadsheet,
  FileText,
  Hash,
  History,
  Image,
  Layers,
  MessageCircle,
  PenTool,
  Sparkles,
  Table2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { FILE_KIND_RECORDS, fileKindForPath, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";

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

// The listing, not the file name, says whether a file is a database: the kind
// registry matches `.db` by extension alone.
export function listedFileKind(path: string, listed: WorkspaceFileEntry["kind"] | null | undefined): FileKindRecord {
  if (listed === "database") return FILE_KIND_RECORDS.database;
  const kind = fileKindForPath(path);
  return kind.displayKind === "database" ? FILE_KIND_RECORDS.binary : kind;
}

// A listed file's mark: a page's `icon` frontmatter emoji stands in for its
// kind glyph (Notion-style), in a box the glyph's size so the name does not
// move.
export function FileGlyph(props: { kind: FileKindRecord; icon: string | undefined; size: number; className?: string }) {
  if (!props.icon) return <KindGlyph kind={props.kind} size={props.size} className={props.className} />;
  return (
    <span
      aria-hidden
      style={{ width: props.size, height: props.size, fontSize: props.size - 2 }}
      className="grid shrink-0 place-items-center leading-none"
    >
      {props.icon}
    </span>
  );
}

// The objects a workspace holds that are not files, each with one glyph
// wherever it is listed. A `Record` over the kinds, so a new kind is a
// compile error here until it has its icon. Like a file's, the glyph is
// decorative beside the object's name.
export type ObjectKind = "app" | "collection" | "group" | "chat" | "agent" | "compare" | "change" | "graph" | "history";

const OBJECT_GLYPHS: Record<ObjectKind, LucideIcon> = {
  app: AppWindow,
  collection: Table2,
  group: Hash,
  chat: MessageCircle,
  agent: Sparkles,
  compare: Layers,
  change: FileDiff,
  graph: Workflow,
  history: History,
};

export function isObjectKind(kind: string): kind is ObjectKind {
  return Object.hasOwn(OBJECT_GLYPHS, kind);
}

export function ObjectGlyph(props: { kind: ObjectKind; size: number; className?: string }) {
  const Glyph = OBJECT_GLYPHS[props.kind];
  return <Glyph aria-hidden size={props.size} className={`shrink-0 ${props.className ?? ""}`} />;
}
