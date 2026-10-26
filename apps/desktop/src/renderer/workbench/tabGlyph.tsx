import { FILE_KIND_RECORDS, type FileDisplayKind } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { FileGlyph, isObjectKind, listedFileKind, ObjectGlyph, type ObjectKind } from "../ui/KindGlyph";
import { parseTab, TAB_KINDS } from "./workbenchState";

// An open tab's mark, wherever the tab is listed: the strip, its overflow
// menu and Explorer's open editors. A file draws its listed kind, or its
// page emoji; a new page draws a page; every other tab draws its object's
// glyph. Primitives, so a
// memoized row compares them by value.
export type TabMark = { glyph: FileDisplayKind | ObjectKind; icon: string | undefined };

export function tabMark(path: string, files: ReadonlyMap<string, WorkspaceFileEntry> | undefined): TabMark {
  const tab = parseTab(path);
  const glyph = TAB_KINDS[tab.kind].glyph(tab);
  if (glyph) return { glyph, icon: undefined };
  const entry = files?.get(path);
  return { glyph: listedFileKind(path, entry?.kind).displayKind, icon: entry?.icon };
}

export function TabGlyph(props: TabMark & { size: number; className?: string }) {
  return isObjectKind(props.glyph)
    ? <ObjectGlyph kind={props.glyph} size={props.size} className={props.className} />
    : <FileGlyph kind={FILE_KIND_RECORDS[props.glyph]} icon={props.icon} size={props.size} className={props.className} />;
}
