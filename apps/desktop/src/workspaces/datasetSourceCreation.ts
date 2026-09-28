import type { CreationStage } from "@dohc/cli/creation";
import { createFile, CreatedFileWriteError } from "./workspaceFiles";
import { readWorkspaceText, resolveWorkspaceMaterializePath } from "./workspaceAssets";

export class SourceCreationConflict extends Error {}

async function existingSource(root: string, path: string, source: string): Promise<boolean> {
  try {
    const existing = await readWorkspaceText(root, path);
    if (existing.truncated || existing.text !== source) {
      throw new SourceCreationConflict(`${path} contains different source. Keep it and choose another folder.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export type SourceCreationProgress = (stage: CreationStage, created: string[]) => void;

/** Existing matching source is a completed write; different source is never overwritten. */
export async function createDatasetSources(
  root: string,
  files: Record<string, string>,
  signal: AbortSignal,
  finish: {
    register(): Promise<unknown>;
    capture(): Promise<unknown>;
    verify(): Promise<unknown>;
  },
  progress?: SourceCreationProgress,
): Promise<void> {
  const entries = Object.entries(files).sort(([a], [b]) => Number(a.endsWith("dataset.json")) - Number(b.endsWith("dataset.json")));
  // Validate every destination before the first write.
  for (const [path, source] of entries) {
    await resolveWorkspaceMaterializePath(root, path);
    await existingSource(root, path, source);
  }
  const created: string[] = [];
  progress?.("write", [...created]);
  for (const [path, source] of entries) {
    signal.throwIfAborted();
    try {
      await createFile(root, path, source, { exclusive: true });
    } catch (error) {
      if (error instanceof CreatedFileWriteError) {
        created.push(path);
        progress?.("write", [...created]);
        throw error;
      }
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      await existingSource(root, path, source);
    }
    created.push(path);
    progress?.("write", [...created]);
  }
  signal.throwIfAborted();
  progress?.("register", [...created]);
  await finish.register();
  progress?.("capture", [...created]);
  await finish.capture();
  signal.throwIfAborted();
  progress?.("verify", [...created]);
  await finish.verify();
  signal.throwIfAborted();
}
