import {
  CHATS_METHOD,
  ChatsLoopbackEngine,
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type Request,
} from "@dohc/workspace-engine-client";
import { MAX_DESKTOP_CAPTURE_TEXT_BYTES } from "@dohc/workspace-engine-client/limits";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import {
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { formatChatBookmarkProjection } from "./chatBookmarkProjection";
import {
  archiveChatBookmarkProjection,
  writeChatBookmarkProjection,
} from "./chatBookmarkProjectionWrite";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await createTestScratch("dohc-generated-text-");
  roots.push(value);
  return value;
}

async function write(rootPath: string, path: string, text: string): Promise<void> {
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

function bookmarkProjection(bookmarkId: string, title: string): string {
  return formatChatBookmarkProjection({
    bookmarkId,
    threadId: `thread-${bookmarkId}`,
    title,
    mode: "live",
    updatedAtMs: 1_000,
    messages: [],
  });
}

function makeChats(workspaceId: string, rootPath: string): {
  store: ReturnType<typeof createLiveLinkedChatStore>;
  seed: (request: Omit<Request, "id" | "workspace">) => Promise<void>;
} {
  const loopback = new ChatsLoopbackEngine();
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request) {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  const store = createLiveLinkedChatStore({ workspaceId, rootPath }, sessions);
  let nextRequestId = 1;
  return {
    store,
    seed: async (request) => {
      await loopback.sendRequest({ ...request, id: nextRequestId++, workspace: workspaceId });
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceEngineCapture generated Markdown", () => {
  it("recovers legacy and crash-interrupted bookmark identity from durable frontmatter", async () => {
    const rootPath = await root();
    const legacyPath = "Bookmarks/Chats/legacy.md";
    const legacyText = bookmarkProjection("bookmark-legacy", "Legacy projection");
    await write(rootPath, legacyPath, legacyText);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-bookmark-recovery-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    const upgraded = await writeChatBookmarkProjection({
      bookmark: { bookmarkId: "bookmark-legacy", destinationPath: legacyPath },
      text: bookmarkProjection("bookmark-legacy", "Refreshed legacy projection"),
      capture,
    });
    expect(await readFile(join(rootPath, legacyPath), "utf8")).toContain(
      "# Refreshed legacy projection",
    );

    // Simulate a crash after the generated write committed but before the
    // bookmark outbox durably recorded upgraded.objectId.
    const retried = await writeChatBookmarkProjection({
      bookmark: { bookmarkId: "bookmark-legacy", destinationPath: legacyPath },
      text: bookmarkProjection("bookmark-legacy", "Crash retry projection"),
      capture,
    });
    expect(retried.objectId).toBe(upgraded.objectId);
    expect(await readFile(join(rootPath, legacyPath), "utf8")).toContain(
      "# Crash retry projection",
    );
    // Positive proof of the backend, not of the outcome: a silent relapse to
    // the legacy in-process store would never open a daemon workspace nor send
    // a versioned write, so these two methods cannot both appear by accident.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).toContain(VERSIONED_METHOD.textWrite);
    await capture.stop();
  });

  it("rejects unclaimed bookmark recovery and archive when the marker is unrelated or corrupt", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-bookmark-collision-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });
    const unrelatedPath = "Bookmarks/Chats/unrelated.md";
    const unrelatedText = bookmarkProjection("bookmark-someone-else", "Unrelated");
    await capture.writeGeneratedTextFile({ path: unrelatedPath, text: unrelatedText });

    await expect(
      writeChatBookmarkProjection({
        bookmark: { bookmarkId: "bookmark-ours", destinationPath: unrelatedPath },
        text: bookmarkProjection("bookmark-ours", "Ours"),
        capture,
      }),
    ).rejects.toThrow(/ownership marker does not match/u);
    await expect(
      archiveChatBookmarkProjection({
        bookmark: { bookmarkId: "bookmark-ours", destinationPath: unrelatedPath },
        archivedPath: "Bookmarks/Chats/Archived/unrelated.md",
        capture,
      }),
    ).rejects.toThrow(/ownership marker does not match/u);
    expect(await readFile(join(rootPath, unrelatedPath), "utf8")).toBe(unrelatedText);

    const corruptPath = "Bookmarks/Chats/corrupt.md";
    await writeChatBookmarkProjection({
      bookmark: { bookmarkId: "bookmark-corrupt", destinationPath: corruptPath },
      text: bookmarkProjection("bookmark-corrupt", "Before corruption"),
      capture,
    });
    await write(rootPath, corruptPath, "# Marker removed by unrelated content\n");
    await expect(
      archiveChatBookmarkProjection({
        bookmark: { bookmarkId: "bookmark-corrupt", destinationPath: corruptPath },
        archivedPath: "Bookmarks/Chats/Archived/corrupt.md",
        capture,
      }),
    ).rejects.toThrow(/ownership marker does not match/u);
    expect(await readFile(join(rootPath, corruptPath), "utf8")).toBe(
      "# Marker removed by unrelated content\n",
    );
    expect(
      await capture.fileObjectIdForPath("Bookmarks/Chats/Archived/corrupt.md"),
    ).toBeNull();
    await capture.stop();
  });

  it("recovers an unclaimed archive across a crash and restores with fresh ownership", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-bookmark-archive-recovery-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });
    const legacyBookmark = {
      bookmarkId: "bookmark-disk-only-archive",
      destinationPath: "Bookmarks/Chats/disk-only-archive.md",
    };
    const legacyArchivedPath = "Bookmarks/Chats/Archived/disk-only-archive.md";
    await write(
      rootPath,
      legacyBookmark.destinationPath,
      bookmarkProjection(legacyBookmark.bookmarkId, "Disk-only legacy archive"),
    );
    const legacyArchived = await archiveChatBookmarkProjection({
      bookmark: legacyBookmark,
      archivedPath: legacyArchivedPath,
      capture,
    });
    expect(await capture.fileObjectIdForPath(legacyArchivedPath)).toBe(
      legacyArchived.objectId,
    );
    await expect(
      readFile(join(rootPath, legacyBookmark.destinationPath), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const bookmark = {
      bookmarkId: "bookmark-archive-recovery",
      destinationPath: "Bookmarks/Chats/recover-archive.md",
    };
    const archivedPath = "Bookmarks/Chats/Archived/recover-archive.md";
    const created = await writeChatBookmarkProjection({
      bookmark,
      text: bookmarkProjection(bookmark.bookmarkId, "Before archive"),
      capture,
    });

    const archived = await archiveChatBookmarkProjection({
      bookmark,
      archivedPath,
      capture,
    });
    expect(archived.objectId).toBe(created.objectId);
    // Simulate a crash after rename but before markBookmarkReady persisted the
    // recovered object id. Recovery must recognize the archived side.
    const retried = await archiveChatBookmarkProjection({
      bookmark,
      archivedPath,
      capture,
    });
    expect(retried).toMatchObject({ objectId: created.objectId, changed: false });

    // Reactivation clears the archived ownership in the store, so the active
    // path is a new projection while the archived object remains untouched.
    const restored = await writeChatBookmarkProjection({
      bookmark,
      text: bookmarkProjection(bookmark.bookmarkId, "Restored projection"),
      capture,
    });
    expect(restored.objectId).not.toBe(created.objectId);
    expect(await capture.fileObjectIdForPath(archivedPath)).toBe(created.objectId);
    expect(await capture.fileObjectIdForPath(bookmark.destinationPath)).toBe(
      restored.objectId,
    );
    await capture.stop();
  });

  it("fences a deferred archive completion from a reactivated live projection", async () => {
    const rootPath = await root();
    const { store: chats, seed } = makeChats("ws", rootPath);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-bookmark-archive-reactivate-race-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "general", name: "general", kind: "channel", nowMs: 10_001 },
    });
    await seed({
      method: CHATS_METHOD.threadStart,
      idempotencyKey: "thread-race:message-race",
      params: {
        channelId: "general",
        threadId: "thread-race",
        messageId: "message-race",
        authorKind: "human",
        authorDisplayName: "Ice",
        body: "Race archive against restore",
        nowMs: 10_002,
      },
    });
    const destinationPath = "Bookmarks/Chats/archive-reactivate-race.md";
    const saved = await chats.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: "thread-race",
      mode: "live",
      destinationPath,
    });
    const original = await writeChatBookmarkProjection({
      bookmark: saved,
      text: bookmarkProjection(saved.bookmarkId, "Original live projection"),
      capture,
    });
    await chats.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: saved.generation,
      projectionObjectId: original.objectId,
      projectionPath: destinationPath,
    });

    const archiveGeneration = await chats.archiveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
    });
    const archivedPath =
      `Bookmarks/Chats/Archived/archive-reactivate-race--g${archiveGeneration.generation}.md`;
    const archivedFile = await archiveChatBookmarkProjection({
      bookmark: archiveGeneration,
      archivedPath,
      capture,
    });
    // Defer archiveGeneration's markBookmarkReady until after the user has
    // reactivated the bookmark and a new live object has been written.
    const reactivated = await chats.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: "thread-race",
      mode: "live",
      destinationPath,
    });
    expect(reactivated).not.toHaveProperty("projectionObjectId");
    const unclaimedLive = await writeChatBookmarkProjection({
      bookmark: reactivated,
      text: bookmarkProjection(reactivated.bookmarkId, "Reactivated live projection"),
      capture,
    });
    expect(unclaimedLive.objectId).not.toBe(archivedFile.objectId);

    const staleArchiveCompletion = await chats.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: archiveGeneration.generation,
      projectionObjectId: archivedFile.objectId,
      projectionPath: destinationPath,
    });
    expect(staleArchiveCompletion.applied).toBe(false);
    expect(staleArchiveCompletion.bookmark).not.toHaveProperty("projectionObjectId");

    // Simulate the active worker retrying after its own write-before-outbox
    // crash. Marker recovery must select the live object, not the archived ID.
    const recoveredLive = await writeChatBookmarkProjection({
      bookmark: staleArchiveCompletion.bookmark,
      text: bookmarkProjection(reactivated.bookmarkId, "Recovered live projection"),
      capture,
    });
    expect(recoveredLive.objectId).toBe(unclaimedLive.objectId);
    const ready = await chats.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: reactivated.generation,
      projectionObjectId: recoveredLive.objectId,
      projectionPath: destinationPath,
    });
    expect(ready).toMatchObject({
      applied: true,
      bookmark: {
        state: "active",
        projectionState: "ready",
        projectionObjectId: unclaimedLive.objectId,
      },
    });
    expect(await capture.fileObjectIdForPath(archivedPath)).toBe(archivedFile.objectId);
    expect(await capture.fileObjectIdForPath(destinationPath)).toBe(unclaimedLive.objectId);
    await chats.close();
    await capture.stop();
  });

  it("materializes idempotently and preserves object identity across live refreshes", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-text-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });

    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/pricing.md",
      text: "# Pricing\n\nFirst projection.\n",
    });
    const repeated = await capture.writeGeneratedTextFile({
      path: created.path,
      text: "# Pricing\n\nFirst projection.\n",
    });
    const refreshed = await capture.writeGeneratedTextFile({
      path: created.path,
      expectedObjectId: created.objectId,
      text: "# Pricing\n\nUpdated projection.\n",
    });

    expect(created.changed).toBe(true);
    expect(repeated).toEqual({ ...created, changed: false });
    expect(refreshed.objectId).toBe(created.objectId);
    expect(await readFile(join(rootPath, refreshed.path), "utf8")).toBe(
      "# Pricing\n\nUpdated projection.\n",
    );
    const moments = await capture.listMoments();
    expect(moments.moments.filter((moment) => moment.path === created.path)).toHaveLength(2);
    expect(new Set(moments.moments.map((moment) => moment.objectId))).toEqual(
      new Set([created.objectId]),
    );
    await capture.stop();
  });

  it("refuses unsafe, non-Markdown, and colliding first-create destinations", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-path-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });

    await expect(
      capture.writeGeneratedTextFile({ path: ".dohc/bookmark.md", text: "nope" }),
    ).rejects.toThrow(/safe visible Markdown path/u);
    await expect(
      capture.writeGeneratedTextFile({ path: "Bookmarks/Chats/bookmark.txt", text: "nope" }),
    ).rejects.toThrow(/safe visible Markdown path/u);

    await write(rootPath, "Bookmarks/Chats/existing.md", "user content\n");
    await expect(
      capture.writeGeneratedTextFile({
        path: "Bookmarks/Chats/existing.md",
        text: "generated content\n",
      }),
    ).rejects.toThrow(/already exists on disk/u);
    expect(await readFile(join(rootPath, "Bookmarks/Chats/existing.md"), "utf8")).toBe(
      "user content\n",
    );

    const existing = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/existing-identical.md",
      text: "generated content\n",
    });
    await expect(
      capture.writeGeneratedTextFile({
        path: existing.path,
        text: "generated content\n",
        createOnly: true,
      }),
    ).rejects.toThrow(/destination already exists/u);
    expect(await capture.fileObjectIdForPath(existing.path)).toBe(existing.objectId);
    await capture.stop();
  });

  it("refuses generated text past the daemon write limit before mutation", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-write-limit-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });

    await expect(
      capture.writeGeneratedTextFile({
        path: "Bookmarks/Chats/oversized.md",
        text: "x".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1),
      }),
    ).rejects.toThrow(
      `Generated Markdown exceeds the in-band write limit: limit ${MAX_DESKTOP_CAPTURE_TEXT_BYTES} bytes, observed ${MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1} bytes: Bookmarks/Chats/oversized.md.`,
    );
    await expect(capture.fileObjectIdForPath("Bookmarks/Chats/oversized.md")).resolves.toBeNull();
    await capture.stop();
  });

  it("archives idempotently while preserving the stable object id", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-archive-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });
    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/launch.md",
      text: "# Launch\n\nArchived conversation.\n",
    });

    const archived = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath: "Bookmarks/Chats/Archived/launch.md",
      expectedObjectId: created.objectId,
    });
    const repeated = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath: archived.path,
      expectedObjectId: created.objectId,
    });

    expect(archived).toMatchObject({ objectId: created.objectId, changed: true });
    expect(repeated).toMatchObject({ objectId: created.objectId, changed: false });
    await expect(readFile(join(rootPath, created.path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(rootPath, archived.path), "utf8")).toBe(
      "# Launch\n\nArchived conversation.\n",
    );
    expect(await capture.fileObjectIdForPath(archived.path)).toBe(created.objectId);
    expect(await capture.fileObjectIdForPath(created.path)).toBeNull();
    await capture.stop();
  });

  it("repairs a partially materialized archive on retry", async () => {
    const rootPath = await root();
    const disk = createDefaultDiskWriter(rootPath);
    let failDelete = true;
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-archive-retry-test",
      rootPath,
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
      diskWriter: {
        writeTextFile: disk.writeTextFile,
        writeBinaryFile: disk.writeBinaryFile,
        async deletePath(path) {
          if (failDelete) {
            failDelete = false;
            throw new Error("injected delete failure");
          }
          await disk.deletePath(path);
        },
      },
    });
    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/retry.md",
      text: "# Retry\n",
    });
    const toPath = "Bookmarks/Chats/Archived/retry.md";

    await expect(
      capture.archiveGeneratedTextFile({
        fromPath: created.path,
        toPath,
        expectedObjectId: created.objectId,
      }),
    ).rejects.toThrow(/injected delete failure/u);
    expect(await capture.fileObjectIdForPath(toPath)).toBe(created.objectId);

    const repaired = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath,
      expectedObjectId: created.objectId,
    });
    expect(repaired.changed).toBe(false);
    await expect(readFile(join(rootPath, created.path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(rootPath, toPath), "utf8")).toBe("# Retry\n");
    await capture.stop();
  });

  it("fails closed when an archive retry finds edited or binary source content", async () => {
    const scenarios: Array<{ name: string; replacement: string | Buffer }> = [
      { name: "edited", replacement: "# User edit after the failed archive\n" },
      { name: "binary", replacement: Buffer.from([0xff, 0x00, 0x01]) },
    ];

    for (const scenario of scenarios) {
      const rootPath = await root();
      const disk = createDefaultDiskWriter(rootPath);
      let failDelete = true;
      const capture = createWorkspaceEngineCapture({
        workspaceId: `generated-archive-${scenario.name}-source-test`,
        rootPath,
        rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
        diskWriter: {
          writeTextFile: disk.writeTextFile,
          writeBinaryFile: disk.writeBinaryFile,
          async deletePath(path) {
            if (failDelete) {
              failDelete = false;
              throw new Error("injected delete failure");
            }
            await disk.deletePath(path);
          },
        },
      });
      const created = await capture.writeGeneratedTextFile({
        path: `Bookmarks/Chats/${scenario.name}.md`,
        text: "# Canonical archive\n",
      });
      const toPath = `Bookmarks/Chats/Archived/${scenario.name}.md`;

      await expect(
        capture.archiveGeneratedTextFile({
          fromPath: created.path,
          toPath,
          expectedObjectId: created.objectId,
        }),
      ).rejects.toThrow(/injected delete failure/u);
      await writeFile(join(rootPath, created.path), scenario.replacement);

      await expect(
        capture.archiveGeneratedTextFile({
          fromPath: created.path,
          toPath,
          expectedObjectId: created.objectId,
        }),
      ).rejects.toThrow(/archive source changed before recovery/u);
      expect(await readFile(join(rootPath, created.path))).toEqual(
        Buffer.from(scenario.replacement),
      );
      expect(await readFile(join(rootPath, toPath), "utf8")).toBe(
        "# Canonical archive\n",
      );
      await capture.stop();
    }
  });
});
