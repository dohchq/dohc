import { WRITE_ASSET_MAX_BYTES, type DohcDesktopBridge } from "../../ipc/bridgeContract";
import { DROP_IMPORT_LIMITS } from "../../ipc/channels";
import { generateAssetFilename } from "../editor/imagePaste";

export interface ChatFilesAdded {
  paths: string[];
  left: number;
  stoppedAt?: string;
}

type ChatFilesBridge = Pick<
  DohcDesktopBridge,
  "getDroppedFilePaths" | "importWorkspaceFiles" | "writeWorkspaceAsset"
>;

function isSavedAsImage(file: File): boolean {
  return file.type.startsWith("image/") && file.size > 0 && file.size <= WRITE_ASSET_MAX_BYTES;
}

export async function addChatFiles(
  api: ChatFilesBridge,
  workspaceId: string,
  folder: string,
  files?: readonly File[],
): Promise<ChatFilesAdded> {
  const into = folder === "" ? {} : { targetDir: folder };
  if (!files) {
    const picked = await api.importWorkspaceFiles({ workspaceId, ...into });
    return {
      paths: picked.imported,
      left: picked.skipped,
      ...(picked.stop ? { stoppedAt: picked.stop.file } : {}),
    };
  }
  const onDisk: string[] = [];
  const pasted: File[] = [];
  let left = 0;
  for (const file of files) {
    const [path] = api.getDroppedFilePaths([file]);
    if (path && onDisk.length < DROP_IMPORT_LIMITS.items) onDisk.push(path);
    else if (!path && isSavedAsImage(file)) pasted.push(file);
    else left += 1;
  }
  const paths: string[] = [];
  let stoppedAt: string | undefined;
  if (onDisk.length > 0) {
    const imported = await api.importWorkspaceFiles({ workspaceId, droppedPaths: onDisk, ...into });
    paths.push(...imported.imported);
    left += imported.skipped;
    stoppedAt = imported.stop?.file;
  }
  let failure: unknown;
  for (const file of pasted) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = generateAssetFilename(file.name, file.type, bytes);
      const relativePath = folder === "" ? name : `${folder}/${name}`;
      await api.writeWorkspaceAsset({ workspaceId, relativePath, bytes });
      paths.push(relativePath);
    } catch (error) {
      failure ??= error;
      left += 1;
    }
  }
  if (failure !== undefined && paths.length === 0) throw failure;
  return { paths, left, ...(stoppedAt ? { stoppedAt } : {}) };
}
