import { createEngineClient, EngineFileObservation } from "@dohc/workspace-engine-client/daemon";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { collapseSqliteSidecars, watchWorkspaceEvents } from "@dohc/workspace-fs";
import { mkdtemp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import type { FileObservationCursor, FileObservationFact } from "@dohc/workspace-engine-client/daemon";

const engine = requireEngineBinaryOrSkip();
const TIMEOUT = 120_000;

describe("engine feed parity with desktop Chokidar", () => {
  it.skipIf(engine.missing)("requires resync after the daemon relaunches", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-file-feed-relaunch-"));
    let previous: FileObservationCursor | undefined;
    try {
      for (let launch = 0; launch < 2; launch++) {
        const client = await createEngineClient({ command: engine.require(), authToken: "file-feed-relaunch", protocolVersion: 2, capabilities: [] });
        const requester = new WorkspaceDaemonRequester(client);
        let workspace: string | undefined;
        try {
          const opened = await requester.request("workspace.open", { rootDir: root, workspaceId: "file-feed-relaunch", captureMode: "none" });
          workspace = (opened as { workspace: string }).workspace;
          const feed = new EngineFileObservation(client, workspace);
          await expect.poll(async () => (await feed.changesSince()).ready, { timeout: TIMEOUT }).toBe(true);
          const result = await feed.changesSince(previous);
          expect(result.resync).toBe(true);
          if (previous) expect(result.cursor.generation).not.toBe(previous.generation);
          previous = result.cursor;
        } finally {
          if (workspace) await requester.request("workspace.close", {}, { workspace });
          client.close(); await client.waitForExit();
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, TIMEOUT);

  it.skipIf(engine.missing).each(["none", "enabled"])("matches settled create, edit, rename, folder removal and WAL facts with capture %s", async captureMode => {
    const root = await mkdtemp(join(tmpdir(), "dohc-file-feed-parity-"));
    const client = await createEngineClient({ command: engine.require(), authToken: "file-feed-parity", protocolVersion: 2, capabilities: [] });
    const requester = new WorkspaceDaemonRequester(client);
    const batches: string[][] = [];
    const watch = watchWorkspaceEvents({ rootDir: root }, paths => batches.push(paths));
    let workspace: string | undefined;
    try {
      const opened = await requester.request("workspace.open", { rootDir: root, workspaceId: "file-feed-parity", ...(captureMode === "none" ? { captureMode } : {}) });
      workspace = (opened as { workspace: string }).workspace;
      const feed = new EngineFileObservation(client, workspace);
      await watch.ready;
      await expect.poll(async () => (await feed.changesSince()).ready, { timeout: TIMEOUT }).toBe(true);
      let cursor: FileObservationCursor = (await feed.changesSince()).cursor;

      const compare = async (operation: () => Promise<unknown>, expected: Array<{ path: string; operation: "update" | "delete" }>) => {
        batches.length = 0;
        await operation();
        await expect.poll(() => new Set(batches.flat()).size, { timeout: TIMEOUT }).toBeGreaterThanOrEqual(expected.length);
        const paths = [...new Set(batches.flat())];
        const legacy = collapseSqliteSidecars(await Promise.all(paths.map(async path => {
          const exists = await stat(join(root, path)).then(() => true, () => false);
          return { path, operation: exists ? "update" as const : "delete" as const };
        })));
        const sort = (facts: Array<{ path: string; operation: string }>) => facts.sort((a, b) => a.path.localeCompare(b.path));
        expect(sort(legacy)).toEqual(sort(expected));
        const collected: FileObservationFact[] = [];
        await expect.poll(async () => {
          const observed = await feed.drain(cursor);
          expect(observed.resync).toBe(false);
          collected.push(...observed.facts); cursor = observed.cursor;
          return collected.length;
        }, { timeout: TIMEOUT }).toBeGreaterThanOrEqual(expected.length);
        const normalized = new Map(collected.map(f => [f.path, { path: f.path, operation: f.kind === "disappeared" ? "delete" : "update" }]));
        expect(sort([...normalized.values()])).toEqual(sort(expected));
      };

      await compare(() => writeFile(join(root, "note.md"), "a"), [{ path: "note.md", operation: "update" }]);
      await compare(() => writeFile(join(root, "note.md"), "longer edit"), [{ path: "note.md", operation: "update" }]);
      await compare(() => rename(join(root, "note.md"), join(root, "renamed.md")), [{ path: "note.md", operation: "delete" }, { path: "renamed.md", operation: "update" }]);
      await compare(async () => { await mkdir(join(root, "old")); await writeFile(join(root, "old/a.md"), "a"); await writeFile(join(root, "old/b.md"), "b"); }, [{ path: "old/a.md", operation: "update" }, { path: "old/b.md", operation: "update" }]);
      await compare(() => rename(join(root, "old"), join(root, "new")), [{ path: "old/a.md", operation: "delete" }, { path: "old/b.md", operation: "delete" }, { path: "new/a.md", operation: "update" }, { path: "new/b.md", operation: "update" }]);
      await compare(() => rm(join(root, "new"), { recursive: true }), [{ path: "new/a.md", operation: "delete" }, { path: "new/b.md", operation: "delete" }]);
      await compare(() => writeFile(join(root, "data.db"), "db"), [{ path: "data.db", operation: "update" }]);
      await compare(() => writeFile(join(root, "data.db-wal"), "wal"), [{ path: "data.db", operation: "update" }]);
      await compare(() => rm(join(root, "data.db-wal")), [{ path: "data.db", operation: "update" }]);
      const before = (await feed.changesSince()).cursor;
      await writeFile(join(root, "just-before-drain.md"), "now");
      expect((await feed.drain(before)).facts).toContainEqual({ path: "just-before-drain.md", kind: "appeared" });
    } finally {
      watch.stop();
      if (workspace) await requester.request("workspace.close", {}, { workspace });
      client.close();
      await client.waitForExit();
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT * 2);
});
