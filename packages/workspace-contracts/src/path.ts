import { WorkspaceError } from "./errors";
import { WorkspacePath } from "./domain";

export function composeRenamedPath(fromPath: string, toName: string) {
  const folderPath = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const cleanName = toName.trim().replace(/^\/+|\/+$/g, "");
  if (!cleanName) throw new WorkspaceError("invalid_path", "Filename is empty");
  if (cleanName.includes("/") || cleanName.split("/").includes("..")) {
    throw new WorkspaceError("invalid_path", "Filename must not contain path segments");
  }
  const result = folderPath ? `${folderPath}/${cleanName}` : cleanName;
  WorkspacePath.parse(result);
  return result;
}
