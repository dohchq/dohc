import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { HomeRow } from "../home/homeModel";
import type { WorkspaceFile } from "../server/workspaceReads";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export const sketchTitle = (path: string) => base(path).replace(/\.excalidraw$/i, "");

export function allSketchRows(files: readonly WorkspaceFile[]): HomeRow[] {
  const owners = new Set(
    files.filter((f) => base(f.path) === "dataset.json").map((f) => dir(f.path)),
  );
  const owned = (p: string) => [...owners].some((o) => p === o || p.startsWith(`${o}/`));
  return files
    .filter((f) => !owned(f.path) && fileKindForPath(f.path).displayKind === "drawing")
    .sort(
      (a, b) => collator.compare(base(a.path), base(b.path)) || collator.compare(a.path, b.path),
    )
    .map((f) => ({
      kind: "sketch" as const,
      key: `sketch:${f.path}`,
      path: f.path,
      objectId: f.objectId,
      name: base(f.path),
      folder: dir(f.path),
    }));
}

export function uniqueSketchPath(files: readonly WorkspaceFile[]): string {
  const used = new Set(files.map((f) => f.path.toLowerCase()));
  if (!used.has("untitled.excalidraw")) return "Untitled.excalidraw";
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `Untitled ${i}.excalidraw`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `Untitled ${Date.now()}.excalidraw`;
}
