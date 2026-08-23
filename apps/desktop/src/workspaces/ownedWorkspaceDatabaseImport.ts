import type { ShareViewFiles } from "./shareViewFiles";
import type { ShareViewFilesWorkspaceRecord } from "./shareViewFilesTarget";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import { importToDatabase } from "./workspaceDatabase";

/** Import structured text through the file owner that is authoritative now. */
export async function importOwnedWorkspaceDatabase(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  files: Pick<ShareViewFiles, "read">;
  sourcePath: string;
  databasePath: string;
  tableName: string;
}): Promise<{ path: string; tableName: string; rowCount: number }> {
  const source = await createOwnedWorkspaceFileReader({
    workspace: input.workspace,
    files: input.files,
  }).readCompleteText(input.sourcePath);
  return importToDatabase(
    input.workspace.rootPath,
    { path: input.sourcePath, body: source },
    input.databasePath,
    input.tableName,
  );
}
