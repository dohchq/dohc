import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";

// Workspace trust, as VS Code has it. A trusted workspace runs its apps' own
// commands (dev, start, build, and their hooks) on this computer. A workspace
// in Restricted Mode still opens, edits, shares, and shows apps through dohc's
// static file server; it runs none of their code.
//
// Only the person grants trust, through main's own dialog, or by creating the
// workspace in an empty folder with New workspace. The record lives in this
// computer's dohc profile, never in the workspace and never synced, so no file
// in the workspace can grant it. Each record names the workspace's id, its
// folder's path, and the folder itself: a moved or replaced folder, or another
// workspace, is restricted again.

export const RESTRICTED_MODE_MESSAGE =
  "This workspace is in Restricted Mode, so dohc does not run its apps' code. Trust the workspace to run it.";

// The renderer reads the class from the IPC error's text.
export class WorkspaceRestrictedError extends Error {
  override name = "WorkspaceRestrictedError";
  constructor() {
    super(RESTRICTED_MODE_MESSAGE);
  }
}

export interface TrustedFolder {
  workspaceId: string;
  rootPath: string;
}

interface TrustRecord extends TrustedFolder {
  // The folder's device and file number when trusted, or null on a file
  // system that has none.
  folder: string | null;
  trustedAtMs: number;
}

function isRecord(value: unknown): value is TrustRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { workspaceId, rootPath, folder, trustedAtMs } = value as Record<string, unknown>;
  return typeof workspaceId === "string" && workspaceId.length > 0 &&
    typeof rootPath === "string" && rootPath.length > 0 &&
    (folder === null || typeof folder === "string") &&
    typeof trustedAtMs === "number";
}

// The folder now at a path. Null when the file system gives folders no
// number, so only the id and the path can match.
export async function folderIdentity(rootPath: string): Promise<string | null> {
  const folder = await stat(rootPath, { bigint: true });
  if (!folder.isDirectory()) throw new Error(`Not a folder: ${rootPath}`);
  return folder.ino === 0n ? null : `${folder.dev}:${folder.ino}`;
}

// A folder New workspace may trust: it does not exist yet, or has nothing in it.
export async function isEmptyOrMissingFolder(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function createWorkspaceTrust(dependencies: {
  file: string;
  identify?: (rootPath: string) => Promise<string | null>;
  now?: () => number;
}) {
  const identify = dependencies.identify ?? folderIdentity;
  const now = dependencies.now ?? Date.now;
  let records: TrustRecord[] | null = null;
  // Writes go one at a time, so the last one lands last.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };

  // An unreadable file trusts nothing. The next change replaces it.
  async function load(): Promise<TrustRecord[]> {
    if (records) return records;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(dependencies.file, "utf8"));
    } catch {
      parsed = null;
    }
    const trusted = parsed && typeof parsed === "object" && "trusted" in parsed ? parsed.trusted : null;
    records = Array.isArray(trusted) ? trusted.filter(isRecord) : [];
    return records;
  }

  async function save(next: TrustRecord[]): Promise<void> {
    await mkdir(dirname(dependencies.file), { recursive: true });
    await atomicReplaceFile(dependencies.file, (temporary) =>
      writeFile(temporary, `${JSON.stringify({ version: 1, trusted: next }, null, 2)}\n`));
    records = next;
  }

  async function isTrusted(workspace: TrustedFolder): Promise<boolean> {
    const record = (await load()).find((each) =>
      each.workspaceId === workspace.workspaceId && each.rootPath === workspace.rootPath);
    if (!record) return false;
    try {
      return (await identify(workspace.rootPath)) === record.folder;
    } catch {
      return false;
    }
  }

  return {
    isTrusted,
    // Main's check before it runs any app command.
    async assertTrusted(workspace: TrustedFolder): Promise<void> {
      if (!(await isTrusted(workspace))) throw new WorkspaceRestrictedError();
    },
    trust: (workspace: TrustedFolder): Promise<void> =>
      serial(async () => {
        const folder = await identify(workspace.rootPath);
        const kept = (await load()).filter((each) => each.workspaceId !== workspace.workspaceId);
        await save([...kept, { workspaceId: workspace.workspaceId, rootPath: workspace.rootPath, folder, trustedAtMs: now() }]);
      }),
    // Restricted Mode for every folder this workspace was trusted in.
    restrict: (workspaceId: string): Promise<void> =>
      serial(async () => {
        const current = await load();
        if (!current.some((each) => each.workspaceId === workspaceId)) return;
        await save(current.filter((each) => each.workspaceId !== workspaceId));
      }),
  };
}

export type WorkspaceTrust = ReturnType<typeof createWorkspaceTrust>;

const TRUST = 0;
const STAY = 1;

/**
 * Main's own question before a workspace may run its apps' code. The renderer
 * can open it but cannot answer it, so only the person trusts a workspace.
 */
export async function confirmWorkspaceTrust(
  deps: {
    showMessageBox(options: {
      type: "warning";
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
    }): Promise<{ response: number }>;
  },
  workspace: { rootPath: string },
): Promise<boolean> {
  const { response } = await deps.showMessageBox({
    type: "warning",
    message: "Do you trust the authors of the files in this workspace?",
    detail: [
      "Apps in this workspace can run code on this computer. That code can do anything you can: open and change your files and use your network.",
      "If you don't know who made these files or who else can change them, stay in Restricted Mode.",
      workspace.rootPath,
    ].join("\n\n"),
    buttons: ["Trust workspace", "Stay in Restricted Mode"],
    defaultId: STAY,
    cancelId: STAY,
    noLink: true,
  });
  return response === TRUST;
}
