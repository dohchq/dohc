import type { WorkspaceFile } from "../server/workspaceReads";

// Home's rows from the workspace's files, by the desktop's rules (apps/desktop/src/renderer/workbench/explorerHomeModel.ts):
// pages nested in the folders that hold them, folders first, each sorted by the name its row shows, and the other files
// by name. A Collection's documents are its records, so neither list shows them. The phone has no Collections or Apps
// sections yet, and doesn't know which folders hold an app.

export type HomeRow =
  | { readonly kind: "folder"; readonly key: string; readonly path: string; readonly name: string; readonly depth: number; readonly open: boolean }
  | { readonly kind: "page"; readonly key: string; readonly path: string; readonly name: string; readonly depth: number }
  | { readonly kind: "other"; readonly key: string; readonly path: string; readonly name: string; readonly folder: string };

export const OTHER_FILES_SHOWN = 20;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** A page's name: its file's, without the extension. */
export const pageTitle = (path: string) => basename(path).replace(/\.(md|markdown)$/i, "");

type Folder = { readonly path: string; readonly folders: Map<string, Folder>; readonly pages: WorkspaceFile[] };

export function homeRows(files: readonly WorkspaceFile[], expanded: ReadonlySet<string>): { pages: HomeRow[]; others: HomeRow[]; otherCount: number } {
  // A dataset's folder holds its dataset.json; everything under it belongs to the Collection.
  const owners = new Set(files.filter(file => basename(file.path) === "dataset.json").map(file => dirname(file.path)));
  const owned = (path: string) => [...owners].some(owner => path === owner || path.startsWith(`${owner}/`));
  const root: Folder = { path: "", folders: new Map(), pages: [] };
  const others: WorkspaceFile[] = [];
  for (const file of files) {
    if (owned(file.path)) continue;
    if (!file.page) {
      others.push(file);
      continue;
    }
    let folder = root;
    const segments = file.path.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let next = folder.folders.get(name);
      if (!next) {
        next = { path: segments.slice(0, index + 1).join("/"), folders: new Map(), pages: [] };
        folder.folders.set(name, next);
      }
      folder = next;
    }
    folder.pages.push(file);
  }

  const pages: HomeRow[] = [];
  const walk = (folder: Folder, depth: number) => {
    for (const [name, child] of [...folder.folders].sort(([a], [b]) => collator.compare(a, b))) {
      const open = expanded.has(child.path);
      pages.push({ kind: "folder", key: `folder:${child.path}`, path: child.path, name, depth, open });
      if (open) walk(child, depth + 1);
    }
    const titled = folder.pages.map(page => ({ path: page.path, name: pageTitle(page.path) }))
      .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));
    for (const page of titled) pages.push({ kind: "page", key: `page:${page.path}`, path: page.path, name: page.name, depth });
  };
  walk(root, 0);

  const shown = others
    .sort((a, b) => collator.compare(basename(a.path), basename(b.path)) || collator.compare(a.path, b.path))
    .slice(0, OTHER_FILES_SHOWN)
    .map((file): HomeRow => ({ kind: "other", key: `other:${file.path}`, path: file.path, name: basename(file.path), folder: dirname(file.path) }));
  return { pages, others: shown, otherCount: others.length };
}
