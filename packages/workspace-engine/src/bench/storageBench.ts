import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
// @ts-expect-error Node's built-in TypeScript stripper resolves the explicit .ts file.
import { createLinkedChatStore } from "../linkedChatStore.ts";
// @ts-expect-error Node's built-in TypeScript stripper resolves the explicit .ts file.
import { createVersionedTextStore } from "../versionedTextStore.ts";
// @ts-expect-error Node's built-in TypeScript stripper resolves the explicit .ts file.
import { searchWorkspaceEngine } from "../workspaceSearch.ts";

const FILE_COUNT = 1_000;
const SEARCH_FILE_COUNT = 10_000;
const SEARCH_MESSAGE_COUNT = 10_000;
const workspaceId = "bench-workspace";
const metadata = { origin: "api" as const, summary: "storage bench" };

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function yieldToVitest(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

    const searchRoot = await mkdtemp(join(tmpdir(), "dohc-workspace-engine-search-bench-"));
    // Declared outside the try so the finally can always release the SQLite
    // handles — a throw mid-bench must not leave engine.db open while rm
    // tears the directory down.
    const searchVersions = createVersionedTextStore(searchRoot, {
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    const searchChats = createLinkedChatStore(searchRoot, {
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    try {
      const searchMain = await searchVersions.ensureMainVersion({ workspaceId });
      for (let index = 0; index < SEARCH_FILE_COUNT; index += 1) {
        await searchVersions.writeTextFile({
          workspaceId,
          versionId: searchMain.id,
          path: `search/file-${String(index).padStart(5, "0")}.md`,
          text: `# Search ${index}\n\ncommon body ${index} ${index === 9876 ? "rare-needle" : ""}\n`,
          metadata,
        });
        if (index % 500 === 0) await yieldToVitest();
      }
      const thread = await searchChats.createThread({ workspaceId, title: "Bench thread" });
      for (let index = 0; index < SEARCH_MESSAGE_COUNT; index += 1) {
        await searchChats.sendMessage({
          workspaceId,
          threadId: thread.id,
          author: { kind: "human", displayName: "Bench" },
          body: `message body ${index} ${index === 6789 ? "rare-needle" : ""}`,
        });
        if (index % 500 === 0) await yieldToVitest();
      }
      const searchStart = performance.now();
      const results = await searchWorkspaceEngine({
        workspaceId,
        versionId: searchMain.id,
        query: "rare-needle",
        versions: searchVersions,
        chats: searchChats,
        limit: 50,
      });
      const searchMs = elapsedMs(searchStart);
      console.log(
        `indexed_search files=${SEARCH_FILE_COUNT} messages=${SEARCH_MESSAGE_COUNT} results=${results.length} ms=${searchMs}`,
      );
    } finally {
      await searchVersions.close();
      await searchChats.close();
      await rm(searchRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "SQLite storage benchmark",
  async () => {
    await main();
  },
  300_000,
);
