import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
// @ts-expect-error Node's built-in TypeScript stripper resolves the explicit .ts file.
import { createVersionedTextStore } from "../versionedTextStore.ts";

const FILE_COUNT = 1_000;
const workspaceId = "bench-workspace";
const metadata = { origin: "api" as const, summary: "storage bench" };

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dohc-workspace-engine-storage-bench-"));
  try {
    let now = 1_000;
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    const mainVersion = await store.ensureMainVersion({ workspaceId });

    const writeStart = performance.now();
    for (let index = 0; index < FILE_COUNT; index += 1) {
      await store.writeTextFile({
        workspaceId,
        versionId: mainVersion.id,
        path: `docs/file-${String(index).padStart(4, "0")}.md`,
        text: `# File ${index}\n\nSQLite storage benchmark body ${index % 17}.\n`,
        metadata,
      });
    }
    const writeMs = elapsedMs(writeStart);

    const coldStart = performance.now();
    const coldStore = createVersionedTextStore(root);
    const files = await coldStore.listTextFiles({
      workspaceId,
      versionId: mainVersion.id,
    });
    for (const file of files) {
      await coldStore.readTextFile({
        workspaceId,
        versionId: mainVersion.id,
        path: file.path,
      });
    }
    const coldReadMs = elapsedMs(coldStart);

    console.log(`root=${root}`);
    console.log(`sequential_writes count=${FILE_COUNT} ms=${writeMs}`);
    console.log(`cold_open_list_and_read count=${files.length} ms=${coldReadMs}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "SQLite storage benchmark",
  async () => {
    await main();
  },
  120_000,
);
