import { normalizeRootPath } from "@dohc/workspace-core";
import type { BigIntStats } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";

// Workspace trust, as VS Code has it. A trusted workspace runs its apps' own
// commands (dev, start, build, and their hooks) on this computer, and starts
// the person's agent for its chats in its folder, where the agent can follow
// the folder's own settings. A workspace in Restricted Mode still opens,
// edits, shares, and shows apps through dohc's static file server; it runs
// none of their code and starts no agent.
//
// Only the person grants trust, through main's own dialog, or by creating the
// workspace in an empty folder with New workspace. The record lives in this
// computer's dohc profile, never in the workspace and never synced, so no file
// in the workspace can grant it. Each record names the workspace's id, its
// folder's path, and the folder itself: a moved or replaced folder, or another
// workspace, is restricted again.

export const RESTRICTED_MODE_MESSAGE =
  "This workspace is in Restricted Mode, so dohc does not run its apps' code or start agents in it. Trust the workspace to allow them.";

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

// A folder's identity: null when the file system gives folders no number, so
// only the id and the path can match.
export function identityOf(folder: Pick<BigIntStats, "dev" | "ino">): string | null {
  return folder.ino === 0n ? null : `${folder.dev}:${folder.ino}`;
}

// The folder now at a path.
export async function folderIdentity(rootPath: string): Promise<string | null> {
  const folder = await stat(rootPath, { bigint: true });
  if (!folder.isDirectory()) throw new Error(`Not a folder: ${rootPath}`);
  return identityOf(folder);
}

// Main spells a root two ways on Windows, with forward slashes in the
// registry and with backslashes in a workspace operation. Both are one folder.
const spelling = (rootPath: string) => normalizeRootPath(rootPath, process.platform);

export function createWorkspaceTrust(dependencies: {
  file: string;
  identify?: (rootPath: string) => Promise<string | null>;
  now?: () => number;
  // Hears every change, whatever made it: true once a grant holds, false
  // the moment a workspace is restricted.
  onChange?: (workspaceId: string, trusted: boolean) => void;
  // Tests replace the file system calls.
  readText?: (file: string) => Promise<string>;
  writeText?: (file: string, text: string) => Promise<void>;
}) {
  const identify = dependencies.identify ?? folderIdentity;
  const now = dependencies.now ?? Date.now;
  const readText = dependencies.readText ?? ((file: string) => readFile(file, "utf8"));
  const writeText = dependencies.writeText ?? (async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true });
    await atomicReplaceFile(file, (temporary) => writeFile(temporary, text));
  });
  // The records as last read or written. Null until a read succeeds.
  let current: TrustRecord[] | null = null;
  // The read in flight, shared by every caller.
  let reading: Promise<TrustRecord[]> | null = null;
  // Workspaces put in Restricted Mode during this run. They stay restricted
  // even when the file could not be written, until the person trusts them.
  const restricted = new Set<string>();
  const revocations = new Map<string, number>();
  // A listener never interrupts a trust or a revoke.
  const changed = (workspaceId: string, trusted: boolean) => {
    try {
      dependencies.onChange?.(workspaceId, trusted);
    } catch (error) {
      console.warn("[desktop] a workspace trust listener failed", error);
    }
  };
  // Writes go one at a time, so the last one lands last.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };

  // A missing file trusts nothing, and so does one dohc cannot parse; that
  // file stays as it is until the person trusts or restricts a workspace.
  // Any other failure is not kept, so the next call reads again.
  async function read(): Promise<TrustRecord[]> {
    let text: string;
    try {
      text = await readText(dependencies.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const trusted = parsed && typeof parsed === "object" && "trusted" in parsed ? parsed.trusted : null;
    return Array.isArray(trusted) ? trusted.filter(isRecord) : [];
  }

  async function load(): Promise<TrustRecord[]> {
    if (current) return current;
    reading ??= read().finally(() => { reading = null; });
    const loaded = await reading;
    // A write that finished meanwhile is newer than this read.
    return (current ??= loaded);
  }

  async function save(next: TrustRecord[]): Promise<void> {
    await writeText(dependencies.file, `${JSON.stringify({ version: 1, trusted: next }, null, 2)}\n`);
    current = next;
  }

  // Whether a grant still holds now. Synchronous, for the spawn boundary.
  const holds = (record: TrustRecord) => !restricted.has(record.workspaceId) && current?.includes(record) === true;

  async function grantFor(workspace: TrustedFolder): Promise<TrustRecord | null> {
    if (restricted.has(workspace.workspaceId)) return null;
    const rootPath = spelling(workspace.rootPath);
    const record = (await load()).find((each) =>
      each.workspaceId === workspace.workspaceId && each.rootPath === rootPath);
    if (!record) return null;
    let folder: string | null;
    try {
      folder = await identify(workspace.rootPath);
    } catch {
      return null;
    }
    // A revoke, or a new grant, during the lookup wins.
    return folder === record.folder && holds(record) ? record : null;
  }

  // Restricted Mode at once, in memory, before anything is written.
  function revoke(workspaceId: string): void {
    restricted.add(workspaceId);
    revocations.set(workspaceId, (revocations.get(workspaceId) ?? 0) + 1);
    changed(workspaceId, false);
  }

  // Writes Restricted Mode to the file. A failed write leaves the workspace
  // restricted in memory; trying again writes it. A grant made since the
  // revoke is the person's last action, so it stays.
  const persistRevocation = (workspaceId: string): Promise<void> =>
    serial(async () => {
      if (!restricted.has(workspaceId)) return;
      const records = await load();
      if (!records.some((each) => each.workspaceId === workspaceId)) return;
      await save(records.filter((each) => each.workspaceId !== workspaceId));
    });

  return {
    // Throws when the file cannot be read, so the caller can say so.
    isTrusted: async (workspace: TrustedFolder): Promise<boolean> => (await grantFor(workspace)) !== null,
    /**
     * Main's check before it runs any app command. The answer is a
     * synchronous check that the grant still holds, for the spawn itself.
     */
    async assertTrusted(workspace: TrustedFolder): Promise<() => void> {
      const record = await grantFor(workspace);
      if (!record) throw new WorkspaceRestrictedError();
      return () => {
        if (!holds(record)) throw new WorkspaceRestrictedError();
      };
    },
    /**
     * Trusts the workspace in its folder now, or in the folder New workspace
     * made when `known` names it. False when the workspace was restricted
     * again before the grant was written.
     */
    trust(workspace: TrustedFolder, known?: { folder: string | null }): Promise<boolean> {
      const revocationsAtStart = revocations.get(workspace.workspaceId) ?? 0;
      const revokedMeanwhile = () => (revocations.get(workspace.workspaceId) ?? 0) !== revocationsAtStart;
      return serial(async () => {
        const folder = known ? known.folder : await identify(workspace.rootPath);
        const records = await load();
        if (revokedMeanwhile()) return false;
        const kept = records.filter((each) => each.workspaceId !== workspace.workspaceId);
        await save([...kept, { workspaceId: workspace.workspaceId, rootPath: spelling(workspace.rootPath), folder, trustedAtMs: now() }]);
        // A revoke during the write wins. It stays restricted here, and its
        // persistRevocation, queued behind this write, takes the grant out
        // of the file.
        if (revokedMeanwhile()) return false;
        restricted.delete(workspace.workspaceId);
        changed(workspace.workspaceId, true);
        return true;
      });
    },
    revoke,
    persistRevocation,
    // Whether this run restricted the workspace and nobody trusted it since.
    isRevoked: (workspaceId: string): boolean => restricted.has(workspaceId),
    // Both, for a caller with nothing to do in between.
    restrict(workspaceId: string): Promise<void> {
      revoke(workspaceId);
      return persistRevocation(workspaceId);
    },
  };
}

export type WorkspaceTrust = ReturnType<typeof createWorkspaceTrust>;

const TRUST = 0;
const STAY = 1;

// Code points a folder name can hide in: controls, line breaks, and the
// marks that reorder text.
function isHidden(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x061c ||
    code === 0x200e || code === 0x200f || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

const BACKSLASH = String.fromCharCode(92);

// A path as one visible line: each hidden code point shows as an escape, so
// a folder's name cannot add lines or reorder words in the dialog.
export function visiblePath(path: string): string {
  return Array.from(path, (character) => {
    const code = character.codePointAt(0)!;
    return isHidden(code) ? `${BACKSLASH}u{${code.toString(16).padStart(4, "0")}}` : character;
  }).join("");
}

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
      "Apps in this workspace can run code on this computer. An agent started here can follow this folder's settings, such as hooks and tool servers, which also run code. That code can do anything you can: open and change your files and use your network.",
      "If you don't know who made these files or who else can change them, stay in Restricted Mode.",
      visiblePath(workspace.rootPath),
    ].join("\n\n"),
    buttons: ["Trust workspace", "Stay in Restricted Mode"],
    defaultId: STAY,
    cancelId: STAY,
    noLink: true,
  });
  return response === TRUST;
}
