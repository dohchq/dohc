import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertSafeWorkspacePath, mediaTypeForPath, sha256 } from "./metadata";

export type ScannedWorkspaceFile = {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
};

export async function scanWorkspaceFiles(rootDir: string): Promise<ScannedWorkspaceFile[]> {
  const files: ScannedWorkspaceFile[] = [];
  await scanDir(rootDir, rootDir, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function scanDir(rootDir: string, dir: string, files: ScannedWorkspaceFile[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".dohc") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(rootDir, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = assertSafeWorkspacePath(relative(rootDir, fullPath).replace(/\\/g, "/"));
    const info = await stat(fullPath);
    if (!info.isFile()) continue;
    const bytes = await readFile(fullPath);
    files.push({
      path: rel,
      mediaType: mediaTypeForPath(rel),
      bytes,
      sha256: sha256(bytes),
    });
  }
}
