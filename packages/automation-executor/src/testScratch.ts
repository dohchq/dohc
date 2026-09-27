import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { MetadataDirResolver } from "./automationRunStore";

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

/** A metadata resolver that answers `folderFor(rootPath)`, made unless `create` is false. */
export function metadataDirAt(folderFor: (rootPath: string) => string): MetadataDirResolver {
  function resolve(rootPath: string): Promise<string>;
  function resolve(rootPath: string, options: { create: false }): Promise<string | null>;
  async function resolve(rootPath: string, options?: { create: false }): Promise<string | null> {
    const dir = folderFor(rootPath);
    if (options?.create === false) return (await lstat(dir).catch(() => null)) === null ? null : dir;
    await mkdir(dir, { recursive: true });
    return dir;
  }
  return resolve;
}

/** `<rootPath>/.dohc`, as the desktop's resolver answers it. */
export const testMetadataDir = metadataDirAt((rootPath) => join(rootPath, ".dohc"));
