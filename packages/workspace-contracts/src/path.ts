import { WorkspaceError } from "./errors";

export function composeRenamedPath(fromPath: string, toName: string) {
  const folderPath = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const cleanName = toName.trim().replace(/^\/+|\/+$/g, "");
  if (!cleanName) throw new WorkspaceError("invalid_path", "Filename is empty");
  return folderPath ? `${folderPath}/${cleanName}` : cleanName;
}
