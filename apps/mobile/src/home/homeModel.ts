import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { PhoneApp } from "../server/phoneApps";
import type { WorkspaceFile } from "../server/workspaceReads";

export type HomeRow =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "page";
      readonly key: string;
      readonly path: string;
      readonly objectId: string;
      readonly name: string;
      readonly depth: number;
    }
  | {
      readonly kind: "sketch";
      readonly key: string;
      readonly path: string;
      readonly objectId: string;
      readonly name: string;
      readonly folder: string;
    }
  | {
      readonly kind: "other";
      readonly key: string;
      readonly path: string;
      readonly objectId: string;
      readonly name: string;
      readonly folder: string;
    };

/** The first FILES_SHOWN of a kind by name, and how many there are in all. */
export interface FirstFiles {
  readonly shown: HomeRow[];
  readonly count: number;
}

export const FILES_SHOWN = 20;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A page's name: its file's, without the extension. */
export const pageTitle = (path: string) => basename(path).replace(/\.(md|markdown)$/i, "");

type Folder = {
  readonly path: string;
  readonly folders: Map<string, Folder>;
  readonly pages: WorkspaceFile[];
};

export function appGroups(apps: readonly PhoneApp[]) {
  const groups = new Map<string, PhoneApp[]>();
  for (const app of apps) {
    const key = app.member ? `member:${app.publicationId}` : app.appRoot;
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return [...groups].map(([key, all]) => {
    const owner = all.filter((app) => app.owner);
    return {
      key,
      versions: owner.length ? [...owner, ...all.filter((app) => !app.owner && app.approved)] : all,
      approvedBefore: all.some((app) => app.approved),
    };
  });
}

export function revealedPages(rows: readonly HomeRow[], passed: Set<string>): string[] {
  const fresh = rows.flatMap((row) =>
    row.kind === "page" && !passed.has(row.path) ? [row.path] : [],
  );
  for (const path of fresh) passed.add(path);
  return fresh;
}

export function homeRows(
  files: readonly WorkspaceFile[],
  expanded: ReadonlySet<string>,
  options?: { readonly showAllOthers?: boolean; readonly excludeDocumentCollections?: boolean },
): { pages: HomeRow[]; sketches: FirstFiles; others: FirstFiles } {
  const excludeDocCols = options?.excludeDocumentCollections !== false;
  const owners = new Set(
    files
      .filter((file) => {
        const name = basename(file.path);
        return (
          name === "dataset.json" ||
          (excludeDocCols && name === "collection.yaml" && file.path.includes("/"))
        );
      })
      .map((file) => dirname(file.path)),
  );
  const owned = (path: string) =>
    [...owners].some((owner) => path === owner || path.startsWith(`${owner}/`));
  const root: Folder = { path: "", folders: new Map(), pages: [] };
  const sketches: WorkspaceFile[] = [];
  const others: WorkspaceFile[] = [];
  for (const file of files) {
    if (owned(file.path)) continue;
    if (!file.page) {
      (fileKindForPath(file.path).displayKind === "drawing" ? sketches : others).push(file);
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
      pages.push({
        kind: "folder",
        key: `folder:${child.path}`,
        path: child.path,
        name,
        depth,
        open,
      });
      if (open) walk(child, depth + 1);
    }
    const titled = folder.pages
      .map((page) => ({ path: page.path, objectId: page.objectId, name: pageTitle(page.path) }))
      .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));
    for (const page of titled)
      pages.push({
        kind: "page",
        key: `page:${page.path}`,
        path: page.path,
        objectId: page.objectId,
        name: page.name,
        depth,
      });
  };
  walk(root, 0);

  const first = (kind: "sketch" | "other", list: WorkspaceFile[], showAll = false): FirstFiles => ({
    shown: list
      .sort(
        (a, b) =>
          collator.compare(basename(a.path), basename(b.path)) || collator.compare(a.path, b.path),
      )
      .slice(0, showAll ? list.length : FILES_SHOWN)
      .map((file): HomeRow => ({
        kind,
        key: `${kind}:${file.path}`,
        path: file.path,
        objectId: file.objectId,
        name: basename(file.path),
        folder: dirname(file.path),
      })),
    count: list.length,
  });
  return {
    pages,
    sketches: first("sketch", sketches),
    others: first("other", others, options?.showAllOthers),
  };
}
