import { normalizeAbsolutePath, validateUserReadPath, validateWorkspaceRootChoice } from "@dohc/workspace-core";
import { basename, dirname, isAbsolute } from "node:path";

export interface OpenPathFileSystem {
  kindOf(path: string): "file" | "folder" | null;
  hasManifest(folder: string): boolean;
}

/**
 * Where a file or folder opened from outside dohc lands. `file` is the
 * workspace-relative file to open in a tab, or null for none.
 */
export type OpenPathTarget<Workspace> =
  | { kind: "workspace"; workspace: Workspace; file: string | null }
  // A folder dohc must register first. One without a manifest becomes a
  // workspace only when the person agrees.
  | { kind: "folder"; rootPath: string; hasManifest: boolean; file: string | null };

/**
 * Resolves a path the OS or a launch handed dohc. A registered workspace that
 * holds it wins, then the nearest folder with a dohc manifest, then the folder
 * itself. Returns null when nothing is there to open, and throws when the
 * only folder left is one the folder picker would refuse.
 */
export function resolveOpenPathTarget<Workspace extends { rootPath: string }>(
  path: string,
  deps: {
    workspaces: readonly Workspace[];
    home: string;
    platform: NodeJS.Platform;
    fs: OpenPathFileSystem;
  },
): OpenPathTarget<Workspace> | null {
  if (!isAbsolute(path)) return null;
  const normalized = normalizeAbsolutePath(path);
  const kind = deps.fs.kindOf(normalized);
  if (kind === null) return null;
  const folder = kind === "folder" ? normalized : dirname(normalized);
  const fileIn = (root: string) => {
    if (kind === "folder") return null;
    const relative = normalized.slice(root.length).replace(/^\/+/u, "");
    return validateUserReadPath(relative, { platform: deps.platform }).ok ? relative : null;
  };

  let registered: { workspace: Workspace; root: string } | null = null;
  for (const workspace of deps.workspaces) {
    const root = normalizeAbsolutePath(workspace.rootPath);
    if (folder !== root && !folder.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
    if (!registered || root.length > registered.root.length) registered = { workspace, root };
  }
  if (registered) return { kind: "workspace", workspace: registered.workspace, file: fileIn(registered.root) };

  // A manifest at a root dohc cannot use, such as the home folder, is passed over.
  for (let current = folder; ; current = dirname(current)) {
    if (deps.fs.hasManifest(current) && validateWorkspaceRootChoice(current, deps.home).ok) {
      return { kind: "folder", rootPath: current, hasManifest: true, file: fileIn(current) };
    }
    if (dirname(current) === current) break;
  }

  if (!validateWorkspaceRootChoice(folder, deps.home).ok) {
    const where = normalizeAbsolutePath(deps.home).toLowerCase() === folder.toLowerCase()
      ? "Your home folder"
      : "The top folder of a disk";
    throw new Error(`${where} cannot be a workspace. ${kind === "file"
      ? "Move the file into a folder, then open it again."
      : "Open a folder inside it."}`);
  }
  return { kind: "folder", rootPath: folder, hasManifest: false, file: fileIn(folder) };
}

const OPEN_AS_WORKSPACE = 0;

/** Main's question before a folder from outside dohc becomes a workspace. */
export async function confirmOpenPathWorkspace(
  deps: {
    showMessageBox(options: {
      type: "question";
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
    }): Promise<{ response: number }>;
  },
  target: { rootPath: string; file: string | null },
): Promise<boolean> {
  const { response } = await deps.showMessageBox({
    type: "question",
    message: `Open "${basename(target.rootPath)}" as a workspace?`,
    detail: [
      `dohc adds a .dohc folder to ${target.rootPath} to keep the workspace's history.`,
      "Your files stay where they are.",
      ...(target.file ? [`Then dohc opens ${basename(target.file)}.`] : []),
    ].join(" "),
    buttons: ["Open as workspace", "Cancel"],
    defaultId: OPEN_AS_WORKSPACE,
    cancelId: 1,
    noLink: true,
  });
  return response === OPEN_AS_WORKSPACE;
}
