import { generateAppSource } from "@dohc/workspace-core/app-source";
import type {
  DohcDesktopBridge,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";

export function firstAppRoot(
  files: WorkspaceFileEntry[],
  folders: string[],
): string {
  const filePaths = new Set(files.map((file) => file.path.toLowerCase()));
  const nonemptyRoots = new Set(
    [...files.map((file) => file.path), ...folders]
      .filter((path) => path.includes("/"))
      .map((path) => path.split("/")[0]!.toLowerCase()),
  );
  const existingFolderByLowerPath = new Map(
    folders.map((folder) => [folder.toLowerCase(), folder]),
  );
  for (let index = 1; index < 10_000; index += 1) {
    const defaultRoot = index === 1 ? "app" : `app-${index}`;
    const normalizedRoot = defaultRoot.toLowerCase();
    const root = existingFolderByLowerPath.get(normalizedRoot) ?? defaultRoot;
    if (
      !filePaths.has(normalizedRoot) &&
      !nonemptyRoots.has(normalizedRoot)
    ) {
      return root;
    }
  }
  return `app-${Date.now()}`;
}

export async function createFirstAppFiles(input: {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  folders: string[];
  mutations: Pick<
    DohcDesktopBridge,
    "createWorkspaceFile" | "createWorkspaceFolder"
  >;
}): Promise<{ root: string }> {
  const root = firstAppRoot(input.files, input.folders);
  const rootExists = input.folders.some(
    (folder) => folder.toLowerCase() === root.toLowerCase(),
  );
  if (!rootExists) {
    await input.mutations.createWorkspaceFolder({
      workspaceId: input.workspaceId,
      relativePath: root,
    });
  }
  const files = generateAppSource({
    title: "My app",
    packageName: root.toLowerCase(),
    withDohcJson: false,
  });
  const createdFolders = new Set([root]);
  for (const file of files) {
    const separator = file.path.lastIndexOf("/");
    if (separator !== -1) {
      const folder = `${root}/${file.path.slice(0, separator)}`;
      if (!createdFolders.has(folder)) {
        await input.mutations.createWorkspaceFolder({
          workspaceId: input.workspaceId,
          relativePath: folder,
        });
        createdFolders.add(folder);
      }
    }
    await input.mutations.createWorkspaceFile({
      workspaceId: input.workspaceId,
      relativePath: `${root}/${file.path}`,
      initialText: file.content,
    });
  }
  return { root };
}
