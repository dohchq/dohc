import { normalizeRootPath } from "@dohc/workspace-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { RegistryEntry, ShareSkippedOps, ShareViewIdentity } from "./registryStore";
import type { ShareViewSelector } from "./shareViewInfo";
import { recordedShareSelector } from "./shareViewRecords";
import { receivedReferencePin, type ReceivedReferencePin } from "./workspaceFileReferenceScopes";
import { folderIdentity } from "./workspaceTrust";

// Share views the person forgot on this computer. Forget keeps the folder.
// When the person opens that folder again, it opens as the same share, and
// every refresh and pull still asks the server what the signed-in account may
// see.
//
// The record lives in this computer's dohc profile, never in the workspace and
// never synced, so no file in the workspace can make a folder open as a share.
// Each record names the workspace's id, its folder's path, and the folder
// itself: a folder moved or replaced after Forget, or another workspace, opens
// as an ordinary workspace. It holds no token, email or display name.

interface ForgottenShareView {
  workspaceId: string;
  rootPath: string;
  // The folder's device and file number at Forget, or null on a file system
  // that has none.
  folder: string | null;
  shareId: string;
  recipientUserId: string;
  relayUrl: string;
  grantedSelector: ShareViewSelector;
  granterUserId?: string;
  receivedIdentity?: ReceivedReferencePin;
  // An ended share opens ended, and content its pulls skipped stays reported.
  ended?: true;
  skippedOps?: ShareSkippedOps;
}

const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// dohc wrote it, so, as the registry does, this checks only its shape.
function skipRecord(value: unknown): ShareSkippedOps | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return Array.isArray(raw.ops) && Number.isInteger(raw.more) && Number.isInteger(raw.generation)
    ? value as ShareSkippedOps
    : undefined;
}

function parseRecord(value: unknown): ForgottenShareView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const grantedSelector = recordedShareSelector(raw.grantedSelector);
  const receivedIdentity = raw.receivedIdentity === undefined ? undefined : receivedReferencePin(raw.receivedIdentity);
  const skippedOps = skipRecord(raw.skippedOps);
  if (!filled(raw.workspaceId) || !filled(raw.rootPath) || (raw.folder !== null && typeof raw.folder !== "string") ||
    !filled(raw.shareId) || !filled(raw.recipientUserId) || !filled(raw.relayUrl) || grantedSelector === null ||
    (raw.granterUserId !== undefined && !filled(raw.granterUserId)) ||
    (raw.receivedIdentity !== undefined && receivedIdentity === undefined) ||
    (raw.ended !== undefined && raw.ended !== true)) {
    return null;
  }
  // A damaged skip record costs its notice, not the share.
  return {
    workspaceId: raw.workspaceId,
    rootPath: raw.rootPath,
    folder: raw.folder,
    shareId: raw.shareId,
    recipientUserId: raw.recipientUserId,
    relayUrl: raw.relayUrl,
    grantedSelector,
    ...(filled(raw.granterUserId) ? { granterUserId: raw.granterUserId } : {}),
    ...(receivedIdentity ? { receivedIdentity } : {}),
    ...(raw.ended === true ? { ended: true } : {}),
    ...(skippedOps ? { skippedOps } : {}),
  };
}

// As workspaceTrust spells a root: one folder, whichever slashes main used.
const spelling = (rootPath: string) => normalizeRootPath(rootPath, process.platform);

export function createForgottenShareViews(dependencies: {
  file: string;
  identify?: (rootPath: string) => Promise<string | null>;
  // Tests replace the file system calls.
  readText?: (file: string) => Promise<string>;
  writeText?: (file: string, text: string) => Promise<void>;
  warn?: (message: string, error: unknown) => void;
}) {
  const identify = dependencies.identify ?? folderIdentity;
  const readText = dependencies.readText ?? ((file: string) => readFile(file, "utf8"));
  const writeText = dependencies.writeText ?? (async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true });
    await atomicReplaceFile(file, (temporary) => writeFile(temporary, text));
  });
  const warn = dependencies.warn ?? ((message: string, error: unknown) => console.warn(message, error));
  // Forget and Open run one at a time, so neither acts on a record the other
  // has already replaced.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };

  // A missing file holds no records, and so does one dohc cannot parse; that
  // file stays as it is until the next Forget of a share view replaces it.
  // Any other failure throws.
  async function load(): Promise<ForgottenShareView[]> {
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
    const forgotten = parsed && typeof parsed === "object" && "forgotten" in parsed ? parsed.forgotten : null;
    return Array.isArray(forgotten)
      ? forgotten.map(parseRecord).filter((record): record is ForgottenShareView => record !== null)
      : [];
  }

  const save = (records: ForgottenShareView[]) =>
    writeText(dependencies.file, `${JSON.stringify({ version: 1, forgotten: records }, null, 2)}\n`);

  // The record for this workspace in this folder, or null. A file or folder
  // dohc cannot read matches nothing.
  async function find(workspace: { workspaceId: string; rootPath: string }): Promise<ForgottenShareView | null> {
    try {
      const rootPath = spelling(workspace.rootPath);
      const record = (await load()).find((each) =>
        each.workspaceId === workspace.workspaceId && each.rootPath === rootPath);
      if (!record) return null;
      return (await identify(workspace.rootPath)) === record.folder ? record : null;
    } catch {
      return null;
    }
  }

  // The record a share view leaves at Forget, or null for one dohc can't
  // read, one without its account or server, or a folder that is gone.
  async function recordOf(
    workspace: { workspaceId: string; rootPath: string },
    shareView: ShareViewIdentity,
  ): Promise<ForgottenShareView | null> {
    const { shareId, recipientUserId, relayUrl, granterUserId } = shareView;
    const grantedSelector = recordedShareSelector(shareView.grantedSelector);
    const receivedIdentity = receivedReferencePin(shareView.receivedIdentity);
    const skippedOps = skipRecord(shareView.skippedOps);
    if (!filled(shareId) || !filled(recipientUserId) || !filled(relayUrl) || grantedSelector === null) return null;
    let folder: string | null;
    try {
      folder = await identify(workspace.rootPath);
    } catch {
      return null;
    }
    return {
      workspaceId: workspace.workspaceId,
      rootPath: spelling(workspace.rootPath),
      folder,
      shareId,
      recipientUserId,
      relayUrl,
      grantedSelector,
      ...(filled(granterUserId) ? { granterUserId } : {}),
      ...(receivedIdentity ? { receivedIdentity } : {}),
      ...(shareView.ended === true ? { ended: true } : {}),
      ...(skippedOps ? { skippedOps } : {}),
    };
  }

  return {
    /**
     * Saves the share view a person forgets, with the access it has now, and
     * drops any older record for the same workspace or folder. A share view
     * dohc can't read, one without its account or server, or a folder that
     * is gone leaves no record. Throws when the profile file can't be read or
     * written, so Forget can fail and keep the workspace listed.
     */
    async remember(workspace: { workspaceId: string; rootPath: string }, shareView: ShareViewIdentity): Promise<void> {
      const record = await recordOf(workspace, shareView);
      const rootPath = spelling(workspace.rootPath);
      await serial(async () => {
        const records = await load();
        const kept = records.filter((each) => each.workspaceId !== workspace.workspaceId && each.rootPath !== rootPath);
        if (record) await save([...kept, record]);
        else if (kept.length < records.length) await save(kept);
      });
    },
    /**
     * Registers a folder the person chose to open: as the share they forgot
     * in it, or else as it is. The share's names stay unknown until a
     * refresh, which runs only for the same account on the same server. Once
     * registered, the record goes; the next Forget saves it again.
     */
    reopen(workspace: CreatedWorkspace, register: (entry: RegistryEntry) => unknown): Promise<RegistryEntry> {
      return serial(async () => {
        const record = await find(workspace);
        if (!record) {
          register(workspace);
          return workspace;
        }
        const entry: RegistryEntry = {
          ...workspace,
          shareView: {
            shareId: record.shareId,
            ...(record.granterUserId ? { granterUserId: record.granterUserId } : {}),
            granterEmail: null,
            subjectName: null,
            sharerName: null,
            genericChatWritable: false,
            grantedSelector: record.grantedSelector,
            ...(record.receivedIdentity ? { receivedIdentity: record.receivedIdentity } : {}),
            relayUrl: record.relayUrl,
            recipientUserId: record.recipientUserId,
            unsavedPaths: null,
            ...(record.ended ? { ended: true } : {}),
            ...(record.skippedOps ? { skippedOps: record.skippedOps } : {}),
          },
        };
        register(entry);
        try {
          await save((await load()).filter((each) => each.workspaceId !== workspace.workspaceId));
        } catch (error) {
          warn("[desktop] could not remove a reopened share's record", error);
        }
        return entry;
      });
    },
  };
}

export type ForgottenShareViews = ReturnType<typeof createForgottenShareViews>;
