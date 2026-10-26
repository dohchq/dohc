import { lstat } from "node:fs/promises";
import { workspaceFolderNameOperations } from "./bridgeContract";
import { registerOperations, type OperationBoundary } from "./operationTable";

// The first of name, "name 2", "name 3" that nothing in the location has.
// Windows and macOS match names regardless of case, so "personal" takes
// "Personal" there. Each path goes through `usableRoot`, which refuses a
// location dohc never offered.
export async function firstFreeFolderName(
  rootPath: string,
  name: string,
  usableRoot: (path: string) => string,
): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    const taken = await lstat(usableRoot(`${rootPath}/${candidate}`)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
      },
    );
    if (!taken) return candidate;
  }
  // Past that, the name stays as the person sees it.
  return name;
}

export function registerWorkspaceFolderNameIpc<Event, Operation>(
  boundary: OperationBoundary<Event, Operation>,
  usableRoot: (path: string) => string,
): void {
  registerOperations(boundary, workspaceFolderNameOperations, {
    suggestWorkspaceFolderName: ({ rootPath, name }) => firstFreeFolderName(rootPath, name, usableRoot),
  });
}
