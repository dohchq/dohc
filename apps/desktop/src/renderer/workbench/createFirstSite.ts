import type {
  DohcDesktopBridge,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";

const FIRST_SITE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My site</title>
  </head>
  <body>
    <main>
      <h1>My site</h1>
    </main>
  </body>
</html>
`;

export function firstSiteRoot(
  files: WorkspaceFileEntry[],
  folders: string[],
): string {
  const filePaths = new Set(files.map((file) => file.path.toLowerCase()));
  const folderPaths = new Set(folders.map((folder) => folder.toLowerCase()));
  const existingFolderByLowerPath = new Map(
    folders.map((folder) => [folder.toLowerCase(), folder]),
  );
  for (let index = 1; index < 10_000; index += 1) {
    const defaultRoot = index === 1 ? "site" : `site-${index}`;
    const normalizedRoot = defaultRoot.toLowerCase();
    const root = existingFolderByLowerPath.get(normalizedRoot) ?? defaultRoot;
    const entryPath = `${normalizedRoot}/index.html`;
    if (
      !filePaths.has(normalizedRoot) &&
      !filePaths.has(entryPath) &&
      !folderPaths.has(entryPath)
    ) {
      return root;
    }
  }
  return `site-${Date.now()}`;
}

export async function createFirstSiteFiles(input: {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  folders: string[];
  mutations: Pick<
    DohcDesktopBridge,
    "createWorkspaceFile" | "createWorkspaceFolder"
  >;
}): Promise<{ root: string }> {
  const root = firstSiteRoot(input.files, input.folders);
  const rootExists = input.folders.some(
    (folder) => folder.toLowerCase() === root.toLowerCase(),
  );
  if (!rootExists) {
    await input.mutations.createWorkspaceFolder({
      workspaceId: input.workspaceId,
      relativePath: root,
    });
  }
  await input.mutations.createWorkspaceFile({
    workspaceId: input.workspaceId,
    relativePath: `${root}/index.html`,
    initialText: FIRST_SITE_HTML,
  });
  return { root };
}
