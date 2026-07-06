#!/usr/bin/env -S pnpm exec tsx

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { exportSyncBundle } from "../packages/workspace-engine/src/syncFolder";

async function main(): Promise<void> {
  const [, , rootDirArg, workspaceIdArg, targetDirArg] = process.argv;
  if (!rootDirArg || !workspaceIdArg || !targetDirArg) {
    console.error("Usage: pnpm exec tsx scripts/engine-sync-folder.ts <rootDir> <workspaceId> <targetDir>");
    process.exitCode = 1;
    return;
  }
  const rootDir = resolve(rootDirArg);
  const targetDir = resolve(targetDirArg);
  await mkdir(targetDir, { recursive: true });
  const result = await exportSyncBundle({
    rootDir,
    workspaceId: workspaceIdArg,
    toDir: targetDir,
  });
  console.log(`Exported ${result.opCount} ops from ${result.originsExported.length} origins.`);
  console.log(`Exported ${result.blobCount} content-addressed text blobs.`);
  console.log("");
  console.log("On the other machine, import this folder from a small tsx snippet:");
  const snippet = `import { importSyncBundle } from "./packages/workspace-engine/src/syncFolder"; await importSyncBundle({ rootDir: "<other-root>", workspaceId: ${JSON.stringify(
    workspaceIdArg,
  )}, fromDir: ${JSON.stringify(targetDir)} });`;
  // The printed command is meant to be copy/pasted verbatim, so the embedded
  // snippet gets real POSIX single-quote escaping: a workspace id or path
  // containing a quote must not break out of the shell string.
  console.log(`pnpm exec tsx -e '${snippet.replace(/'/gu, `'\\''`)}'`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
