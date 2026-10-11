import { generateAppSource } from "@dohc/workspace-core/app-source";
import type {
  DohcDesktopBridge,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";

export function firstAppRoot(
  files: WorkspaceFileEntry[],
  folders: string[],
): string {
  const occupiedRoots = new Set(
    [...files.map((file) => file.path), ...folders]
      .map((path) => path.split("/")[0]!.toLowerCase()),
  );
  for (let index = 1; index < 10_000; index += 1) {
    const defaultRoot = index === 1 ? "app" : `app-${index}`;
    const normalizedRoot = defaultRoot.toLowerCase();
    if (!occupiedRoots.has(normalizedRoot)) return defaultRoot;
  }
  return `app-${Date.now()}`;
}

export async function createFirstAppFiles(input: {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  folders: string[];
  mutations: Pick<
    DohcDesktopBridge,
    "createWorkspaceFile" | "createWorkspaceFolder" | "deleteWorkspacePath"
  >;
}): Promise<{ root: string }> {
  const root = firstAppRoot(input.files, input.folders);
  const files = generateAppSource({
    title: "My app",
    appRoot: root,
    withDohcJson: true,
  });
  const createdPaths: Array<{ path: string; folder: boolean }> = [];
  const createdFolders = new Set([root]);
  try {
    await input.mutations.createWorkspaceFolder({
      workspaceId: input.workspaceId,
      relativePath: root,
      exclusive: true,
    });
    createdPaths.push({ path: root, folder: true });
    for (const file of files) {
      const separator = file.path.lastIndexOf("/");
      if (separator !== -1) {
        const folder = `${root}/${file.path.slice(0, separator)}`;
        if (!createdFolders.has(folder)) {
          await input.mutations.createWorkspaceFolder({
            workspaceId: input.workspaceId,
            relativePath: folder,
            exclusive: true,
          });
          createdFolders.add(folder);
          createdPaths.push({ path: folder, folder: true });
        }
      }
      const path = `${root}/${file.path}`;
      await input.mutations.createWorkspaceFile({
        workspaceId: input.workspaceId,
        relativePath: path,
        initialText: file.content,
        exclusive: true,
      });
      createdPaths.push({ path, folder: false });
    }
    return { root };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const { path, folder } of createdPaths.reverse()) {
      try {
        await input.mutations.deleteWorkspacePath({
          workspaceId: input.workspaceId,
          relativePath: path,
          ...(folder ? { emptyFolderOnly: true } : {}),
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "The app could not be created or fully removed. Check its folder before trying again.",
        { cause: error },
      );
    }
    throw error;
  }
}
