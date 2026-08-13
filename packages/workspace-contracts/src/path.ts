import * as Schema from "effect/Schema";
import { WorkspaceError } from "./errors";
import { WorkspacePath } from "./domain";

const decodeWorkspacePath = Schema.decodeUnknownSync(WorkspacePath);

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
  decodeWorkspacePath(result);
  return result;
}
