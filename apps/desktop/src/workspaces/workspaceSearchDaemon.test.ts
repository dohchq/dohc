import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { queryWorkspaceSearchDaemon } from "./workspaceSearchDaemon";

describe("queryWorkspaceSearchDaemon", () => {
  it("reads bounded daemon pages and preserves the renderer result contract", async () => {
    const queryPage = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            surface: "file",
            path: "notes/first.md",
            title: "notes/first.md",
            line: 2,
            preview: "é needle",
            matchStart: 3,
            matchEnd: 9,
            threadId: null,
            objectId: "object-first",
          },
        ],
        nextCursor: "page-2",
        versionId: "main",
      })
      .mockResolvedValueOnce({
        results: [
          {
            surface: "chat",
            path: "chat/thread-1",
            title: "Thread one",
            line: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
            threadId: "thread-1",
            objectId: null,
          },
        ],
        nextCursor: null,
        versionId: "main",
      });

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "needle",
      limit: 50,
      isCurrent: () => true,
    });

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({
      path: "notes/first.md",
      matchStart: 2,
      matchEnd: 8,
    });
    expect(queryPage).toHaveBeenNthCalledWith(
      1,
      { query: "needle", limit: 50 },
    );
    expect(queryPage).toHaveBeenNthCalledWith(
      2,
      { query: "needle", limit: 50, cursor: "page-2" },
    );
  });

  it("fails closed on an unpaged daemon response", async () => {
    const queryPage = vi.fn().mockResolvedValue([]);
    await expect(
      queryWorkspaceSearchDaemon({
        daemon: { queryPage },
        query: "needle",
        limit: 50,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("must be a JSON object");
  });
});

describe("desktop workspace-search handler wiring", () => {
  const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const marker = "CHANNELS.searchWorkspace,";
  const markerAt = mainSource.indexOf(marker);
  const handlerStart = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  const handlerEnd = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  it("routes engine search only through the paged daemon read", () => {
    expect(handler).toContain("queryWorkspaceSearchDaemon({");
    expect(handler).toContain("rendererGeneration(sender.id) === generation");
    expect(handler).toContain(
      "latestSearchIdBySender.get(sender.id) === input.searchId",
    );
    expect(handler).not.toContain("searchWorkspaceEngine(");
    expect(handler).not.toContain("engineSearchStoreFor(");
  });
});
