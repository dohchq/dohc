import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { basenameOf, dirnameOf } from "../path";
import { tabMark, type TabMark } from "./tabGlyph";
import { collectionTabPath, parseTab, siteTabPath, transactionalCollectionTabPath } from "./workbenchState";

// The Explorer's Home: the workspace grouped by what each thing is, over the
// same listing the Files tree shows. Nothing here reads a file's contents;
// a page's name is its file name, which dohc takes from the title a person
// gave it when the page was made.

export type HomeSectionId = "pinned" | "pages" | "sketches" | "collections" | "apps" | "other";

// What a row draws before its name: a tab's mark, or a folder.
export type HomeGlyph = TabMark | { glyph: "folder"; open: boolean };

export type HomeRowModel = {
  // Unique across Home. The same page can be pinned and in Pages.
  key: string;
  section: HomeSectionId;
  // The parent row's key: the section's, or the folder's in Pages.
  parentKey: string;
  // 1 directly under the section heading.
  depth: number;
  label: string;
  glyph: HomeGlyph;
  // What a click opens: a workspace path or a tab path. A Pages folder opens
  // nothing; it folds.
  open: string | null;
  // The workspace path whose Files menu this row shows, and its kind.
  menu: { path: string; kind: "file" | "folder" } | null;
  // Pages folders fold; everything else is a leaf.
  folder: boolean;
  expanded: boolean;
  // Muted text at the end of the row, such as a sketch's or an Other file's folder.
  detail?: string;
  // Why the row cannot open, as the sentence that says what to fix. It is the
  // row's tooltip and description.
  unavailable?: string;
  // The files to fix, which the row's click and menu show in Files.
  fix?: readonly string[];
};

export type DataCollection = {
  datasetId: string;
  datasetPath: string | null;
  /** Why a Collection with no `datasetPath` can't open, and the dataset.json files to fix. */
  datasetAddressStatus?: "available" | "missing" | "ambiguous" | "unreadable";
  datasetPaths?: readonly string[];
  tableId: string;
  name: string;
  archived?: boolean;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function pageTitle(path: string): string {
  return basenameOf(path).replace(/\.(md|markdown)$/i, "");
}

// Folders whose contents belong to something else: a Collection's documents
// are its records, and an app's files are its source.
function ownedBy(path: string, owners: ReadonlySet<string>): boolean {
  if (owners.size === 0) return false;
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    if (owners.has(path.slice(0, end))) return true;
  }
  return owners.has(path);
}

export const FILES_SHOWN = 20;

// The first FILES_SHOWN files by name, and how many there are in all.
export type FirstFiles = { shown: WorkspaceFileEntry[]; count: number };

export type HomeKinds = { pages: WorkspaceFileEntry[]; sketches: FirstFiles; others: FirstFiles };

const compareByName = (a: WorkspaceFileEntry, b: WorkspaceFileEntry) =>
  collator.compare(basenameOf(a.path), basenameOf(b.path)) || collator.compare(a.path, b.path);

function keepFirst(list: FirstFiles, file: WorkspaceFileEntry): void {
  list.count += 1;
  const { shown } = list;
  if (shown.length === FILES_SHOWN && compareByName(file, shown[FILES_SHOWN - 1]!) >= 0) return;
  let at = shown.length;
  while (at > 0 && compareByName(file, shown[at - 1]!) < 0) at -= 1;
  shown.splice(at, 0, file);
  if (shown.length > FILES_SHOWN) shown.pop();
}

// One pass over the listing. A dataset's folder holds its dataset.json.
// Sketches and other files are never sorted whole: Home shows only the first few.
export function classifyFiles(
  files: readonly WorkspaceFileEntry[],
  collectionFolders: ReadonlySet<string>,
  appFolders: ReadonlySet<string>,
): HomeKinds {
  const owners = new Set([...collectionFolders, ...appFolders]);
  for (const file of files) {
    if (basenameOf(file.path) === "dataset.json") owners.add(dirnameOf(file.path));
  }
  const pages: WorkspaceFileEntry[] = [];
  const sketches: FirstFiles = { shown: [], count: 0 };
  const others: FirstFiles = { shown: [], count: 0 };
  for (const file of files) {
    if (ownedBy(file.path, owners)) continue;
    const kind = file.kind === "file" ? fileKindForPath(file.path).displayKind : null;
    if (kind === "markdown") pages.push(file);
    else keepFirst(kind === "drawing" ? sketches : others, file);
  }
  return { pages, sketches, others };
}

type PageFolder = { path: string; folders: Map<string, PageFolder>; pages: WorkspaceFileEntry[] };

// The folders that hold pages, nested as the person made them. A folder
// with no page anywhere under it does not appear.
export function pageTree(pages: readonly WorkspaceFileEntry[]): PageFolder {
  const root: PageFolder = { path: "", folders: new Map(), pages: [] };
  for (const page of pages) {
    let cursor = root;
    const segments = page.path.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let next = cursor.folders.get(name);
      if (!next) {
        next = { path: segments.slice(0, index + 1).join("/"), folders: new Map(), pages: [] };
        cursor.folders.set(name, next);
      }
      cursor = next;
    }
    cursor.pages.push(page);
  }
  return root;
}

// The Pages rows a person can see: folders first, then pages, each sorted
// by the name the row shows.
export function pageRows(tree: PageFolder, expanded: ReadonlySet<string>): HomeRowModel[] {
  const out: HomeRowModel[] = [];
  const walk = (folder: PageFolder, depth: number, parentKey: string) => {
    const folders = [...folder.folders.entries()].sort(([a], [b]) => collator.compare(a, b));
    for (const [name, child] of folders) {
      const open = expanded.has(child.path);
      const key = `pages:${child.path}/`;
      out.push({
        key, section: "pages", parentKey, depth, label: name,
        glyph: { glyph: "folder", open }, open: null,
        menu: { path: child.path, kind: "folder" }, folder: true, expanded: open,
      });
      if (open) walk(child, depth + 1, key);
    }
    const pages = folder.pages
      .map((page) => ({ page, title: pageTitle(page.path) }))
      .sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.page.path, b.page.path));
    for (const { page, title } of pages) {
      out.push({
        key: `pages:${page.path}`, section: "pages", parentKey, depth, label: title,
        glyph: { glyph: "markdown", icon: page.icon }, open: page.path,
        menu: { path: page.path, kind: "file" }, folder: false, expanded: false,
      });
    }
  };
  walk(tree, 1, "pages");
  return out;
}

// A Sketches or Other files row: the file's name, then its folder.
export function fileRows(
  section: "sketches" | "other",
  files: readonly WorkspaceFileEntry[],
  lookup: ReadonlyMap<string, WorkspaceFileEntry>,
): HomeRowModel[] {
  return files.map((file) => ({
    key: `${section}:${file.path}`, section, parentKey: section, depth: 1,
    label: basenameOf(file.path), glyph: tabMark(file.path, lookup), open: file.path,
    menu: { path: file.path, kind: "file" }, folder: false, expanded: false,
    ...(dirnameOf(file.path) ? { detail: dirnameOf(file.path) } : {}),
  }));
}

// What Home knows about each thing a pin can name.
export type HomeLookup = {
  files: ReadonlyMap<string, WorkspaceFileEntry>;
  folders: ReadonlySet<string>;
  collectionFolders: ReadonlySet<string>;
  // App folders and their titles, once the apps are read.
  apps: ReadonlyMap<string, string>;
  dataCollections: readonly DataCollection[];
};

// The row a workspace path or tab path stands for in Pinned, or null when the
// workspace no longer has it.
function pinnedRow(path: string, lookup: HomeLookup): HomeRowModel | null {
  const base = { key: `pinned:${path}`, section: "pinned" as const, parentKey: "pinned", depth: 1, folder: false, expanded: false };
  const tab = parseTab(path);
  if (tab.kind === "site") {
    const root = tab.siteRoot;
    if (root === null || !lookup.apps.has(root)) return null;
    return { ...base, label: lookup.apps.get(root)!, glyph: { glyph: "app", icon: undefined }, open: path, menu: { path: root, kind: "folder" } };
  }
  if (tab.kind === "collection") {
    const folder = tab.collectionPath;
    if (folder === null || !lookup.collectionFolders.has(folder)) return null;
    return collectionRow(base, folder);
  }
  if (tab.kind === "transactionalCollection") {
    const collection = lookup.dataCollections.find((entry) => entry.datasetPath === tab.datasetPath && entry.tableId === tab.tableId);
    if (!collection) return null;
    return { ...base, label: collection.name, glyph: { glyph: "collection", icon: undefined }, open: path, menu: datasetMenu(tab.datasetPath) };
  }
  if (tab.kind !== "file") return null;
  // A pin names an app or a Collection by its folder.
  if (lookup.apps.has(path)) {
    return { ...base, label: lookup.apps.get(path)!, glyph: { glyph: "app", icon: undefined }, open: siteTabPath(path), menu: { path, kind: "folder" } };
  }
  if (lookup.collectionFolders.has(path)) return collectionRow(base, path);
  if (lookup.folders.has(path)) {
    return { ...base, label: basenameOf(path), glyph: { glyph: "folder", open: false }, open: null, menu: { path, kind: "folder" } };
  }
  const file = lookup.files.get(path);
  if (!file) return null;
  const page = file.kind === "file" && fileKindForPath(path).displayKind === "markdown";
  return {
    ...base,
    label: page ? pageTitle(path) : basenameOf(path),
    glyph: tabMark(path, lookup.files), open: path, menu: { path, kind: "file" },
  };
}

// A dataset Collection's menu is its folder's. One kept at the workspace's
// top has no folder of its own, so it has no menu.
function datasetMenu(datasetPath: string): HomeRowModel["menu"] {
  const folder = dirnameOf(datasetPath);
  return folder ? { path: folder, kind: "folder" } : null;
}

function collectionRow(base: Omit<HomeRowModel, "label" | "glyph" | "open" | "menu">, folder: string): HomeRowModel {
  return { ...base, label: basenameOf(folder), glyph: { glyph: "collection", icon: undefined }, open: collectionTabPath(folder), menu: { path: folder, kind: "folder" } };
}

// Pinned apps first, in pin order, then everything else pinned. An app
// pinned both ways shows once.
export function pinnedRows(pinnedApps: readonly string[], pinned: readonly string[], lookup: HomeLookup): HomeRowModel[] {
  const seen = new Set<string>();
  const out: HomeRowModel[] = [];
  for (const path of [...pinnedApps, ...pinned]) {
    if (seen.has(path)) continue;
    seen.add(path);
    const row = pinnedRow(path, lookup);
    if (row) out.push(row);
  }
  return out;
}

// A Collection that can't open shows its cause in place of its detail. One
// whose dataset.json files are in this workspace shows them in Files.
function unavailableWords(entry: DataCollection): Pick<HomeRowModel, "detail" | "unavailable" | "fix"> {
  const fix = entry.datasetPaths ?? [];
  if (entry.datasetAddressStatus === "ambiguous") {
    return { detail: `${fix.length} dataset.json files`, unavailable: "Several dataset.json files name this Collection. Keep one and remove the others.", fix };
  }
  if (entry.datasetAddressStatus === "unreadable") {
    return { detail: "Can't read dataset.json", unavailable: "dohc can't read this Collection's dataset.json. Fix the file, or restore it from History.", fix };
  }
  return { detail: "Not in this share", unavailable: "This share doesn't include the Collection's dataset.json. Ask the owner to include it." };
}

// The Collections rows: dataset Collections in the order the engine lists
// them, then folder Collections by name.
export function collectionRows(data: readonly DataCollection[], collectionFolders: ReadonlySet<string>): HomeRowModel[] {
  const base = { section: "collections" as const, parentKey: "collections", depth: 1, folder: false, expanded: false };
  const rows: HomeRowModel[] = data.map((entry) => ({
    ...base,
    key: `collections:${entry.datasetId}:${entry.tableId}`,
    label: entry.name,
    glyph: { glyph: "collection", icon: undefined },
    open: entry.datasetPath === null ? null : transactionalCollectionTabPath(entry.datasetPath, entry.tableId),
    menu: entry.datasetPath === null ? null : datasetMenu(entry.datasetPath),
    ...(entry.datasetPath === null ? unavailableWords(entry) : entry.archived ? { detail: "Archived" } : {}),
  }));
  const folders = [...collectionFolders].sort((a, b) => collator.compare(basenameOf(a), basenameOf(b)));
  for (const folder of folders) rows.push(collectionRow({ ...base, key: `collections:${folder}/` }, folder));
  return rows;
}
