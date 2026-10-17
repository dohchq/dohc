import { validateUserReadPath, validateWorkspaceRootChoice } from "@dohc/workspace-core";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { isInside } from "../security/pathContainment";

export interface OpenPathFileSystem {
  // The path as the file system names it, links resolved and in its on-disk
  // letter case, or null when nothing is there.
  realPath(path: string): string | null;
  kindOf(realPath: string): "file" | "folder" | null;
  hasManifest(folder: string): boolean;
}

// A folder dohc must register before it opens. `file` is the
// workspace-relative file to open in a tab, or null for none.
export interface OpenPathFolder {
  rootPath: string;
  hasManifest: boolean;
  file: string | null;
}

/** Where a file or folder opened from outside dohc lands. */
export type OpenPathTarget<Workspace> =
  | { kind: "workspace"; workspace: Workspace; file: string | null }
  | ({ kind: "folder" } & OpenPathFolder);

/**
 * Resolves a path the OS or a launch handed dohc. A registered workspace that
 * holds it wins, then the nearest folder with a dohc manifest, then the folder
 * itself. Paths compare in their canonical form, as the registry compares
 * roots. Returns null when nothing is there to open, and throws when the only
 * folder left is one the folder picker would refuse.
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
  const real = deps.fs.realPath(path);
  const kind = real === null ? null : deps.fs.kindOf(real);
  if (real === null || kind === null) return null;
  const folder = kind === "folder" ? real : dirname(real);
  const home = deps.fs.realPath(deps.home) ?? deps.home;
  const fileIn = (root: string) => {
    if (kind === "folder") return null;
    const file = relative(root, real).split(sep).join("/");
    return validateUserReadPath(file, { platform: deps.platform }).ok ? file : null;
  };

  let registered: { workspace: Workspace; root: string } | null = null;
  for (const workspace of deps.workspaces) {
    const root = deps.fs.realPath(workspace.rootPath);
    if (root === null || !isInside(root, folder)) continue;
    if (!registered || root.length > registered.root.length) registered = { workspace, root };
  }
  if (registered) return { kind: "workspace", workspace: registered.workspace, file: fileIn(registered.root) };

  // A manifest at a root dohc cannot use, such as the home folder, is passed over.
  for (let current = folder; ; current = dirname(current)) {
    if (deps.fs.hasManifest(current) && validateWorkspaceRootChoice(current, home).ok) {
      return { kind: "folder", rootPath: current, hasManifest: true, file: fileIn(current) };
    }
    if (dirname(current) === current) break;
  }

  if (!validateWorkspaceRootChoice(folder, home).ok) {
    const where = relative(home, folder) === "" ? "Your home folder" : "The top folder of a disk";
    throw new Error(`${where} cannot be a workspace. ${kind === "file"
      ? "Move the file into a folder, then open it again."
      : "Open a folder inside it."}`);
  }
  return { kind: "folder", rootPath: folder, hasManifest: false, file: fileIn(folder) };
}

/**
 * Opens paths from outside dohc one at a time, so files opened together from
 * one new folder ask once and register it once. Only a registered workspace
 * opens without asking. Resolves null when nothing opened.
 */
export function createOpenPathOpener<Workspace extends { rootPath: string }, Window>(deps: {
  workspaces(): readonly Workspace[];
  home(): string;
  platform: NodeJS.Platform;
  fs: OpenPathFileSystem;
  // True when the person agrees that the folder becomes a workspace.
  confirm(folder: OpenPathFolder, window: Window | undefined): Promise<boolean>;
  register(rootPath: string): Promise<Workspace>;
  activate(workspace: Workspace, file: string | null, window: Window | undefined): Promise<void>;
}): (path: string, window?: Window) => Promise<Workspace | null> {
  let queue: Promise<unknown> = Promise.resolve();
  async function open(path: string, window: Window | undefined): Promise<Workspace | null> {
    const target = resolveOpenPathTarget(path, {
      workspaces: deps.workspaces(), home: deps.home(), platform: deps.platform, fs: deps.fs,
    });
    if (!target) return null;
    let workspace: Workspace;
    if (target.kind === "workspace") {
      workspace = target.workspace;
    } else {
      if (!(await deps.confirm(target, window))) return null;
      workspace = await deps.register(target.rootPath);
    }
    await deps.activate(workspace, target.file, window);
    return workspace;
  }
  return (path, window) => {
    const opened = queue.then(() => open(path, window));
    queue = opened.catch(() => undefined);
    return opened;
  };
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
  folder: OpenPathFolder,
): Promise<boolean> {
  const { response } = await deps.showMessageBox({
    type: "question",
    message: `Open "${basename(folder.rootPath)}" as a workspace?`,
    detail: [
      folder.hasManifest
        ? `${folder.rootPath} already has a .dohc folder. dohc keeps the workspace's history there.`
        : `dohc adds a .dohc folder to ${folder.rootPath} to keep the workspace's history.`,
      "Your files stay where they are.",
      ...(folder.file ? [`Then dohc opens ${basename(folder.file)}.`] : []),
    ].join(" "),
    buttons: ["Open as workspace", "Cancel"],
    defaultId: OPEN_AS_WORKSPACE,
    cancelId: 1,
    noLink: true,
  });
  return response === OPEN_AS_WORKSPACE;
}
