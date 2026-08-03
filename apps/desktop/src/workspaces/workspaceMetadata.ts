import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  DOHC_METADATA_GUARD,
  notARealFolderRefusal,
  outsideWorkspaceRefusal,
} from "@dohc/workspace-core";

// THE resolver for a workspace's internal metadata directory (<root>/.dohc).
// Every main-process writer of internal metadata (ui-state.json,
// agent-runs.json) must resolve the directory through here — never join
// "<root>/.dohc" by hand. The trap this closes: a malicious attached
// workspace can carry `.dohc -> /some/user-writable/outside-dir` (a symlink
// with a valid manifest copied inside), and a naive join-then-write would
// follow it and land files OUTSIDE the workspace boundary. The contract:
//
//   - the workspace root is realpath'd first (so containment compares
//     resolved paths, not symlinked aliases),
//   - <root>/.dohc must be a REAL directory — lstat, so a symlink is seen AS
//     a symlink and refused, even one pointing at a real directory,
//   - a missing .dohc is created (first write on a fresh workspace),
//   - and the resolved dir must still live inside the resolved root.
//
// Refusal is a thrown error: callers that must stay tolerant (readers)
// catch it; writers surface it instead of writing outside the workspace.
export async function resolveWorkspaceMetadataDir(rootPath: string): Promise<string> {
  const realRoot = await realpath(rootPath);
  const dir = join(realRoot, ".dohc");
  let stats = await lstat(dir).catch(() => null);
  if (stats === null) {
    await mkdir(dir, { recursive: true });
    stats = await lstat(dir);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(notARealFolderRefusal(DOHC_METADATA_GUARD, stats));
  }
  // Belt and braces: with the root resolved and .dohc a real directory the
  // resolved dir IS the joined path; anything else means an escape.
  const realDir = await realpath(dir);
  if (realDir !== dir && !realDir.startsWith(realRoot + sep)) {
    throw new Error(outsideWorkspaceRefusal(DOHC_METADATA_GUARD));
  }
  return dir;
}
