import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { AutomationStoreFolder } from "./automationRunStore";

// Folders for tests, removed after each test.

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 8 })));
});

/** A new empty folder for one test. */
export async function createTestScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/**
 * A store folder at `path`, which a write finds made, as a host prepares it
 * before its first write, and a read finds only once something made it.
 */
export function storeFolderAt(path: string): AutomationStoreFolder {
  return {
    async forWrite() {
      await mkdir(path, { recursive: true });
      return path;
    },
    async read(work) {
      return work((await lstat(path).catch(() => null)) === null ? null : path);
    },
  };
}

/** `<rootPath>/.dohc/local`, where the desktop keeps a workspace's run store. */
export function testStoreFolder(rootPath: string): AutomationStoreFolder {
  return storeFolderAt(join(rootPath, ".dohc", "local"));
}
